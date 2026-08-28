import * as React from 'react';
import { View, Image, ActivityIndicator, Pressable, TextInput, Keyboard, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { machineBash } from '@/sync/ops';
import { useSession, useSocketStatus } from '@/sync/storage';
import { mapDisplayToInput, type Size, type StreamFrameMetadata } from '@/takeover';
import { codeForKey, keyMessage, openTakeover, parseStreamFrame, touchMessage } from '@/takeover';

function selectedPort(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/** Shell-safe agent-browser session names only; anything else is dropped. */
function selectedSession(value: string | undefined): string | undefined {
    return value !== undefined && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

interface LiveFrame {
    uri: string;
    metadata: StreamFrameMetadata;
}

const TAP_SLOP_PX = 12;
const TAP_TIMEOUT_MS = 400;

/**
 * Live view of an agent-browser stream, tunnelled through the relay preview
 * channel. The user clears a login / 2FA / CAPTCHA wall here by touch while
 * the agent waits. Nothing rendered or typed is logged or persisted.
 */
export default function TakeoverScreen() {
    const { theme } = useUnistyles();
    const { id, port, session: browserSession } = useLocalSearchParams<{ id: string; port?: string; session?: string }>();
    const session = useSession(id);
    const { status } = useSocketStatus();
    const [frame, setFrame] = React.useState<LiveFrame | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [connecting, setConnecting] = React.useState(false);
    const [display, setDisplay] = React.useState<Size>({ width: 0, height: 0 });
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);
    const [typed, setTyped] = React.useState('');
    const [portDraft, setPortDraft] = React.useState('');
    const socketRef = React.useRef<WebSocket | null>(null);
    const closeTunnelRef = React.useRef<(() => void) | null>(null);
    const inputRef = React.useRef<TextInput>(null);
    const tapRef = React.useRef<{ x: number; y: number; at: number } | null>(null);
    const streamRef = React.useRef<{ command: string; cwd: string } | null>(null);

    const cwd = session?.metadata?.path ?? '.';
    const sessionFlag = selectedSession(browserSession);
    const agentBrowser = sessionFlag === undefined ? 'agent-browser' : `agent-browser --session ${sessionFlag}`;

    const send = React.useCallback((message: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(message);
    }, []);

    const disconnect = React.useCallback(() => {
        socketRef.current?.close();
        socketRef.current = null;
        closeTunnelRef.current?.();
        closeTunnelRef.current = null;
    }, []);

    // Refcounted stream lifecycle: the screen enables on mount and disables on
    // unmount, so the screencast never outlives its last watcher.
    const connect = React.useCallback(async (streamPort: number) => {
        disconnect();
        setConnecting(true);
        setError(null);
        try {
            await machineBash('', `${agentBrowser} stream enable --port ${streamPort}`, cwd);
            streamRef.current = { command: agentBrowser, cwd };
            const opened = await openTakeover(streamPort);
            closeTunnelRef.current = opened.close;
            const socket = new WebSocket(opened.wsUrl);
            socketRef.current = socket;
            socket.onmessage = (event) => {
                const next = parseStreamFrame(event.data);
                if (next !== undefined) setFrame({ uri: `data:image/jpeg;base64,${next.data}`, metadata: next.metadata });
            };
            socket.onerror = () => setError('The takeover stream connection failed.');
            socket.onclose = () => {
                setFrame(null);
                // A close on the live socket is never silent: deliberate
                // teardown nulls the ref first, so this only fires upstream.
                if (socketRef.current === socket) setError('The takeover stream closed.');
            };
        } catch (cause: unknown) {
            disconnect();
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setConnecting(false);
        }
    }, [agentBrowser, cwd, disconnect]);

    const attempted = React.useRef<string | undefined>(undefined);
    const directPort = selectedPort(port);
    React.useEffect(() => {
        if (directPort === undefined || status !== 'connected' || session === undefined) return;
        const key = `${id}:${directPort}`;
        if (attempted.current === key) return;
        attempted.current = key;
        void connect(directPort);
    }, [connect, directPort, id, session, status]);

    // Unmount only: close the stream and drop the enable refcount when a
    // stream was actually enabled by this screen.
    const cleanupRef = React.useRef<() => void>(() => {});
    cleanupRef.current = () => {
        disconnect();
        if (streamRef.current !== null) {
            void machineBash('', `${streamRef.current.command} stream disable`, streamRef.current.cwd);
            streamRef.current = null;
        }
    };
    React.useEffect(() => () => cleanupRef.current(), []);

    const releaseTap = React.useCallback((x: number, y: number) => {
        const start = tapRef.current;
        tapRef.current = null;
        if (start === null || frame === null) return;
        if (Math.abs(x - start.x) > TAP_SLOP_PX || Math.abs(y - start.y) > TAP_SLOP_PX) return;
        if (Date.now() - start.at > TAP_TIMEOUT_MS) return;
        const point = mapDisplayToInput({ x, y }, display, frame.metadata);
        send(touchMessage('touchStart', point));
        send(touchMessage('touchEnd'));
    }, [display, frame, send]);

    const pushText = React.useCallback((value: string) => {
        const added = value.slice(typed.length);
        for (const key of added) {
            send(keyMessage('keyDown', key, codeForKey(key)));
            send(keyMessage('keyUp', key, codeForKey(key)));
        }
        // Keep the hidden field short so diffs stay cheap and nothing accumulates.
        setTyped(value.length > 32 ? '' : value);
    }, [send, typed]);

    const saveState = React.useCallback(async () => {
        const accepted = await Modal.confirm(
            'Save browser login?',
            'Stores the cookies and session state on the machine so this wall does not come back. The file holds plaintext session tokens and is kept private to your user.',
            { confirmText: 'Save' },
        );
        if (!accepted) return;
        const name = `takeover-${Date.now()}.json`;
        const result = await machineBash('', `${agentBrowser} state save ${name} && chmod 600 "$HOME/.agent-browser/sessions/${name}"`, cwd);
        if (!result.success) Modal.alert('Could not save state', result.stderr || result.stdout);
    }, [agentBrowser, cwd]);

    const toggleKeyboard = React.useCallback(() => {
        if (keyboardOpen) {
            Keyboard.dismiss();
            setKeyboardOpen(false);
        } else {
            setTyped('');
            inputRef.current?.focus();
            setKeyboardOpen(true);
        }
    }, [keyboardOpen]);

    const toolbar = (
        <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: theme.colors.surface }}>
            <Pressable onPress={toggleKeyboard} hitSlop={10} accessibilityRole="button" accessibilityLabel="Toggle keyboard" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name={keyboardOpen ? 'keypad' : 'keypad-outline'} size={20} color={theme.colors.text} />
                <Text style={{ ...Typography.default(), color: theme.colors.text }}>Type</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => void saveState()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Save browser login" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="key-outline" size={20} color={theme.colors.text} />
                <Text style={{ ...Typography.default(), color: theme.colors.text }}>Save login</Text>
            </Pressable>
        </View>
    );

    const hiddenInput = (
        <TextInput
            ref={inputRef}
            value={typed}
            onChangeText={pushText}
            onKeyPress={({ nativeEvent }) => {
                if (nativeEvent.key === 'Backspace') {
                    send(keyMessage('keyDown', 'Backspace', 'Backspace'));
                    send(keyMessage('keyUp', 'Backspace', 'Backspace'));
                }
            }}
            onSubmitEditing={() => {
                send(keyMessage('keyDown', 'Enter', 'Enter'));
                send(keyMessage('keyUp', 'Enter', 'Enter'));
            }}
            onBlur={() => setKeyboardOpen(false)}
            autoCapitalize="none"
            autoCorrect={false}
            blurOnSubmit={false}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
            accessibilityLabel="Takeover keyboard input"
        />
    );

    if (frame !== null) {
        return (
            <View style={{ flex: 1, backgroundColor: '#000' }}>
                <View
                    style={{ flex: 1 }}
                    onLayout={(event) => setDisplay({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
                    onStartShouldSetResponder={() => true}
                    onResponderGrant={(event) => {
                        tapRef.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY, at: Date.now() };
                    }}
                    onResponderRelease={(event) => releaseTap(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    onResponderTerminate={() => { tapRef.current = null; }}
                >
                    <Image source={{ uri: frame.uri }} style={{ flex: 1 }} resizeMode="contain" />
                </View>
                {toolbar}
                {hiddenInput}
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, padding: 16 }}>
            {error !== null && <Text style={{ ...Typography.default(), color: theme.colors.textDestructive, marginBottom: 12 }}>{error}</Text>}

            {(connecting || (directPort !== undefined && error === null)) && (
                <View style={{ alignItems: 'center', paddingVertical: 24, gap: 12 }}>
                    <ActivityIndicator size="small" color={theme.colors.text} />
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>Connecting to the browser stream…</Text>
                </View>
            )}

            {error !== null && directPort !== undefined && !connecting && (
                <Pressable onPress={() => void connect(directPort)} accessibilityRole="button" accessibilityLabel="Retry takeover" style={{ paddingVertical: 14, alignItems: 'center' }}>
                    <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Retry</Text>
                </Pressable>
            )}

            {directPort === undefined && !connecting && (
                <View style={{ gap: 12 }}>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>
                        Enter the agent-browser stream port from the blocked-agent message.
                    </Text>
                    <TextInput
                        value={portDraft}
                        onChangeText={setPortDraft}
                        placeholder="Stream port"
                        placeholderTextColor={theme.colors.textSecondary}
                        keyboardType={Platform.OS === 'web' ? undefined : 'number-pad'}
                        style={{ ...Typography.default(), color: theme.colors.text, backgroundColor: theme.colors.surface, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 }}
                    />
                    <Pressable
                        onPress={() => {
                            const picked = selectedPort(portDraft);
                            if (picked !== undefined) void connect(picked);
                        }}
                        disabled={selectedPort(portDraft) === undefined || status !== 'connected'}
                        accessibilityRole="button"
                        accessibilityLabel="Connect to stream"
                        style={{ alignItems: 'center', paddingVertical: 14, borderRadius: 12, backgroundColor: theme.colors.surface, opacity: selectedPort(portDraft) === undefined ? 0.4 : 1 }}
                    >
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Connect</Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
}
