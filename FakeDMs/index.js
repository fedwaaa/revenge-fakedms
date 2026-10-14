(() => {
    "use strict";

    // ── Safe API Resolver across Kettu, Bunny, and Vendetta ───────────────────
    const root = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : global);
    const mod = root.kettu || root.bunny || root.vendetta;

    const metro = mod?.metro;
    const patcher = mod?.patcher;
    const commands = mod?.commands;
    const toasts = mod?.ui?.toasts;

    const findByProps = (...props) => metro?.findByProps(...props);

    // ── Metro Modules ────────────────────────────────────────────────────────
    let FluxDispatcher;
    let UserStore;
    let SelectedChannelStore;
    let ChannelStore;
    let RelationshipStore;
    let MessageActions;

    function initModules() {
        try {
            FluxDispatcher = findByProps("dispatch", "subscribe");
            UserStore = findByProps("getCurrentUser", "getUser");
            SelectedChannelStore = findByProps("getChannelId");
            ChannelStore = findByProps("getChannel");
            RelationshipStore = findByProps("getRelationships", "getFriendIDs");
            MessageActions = findByProps("sendMessage", "receiveMessage") || findByProps("sendMessage");
        } catch (e) {
            console.error("[FakeDMs] Error resolving Metro modules:", e);
        }
    }

    function notify(text) {
        try {
            if (toasts?.showToast) {
                toasts.showToast(text, "ic_message_edit");
            } else {
                console.log("[FakeDMs]", text);
            }
        } catch {}
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function generateSnowflake() {
        const DISCORD_EPOCH = 1420070400000n;
        const ts = BigInt(Date.now()) - DISCORD_EPOCH;
        return ((ts << 22n) | BigInt(Math.floor(Math.random() * 4194304))).toString();
    }

    function guessContentType(filename) {
        const ext = (filename || "").split(".").pop().toLowerCase();
        const map = {
            exe: "application/x-msdownload",
            zip: "application/zip",
            rar: "application/x-rar-compressed",
            "7z": "application/x-7z-compressed",
            tar: "application/x-tar",
            gz: "application/gzip",
            pdf: "application/pdf",
            doc: "application/msword",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            txt: "text/plain",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            mp4: "video/mp4",
            mp3: "audio/mpeg"
        };
        return map[ext] || "application/octet-stream";
    }

    function getRandomFileSize(filename) {
        const ext = (filename || "").split(".").pop().toLowerCase();
        const ranges = {
            exe: [1000000, 45000000],
            zip: [100000, 25000000],
            rar: [100000, 25000000],
            "7z": [100000, 20000000],
            pdf: [50000, 8000000],
            png: [10000, 4000000],
            jpg: [15000, 3000000]
        };
        const [min, max] = ranges[ext] || [50000, 10000000];
        return Math.floor(Math.random() * (max - min) + min);
    }

    // ── Mention Parser ───────────────────────────────────────────────────────
    function parseMentions(text, channel) {
        const usersMap = new Map();

        const registerUser = (u) => {
            if (!u) return;
            if (u.username) usersMap.set(u.username.toLowerCase(), u);
            if (u.globalName) usersMap.set(u.globalName.toLowerCase(), u);
        };

        if (channel?.recipients && UserStore) {
            channel.recipients.forEach((id) => registerUser(UserStore.getUser(id)));
        }
        const self = UserStore?.getCurrentUser();
        if (self) registerUser(self);

        if (RelationshipStore?.getFriendIDs && UserStore) {
            try {
                const friends = RelationshipStore.getFriendIDs();
                friends.forEach((id) => registerUser(UserStore.getUser(id)));
            } catch {}
        }

        const mentionedUsers = [];
        let parsedText = text;

        const rawRegex = /<@!?(\d+)>/g;
        let match;
        while ((match = rawRegex.exec(text)) !== null) {
            const user = UserStore?.getUser(match[1]);
            if (user && !mentionedUsers.some((u) => u.id === user.id)) {
                mentionedUsers.push(user);
            }
        }

        const sorted = [...usersMap.entries()].sort((a, b) => b[0].length - a[0].length);
        for (const [name, user] of sorted) {
            const regex = new RegExp(`@${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "gi");
            if (regex.test(parsedText)) {
                parsedText = parsedText.replace(regex, `<@${user.id}>`);
                if (!mentionedUsers.some((u) => u.id === user.id)) {
                    mentionedUsers.push(user);
                }
            }
        }

        const mentionEveryone = /@everyone/i.test(parsedText) || /@here/i.test(parsedText);

        const mentions = mentionedUsers.map((u) => ({
            id: u.id,
            username: u.username,
            global_name: u.globalName || u.username,
            avatar: u.avatar,
            discriminator: u.discriminator || "0",
            public_flags: u.publicFlags || 0,
            bot: false
        }));

        return { parsedText, mentions, mentionEveryone };
    }

    // ── Core Injection Engine ────────────────────────────────────────────────
    function injectFakeMessage({ text, fileName, fileUrl, asSelf, channelId }) {
        initModules();

        const targetChannelId = channelId || SelectedChannelStore?.getChannelId();
        const channel = ChannelStore?.getChannel(targetChannelId);

        if (!channel || (channel.type !== 1 && channel.type !== 3)) {
            notify("⚠️ Only works inside DMs or Group chats!");
            return;
        }

        const currentUser = UserStore?.getCurrentUser();
        let sender = currentUser;

        if (!asSelf) {
            const recipientId = channel.recipients?.find((id) => id !== currentUser.id);
            if (recipientId && UserStore) {
                sender = UserStore.getUser(recipientId) || currentUser;
            }
        }

        const { parsedText, mentions, mentionEveryone } = parseMentions(text || "", channel);

        const attachments = [];
        if (fileName) {
            const attachId = generateSnowflake();
            const dlUrl = fileUrl || `https://cdn.discordapp.com/attachments/0/${attachId}/${encodeURIComponent(fileName)}`;
            attachments.push({
                id: attachId,
                filename: fileName,
                size: getRandomFileSize(fileName),
                url: dlUrl,
                proxy_url: dlUrl,
                content_type: guessContentType(fileName),
                spoiler: false
            });
        }

        const messageId = generateSnowflake();

        if (!FluxDispatcher?.dispatch) {
            notify("⚠️ FluxDispatcher not available.");
            return;
        }

        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: targetChannelId,
            message: {
                id: messageId,
                type: 0,
                channel_id: targetChannelId,
                author: {
                    id: sender.id,
                    username: sender.username,
                    global_name: sender.globalName || sender.username,
                    avatar: sender.avatar,
                    discriminator: sender.discriminator || "0",
                    public_flags: sender.publicFlags || 0,
                    bot: false
                },
                content: parsedText,
                timestamp: new Date().toISOString(),
                edited_timestamp: null,
                tts: false,
                mention_everyone: mentionEveryone,
                mentions: mentions,
                mention_roles: [],
                attachments: attachments,
                embeds: [],
                reactions: [],
                pinned: false,
                flags: 0
            },
            optimistic: false,
            isPushNotification: false
        });

        notify(`✨ Injected as ${sender.globalName || sender.username}!`);
    }

    let unpatches = [];

    const plugin = {
        onLoad: () => {
            initModules();
            unpatches = [];

            // ════════════════════════════════════════════════════════════════════
            // METHOD 1: Chat Prefix Trigger (!fake <message> [--file name.exe] [--me])
            // Just type it in the text box and hit send!
            // It will NEVER send to Discord servers — intercepts locally!
            // ════════════════════════════════════════════════════════════════════
            if (MessageActions?.sendMessage && patcher?.instead) {
                try {
                    const unpatchSend = patcher.instead("sendMessage", MessageActions, (args, orig) => {
                        const [channelId, msgObj] = args;
                        const content = msgObj?.content ? msgObj.content.trim() : "";

                        if (content.startsWith("!fake ") || content.startsWith("!fakedm ")) {
                            let raw = content.replace(/^!(fakedm|fake)\s+/, "");

                            let asSelf = false;
                            if (raw.includes("--me")) {
                                asSelf = true;
                                raw = raw.replace("--me", "").trim();
                            }

                            let fileName = null;
                            const fileMatch = raw.match(/--file\s+([^\s]+)/i);
                            if (fileMatch) {
                                fileName = fileMatch[1];
                                raw = raw.replace(fileMatch[0], "").trim();
                            }

                            let fileUrl = null;
                            const urlMatch = raw.match(/--url\s+([^\s]+)/i);
                            if (urlMatch) {
                                fileUrl = urlMatch[1];
                                raw = raw.replace(urlMatch[0], "").trim();
                            }

                            injectFakeMessage({
                                text: raw,
                                fileName: fileName,
                                fileUrl: fileUrl,
                                asSelf: asSelf,
                                channelId: channelId
                            });

                            // Cancel sending over network
                            return Promise.resolve();
                        }

                        return orig(...args);
                    });
                    unpatches.push(unpatchSend);
                    console.log("[FakeDMs] !fake chat prefix interceptor active!");
                } catch (e) {
                    console.error("[FakeDMs] Error patching sendMessage:", e);
                }
            }

            // ════════════════════════════════════════════════════════════════════
            // METHOD 2: Slash Command (/fakedm) fallback
            // ════════════════════════════════════════════════════════════════════
            const register = commands?.registerCommand || mod?.commands?.registerCommand;
            if (typeof register === "function") {
                try {
                    const unregisterCmd = register({
                        name: "fakedm",
                        displayName: "fakedm",
                        description: "Inject client-sided DM messages with real profiles, @mentions, & attachments",
                        type: 1,
                        inputType: 0,
                        applicationId: "-1",
                        options: [
                            {
                                name: "message",
                                displayName: "message",
                                description: "Message text (@mentions and links work)",
                                type: 3,
                                required: true
                            },
                            {
                                name: "file",
                                displayName: "file",
                                description: "Attachment filename with extension (e.g. payload.exe, archive.zip)",
                                type: 3,
                                required: false
                            },
                            {
                                name: "url",
                                displayName: "url",
                                description: "Optional custom download URL for the file",
                                type: 3,
                                required: false
                            },
                            {
                                name: "as_self",
                                displayName: "as_self",
                                description: "Send as yourself instead of the other person? (true/false)",
                                type: 5,
                                required: false
                            }
                        ],
                        execute: (args, ctx) => {
                            const rawText = args.find((a) => a.name === "message")?.value || "";
                            const fileName = args.find((a) => a.name === "file")?.value;
                            const fileUrl = args.find((a) => a.name === "url")?.value;
                            const asSelf = args.find((a) => a.name === "as_self")?.value || false;

                            injectFakeMessage({
                                text: rawText,
                                fileName,
                                fileUrl,
                                asSelf,
                                channelId: ctx?.channel?.id
                            });
                        }
                    });
                    if (typeof unregisterCmd === "function") unpatches.push(unregisterCmd);
                } catch (e) {}
            }

            notify("FakeDMs v3.3 loaded! Use !fake in chat");
        },
        onUnload: () => {
            unpatches.forEach((u) => {
                try {
                    if (typeof u === "function") u();
                } catch {}
            });
            unpatches = [];
        }
    };

    return plugin;
})();
