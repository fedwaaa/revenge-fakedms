(() => {
    "use strict";

    // ── Safe API Resolver across Kettu, Bunny, and Vendetta ───────────────────
    const root = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : global);
    const mod = root.kettu || root.bunny || root.vendetta;

    const metro = mod?.metro;
    const commands = mod?.commands;

    const findByProps = (...props) => metro?.findByProps(...props);

    // ── Metro Modules ────────────────────────────────────────────────────────
    let FluxDispatcher;
    let UserStore;
    let SelectedChannelStore;
    let ChannelStore;
    let RelationshipStore;

    function initModules() {
        try {
            FluxDispatcher = findByProps("dispatch", "subscribe");
            UserStore = findByProps("getCurrentUser", "getUser");
            SelectedChannelStore = findByProps("getChannelId");
            ChannelStore = findByProps("getChannel");
            RelationshipStore = findByProps("getRelationships", "getFriendIDs");
        } catch (e) {
            console.error("[FakeDMs] Error resolving Metro modules:", e);
        }
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

    let unregister;

    const plugin = {
        onLoad: () => {
            initModules();

            const register = commands?.registerCommand || mod?.commands?.registerCommand;
            if (typeof register !== "function") {
                console.error("[FakeDMs] registerCommand is not available in Kettu");
                return;
            }

            try {
                unregister = register({
                    name: "fakedm",
                    displayName: "fakedm",
                    description: "Inject client-sided DM messages with real profiles, @mentions, & attachments",
                    type: 1, // CHAT_INPUT slash command
                    inputType: 0, // BUILT_IN client command
                    applicationId: "-1",
                    options: [
                        {
                            name: "message",
                            displayName: "message",
                            description: "Message text (@mentions and links work)",
                            type: 3, // STRING
                            required: true
                        },
                        {
                            name: "file",
                            displayName: "file",
                            description: "Attachment filename with extension (e.g. payload.exe, archive.zip)",
                            type: 3, // STRING
                            required: false
                        },
                        {
                            name: "url",
                            displayName: "url",
                            description: "Optional custom download URL for the file",
                            type: 3, // STRING
                            required: false
                        },
                        {
                            name: "as_self",
                            displayName: "as_self",
                            description: "Send as yourself instead of the other person? (true/false)",
                            type: 5, // BOOLEAN
                            required: false
                        }
                    ],
                    execute: (args, ctx) => {
                        initModules();

                        const channelId = ctx?.channel?.id || SelectedChannelStore?.getChannelId();
                        const channel = ctx?.channel || ChannelStore?.getChannel(channelId);

                        if (!channel || (channel.type !== 1 && channel.type !== 3)) {
                            return { content: "⚠️ Please run this command inside a DM or Group DM." };
                        }

                        const currentUser = UserStore?.getCurrentUser();
                        let sender = currentUser;

                        const asSelf = args.find((a) => a.name === "as_self")?.value || false;
                        if (!asSelf) {
                            const recipientId = channel.recipients?.find((id) => id !== currentUser.id);
                            if (recipientId && UserStore) {
                                sender = UserStore.getUser(recipientId) || currentUser;
                            }
                        }

                        const rawText = args.find((a) => a.name === "message")?.value || "";
                        const fileName = args.find((a) => a.name === "file")?.value;
                        const fileUrl = args.find((a) => a.name === "url")?.value;

                        const { parsedText, mentions, mentionEveryone } = parseMentions(rawText, channel);

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
                            return { content: "⚠️ FluxDispatcher not found in Kettu client." };
                        }

                        FluxDispatcher.dispatch({
                            type: "MESSAGE_CREATE",
                            channelId: channelId,
                            message: {
                                id: messageId,
                                type: 0,
                                channel_id: channelId,
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
                    }
                });
                console.log("[FakeDMs] /fakedm registered successfully!");
            } catch (err) {
                console.error("[FakeDMs] Failed to register command:", err);
            }
        },
        onUnload: () => {
            if (typeof unregister === "function") {
                unregister();
            }
        }
    };

    return plugin;
})();
