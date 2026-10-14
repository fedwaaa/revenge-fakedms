(() => {
    "use strict";

    // ── Safe API Resolver across Kettu, Bunny, and Vendetta ───────────────────
    const root = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : global);
    const mod = root.kettu || root.bunny || root.vendetta || {};

    const metro = mod.metro || {};
    const patcher = mod.patcher || {};
    const commands = mod.commands || {};
    const toasts = mod.ui?.toasts || {};
    const utils = mod.utils || {};

    const findByProps = (...props) => metro.findByProps ? metro.findByProps(...props) : null;
    const findInReactTree = utils.findInReactTree || ((tree, filter) => {
        const stack = [tree];
        while (stack.length > 0) {
            const current = stack.pop();
            if (!current) continue;
            try {
                if (filter(current)) return current;
            } catch {}
            if (Array.isArray(current)) {
                for (const item of current) stack.push(item);
            } else if (typeof current === "object") {
                if (current.props) stack.push(current.props);
                if (current.children) stack.push(current.children);
            }
        }
        return null;
    });

    // ── Persistent Storage for Injected Messages (Survives App Restarts) ─────
    const fakeMessagesByChannel = new Map();
    const STORAGE_KEY = "FAKEDMS_MESSAGES_STORE_V1";
    let cachedAsyncStorage = null;

    function getAsyncStorage() {
        if (cachedAsyncStorage) return cachedAsyncStorage;
        try {
            const modAsync = metro.common?.AsyncStorage;
            if (modAsync && typeof modAsync.getItem === "function") {
                cachedAsyncStorage = modAsync;
                return cachedAsyncStorage;
            }
            const found = findByProps("getItem", "setItem");
            if (found && typeof found.getItem === "function") {
                cachedAsyncStorage = found;
                return cachedAsyncStorage;
            }
        } catch {}
        return null;
    }

    async function savePersistentStore() {
        try {
            const data = {};
            for (const [chId, msgs] of fakeMessagesByChannel.entries()) {
                if (Array.isArray(msgs) && msgs.length > 0) {
                    data[chId] = msgs;
                }
            }
            const json = JSON.stringify(data);

            // 1. AsyncStorage (Discord React Native)
            try {
                const storage = getAsyncStorage();
                if (storage && typeof storage.setItem === "function") {
                    await storage.setItem(STORAGE_KEY, json);
                }
            } catch {}

            // 2. Kettu / Bunny / Vendetta storage
            try {
                if (mod.storage && typeof mod.storage === "object") {
                    mod.storage[STORAGE_KEY] = json;
                }
            } catch {}

            // 3. localStorage (Hermes/JSC global runtime)
            try {
                if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.setItem === "function") {
                    localStorage.setItem(STORAGE_KEY, json);
                }
            } catch {}
        } catch (e) {
            console.error("[FakeDMs] Error saving persistent messages:", e);
        }
    }

    async function loadPersistentStore() {
        try {
            let json = null;

            // 1. AsyncStorage
            try {
                const storage = getAsyncStorage();
                if (storage && typeof storage.getItem === "function") {
                    json = await storage.getItem(STORAGE_KEY);
                }
            } catch {}

            // 2. Mod storage
            if (!json) {
                try {
                    if (mod.storage && mod.storage[STORAGE_KEY]) {
                        json = mod.storage[STORAGE_KEY];
                    }
                } catch {}
            }

            // 3. localStorage
            if (!json) {
                try {
                    if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.getItem === "function") {
                        json = localStorage.getItem(STORAGE_KEY);
                    }
                } catch {}
            }

            if (json) {
                const parsed = typeof json === "string" ? JSON.parse(json) : json;
                if (parsed && typeof parsed === "object") {
                    fakeMessagesByChannel.clear();
                    for (const [chId, msgs] of Object.entries(parsed)) {
                        if (Array.isArray(msgs) && msgs.length > 0) {
                            fakeMessagesByChannel.set(chId, msgs);
                        }
                    }
                    console.log("[FakeDMs] Loaded persistent messages for channels:", Object.keys(parsed).length);
                }
            }
        } catch (e) {
            console.error("[FakeDMs] Error loading persistent messages:", e);
        }
    }

    function deleteFakeMessages(channelId) {
        if (!channelId || !fakeMessagesByChannel.has(channelId)) return;
        const msgs = fakeMessagesByChannel.get(channelId) || [];

        // Erase each fake message live from Discord chat view
        if (FluxDispatcher?.dispatch) {
            for (const msg of msgs) {
                try {
                    FluxDispatcher.dispatch({
                        type: "MESSAGE_DELETE",
                        channelId: channelId,
                        id: msg.id
                    });
                } catch {}
            }
        }

        fakeMessagesByChannel.delete(channelId);
        savePersistentStore();
    }

    function deleteSingleFakeMessage(channelId, messageId) {
        if (!channelId || !messageId || !fakeMessagesByChannel.has(channelId)) return;
        const msgs = fakeMessagesByChannel.get(channelId) || [];
        const remaining = msgs.filter((m) => m.id !== messageId);

        if (remaining.length > 0) {
            fakeMessagesByChannel.set(channelId, remaining);
        } else {
            fakeMessagesByChannel.delete(channelId);
        }

        if (FluxDispatcher?.dispatch) {
            try {
                FluxDispatcher.dispatch({
                    type: "MESSAGE_DELETE",
                    channelId: channelId,
                    id: messageId
                });
            } catch {}
        }

        savePersistentStore();
    }

    // ── Metro Modules ────────────────────────────────────────────────────────
    let FluxDispatcher;
    let UserStore;
    let SelectedChannelStore;
    let ChannelStore;
    let RelationshipStore;
    let LazyActionSheet;
    let MessageActions;
    let PrivateChannelActions;
    let React;
    let ReactNative;

    function initModules() {
        try {
            FluxDispatcher = findByProps("_currentDispatchActionType") || findByProps("dispatch", "subscribe");
            UserStore = findByProps("getCurrentUser", "getUser");
            SelectedChannelStore = findByProps("getChannelId");
            ChannelStore = findByProps("getChannel");
            RelationshipStore = findByProps("getRelationships", "getFriendIDs");
            LazyActionSheet = findByProps("openLazy", "hideActionSheet");
            MessageActions = findByProps("sendMessage", "receiveMessage") || findByProps("sendMessage");
            PrivateChannelActions = findByProps("selectPrivateChannel");

            const common = metro.common || {};
            React = common.React || root.React;
            ReactNative = common.ReactNative || root.ReactNative || findByProps("View", "Text");
        } catch (e) {
            console.error("[FakeDMs] Error resolving Metro modules:", e);
        }
    }

    function notify(text) {
        try {
            if (toasts.showToast) {
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

    function getAvatarUrl(user) {
        if (!user) return null;
        if (user.avatar) {
            return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
        }
        const defaultNum = (BigInt(user.id || 0) >> 22n) % 6n;
        return `https://cdn.discordapp.com/embed/avatars/${defaultNum}.png`;
    }

    // ── Get All DMs ──────────────────────────────────────────────────────────
    function getAllDMChannels() {
        initModules();
        const dms = [];
        const seen = new Set();

        const addChannel = (c) => {
            if (!c || seen.has(c.id)) return;
            if (c.type === 1 || c.type === 3) {
                seen.add(c.id);
                dms.push(c);
            }
        };

        if (typeof ChannelStore?.getSortedPrivateChannels === "function") {
            try {
                const list = ChannelStore.getSortedPrivateChannels();
                if (Array.isArray(list)) list.forEach(addChannel);
            } catch {}
        }

        if (dms.length === 0 && typeof ChannelStore?.getDMChannelIds === "function") {
            try {
                const ids = ChannelStore.getDMChannelIds();
                if (Array.isArray(ids)) {
                    ids.forEach((id) => addChannel(ChannelStore.getChannel(id)));
                }
            } catch {}
        }

        if (dms.length === 0 && ChannelStore?.getChannels) {
            try {
                const all = ChannelStore.getChannels();
                if (all) {
                    for (const key in all) addChannel(all[key]);
                }
            } catch {}
        }

        return dms;
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

    // ── Re-Inject Messages into Channel View ──────────────────────────────────
    function restoreFakeMessages(channelId) {
        if (!channelId || !fakeMessagesByChannel.has(channelId)) return;
        const list = fakeMessagesByChannel.get(channelId);
        if (!Array.isArray(list) || list.length === 0) return;

        initModules();
        if (!FluxDispatcher?.dispatch) return;

        for (const msg of list) {
            try {
                FluxDispatcher.dispatch({
                    type: "MESSAGE_CREATE",
                    channelId: channelId,
                    message: msg,
                    optimistic: false,
                    sendMessageOptions: {},
                    isPushNotification: false
                });
            } catch (e) {
                console.error("[FakeDMs] Error restoring message:", e);
            }
        }
    }

    // ── Core Injection Engine ────────────────────────────────────────────────
    function injectFakeMessage({ text, fileName, fileUrl, asSelf, channelId }) {
        initModules();

        const targetChannelId = channelId || SelectedChannelStore?.getChannelId();
        const channel = ChannelStore?.getChannel(targetChannelId);

        if (!channel || (channel.type !== 1 && channel.type !== 3)) {
            notify("⚠️ Please select a DM from the list first!");
            return false;
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
            return false;
        }

        const message = {
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
        };

        // Save to persistent channel list & write to storage
        if (!fakeMessagesByChannel.has(targetChannelId)) {
            fakeMessagesByChannel.set(targetChannelId, []);
        }
        fakeMessagesByChannel.get(targetChannelId).push(message);
        savePersistentStore();

        // Dispatch into local view immediately
        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: targetChannelId,
            message: message,
            optimistic: false,
            sendMessageOptions: {},
            isPushNotification: false
        });

        notify(`✨ Injected as ${sender.globalName || sender.username}!`);
        return true;
    }

    // ── React Native Composer with DM Selector & Persistence ──────────────────
    function ComposerView({ onClose }) {
        initModules();
        if (!React || !ReactNative) return null;

        const { View, Text, TextInput, TouchableOpacity, ScrollView, Image } = ReactNative;
        const [messageText, setMessageText] = React.useState("");
        const [fileName, setFileName] = React.useState("");
        const [asSelf, setAsSelf] = React.useState(false);
        const [showPicker, setShowPicker] = React.useState(false);

        const allDMs = React.useMemo(() => getAllDMChannels(), []);
        const activeChannelId = SelectedChannelStore?.getChannelId();

        const initialChannelId = (allDMs.find(c => c.id === activeChannelId) || allDMs[0])?.id || null;
        const [targetChannelId, setTargetChannelId] = React.useState(initialChannelId);

        const selectedChannel = ChannelStore?.getChannel(targetChannelId) || allDMs.find(c => c.id === targetChannelId);
        const currentUser = UserStore?.getCurrentUser();
        const otherUserId = selectedChannel?.recipients?.find((id) => id !== currentUser?.id);
        const otherUser = otherUserId ? UserStore?.getUser(otherUserId) : null;

        const otherName = otherUser?.globalName || otherUser?.username || selectedChannel?.name || "Target User";
        const myName = currentUser?.globalName || currentUser?.username || "You";

        const [updateTick, setUpdateTick] = React.useState(0);
        const triggerUpdate = () => setUpdateTick((t) => t + 1);

        const currentFakes = (targetChannelId && fakeMessagesByChannel.get(targetChannelId)) || [];
        const injectedCount = currentFakes.length;

        const handleInject = () => {
            if (!targetChannelId) {
                notify("⚠️ Please select a DM conversation first!");
                return;
            }
            if (!messageText.trim() && !fileName.trim()) {
                notify("⚠️ Enter a message or filename!");
                return;
            }

            const success = injectFakeMessage({
                text: messageText,
                fileName: fileName.trim() || null,
                asSelf: asSelf,
                channelId: targetChannelId
            });

            if (success) {
                setMessageText("");
                setFileName("");
                triggerUpdate();
                if (typeof onClose === "function") onClose();
                if (LazyActionSheet?.hideActionSheet) LazyActionSheet.hideActionSheet();
            }
        };

        const handleJumpToDM = () => {
            if (targetChannelId && PrivateChannelActions?.selectPrivateChannel) {
                PrivateChannelActions.selectPrivateChannel(targetChannelId);
                setTimeout(() => restoreFakeMessages(targetChannelId), 200);
                notify(`Switched to DM with ${otherName}`);
            }
        };

        const handleDeleteAllInDM = () => {
            if (targetChannelId && fakeMessagesByChannel.has(targetChannelId)) {
                deleteFakeMessages(targetChannelId);
                triggerUpdate();
                notify(`🗑 Deleted all fake messages for DM with ${otherName}`);
            }
        };

        const handleDeleteSingle = (msgId) => {
            if (targetChannelId) {
                deleteSingleFakeMessage(targetChannelId, msgId);
                triggerUpdate();
                notify("🗑 Deleted fake message");
            }
        };

        return React.createElement(ScrollView, {
            style: { padding: 16, backgroundColor: "#1e1f22", borderRadius: 12 },
            contentContainerStyle: { paddingBottom: 36 }
        },
            // Title Header
            React.createElement(Text, {
                style: { color: "#ffffff", fontSize: 20, fontWeight: "bold", marginBottom: 4 }
            }, "⚡ Fake DM Composer"),
            React.createElement(Text, {
                style: { color: "#949ba4", fontSize: 13, marginBottom: 14 }
            }, "Choose who you want to fake a conversation with:"),

            // ── TARGET DM SELECTOR BAR ──
            React.createElement(TouchableOpacity, {
                style: {
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: "#2b2d31",
                    padding: 12,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "#5865F2",
                    marginBottom: 10
                },
                onPress: () => setShowPicker(!showPicker)
            },
                otherUser ? React.createElement(Image, {
                    source: { uri: getAvatarUrl(otherUser) },
                    style: { width: 34, height: 34, borderRadius: 17, marginRight: 10 }
                }) : null,
                React.createElement(View, { style: { flex: 1 } },
                    React.createElement(Text, { style: { color: "#949ba4", fontSize: 11, fontWeight: "bold" } }, "TARGET CONVERSATION"),
                    React.createElement(Text, { style: { color: "#ffffff", fontSize: 15, fontWeight: "bold" } }, otherName)
                ),
                React.createElement(Text, { style: { color: "#5865F2", fontWeight: "bold", fontSize: 13 } }, showPicker ? "▲ Hide" : "▼ Change DM")
            ),

            // ── EXPANDABLE DM LIST ──
            showPicker ? React.createElement(View, {
                style: {
                    backgroundColor: "#232428",
                    borderRadius: 8,
                    padding: 6,
                    marginBottom: 14,
                    maxHeight: 200
                }
            },
                React.createElement(ScrollView, { nestedScrollEnabled: true },
                    allDMs.length === 0 ? React.createElement(Text, {
                        style: { color: "#949ba4", padding: 10, textAlign: "center" }
                    }, "No recent DMs found.") : allDMs.map((c) => {
                        const recId = c.recipients?.find(id => id !== currentUser?.id);
                        const recUser = recId ? UserStore?.getUser(recId) : null;
                        const label = recUser?.globalName || recUser?.username || c.name || `Chat (${c.id.slice(-4)})`;
                        const isSelected = c.id === targetChannelId;

                        return React.createElement(TouchableOpacity, {
                            key: c.id,
                            style: {
                                flexDirection: "row",
                                alignItems: "center",
                                padding: 10,
                                backgroundColor: isSelected ? "#35373c" : "transparent",
                                borderRadius: 6,
                                marginBottom: 2
                            },
                            onPress: () => {
                                setTargetChannelId(c.id);
                                setShowPicker(false);
                            }
                        },
                            recUser ? React.createElement(Image, {
                                source: { uri: getAvatarUrl(recUser) },
                                style: { width: 26, height: 26, borderRadius: 13, marginRight: 8 }
                            }) : null,
                            React.createElement(Text, {
                                style: { color: isSelected ? "#5865F2" : "#dbdee1", fontWeight: isSelected ? "bold" : "normal", fontSize: 14, flex: 1 }
                            }, label),
                            isSelected ? React.createElement(Text, { style: { color: "#5865F2" } }, "✓") : null
                        );
                    })
                )
            ) : null,

            // Quick Jump and Clear Row
            targetChannelId ? React.createElement(View, {
                style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }
            },
                React.createElement(TouchableOpacity, { onPress: handleJumpToDM },
                    React.createElement(Text, { style: { color: "#00aff4", fontSize: 12, fontWeight: "600" } }, `➔ Open DM with ${otherName}`)
                ),
                injectedCount > 0 ? React.createElement(TouchableOpacity, { onPress: handleDeleteAllInDM },
                    React.createElement(Text, { style: { color: "#ed4245", fontSize: 12, fontWeight: "600" } }, `🗑 Delete All (${injectedCount})`)
                ) : null
            ) : null,

            // ── SENDER TOGGLE BUTTON ──
            React.createElement(TouchableOpacity, {
                style: {
                    backgroundColor: asSelf ? "#248046" : "#5865F2",
                    padding: 13,
                    borderRadius: 8,
                    alignItems: "center",
                    marginBottom: 14
                },
                onPress: () => setAsSelf(!asSelf)
            },
                React.createElement(Text, {
                    style: { color: "#ffffff", fontWeight: "bold", fontSize: 15 }
                }, asSelf ? `👤 Talking as: ${myName} (You)` : `🎭 Talking as: ${otherName}`)
            ),

            // Message Input
            React.createElement(Text, {
                style: { color: "#b5bac1", fontSize: 12, fontWeight: "bold", marginBottom: 6 }
            }, "MESSAGE CONTENT (@mentions and links work)"),
            React.createElement(TextInput, {
                style: {
                    backgroundColor: "#2b2d31",
                    color: "#ffffff",
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 14,
                    minHeight: 70,
                    textAlignVertical: "top",
                    marginBottom: 14
                },
                placeholder: `Type what ${asSelf ? "you" : otherName} will say...`,
                placeholderTextColor: "#6d6f78",
                multiline: true,
                value: messageText,
                onChangeText: setMessageText
            }),

            // File Attachment Input
            React.createElement(Text, {
                style: { color: "#b5bac1", fontSize: 12, fontWeight: "bold", marginBottom: 6 }
            }, "OPTIONAL ATTACHMENT (.exe, .zip, .pdf, images)"),
            React.createElement(TextInput, {
                style: {
                    backgroundColor: "#2b2d31",
                    color: "#ffffff",
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 14,
                    marginBottom: 16
                },
                placeholder: "e.g. payload.exe, confidential.zip",
                placeholderTextColor: "#6d6f78",
                value: fileName,
                onChangeText: setFileName
            }),

            // Inject Button
            React.createElement(TouchableOpacity, {
                style: {
                    backgroundColor: "#5865F2",
                    padding: 14,
                    borderRadius: 8,
                    alignItems: "center",
                    marginBottom: 10
                },
                onPress: handleInject
            },
                React.createElement(Text, {
                    style: { color: "#ffffff", fontWeight: "bold", fontSize: 16 }
                }, "⚡ Inject Message Locally")
            ),

            // Saved Messages List for this DM (with individual Delete buttons)
            currentFakes.length > 0 ? React.createElement(View, {
                style: { marginTop: 10, borderTopWidth: 1, borderTopColor: "#35373c", paddingTop: 12 }
            },
                React.createElement(View, {
                    style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }
                },
                    React.createElement(Text, {
                        style: { color: "#b5bac1", fontSize: 12, fontWeight: "bold" }
                    }, `SAVED IN THIS DM (${currentFakes.length})`),
                    React.createElement(TouchableOpacity, { onPress: handleDeleteAllInDM },
                        React.createElement(Text, {
                            style: { color: "#ed4245", fontSize: 12, fontWeight: "bold" }
                        }, "🗑 Delete All")
                    )
                ),
                currentFakes.map((msg) => {
                    const isMsgSelf = msg.author?.id === currentUser?.id;
                    const senderLabel = isMsgSelf ? `${myName} (You)` : (msg.author?.global_name || msg.author?.username || otherName);
                    const previewText = msg.content || (msg.attachments?.[0]?.filename ? `📎 ${msg.attachments[0].filename}` : "Message");
                    return React.createElement(View, {
                        key: msg.id,
                        style: {
                            flexDirection: "row",
                            alignItems: "center",
                            backgroundColor: "#2b2d31",
                            padding: 10,
                            borderRadius: 8,
                            marginBottom: 6
                        }
                    },
                        React.createElement(View, { style: { flex: 1, marginRight: 8 } },
                            React.createElement(Text, {
                                style: { color: isMsgSelf ? "#57f287" : "#5865f2", fontSize: 12, fontWeight: "bold", marginBottom: 2 }
                            }, senderLabel),
                            React.createElement(Text, {
                                style: { color: "#dbdee1", fontSize: 13 },
                                numberOfLines: 2
                            }, previewText)
                        ),
                        React.createElement(TouchableOpacity, {
                            style: {
                                backgroundColor: "#da373c",
                                paddingVertical: 6,
                                paddingHorizontal: 10,
                                borderRadius: 6
                            },
                            onPress: () => handleDeleteSingle(msg.id)
                        },
                            React.createElement(Text, {
                                style: { color: "#ffffff", fontSize: 12, fontWeight: "bold" }
                            }, "Delete")
                        )
                    );
                })
            ) : null,

            // Quick hint
            React.createElement(Text, {
                style: { color: "#6d6f78", fontSize: 11, textAlign: "center", marginTop: 10 }
            }, "Messages are permanently saved to your device until you press Delete. Loads silently in background.")
        );
    }

    function openComposer() {
        initModules();
        if (LazyActionSheet?.openLazy) {
            LazyActionSheet.openLazy(
                Promise.resolve({ default: () => React.createElement(ComposerView, { onClose: () => LazyActionSheet.hideActionSheet() }) }),
                "FakeDMComposer"
            );
        } else {
            notify("⚠️ Could not open composer sheet.");
        }
    }

    let unpatches = [];

    const plugin = {
        onLoad: () => {
            initModules();
            unpatches = [];

            // 0. Silently load persistent messages from device storage in background
            loadPersistentStore().then(() => {
                const activeCh = SelectedChannelStore?.getChannelId();
                if (activeCh && fakeMessagesByChannel.has(activeCh)) {
                    setTimeout(() => restoreFakeMessages(activeCh), 200);
                    setTimeout(() => restoreFakeMessages(activeCh), 800);
                }
            });

            // 1. Auto-Restore Injected Messages When Switching/Loading Channels
            if (FluxDispatcher?.subscribe) {
                try {
                    const handleFluxEvent = (event) => {
                        if (!event) return;
                        const eventType = event.type;
                        if (eventType === "LOAD_MESSAGES_SUCCESS" || eventType === "CHANNEL_SELECT") {
                            const chId = event.channelId;
                            if (chId && fakeMessagesByChannel.has(chId)) {
                                setTimeout(() => restoreFakeMessages(chId), 120);
                                setTimeout(() => restoreFakeMessages(chId), 500);
                                setTimeout(() => restoreFakeMessages(chId), 1200);
                            }
                        }
                    };

                    FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", handleFluxEvent);
                    FluxDispatcher.subscribe("CHANNEL_SELECT", handleFluxEvent);

                    unpatches.push(() => {
                        try {
                            FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", handleFluxEvent);
                            FluxDispatcher.unsubscribe("CHANNEL_SELECT", handleFluxEvent);
                        } catch {}
                    });
                } catch (e) {
                    console.error("[FakeDMs] Flux subscribe error:", e);
                }
            }

            // ════════════════════════════════════════════════════════════════════
            // 1. Hook the + Button and Chat Action Sheets to add "⚡ Fake DM"
            // ════════════════════════════════════════════════════════════════════
            if (LazyActionSheet?.openLazy && patcher.before) {
                try {
                    const unpatchSheet = patcher.before("openLazy", LazyActionSheet, (args) => {
                        const [component] = args;
                        if (!component || typeof component.then !== "function") return;

                        component.then((instance) => {
                            if (!instance || !instance.default || !patcher.after) return;
                            const unpatchRender = patcher.after("default", instance, (_, res) => {
                                try {
                                    if (!React || !ReactNative) return;
                                    const { TouchableOpacity, Text } = ReactNative;

                                    const targetList = findInReactTree(res, (x) =>
                                        Array.isArray(x) && x.some((item) =>
                                            item?.props?.label || item?.props?.title || item?.type?.name === "ButtonRow" || item?.props?.leading
                                        )
                                    );

                                    if (targetList && !targetList.some((item) => item?.key === "fakedm-action-btn")) {
                                        targetList.unshift(
                                            React.createElement(TouchableOpacity, {
                                                key: "fakedm-action-btn",
                                                style: {
                                                    flexDirection: "row",
                                                    alignItems: "center",
                                                    padding: 14,
                                                    backgroundColor: "#2b2d31",
                                                    borderRadius: 8,
                                                    marginVertical: 4
                                                },
                                                onPress: () => {
                                                    LazyActionSheet.hideActionSheet();
                                                    setTimeout(() => openComposer(), 250);
                                                }
                                            },
                                                React.createElement(Text, {
                                                    style: { color: "#5865F2", fontWeight: "bold", fontSize: 15 }
                                                }, "⚡ Fake DM Composer")
                                            )
                                        );
                                    }
                                } catch {}
                            });
                            unpatches.push(unpatchRender);
                        });
                    });
                    unpatches.push(unpatchSheet);
                } catch (e) {}
            }

            // ════════════════════════════════════════════════════════════════════
            // 2. Chat Prefix: !fake <message> [--file name.exe] [--me]
            // ════════════════════════════════════════════════════════════════════
            if (MessageActions?.sendMessage && patcher.instead) {
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

                            return Promise.resolve();
                        }

                        return orig(...args);
                    });
                    unpatches.push(unpatchSend);
                } catch (e) {}
            }

            // ════════════════════════════════════════════════════════════════════
            // 3. Slash Command: /fakedm
            // ════════════════════════════════════════════════════════════════════
            const register = commands.registerCommand || mod.commands?.registerCommand;
            if (typeof register === "function") {
                try {
                    const unregisterCmd = register({
                        name: "fakedm",
                        displayName: "fakedm",
                        description: "Inject client-sided DM messages with real profiles, @mentions, & attachments",
                        displayDescription: "Inject client-sided DM messages with real profiles, @mentions, & attachments",
                        type: 1,
                        inputType: 0,
                        applicationId: "-1",
                        options: [
                            {
                                name: "message",
                                displayName: "message",
                                description: "Message text (@mentions and links work)",
                                displayDescription: "Message text (@mentions and links work)",
                                type: 3,
                                required: true
                            },
                            {
                                name: "file",
                                displayName: "file",
                                description: "Attachment filename with extension (e.g. payload.exe, archive.zip)",
                                displayDescription: "Attachment filename with extension (e.g. payload.exe, archive.zip)",
                                type: 3,
                                required: false
                            },
                            {
                                name: "url",
                                displayName: "url",
                                description: "Optional custom download URL for the file",
                                displayDescription: "Optional custom download URL for the file",
                                type: 3,
                                required: false
                            },
                            {
                                name: "as_self",
                                displayName: "as_self",
                                description: "Send as yourself instead of the other person? (true/false)",
                                displayDescription: "Send as yourself instead of the other person? (true/false)",
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

            // Loads 100% silently in background with no startup banner
        },
        onUnload: () => {
            unpatches.forEach((u) => {
                try {
                    if (typeof u === "function") u();
                } catch {}
            });
            unpatches = [];
        },
        // Settings page renderer (gear icon in Plugins list)
        settings: ComposerView
    };

    return plugin;
})();
