import * as React from 'react';
import { View, Image, ActivityIndicator, Pressable, TextInput, Keyboard, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { machineBash } from '@/catalog/ops';
import { useSession, useSocketStatus } from '@/catalog/store';
import { mapDisplayToInput, type Point, type Size, type StreamFrameMetadata } from '@/takeover';
import { codeForKey, keyMessage, mouseMessage, openTakeover, parseStreamFrame, parseStreamPage, touchMessage } from '@/takeover';

function selectedPort(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/** Only a plain http(s) address is openable; anything else is dropped. */
function openableAddress(value: string | undefined): string | undefined {
    if (value === undefined || value.length > 2048 || /\s|["']/.test(value)) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

/** Shell-safe agent-browser session names only; anything else is dropped. */
function selectedSession(value: string | undefined): string | undefined {
    return value !== undefined && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

/** Reads the port out of `agent-browser stream enable --json` output. */
function parseEnablePort(stdout: string): number | undefined {
    try {
        const parsed = JSON.parse(stdout) as { port?: unknown };
        if (typeof parsed.port === 'number') return selectedPort(String(parsed.port));
    } catch {
        // Fall through to the regex for non-JSON output.
    }
    return selectedPort(/"port"\s*:\s*(\d+)/.exec(stdout)?.[1]);
}

interface LiveFrame {
    uri: string;
    metadata: StreamFrameMetadata;
}

const TAP_SLOP_PX = 12;
const TAP_TIMEOUT_MS = 400;
/** The frame visually follows the finger only this far; the scroll is committed once, on release. */
const MAX_PAN_PX = 100;
const DRAG_STEPS = 8;
const OPEN_TIMEOUT_MS = 15_000;

/**
 * What the person can be looking at: the page, the wait for it, or one of
 * three plain-language failures (no browser to open, could not reach it,
 * lost it mid-session).
 */
type Phase = 'opening' | 'live' | 'unreachable' | 'noBrowser' | 'lost';

/**
 * Live view of an agent-browser stream, tunnelled through the relay preview
 * channel. The user clears a login / 2FA / CAPTCHA wall here by touch
 * and type while the agent waits. Nothing rendered or typed is logged or persisted.
 */
export default function TakeoverScreen() {
    const { theme } = useUnistyles();
    const { id, port, session: browserSession } = useLocalSearchParams<{ id: string; port?: string; session?: string }>();
    const session = useSession(id);
    const { status } = useSocketStatus();
    const window = useWindowDimensions();
    const [phase, setPhase] = React.useState<Phase>('opening');
    const [frame, setFrame] = React.useState<LiveFrame | null>(null);
    const [pageUrl, setPageUrl] = React.useState<string | null>(null);
    // Raw shell output, kept for the Details disclosure only.
    const [detail, setDetail] = React.useState<string | null>(null);
    const [detailOpen, setDetailOpen] = React.useState(false);
    const [display, setDisplay] = React.useState<Size>({ width: 0, height: 0 });
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);
    const socketRef = React.useRef<WebSocket | null>(null);
    const closeTunnelRef = React.useRef<(() => void) | null>(null);
    const inputRef = React.useRef<TextInput>(null);
    const tapRef = React.useRef<{ x: number; y: number; at: number } | null>(null);
    // The takeover screen's scroll gesture, local-first: the frame follows
    // the finger for instant feedback, and the drag is committed to the
    // browser once, on release; the next frames confirm the real position.
    const panRef = React.useRef<{ startX: number; startY: number } | null>(null);
    const [pan, setPan] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const commitBusyRef = React.useRef(false);
    const pendingCommitRef = React.useRef<{ from: Point; to: Point } | null>(null);
    const streamRef = React.useRef<{ command: string; cwd: string } | null>(null);
    const lastPortRef = React.useRef<number | undefined>(undefined);
    const deadlineRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const gotFrameRef = React.useRef(false);
    const connectBusyRef = React.useRef(false);

    const cwd = session?.metadata?.path ?? '.';
    const sessionFlag = selectedSession(browserSession);
    const agentBrowser = sessionFlag === undefined ? 'agent-browser' : `agent-browser --session ${sessionFlag}`;
    const machineName = session?.metadata?.host ?? 'this computer';
    const agentName = session?.metadata?.name ?? 'The agent';

    const send = React.useCallback((message: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(message);
    }, []);

    const commitDrag = React.useCallback((from: Point, to: Point) => {
        pendingCommitRef.current = { from, to };
        if (commitBusyRef.current) return;
        commitBusyRef.current = true;
        void (async () => {
            while (pendingCommitRef.current !== null) {
                const drag = pendingCommitRef.current;
                pendingCommitRef.current = null;
                send(touchMessage('touchStart', drag.from));
                for (let index = 1; index <= DRAG_STEPS; index += 1) {
                    send(touchMessage('touchMove', {
                        x: Math.round(drag.from.x + (drag.to.x - drag.from.x) * index / DRAG_STEPS),
                        y: Math.round(drag.from.y + (drag.to.y - drag.from.y) * index / DRAG_STEPS),
                    }));
                    await new Promise((resolve) => setTimeout(resolve, 16));
                }
                send(touchMessage('touchEnd'));
            }
            commitBusyRef.current = false;
        })();
    }, [send]);

    const disconnect = React.useCallback(() => {
        socketRef.current?.close();
        socketRef.current = null;
        closeTunnelRef.current?.();
        closeTunnelRef.current = null;
    }, []);

    const clearDeadline = React.useCallback(() => {
        if (deadlineRef.current !== null) clearTimeout(deadlineRef.current);
        deadlineRef.current = null;
    }, []);

    // Refcounted stream lifecycle: the screen enables on mount and disables on
    // unmount, so the screencast never outlives its last watcher.
    const connect = React.useCallback(async (streamPort: number | undefined) => {
        if (connectBusyRef.current) return;
        connectBusyRef.current = true;
        try {
        disconnect();
        clearDeadline();
        if (streamRef.current !== null) {
            const prev = streamRef.current;
            streamRef.current = null;
            await machineBash('', `${prev.command} stream disable`, prev.cwd);
        }
        setDetail(null);
        setDetailOpen(false);
        setFrame(null);
        setPageUrl(null);
        gotFrameRef.current = false;
        setPhase('opening');
        try {
            let resolvedPort = streamPort;
            if (resolvedPort === undefined) {
                const enabled = await machineBash('', `${agentBrowser} stream enable --json`, cwd);
                if (!enabled.success) {
                    // No live browser (or the stream would not start): the raw
                    // output stays behind Details.
                    setDetail([enabled.stderr, enabled.stdout].filter(Boolean).join('\n') || null);
                    setPhase('noBrowser');
                    return;
                }
                resolvedPort = parseEnablePort(enabled.stdout);
                if (resolvedPort === undefined) {
                    void machineBash('', `${agentBrowser} stream disable`, cwd);
                    setPhase('unreachable');
                    return;
                }
            } else {
                const enabled = await machineBash('', `${agentBrowser} stream enable --port ${resolvedPort}`, cwd);
                if (!enabled.success) {
                    setDetail([enabled.stderr, enabled.stdout].filter(Boolean).join('\n') || null);
                    setPhase('noBrowser');
                    return;
                }
            }
            lastPortRef.current = resolvedPort;
            streamRef.current = { command: agentBrowser, cwd };
            // Size the watched browser to this phone so frames arrive readable
            // instead of a desktop viewport letterboxed into a hand-sized pane.
            const viewportWidth = Math.max(320, Math.min(768, Math.round(window.width)));
            const viewportHeight = Math.max(480, Math.min(1280, Math.round(window.height) - 64));
            await machineBash('', `${agentBrowser} set viewport ${viewportWidth} ${viewportHeight}`, cwd);
            const opened = await openTakeover({ port: resolvedPort });
            closeTunnelRef.current = opened.close;
            const socket = new WebSocket(opened.wsUrl);
            socketRef.current = socket;
            // The wait is bounded: if no picture has arrived when the deadline
            // fires, say so instead of spinning forever.
            deadlineRef.current = setTimeout(() => {
                if (socketRef.current === socket) {
                    disconnect();
                    setPhase('unreachable');
                }
            }, OPEN_TIMEOUT_MS);
            socket.onmessage = (event) => {
                const next = parseStreamFrame(event.data);
                if (next === undefined) return;
                clearDeadline();
                gotFrameRef.current = true;
                setFrame({ uri: `data:image/jpeg;base64,${next.data}`, metadata: next.metadata });
                setPhase('live');
                const page = parseStreamPage(event.data);
                if (page !== undefined) setPageUrl(page.url);
            };
            socket.onerror = () => {
                if (socketRef.current !== socket) return;
                disconnect();
                clearDeadline();
                setFrame(null);
                setPageUrl(null);
                setPhase(gotFrameRef.current ? 'lost' : 'unreachable');
            };
            socket.onclose = () => {
                // A close on the live socket is never silent: deliberate
                // teardown nulls the ref first, so this only fires upstream.
                if (socketRef.current !== socket) return;
                setFrame(null);
                setPageUrl(null);
                clearDeadline();
                setPhase(gotFrameRef.current ? 'lost' : 'unreachable');
            };
        } catch (cause: unknown) {
            disconnect();
            setDetail(cause instanceof Error ? cause.message : String(cause));
            setPhase('unreachable');
        }
        } finally {
            connectBusyRef.current = false;
        }
    }, [agentBrowser, clearDeadline, cwd, disconnect, window.width, window.height]);

    const openBrowser = React.useCallback(async () => {
        // A browser this screen can show: open one, then come back through the
        // normal path so every failure keeps one wording.
        const opened = await machineBash('', `${agentBrowser} open`, cwd);
        if (!opened.success) {
            setDetail([opened.stderr, opened.stdout].filter(Boolean).join('\n') || 'Could not open a browser.');
            setDetailOpen(true);
            return;
        }
        await connect(undefined);
    }, [agentBrowser, connect, cwd]);

    // First entry: an explicit port in the URL wins (deep links), otherwise the
    // screen finds the running stream itself.
    const attempted = React.useRef<string | undefined>(undefined);
    const directPort = selectedPort(port);
    React.useEffect(() => {
        if (status !== 'connected' || session === undefined) return;
        const key = `${id}:${directPort ?? 'auto'}`;
        if (attempted.current === key) return;
        attempted.current = key;
        void connect(directPort);
    }, [connect, directPort, id, session, status]);

    // Unmount only: close the stream and drop the enable refcount when a
    // stream was actually enabled by this screen.
    const cleanupRef = React.useRef<() => void>(() => {});
    cleanupRef.current = () => {
        disconnect();
        clearDeadline();
        if (streamRef.current !== null) {
            void machineBash('', `${streamRef.current.command} stream disable`, streamRef.current.cwd);
            streamRef.current = null;
        }
    };
    React.useEffect(() => () => cleanupRef.current(), []);

    const moveDrag = React.useCallback((x: number, y: number) => {
        const start = tapRef.current;
        if (start === null || frame === null) return;
        if (panRef.current === null) {
            if (Math.abs(x - start.x) <= TAP_SLOP_PX && Math.abs(y - start.y) <= TAP_SLOP_PX) return;
            panRef.current = { startX: start.x, startY: start.y };
        }
        setPan({
            x: Math.max(-MAX_PAN_PX, Math.min(MAX_PAN_PX, x - start.x)),
            y: Math.max(-MAX_PAN_PX, Math.min(MAX_PAN_PX, y - start.y)),
        });
    }, [frame]);

    const releaseTap = React.useCallback((x: number, y: number) => {
        const start = tapRef.current;
        tapRef.current = null;
        if (start === null || frame === null) return;
        if (panRef.current !== null) {
            panRef.current = null;
            setPan({ x: 0, y: 0 });
            commitDrag(mapDisplayToInput({ x: start.x, y: start.y }, display, frame.metadata), mapDisplayToInput({ x, y }, display, frame.metadata));
            return;
        }
        if (Math.abs(x - start.x) > TAP_SLOP_PX || Math.abs(y - start.y) > TAP_SLOP_PX) return;
        if (Date.now() - start.at > TAP_TIMEOUT_MS) return;
        const point = mapDisplayToInput({ x, y }, display, frame.metadata);
        send(touchMessage('touchStart', point));
        send(touchMessage('touchEnd'));
    }, [commitDrag, display, frame, send]);

    const typedRef = React.useRef('');
    const suppressBackspaceRef = React.useRef(false);
    const pushText = React.useCallback((value: string) => {
        const previous = [...typedRef.current];
        const current = [...value];
        let common = 0;
        while (common < previous.length && common < current.length && previous[common] === current[common]) common += 1;
        typedRef.current = value;
        suppressBackspaceRef.current = previous.length - common > 0 && value.length === 0;
        for (let index = 0; index < previous.length - common; index += 1) {
            send(keyMessage('keyDown', 'Backspace', 'Backspace'));
            send(keyMessage('keyUp', 'Backspace', 'Backspace'));
        }
        for (let index = common; index < current.length; index += 1) {
            const key = current[index];
            send(keyMessage('keyDown', key, codeForKey(key)));
            send(keyMessage('keyUp', key, codeForKey(key)));
        }
    }, [send]);

    const saveState = React.useCallback(async () => {
        const accepted = await Modal.confirm(
            `Remember this login on ${machineName}?`,
            "Saves the site's cookies on your computer so the agent doesn't hit this sign-in again. Only you can read the file.",
            { confirmText: 'Remember' },
        );
        if (!accepted) return;
        const name = `takeover-${Date.now()}.json`;
        const result = await machineBash('', `${agentBrowser} state save ${name} && chmod 600 "$HOME/.agent-browser/sessions/${name}"`, cwd);
        if (!result.success) Modal.alert("Couldn't remember this login", result.stderr || result.stdout);
    }, [agentBrowser, cwd, machineName]);

    const navigateStream = React.useCallback((button: 'back' | 'forward') => {
        send(mouseMessage('mousePressed', { x: 0, y: 0 }, button));
        send(mouseMessage('mouseReleased', { x: 0, y: 0 }, button));
    }, [send]);

    const openAddress = React.useCallback(async () => {
        const entered = await Modal.prompt('Open address', 'Navigate the watched browser to a web address.', { placeholder: 'https://…', confirmText: 'Open' });
        const url = openableAddress(entered ?? undefined);
        if (url === undefined) return;
        const result = await machineBash('', `${agentBrowser} open '${url}'`, cwd);
        if (!result.success) Modal.alert('Could not open the address', result.stderr || result.stdout);
    }, [agentBrowser, cwd]);

    const toggleKeyboard = React.useCallback(() => {
        if (keyboardOpen) {
            typedRef.current = '';
            suppressBackspaceRef.current = false;
            inputRef.current?.clear();
            Keyboard.dismiss();
            setKeyboardOpen(false);
        } else {
            typedRef.current = '';
            suppressBackspaceRef.current = false;
            inputRef.current?.focus();
            setKeyboardOpen(true);
        }
    }, [keyboardOpen]);

    const toolbar = (
        <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: theme.colors.surface }}>
            <Pressable onPress={() => navigateStream('back')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Browser back">
                <Ionicons name="arrow-back" size={20} color={theme.colors.text} />
            </Pressable>
            <Pressable onPress={() => navigateStream('forward')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Browser forward">
                <Ionicons name="arrow-forward" size={20} color={theme.colors.text} />
            </Pressable>
            <Pressable onPress={toggleKeyboard} hitSlop={10} accessibilityRole="button" accessibilityLabel="Keyboard" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name={keyboardOpen ? 'keypad' : 'keypad-outline'} size={20} color={theme.colors.text} />
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => void openAddress()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Open address" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} disabled={status !== 'connected'}>
                <Ionicons name="globe-outline" size={20} color={theme.colors.text} />
            </Pressable>
            <Pressable onPress={() => void saveState()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Remember login" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="key-outline" size={20} color={theme.colors.text} />
                <Text style={{ ...Typography.default(), color: theme.colors.text }}>Remember login</Text>
            </Pressable>
        </View>
    );

    const hiddenInput = (
        <TextInput
            ref={inputRef}
            onChangeText={pushText}
            onKeyPress={({ nativeEvent }) => {
                if (nativeEvent.key === 'Backspace' && typedRef.current === '') {
                    if (suppressBackspaceRef.current) suppressBackspaceRef.current = false;
                    else {
                        send(keyMessage('keyDown', 'Backspace', 'Backspace'));
                        send(keyMessage('keyUp', 'Backspace', 'Backspace'));
                    }
                }
            }}
            onSubmitEditing={() => {
                send(keyMessage('keyDown', 'Enter', 'Enter'));
                send(keyMessage('keyUp', 'Enter', 'Enter'));
            }}
            onBlur={() => {
                typedRef.current = '';
                suppressBackspaceRef.current = false;
                inputRef.current?.clear();
                setKeyboardOpen(false);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            blurOnSubmit={false}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
            accessibilityLabel="Keyboard input"
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
                        panRef.current = null;
                        setPan({ x: 0, y: 0 });
                        tapRef.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY, at: Date.now() };
                    }}
                    onResponderMove={(event) => moveDrag(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    onResponderRelease={(event) => releaseTap(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                    onResponderTerminate={() => {
                        tapRef.current = null;
                        panRef.current = null;
                        setPan({ x: 0, y: 0 });
                    }}
                >
                    <Image source={{ uri: frame.uri }} style={{ flex: 1, transform: [{ translateX: pan.x }, { translateY: pan.y }] }} resizeMode="contain" />
                </View>
                {pageUrl !== null && (
                    <Text numberOfLines={1} style={{ ...Typography.default(), fontSize: 11, color: theme.colors.textSecondary, paddingHorizontal: 16, paddingBottom: 8, backgroundColor: theme.colors.surface }}>{pageUrl}</Text>
                )}
                {toolbar}
                {hiddenInput}
            </View>
        );
    }

    const retry = () => void connect(lastPortRef.current);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, padding: 16, gap: 12 }}>
            {phase === 'opening' && (
                <View style={{ alignItems: 'center', paddingVertical: 24, gap: 12 }}>
                    <ActivityIndicator size="small" color={theme.colors.text} />
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>Opening…</Text>
                </View>
            )}

            {phase === 'noBrowser' && (
                <View style={{ alignItems: 'center', paddingVertical: 24, gap: 16 }}>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>
                        {agentName} hasn't opened a browser.
                    </Text>
                    <Pressable onPress={() => void openBrowser()} accessibilityRole="button" accessibilityLabel="Open a browser" style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: theme.colors.surface }}>
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Open one</Text>
                    </Pressable>
                </View>
            )}

            {phase === 'unreachable' && (
                <View style={{ alignItems: 'center', paddingVertical: 24, gap: 16 }}>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>
                        Couldn't reach the browser on {machineName}.
                    </Text>
                    <Pressable onPress={retry} accessibilityRole="button" accessibilityLabel="Try again" style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: theme.colors.surface }}>
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Try again</Text>
                    </Pressable>
                </View>
            )}

            {phase === 'lost' && (
                <View style={{ alignItems: 'center', paddingVertical: 24, gap: 16 }}>
                    <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center' }}>
                        Lost the browser.
                    </Text>
                    <Pressable onPress={retry} accessibilityRole="button" accessibilityLabel="Reconnect" style={{ paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: theme.colors.surface }}>
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Reconnect</Text>
                    </Pressable>
                </View>
            )}

            {detail !== null && (
                <View style={{ gap: 4 }}>
                    <Pressable
                        onPress={() => setDetailOpen(!detailOpen)}
                        accessibilityRole="button"
                        accessibilityLabel={detailOpen ? 'Hide details' : 'Show details'}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 }}
                    >
                        <Ionicons name={detailOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={theme.colors.textSecondary} />
                        <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>Details</Text>
                    </Pressable>
                    {detailOpen && (
                        <Text selectable style={{ ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12 }}>
                            {detail}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
