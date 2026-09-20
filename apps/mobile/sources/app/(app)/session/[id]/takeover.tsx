import * as React from 'react';
import { View, Image, ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, Keyboard, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { cardStyle, ui } from '@/components/ui';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { machineBash } from '@/catalog/ops';
import { useHerdrTree, useSession, useSocketStatus } from '@/catalog/store';
import { agentLabels, herdrPaneForSession, isShellLabels, middleTruncate } from '@/herd';
import { t } from '@/text';
import { mapDisplayToInput, resolveStreamPort, type Point, type Size, type StreamFrameMetadata } from '@/takeover';
import { codeForKey, keyMessage, missingBrowserBinary, mouseMessage, openTakeover, parseStreamFrame, parseStreamPage, touchMessage } from '@/takeover';

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
 * What the person can be looking at: the page, the wait for the connection
 * or for the page, or one of five plain-language failures (no browser to
 * open, no driver to open one with, could not reach it, lost it mid-session,
 * could not open one).
 */
type Phase = 'waiting' | 'opening' | 'live' | 'unreachable' | 'noBrowser' | 'noDriver' | 'lost' | 'openFailed';

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
    const { workspaces } = useHerdrTree();
    const window = useWindowDimensions();
    const keyboard = useKeyboardState();
    const [phase, setPhase] = React.useState<Phase>('waiting');
    const [frame, setFrame] = React.useState<LiveFrame | null>(null);
    const [pageUrl, setPageUrl] = React.useState<string | null>(null);
    // Raw shell output, kept for the Details disclosure only.
    const [detail, setDetail] = React.useState<string | null>(null);
    const [detailOpen, setDetailOpen] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
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
    const mountedRef = React.useRef<boolean>(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);

    // The pane says whose browser this is and what the agent is doing there;
    // a shell pane or no pane at all stays nameless.
    const pane = herdrPaneForSession(workspaces, id);
    const paneLabels = agentLabels(pane);
    const cwd = session?.metadata?.path ?? '.';
    const sessionFlag = selectedSession(browserSession);
    const agentBrowser = sessionFlag === undefined ? 'agent-browser' : `agent-browser --session ${sessionFlag}`;
    const machineName = session?.metadata?.host ?? 'this computer';
    const agentName = isShellLabels(paneLabels) ? 'The agent' : paneLabels.agentName;

    const pageHost = React.useMemo(() => {
        if (pageUrl === null) return undefined;
        try {
            return new URL(pageUrl).hostname || undefined;
        } catch {
            return undefined;
        }
    }, [pageUrl]);

    // Status line words (one surface, decided): the pane lifecycle says what
    // the agent is doing, the active URL says where. Dots are decorative.
    const paneStatus = pane?.agentStatus;
    const statusSentence = paneStatus === 'working' || paneStatus === 'starting'
        ? t('browser.statusBrowsing', { agent: agentName })
        : paneStatus === 'blocked'
            ? t('browser.statusWaitingForYou', { agent: agentName })
            : paneStatus === 'failed'
                ? t('browser.statusStopped', { agent: agentName })
                : undefined;
    const statusDot = paneStatus === 'working' || paneStatus === 'starting'
        ? theme.colors.status.working
        : paneStatus === 'blocked' || paneStatus === 'failed'
            ? theme.colors.status.error
            : undefined;
    const statusLineView = (
        <View
            accessibilityLiveRegion="polite"
            style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, backgroundColor: theme.colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider }}
        >
            {statusDot !== undefined && <StatusDot color={statusDot} isPulsing={paneStatus === 'working' || paneStatus === 'starting'} />}
            <Text numberOfLines={1} style={{ ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.text, flex: 1 }}>
                {statusSentence !== undefined
                    ? <>{statusSentence}{pageHost !== undefined && <Text style={{ color: theme.colors.textSecondary }}>{` · ${middleTruncate(pageHost, 32)}`}</Text>}</>
                    : pageHost !== undefined
                        ? pageHost
                        : t('browser.statusIdleBrowser', { agent: agentName })}
            </Text>
        </View>
    );

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

    // The screen disables on unmount only a stream it enabled itself; a
    // reattached one belongs to its other watchers and stays up.
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
            const stream = await resolveStreamPort((command) => machineBash('', command, cwd), agentBrowser, streamPort);
            if (stream.kind === 'noBrowser') {
                // No live browser (or the stream would not start): the raw
                // output stays behind Details.
                setDetail(stream.detail);
                setPhase('noBrowser');
                return;
            }
            if (stream.kind === 'noDriver') {
                // The computer has no agent-browser to open anything with;
                // the raw shell error stays behind Details.
                setDetail(stream.detail);
                setPhase('noDriver');
                return;
            }
            if (stream.kind === 'unreachable') {
                void machineBash('', `${agentBrowser} stream disable`, cwd);
                setPhase('unreachable');
                return;
            }
            const resolvedPort = stream.port;
            lastPortRef.current = resolvedPort;
            if (!mountedRef.current) {
                if (stream.owned) await machineBash('', `${agentBrowser} stream disable`, cwd);
                return;
            }
            if (stream.owned) streamRef.current = { command: agentBrowser, cwd };
            // Size the watched browser to this phone so frames arrive readable
            // instead of a desktop viewport letterboxed into a hand-sized pane.
            const viewportWidth = Math.max(320, Math.min(768, Math.round(window.width)));
            const viewportHeight = Math.max(480, Math.min(1280, Math.round(window.height) - 64));
            await machineBash('', `${agentBrowser} set viewport ${viewportWidth} ${viewportHeight}`, cwd);
            const opened = await openTakeover({ port: resolvedPort });
            closeTunnelRef.current = opened.close;
            const socket = new WebSocket(opened.wsUrl);
            socketRef.current = socket;
            if (!mountedRef.current) {
                disconnect();
                if (streamRef.current !== null) {
                    const prev = streamRef.current;
                    streamRef.current = null;
                    await machineBash('', `${prev.command} stream disable`, prev.cwd);
                }
                return;
            }
            // The wait is bounded: if no picture has arrived when the deadline
            // fires, say so instead of spinning forever.
            deadlineRef.current = setTimeout(() => {
                if (socketRef.current === socket) {
                    disconnect();
                    setPhase('unreachable');
                }
            }, OPEN_TIMEOUT_MS);
            socket.onmessage = (event) => {
                // The tabs message rides its own frame; parse it before the
                // frame check or the status line never learns the host.
                const page = parseStreamPage(event.data);
                if (page !== undefined) setPageUrl(page.url);
                const next = parseStreamFrame(event.data);
                if (next === undefined) return;
                clearDeadline();
                gotFrameRef.current = true;
                setFrame({ uri: `data:image/jpeg;base64,${next.data}`, metadata: next.metadata });
                setPhase('live');
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
            if (!mountedRef.current) {
                if (streamRef.current !== null) {
                    const prev = streamRef.current;
                    streamRef.current = null;
                    await machineBash('', `${prev.command} stream disable`, prev.cwd);
                }
                return;
            }
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
            setPhase('openFailed');
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
        const entered = await Modal.prompt(t('browser.goTo'), undefined, { placeholder: t('browser.goToPlaceholder'), confirmText: t('browser.goToConfirm') });
        const value = (entered ?? '').trim();
        if (value === '') return;
        // A bare host ("github.com") gets https:// before the openable check.
        const url = openableAddress(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
        if (url === undefined) return;
        const result = await machineBash('', `${agentBrowser} open '${url}'`, cwd);
        if (!result.success) Modal.alert(t('browser.goToFailed'), result.stderr || result.stdout);
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

    const streamDown = status !== 'connected';
    const toolbarTarget = { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const };
    const toolbar = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, backgroundColor: theme.colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
            <Pressable onPress={() => navigateStream('back')} disabled={streamDown} accessibilityRole="button" accessibilityLabel="Browser back" style={[toolbarTarget, streamDown && { opacity: 0.4 }]}>
                <Ionicons name="arrow-back" size={20} color={theme.colors.text} />
            </Pressable>
            <Pressable onPress={() => navigateStream('forward')} disabled={streamDown} accessibilityRole="button" accessibilityLabel="Browser forward" style={[toolbarTarget, streamDown && { opacity: 0.4 }]}>
                <Ionicons name="arrow-forward" size={20} color={theme.colors.text} />
            </Pressable>
            <Pressable onPress={toggleKeyboard} disabled={streamDown} accessibilityRole="button" accessibilityLabel="Keyboard" style={[toolbarTarget, streamDown && { opacity: 0.4 }]}>
                <Ionicons name={keyboardOpen ? 'keypad' : 'keypad-outline'} size={20} color={theme.colors.text} />
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => void openAddress()} disabled={streamDown} accessibilityRole="button" accessibilityLabel="Go to" style={[toolbarTarget, streamDown && { opacity: 0.4 }]}>
                <Ionicons name="globe-outline" size={20} color={theme.colors.text} />
            </Pressable>
            <Pressable
                onPress={() => void saveState()}
                disabled={streamDown}
                accessibilityRole="button"
                accessibilityLabel="Remember login"
                style={({ pressed }) => [
                    { flexDirection: 'row', alignItems: 'center', gap: 6, height: 44, paddingHorizontal: 12, borderRadius: ui.radius.control },
                    pressed && { backgroundColor: theme.colors.surfacePressed },
                    streamDown && { opacity: 0.4 },
                ]}
            >
                <Ionicons name="key-outline" size={20} color={theme.colors.text} />
                <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text }}>Remember login</Text>
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
            <View style={{ flex: 1, backgroundColor: '#000', paddingBottom: keyboard.isVisible ? keyboard.height : 0 }}>
                {statusLineView}
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
                    accessible
                    accessibilityLabel={`${agentName}'s browser page`}
                    accessibilityHint="Tap and drag to use the page; the keyboard button types into it."
                >
                    <Image source={{ uri: frame.uri }} style={{ flex: 1, transform: [{ translateX: pan.x }, { translateY: pan.y }] }} resizeMode="contain" />
                </View>
                {toolbar}
                {hiddenInput}
            </View>
        );
    }

    const retry = () => void connect(lastPortRef.current);
    const tryOpenBrowser = () => void openBrowser();
    const waitingForConnection = phase === 'opening' || phase === 'waiting';
    // A missing driver or browser is fixed once on the computer, not from
    // here: show the install command with a copy button instead of a button
    // that would only fail the same way again.
    const installCommand = phase === 'noDriver'
        ? 'npm install -g agent-browser && agent-browser install --with-deps'
        : phase === 'openFailed' && detail !== null && missingBrowserBinary(detail)
            ? 'agent-browser install --with-deps'
            : undefined;
    const errorTitle = phase === 'noBrowser'
        ? `${agentName} hasn't opened a browser.`
        : phase === 'noDriver'
            ? t('browser.noDriverTitle', { machine: machineName })
            : phase === 'unreachable'
                ? `Couldn't reach the browser on ${machineName}.`
                : phase === 'lost'
                    ? 'Lost the browser.'
                    : phase === 'openFailed'
                        ? t('browser.openFailedTitle', { machine: machineName })
                        : undefined;
    const errorBody = phase === 'lost'
        ? t('browser.lostBody', { machine: machineName })
        : phase === 'noDriver'
            ? t('browser.noDriverBody')
            : installCommand !== undefined
                ? t('browser.installBody', { machine: machineName })
                : undefined;
    const errorAction = errorTitle === undefined || installCommand !== undefined ? undefined : {
        label: phase === 'noBrowser' ? 'Open one' : phase === 'lost' ? 'Reconnect' : 'Try again',
        onPress: phase === 'noBrowser' || phase === 'openFailed' ? tryOpenBrowser : retry,
    };

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
            <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 48, gap: 12 }}>
                {waitingForConnection && (
                    <>
                        <ActivityIndicator size="small" color={theme.colors.text} />
                        <Text style={{ ...Typography.default(), fontSize: 15, lineHeight: 21, color: theme.colors.textSecondary, textAlign: 'center' }}>
                            {phase === 'opening' ? 'Opening…' : t('browser.waitingForConnection', { machine: machineName })}
                        </Text>
                    </>
                )}
                {errorTitle !== undefined && (
                    <Text numberOfLines={3} style={{ ...Typography.default('semiBold'), fontSize: 17, lineHeight: 22, color: theme.colors.text, textAlign: 'center' }}>
                        {errorTitle}
                    </Text>
                )}
                {errorBody !== undefined && (
                    <Text style={{ ...Typography.default(), fontSize: 15, lineHeight: 21, color: theme.colors.textSecondary, textAlign: 'center' }}>
                        {errorBody}
                    </Text>
                )}
                {errorAction !== undefined && (
                    <Pressable
                        onPress={errorAction.onPress}
                        accessibilityRole="button"
                        accessibilityLabel={errorAction.label}
                        style={{ height: 44, minWidth: 140, paddingHorizontal: 20, borderRadius: ui.radius.control, backgroundColor: theme.colors.button.primary.background, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Text style={{ ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.button.primary.tint }}>{errorAction.label}</Text>
                    </Pressable>
                )}
                {installCommand !== undefined && (
                    <View style={[cardStyle(theme), { alignSelf: 'stretch', marginHorizontal: 24, padding: 12, gap: 10 }]}>
                        <Text selectable style={{ ...Typography.mono(), fontSize: 12, lineHeight: 18, color: theme.colors.text }}>
                            {installCommand}
                        </Text>
                        <Pressable
                            onPress={() => {
                                void Clipboard.setStringAsync(installCommand)
                                    .then(() => setCopied(true))
                                    .catch(() => Modal.alert(t('browser.copyFailedTitle'), t('browser.copyFailedBody')));
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={copied ? t('browser.copied') : t('browser.copyCommand')}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, alignSelf: 'flex-start', paddingHorizontal: 12, borderRadius: ui.radius.control, backgroundColor: theme.colors.surfacePressed }}
                        >
                            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={theme.colors.text} />
                            <Text style={{ ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text }}>
                                {copied ? t('browser.copied') : t('browser.copyCommand')}
                            </Text>
                        </Pressable>
                    </View>
                )}
                {detail !== null && (
                    <>
                        <Pressable
                            onPress={() => setDetailOpen(!detailOpen)}
                            accessibilityRole="button"
                            accessibilityLabel={detailOpen ? 'Hide details' : 'Show details'}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 44, paddingHorizontal: 8 }}
                        >
                            <Ionicons name={detailOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={theme.colors.textSecondary} />
                            <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary }}>Details</Text>
                        </Pressable>
                        {detailOpen && (
                            <View style={[cardStyle(theme), { alignSelf: 'stretch', padding: 12, maxHeight: '40%' }]}>
                                <ScrollView>
                                    <Text selectable style={{ ...Typography.mono(), fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary }}>
                                        {detail}
                                    </Text>
                                </ScrollView>
                            </View>
                        )}
                    </>
                )}
            </View>
        </View>
    );
}
