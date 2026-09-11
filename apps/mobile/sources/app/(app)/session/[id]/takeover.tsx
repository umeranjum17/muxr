import * as React from 'react';
import { View, Image, ActivityIndicator, Pressable, TextInput, Keyboard, Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { machineBash } from '@/catalog/ops';
import { useSession, useSocketStatus } from '@/catalog/store';
import { mapDisplayToInput, type Size, type StreamFrameMetadata } from '@/takeover';
import { codeForKey, isTakeoverConflict, keyMessage, openTakeover, parseStreamFrame, textEdits, touchMessage, wheelMessage } from '@/takeover';
import { useWebImeComposing } from '@/components/useWebImeComposing';
import { failureText } from '@/utils/errors';

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
/** A connected stream that never paints is a failure, not a spinner. */
const FIRST_FRAME_TIMEOUT_MS = 15_000;

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
    const [watching, setWatching] = React.useState(false);
    const socketRef = React.useRef<WebSocket | null>(null);
    const closeTunnelRef = React.useRef<(() => void) | null>(null);
    // Browser stream sender: set while a WebSocket-over-multiplex session is
    // live, so send/disconnect treat both transports the same below.
    const streamSendRef = React.useRef<((message: string) => void) | null>(null);
    const inputRef = React.useRef<TextInput>(null);
    const tapRef = React.useRef<{ x: number; y: number; at: number } | null>(null);
    const streamRef = React.useRef<{ command: string; cwd: string } | null>(null);
    // Every async startup stage checks this: a retry or navigation away bumps
    // it, and whatever a late stage produced is closed instead of adopted.
    const attemptRef = React.useRef(0);
    // Which connect() owns the screen: a newer connect or unmount supersedes
    // the older one, so a conflict dialog answered late cannot reconnect and
    // a failure of the old operation cannot touch the new one's state.
    const operationRef = React.useRef(0);
    const firstFrameTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const surfaceRef = React.useRef<View>(null);
    const dragRef = React.useRef<{ active: boolean; pending: { x: number; y: number } | null; raf: number | undefined }>({ active: false, pending: null, raf: undefined });
    const committedRef = React.useRef('');
    const isComposingRef = useWebImeComposing(inputRef, keyboardOpen);

    const cwd = session?.metadata?.path ?? '.';
    const sessionFlag = selectedSession(browserSession);
    const agentBrowser = sessionFlag === undefined ? 'agent-browser' : `agent-browser --session ${sessionFlag}`;

    const send = React.useCallback((message: string) => {
        // Watchers are read-only host-side too; dropping here keeps the UI honest.
        if (watching) return;
        if (streamSendRef.current !== null) {
            streamSendRef.current(message);
            return;
        }
        if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(message);
    }, [watching]);

    const disconnect = React.useCallback(() => {
        attemptRef.current += 1;
        if (firstFrameTimerRef.current !== undefined) clearTimeout(firstFrameTimerRef.current);
        firstFrameTimerRef.current = undefined;
        socketRef.current?.close();
        socketRef.current = null;
        streamSendRef.current = null;
        closeTunnelRef.current?.();
        closeTunnelRef.current = null;
    }, []);

    const armFirstFrame = React.useCallback((attempt: number) => {
        firstFrameTimerRef.current = setTimeout(() => {
            if (attempt !== attemptRef.current) return;
            disconnect();
            setError('The browser stream connected but never sent a picture. Check the agent browser is open, then retry.');
        }, FIRST_FRAME_TIMEOUT_MS);
    }, [disconnect]);

    // Refcounted stream lifecycle: the screen enables on mount and disables on
    // unmount, so the screencast never outlives its last watcher.
    const connect = React.useCallback(async (streamPort: number, mode: 'observe' | 'control' = 'control') => {
        disconnect();
        const attempt = attemptRef.current;
        const operation = ++operationRef.current;
        const stale = () => attempt !== attemptRef.current;
        const superseded = () => operation !== operationRef.current;
        setConnecting(true);
        setError(null);
        setWatching(mode === 'observe');
        try {
            await machineBash('', `${agentBrowser} stream enable --port ${streamPort}`, cwd);
            if (stale()) {
                // The screen left (or retried) while enable was in flight:
                // balance this acquisition instead of leaving a screencast on.
                void machineBash('', `${agentBrowser} stream disable`, cwd);
                return;
            }
            streamRef.current = { command: agentBrowser, cwd };
            const opened = await openTakeover({ port: streamPort, mode });
            if (stale()) {
                // Late result after retry or leaving the screen: never adopt it.
                opened.close();
                return;
            }
            closeTunnelRef.current = opened.close;
            const paint = (next: ReturnType<typeof parseStreamFrame>) => {
                if (next === undefined || stale()) return;
                if (firstFrameTimerRef.current !== undefined) clearTimeout(firstFrameTimerRef.current);
                firstFrameTimerRef.current = undefined;
                setFrame({ uri: `data:image/jpeg;base64,${next.data}`, metadata: next.metadata });
            };
            armFirstFrame(attempt);
            if (opened.stream !== undefined) {
                // Browser: frames and input ride the sealed preview channel;
                // rendering, tap mapping, and input messages below are shared.
                const stream = opened.stream;
                streamSendRef.current = (message) => stream.send(message);
                stream.onMessage((data) => paint(parseStreamFrame(data)));
                stream.onClose(() => {
                    if (stale()) return;
                    setFrame(null);
                    // Deliberate teardown nulls the sender first, as with the socket.
                    if (streamSendRef.current !== null) setError('The browser stream closed. Retry to reconnect.');
                    // An upstream death leaves the outer tunnel open but useless:
                    // close it so the relay and host reap the pair and free the
                    // port for the next device. A no-op after deliberate teardown.
                    disconnect();
                });
                return;
            }
            if (opened.wsUrl === undefined) throw new Error('The takeover stream is unavailable on this platform.');
            const socket = new WebSocket(opened.wsUrl);
            socketRef.current = socket;
            socket.onmessage = (event) => paint(parseStreamFrame(event.data));
            socket.onerror = () => { if (!stale()) setError('Could not reach the browser stream. Retry to reconnect.'); };
            socket.onclose = () => {
                if (stale()) return;
                setFrame(null);
                // A close on the live socket is never silent: deliberate
                // teardown nulls the ref first, so this only fires upstream.
                if (socketRef.current === socket) setError('The browser stream closed. Retry to reconnect.');
            };
        } catch (cause: unknown) {
            if (stale()) return;
            // This attempt failed on its own; disconnect() bumps the attempt,
            // so the failure state is settled here, not in finally.
            disconnect();
            if (mode === 'control' && isTakeoverConflict(cause)) {
                const watch = await Modal.confirm(
                    'Another device is controlling this browser',
                    'Only one device drives the stream. Watch read-only instead?',
                    { confirmText: 'Watch' },
                );
                if (superseded()) return;
                if (watch) {
                    await connect(streamPort, 'observe');
                    return;
                }
            }
            if (superseded()) return;
            setError(failureText(cause));
            setConnecting(false);
        } finally {
            if (!stale()) setConnecting(false);
        }
    }, [agentBrowser, armFirstFrame, cwd, disconnect]);

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
        operationRef.current = -1;
        disconnect();
        if (streamRef.current !== null) {
            void machineBash('', `${streamRef.current.command} stream disable`, streamRef.current.cwd);
            streamRef.current = null;
        }
    };
    React.useEffect(() => () => cleanupRef.current(), []);

    // One finger past the tap slop is a touch drag: the page gets the same
    // touchStart/touchMove/touchEnd it would from a real finger and decides
    // itself whether that scrolls or drags. Moves coalesce to one per frame.
    const flushDrag = React.useCallback(() => {
        const drag = dragRef.current;
        drag.raf = undefined;
        if (!drag.active || drag.pending === null || frame === null) return;
        send(touchMessage('touchMove', mapDisplayToInput(drag.pending, display, frame.metadata)));
        drag.pending = null;
    }, [display, frame, send]);

    const moveTouch = React.useCallback((x: number, y: number) => {
        const start = tapRef.current;
        const drag = dragRef.current;
        if (start === null || frame === null) return;
        if (!drag.active) {
            if (Math.abs(x - start.x) <= TAP_SLOP_PX && Math.abs(y - start.y) <= TAP_SLOP_PX) return;
            drag.active = true;
            send(touchMessage('touchStart', mapDisplayToInput(start, display, frame.metadata)));
        }
        drag.pending = { x, y };
        if (drag.raf === undefined) drag.raf = requestAnimationFrame(flushDrag);
    }, [display, flushDrag, frame, send]);

    const endTouch = React.useCallback(() => {
        const drag = dragRef.current;
        if (!drag.active) return false;
        if (drag.raf !== undefined) cancelAnimationFrame(drag.raf);
        drag.raf = undefined;
        drag.pending = null;
        drag.active = false;
        send(touchMessage('touchEnd'));
        return true;
    }, [send]);

    const releaseTap = React.useCallback((x: number, y: number) => {
        const start = tapRef.current;
        tapRef.current = null;
        if (endTouch()) return;
        if (start === null || frame === null) return;
        if (Math.abs(x - start.x) > TAP_SLOP_PX || Math.abs(y - start.y) > TAP_SLOP_PX) return;
        if (Date.now() - start.at > TAP_TIMEOUT_MS) return;
        const point = mapDisplayToInput({ x, y }, display, frame.metadata);
        send(touchMessage('touchStart', point));
        send(touchMessage('touchEnd'));
    }, [display, endTouch, frame, send]);

    // Wheel on web goes to the page as a wheel tick at the pointer; the page
    // scrolls or not. Native has no wheel; touch drag covers it.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || frame === null) return;
        const node = surfaceRef.current as unknown as HTMLElement | null;
        if (node === null || typeof node.addEventListener !== 'function') return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            const rect = node.getBoundingClientRect();
            const point = mapDisplayToInput({ x: event.clientX - rect.left, y: event.clientY - rect.top }, display, frame.metadata);
            send(wheelMessage(point, event.deltaX, event.deltaY));
        };
        node.addEventListener('wheel', onWheel, { passive: false });
        return () => node.removeEventListener('wheel', onWheel);
    }, [display, frame, send]);

    // Edits, not appends: whatever changed since the last committed value is
    // sent as backspaces plus retyped tail. Mid-composition text stays local
    // until the IME commits, so the page never sees half a character.
    const commitText = React.useCallback((value: string) => {
        const edits = textEdits(committedRef.current, value);
        for (let index = 0; index < edits.deletions; index += 1) {
            send(keyMessage('keyDown', 'Backspace', 'Backspace'));
            send(keyMessage('keyUp', 'Backspace', 'Backspace'));
        }
        for (const key of edits.inserted) {
            send(keyMessage('keyDown', key, codeForKey(key)));
            send(keyMessage('keyUp', key, codeForKey(key)));
        }
        // Keep the hidden field short so diffs stay cheap and nothing accumulates.
        const kept = value.length > 32 ? '' : value;
        committedRef.current = kept;
        setTyped(kept);
    }, [send]);

    const pushText = React.useCallback((value: string) => {
        if (isComposingRef.current) {
            setTyped(value);
            return;
        }
        commitText(value);
    }, [commitText, isComposingRef]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !keyboardOpen) return;
        const node = inputRef.current as unknown as HTMLInputElement | null;
        if (node === null || typeof node.addEventListener !== 'function') return;
        const onEnd = () => commitText(node.value);
        node.addEventListener('compositionend', onEnd);
        return () => node.removeEventListener('compositionend', onEnd);
    }, [commitText, keyboardOpen]);

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
            committedRef.current = '';
            inputRef.current?.focus();
            setKeyboardOpen(true);
        }
    }, [keyboardOpen]);

    const toolbar = (
        <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: theme.colors.surface }}>
            {watching ? (
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>Watching — read-only</Text>
            ) : (
                <Pressable onPress={toggleKeyboard} hitSlop={10} accessibilityRole="button" accessibilityLabel="Toggle keyboard" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name={keyboardOpen ? 'keypad' : 'keypad-outline'} size={20} color={theme.colors.text} />
                    <Text style={{ ...Typography.default(), color: theme.colors.text }}>Type</Text>
                </Pressable>
            )}
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
                // With text in the field, the diff path sends the deletion;
                // an empty field has nothing to diff, so forward it directly.
                if (nativeEvent.key === 'Backspace' && committedRef.current === '') {
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
                    ref={surfaceRef}
                    style={{ flex: 1 }}
                    onLayout={(event) => setDisplay({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={(event) => {
                        tapRef.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY, at: Date.now() };
                    }}
                    onResponderMove={(event) => moveTouch(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    onResponderRelease={(event) => releaseTap(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    onResponderTerminate={() => { tapRef.current = null; endTouch(); }}
                >
                    <Image source={{ uri: frame.uri }} accessibilityLabel="Live view of the agent's browser" style={{ flex: 1 }} resizeMode="contain" />
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
