import * as React from 'react';
import { ActivityIndicator, AppState, BackHandler, Dimensions, Platform, Pressable, StyleSheet, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useKeyboardState, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { DesktopView, observeWebKeyboardMotion, useDesktopSession } from '@desklink/react-native';
import { DESKTOP_CONSENT_WAIT_MS } from '@trymuxr/contract';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ui } from '@/components/ui';
import { sync } from '@/catalog';
import { useLocalSettingMutable, useMachine } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { hapticsSelection } from '@/components/haptics';
import { claimDesktopRequest, peekDesktopRequest, previewDocks, requestDesktop } from '../request';
import { createDesktopSignaling } from '../application/desktopSignaling';
import { desktopCopy, previewCopy, previewIcon } from '../model/desktopCopy';
import { describeDesktopFailureDetail, describeDesktopOverlay, describeInputRejection, describePreviewOverlay, type PreviewKind } from '../model/desktopOverlay';
import { DESKTOP_KEY_ROW_HEIGHT, DesktopKeyRow } from './DesktopKeyRow';

/** Request smoother motion than the engine's default; still frames are not repeated. */
const DESKTOP_FPS = 60;

/** How long a notice stays over the desktop before it gets out of the way. */
const NOTICE_MS = 4000;

/** The first live desktop on a device explains its gestures once, for longer. */
const HINT_MS = 7000;

/** An open that has not answered by now is waiting on a person at the computer. */
const CONSENT_HINT_AFTER_MS = 2000;

/** The two round controls: a thumb's size, in the terminal's floating material. */
const BUTTON = 44;
/** From the screen's sides. */
const EDGE = 16;
/** Above the home indicator while the keyboard is down. */
const REST_GAP = 12;
/** Between the round controls and the key row riding on the keyboard. */
const ABOVE_KEYS = 8;
/** Between the picture and the round controls while the keyboard is up. */
const PICTURE_GAP = 8;

type DesktopPermission = 'view' | 'control' | 'clipboard';
type Menu = 'clipboard' | 'help' | 'more';

/** What each gesture does, for the help the header's "?" opens. */
const GESTURES: readonly [gesture: string, effect: string][] = [
    ['Tap', 'Click'],
    ['Double-tap', 'Double-click'],
    ['Hold', 'Right-click'],
    ['Hold and drag', 'Select or drag'],
    ['Two fingers', 'Scroll'],
    ['Pinch', 'Zoom'],
    ['Drag', 'Move around when zoomed'],
    ['Drag on the whole desktop', 'Move the pointer'],
];

/** A device preview takes touch like a phone: an emulator and a simulator alike. */
const PREVIEW_GESTURES: Record<PreviewKind, readonly [gesture: string, effect: string][]> = {
    android: [['Tap', 'Tap'], ['Drag', 'Swipe'], ['Hold', 'Long press'], ['Pinch', 'Zoom']],
    ios: [['Tap', 'Tap'], ['Drag', 'Swipe'], ['Hold', 'Long press'], ['Pinch', 'Zoom']],
};

type Icon = React.ComponentProps<typeof Ionicons>['name'];

/**
 * The toolbar's keys, sent as key presses and mapped by the host to device
 * keys (a headless emulator included).
 */
const PREVIEW_KEYS: Record<PreviewKind, readonly { label: string; icon: Icon; name?: string; character?: string; modifiers: string[] }[]> = {
    android: [
        { label: 'Back', icon: 'caret-back-outline', name: 'Backspace', modifiers: ['Control'] },
        { label: 'Home', icon: 'ellipse-outline', character: 'h', modifiers: ['Control'] },
        { label: 'Recents', icon: 'square-outline', character: 'o', modifiers: ['Control'] },
    ],
    // The simulator's Home button; the host maps the same chord.
    ios: [
        { label: 'Home', icon: 'ellipse-outline', character: 'h', modifiers: ['Control'] },
    ],
};

/** The toolbar's discs and the band they sit in, above the home indicator. */
const DISC = 40;
const TOOLBAR = DISC + 16;

/** Growing out of the chip that opened it. Mass is explicit: Reanimated 4's default of 4 overshoots by a quarter. */
const GROW_SPRING = { damping: 26, stiffness: 260, mass: 1 };

/** Expo reports a blocked browser clipboard read as ERR_NO_PERMISSION. */
function describeClipboardError(error: unknown, fallback: string): string {
    const refused = error as { code?: unknown } | null;
    if (refused?.code === 'ERR_NO_PERMISSION') return desktopCopy.clipboardBlocked;
    return error instanceof Error ? error.message : fallback;
}

export interface DesktopSurfaceProps {
    sessionId: string;
    onExit: () => void;
    /** The conversation the desktop was opened from; the computer's name without one. */
    title?: string;
    /** The conversation's mark, drawn before the title the way its own header draws it. */
    leading?: React.ReactNode;
    /**
     * Show the session's preview — the emulator or claimed simulator its agent is
     * showing — instead of this computer's desktop. `closed` once the agent's
     * device is gone; the title is the device or simulator name.
     */
    target?: { sessionId: string; kind: PreviewKind; title?: string; closed?: boolean; viewOnly?: boolean };
}

/**
 * The keyboard's offset (negative while it is up) and how far up it is, as
 * values the UI thread moves with it. A phone browser reports neither: there
 * the visual viewport says how much of the page the keyboard covers.
 */
function useKeyboardMotion(): { height: SharedValue<number>; progress: SharedValue<number>; visible: boolean } {
    const native = useReanimatedKeyboardAnimation();
    const height = useSharedValue(0);
    const progress = useSharedValue(0);
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        return observeWebKeyboardMotion(({ covered, phase }) => {
            height.value = -covered;
            progress.value = phase;
            setVisible(covered > 0);
        });
    }, [height, progress]);
    return Platform.OS === 'web' ? { height, progress, visible } : { ...native, visible: false };
}

/**
 * The live desktop, inside the conversation.
 *
 * The screen is the desktop: fitted to the width on black, under the
 * conversation's own header line. Two round controls float in the bottom
 * corners, for what a phone cannot do with the desktop's own hands — the
 * clipboard, both ways, and the keyboard. With the keyboard up, the key row a
 * phone keyboard lacks rides on it, the controls above that, and the picture
 * moves up to sit over all of them with the pointer still in sight.
 */
export function DesktopSurface(props: DesktopSurfaceProps) {
    const { width } = useWindowDimensions();
    const docked = props.target !== undefined && previewDocks(Platform.OS === 'web', width);
    // Docked beside the conversation, the panel's chrome is the app's own
    // theme; over the conversation it is the terminal's dark. One ScopedTheme
    // element renders for both, so crossing the web width that docks swaps
    // only its theme and the live view under it never remounts.
    return (
        <ScopedTheme {...(docked ? { reset: true } : { name: 'dark' as const })}>
            <DesktopSurfaceBody {...props} docked={docked} />
        </ScopedTheme>
    );
}

function DesktopSurfaceBody({ sessionId, onExit, title, leading, target, docked }: DesktopSurfaceProps & { docked: boolean }) {
    const { theme } = useUnistyles();
    const preview = target !== undefined;
    // Only read on the preview path, where the target always names its kind.
    const kind: PreviewKind = target?.kind ?? 'android';
    const closed = target?.closed === true;
    const targetSession = target?.sessionId;
    // A phone paired to watch sees an agent's device preview but never drives it.
    const viewOnly = target?.viewOnly === true;
    const viewOnlyRef = React.useRef(viewOnly);
    viewOnlyRef.current = viewOnly;
    const [clipboardBusy, setClipboardBusy] = React.useState(false);
    const [notice, setNotice] = React.useState<{ text: string; ms: number } | null>(null);
    const [keyboardOpen, setKeyboardOpen] = React.useState(false);
    const [clipboardAvailable, setClipboardAvailable] = React.useState(false);
    const [openSentAt, setOpenSentAt] = React.useState<number | null>(null);
    const [menu, setMenu] = React.useState<Menu | null>(null);
    const [landscape, setLandscape] = React.useState(false);
    const keyboard = useKeyboardState();
    const motion = useKeyboardMotion();
    const insets = useSafeAreaInsets();
    const { width: windowWidth } = useWindowDimensions();
    const [openedBefore, setOpenedBefore] = useLocalSettingMutable('desktopOpenedBefore');
    const machine = useMachine(getCachedConnectionSettings().machineId ?? '');
    const computerName = machine?.metadata?.displayName || machine?.metadata?.host || 'Computer';
    const heading = title || computerName;

    const say = React.useCallback((text: string, ms = NOTICE_MS) => setNotice({ text, ms }), []);
    const [commandCopied, setCommandCopied] = React.useState(false);
    const copyCommand = React.useCallback(async (command: string) => {
        await Clipboard.setStringAsync(command);
        setCommandCopied(true);
        setTimeout(() => setCommandCopied(false), 2000);
    }, []);

    const session = useDesktopSession({
        // Ask the host what it can actually do before requesting scope: a host
        // whose clipboard backend is absent must not be asked for a permission
        // whose every use would fail. The picture's size is the engine's to
        // choose: the desktop's own pixels, so zooming stays sharp.
        authorize: React.useCallback(async () => {
            const scope = targetSession === undefined ? {} : { target: { sessionId: targetSession } };
            const capabilities = await sync.request('desktop.capabilities', scope).catch(() => null);
            const canClipboard = capabilities?.clipboard === true && !viewOnlyRef.current;
            setClipboardAvailable(canClipboard);
            const permissions: DesktopPermission[] = viewOnlyRef.current ? ['view']
                : canClipboard ? ['view', 'control', 'clipboard']
                : ['view', 'control'];
            return {
                signaling: createDesktopSignaling({ permissions, maxFps: DESKTOP_FPS, onOpenSent: () => setOpenSentAt(Date.now()), ...scope }),
                session: { permissions },
            };
        }, [targetSession]),
        onError: (failure) => say(describeDesktopFailureDetail(failure)),
        // Text the desktop refused is a notice, not a failure: the session
        // carries on, and the clipboard is the way round.
        onRejected: ({ code }) => {
            const message = describeInputRejection(code, clipboardAvailable);
            if (message !== null) say(message);
        },
    });

    const { connect, close, snapshot, releaseHeld, hideKeyboard, setOrientation, setInputEnabled } = session;
    const clipboardEpoch = React.useRef(0);
    const disarm = React.useCallback(() => {
        setInputEnabled(false);
        clipboardEpoch.current += 1;
        setArmed(false);
        hideKeyboard();
    }, [setInputEnabled, hideKeyboard]);

    // Opening is a user action. A screen that is back without one (a link, or
    // the app restoring where it was) waits for a tap before it captures.
    const [request] = React.useState(() => peekDesktopRequest(getCachedConnectionSettings().machineId ?? '', sessionId, preview));
    React.useEffect(() => {
        claimDesktopRequest(getCachedConnectionSettings().machineId ?? '', sessionId, preview);
    }, [sessionId, preview]);
    const [started, setStarted] = React.useState(request.allowed);
    // Stopped for the background and coming back: that is opening, not closed.
    const [resuming, setResuming] = React.useState(false);
    const startedRef = React.useRef(started);
    startedRef.current = started;
    const closedRef = React.useRef(closed);
    closedRef.current = closed;
    // Control follows a deliberate tap. Whatever happens on its own — the
    // phone locking, the app going to the background, a reconnect — may bring
    // the picture back, but not the control: fingers that were unlocking the
    // phone must not land on the desktop.
    const [armed, setArmed] = React.useState(false);
    // A device preview opens to watch: only a tap on it hands over control.
    const armWhenLive = React.useRef(request.fresh && !preview);
    const arm = React.useCallback(() => {
        if (viewOnlyRef.current) return;
        setInputEnabled(true);
        setArmed(true);
    }, [setInputEnabled]);

    React.useEffect(() => () => {
        disarm();
        releaseHeld();
        void close('left the desktop');
    }, [close, releaseHeld, disarm]);

    React.useEffect(() => {
        if (started) void connect();
    }, [started, connect]);

    const start = React.useCallback(() => {
        // This tap is the desktop action too, for the rest of this run.
        const machineId = getCachedConnectionSettings().machineId ?? '';
        requestDesktop(machineId, sessionId, preview);
        claimDesktopRequest(machineId, sessionId, preview);
        armWhenLive.current = !preview;
        setStarted(true);
    }, [sessionId, preview]);

    // The agent is done with its window: nothing is left to show or to hold.
    // Its window back means the view follows it, still only watching.
    const hadClosed = React.useRef(false);
    React.useEffect(() => {
        if (closed) {
            hadClosed.current = true;
            disarm();
            releaseHeld();
            void close('the target closed');
            return;
        }
        if (!hadClosed.current || !startedRef.current) return;
        hadClosed.current = false;
        // A stream already up or on its way, the engine's own reconnect included, needs no second open.
        if (snapshot.status === 'live' || snapshot.status === 'opening' || snapshot.status === 'connecting' || snapshot.status === 'reconnecting') return;
        void connect();
    }, [closed, snapshot.status, connect, close, releaseHeld, disarm]);

    const retry = React.useCallback(() => {
        armWhenLive.current = false;
        void connect();
    }, [connect]);

    React.useEffect(() => setKeyboardOpen(keyboard.isVisible), [keyboard.isVisible]);

    React.useEffect(() => {
        // Nobody watches a device preview from the background: its stream
        // stops there and opens again, still only watching, on the way back.
        let paused = false;
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                if (paused && startedRef.current && !closedRef.current) void connect();
                else setResuming(false);
                paused = false;
                return;
            }
            disarm();
            armWhenLive.current = false;
            setKeyboardOpen(false);
            setMenu((open) => (open === 'clipboard' ? null : open));
            if (preview && state === 'background' && !paused) {
                paused = true;
                setResuming(true);
                releaseHeld();
                void close('backgrounded');
            }
        });
        return () => subscription.remove();
    }, [disarm, preview, connect, close, releaseHeld]);

    React.useEffect(() => {
        if (notice === null) return;
        const timer = setTimeout(() => {
            setNotice(notice.text === desktopCopy.gestureHint && !clipboardAvailable
                ? { text: desktopCopy.clipboardUnavailable, ms: NOTICE_MS }
                : null);
        }, notice.ms);
        return () => clearTimeout(timer);
    }, [notice, clipboardAvailable]);

    const toggleKeyboard = React.useCallback(() => {
        setMenu(null);
        if (keyboardOpen) {
            session.hideKeyboard();
            setKeyboardOpen(false);
            return;
        }
        arm();
        session.showKeyboard();
        setKeyboardOpen(true);
    }, [keyboardOpen, session, arm]);

    // A toolbar key is a deliberate tap, so it takes control as it presses.
    const pressToolbarKey = React.useCallback(({ name, character, modifiers }: (typeof PREVIEW_KEYS)[PreviewKind][number]) => {
        arm();
        hapticsSelection();
        const key = name === undefined ? { character } : { name };
        session.send({ kind: 'key', ...key, modifiers, down: true });
        session.send({ kind: 'key', ...key, modifiers, down: false });
    }, [arm, session]);

    // Opened from the chip, the view grows out of it, and goes back into it
    // while the agent's window is still there to go back to.
    const reduceMotion = useReducedMotion();
    const from = docked ? undefined : request.from;
    const grow = useSharedValue(from === undefined ? 1 : 0);
    const rootRef = React.useRef<View>(null);
    const [frame, setFrame] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const measureFrame = React.useCallback(() => {
        rootRef.current?.measureInWindow((x, y, width, height) => setFrame({ x, y, width, height }));
    }, []);
    React.useEffect(() => {
        if (from === undefined || frame === null || grow.value !== 0) return;
        grow.value = reduceMotion ? withTiming(1, { duration: 120 }) : withSpring(1, GROW_SPRING);
    }, [from, frame, grow, reduceMotion]);
    const growStyle = useAnimatedStyle(() => {
        if (from === undefined || frame === null) return from === undefined ? {} : { opacity: 0 };
        // A full-screen view must never grow past the screen, however the spring settles.
        const p = Math.min(1, grow.value);
        if (reduceMotion) return { opacity: p };
        const start = Math.max(from.width / frame.width, from.height / frame.height);
        return {
            opacity: Math.min(1, p * 2.5),
            borderRadius: 16 * (1 - p),
            transform: [
                { translateX: (from.x + from.width / 2 - (frame.x + frame.width / 2)) * (1 - p) },
                { translateY: (from.y + from.height / 2 - (frame.y + frame.height / 2)) * (1 - p) },
                { scale: start + (1 - start) * p },
            ],
        };
    });
    const leave = React.useCallback(() => {
        if (from === undefined || closed) {
            onExit();
            return;
        }
        grow.value = withTiming(0, { duration: reduceMotion ? 120 : 180 }, (done) => {
            if (done) runOnJS(onExit)();
        });
    }, [from, closed, grow, reduceMotion, onExit]);

    // Landscape belongs to this screen while it is in front: leaving it by any
    // route, or another screen opening over it, hands the phone its own
    // orientation back. The app going to the background is the native side's.
    useFocusEffect(React.useCallback(() => {
        if (!landscape) return undefined;
        setOrientation('landscape');
        return () => setOrientation('auto');
    }, [landscape, setOrientation]));

    const toggleLandscape = React.useCallback(() => setLandscape((current) => !current), []);

    const copyFromDesktop = React.useCallback(async () => {
        const epoch = clipboardEpoch.current;
        setClipboardBusy(true);
        setNotice(null);
        try {
            let writeLocal = async (text: string) => {
                if (epoch === clipboardEpoch.current) await Clipboard.setStringAsync(text);
            };
            let abandonWrite = () => {};
            if (Platform.OS === 'web') {
                // Start the write in the tap's user gesture; the remote reply can arrive later.
                const remote = new Promise<string>((resolve, reject) => {
                    writeLocal = async (text) => {
                        resolve(text);
                        if (!await written) throw new Error(desktopCopy.clipboardBlocked);
                    };
                    abandonWrite = () => reject(new Error('no desktop clipboard'));
                });
                remote.catch(() => undefined);
                let written: Promise<boolean>;
                try {
                    const write = typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write
                        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': remote.then((text) => new Blob([text], { type: 'text/plain' })) })])
                        : remote.then((text) => navigator.clipboard.writeText(text));
                    written = write.then(() => true, () => false);
                } catch {
                    written = Promise.resolve(false);
                }
            }
            const { text, truncated } = await session.copyRemoteToLocal(writeLocal).finally(abandonWrite);
            if (epoch !== clipboardEpoch.current) return;
            if (truncated) say('Copied the start of the desktop clipboard; the rest was too large.');
            else if (text === '') say('The desktop clipboard was empty.');
            else say('Copied to this phone.');
        } catch (error) {
            if (epoch === clipboardEpoch.current) say(describeClipboardError(error, 'Could not copy from the desktop.'));
        } finally {
            setClipboardBusy(false);
        }
    }, [session, say]);

    const pasteToDesktop = React.useCallback(async () => {
        const epoch = clipboardEpoch.current;
        setClipboardBusy(true);
        setNotice(null);
        try {
            const text = await Clipboard.getStringAsync();
            if (epoch !== clipboardEpoch.current) return;
            await session.pasteLocalToRemote(text);
            if (epoch !== clipboardEpoch.current) return;
            say('On the desktop clipboard. Hold on a field and choose Paste.');
        } catch (error) {
            if (epoch === clipboardEpoch.current) say(describeClipboardError(error, 'Could not paste to the desktop.'));
        } finally {
            setClipboardBusy(false);
        }
    }, [session, say]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const back = BackHandler.addEventListener('hardwareBackPress', () => {
            if (menu !== null) setMenu(null);
            else leave();
            return true;
        });
        return () => back.remove();
    }, [menu, leave]);

    const live = snapshot.status === 'live';
    React.useEffect(() => {
        if (live || snapshot.status === 'failed') setResuming(false);
    }, [live, snapshot.status]);
    // The engine's own reconnect passes through opening again; while it does,
    // the view still says what happened, not that it is starting.
    const [dropped, setDropped] = React.useState(false);
    React.useEffect(() => {
        if (snapshot.status === 'reconnecting') setDropped(true);
        else if (snapshot.status !== 'opening' && snapshot.status !== 'connecting') setDropped(false);
    }, [snapshot.status]);
    React.useEffect(() => {
        if (!live) {
            disarm();
            if (snapshot.status === 'failed' || snapshot.status === 'ended' || snapshot.status === 'reconnecting') armWhenLive.current = false;
            return;
        }
        if (armWhenLive.current) {
            setInputEnabled(true);
            setArmed(true);
        }
        armWhenLive.current = false;
    }, [live, snapshot.status, disarm, setInputEnabled]);
    const controlling = live && armed;

    // The first desktop on a device explains its gestures; after that, a
    // computer that cannot share its clipboard says so once per opening
    // rather than for as long as the desktop is up.
    const explained = React.useRef(false);
    React.useEffect(() => {
        // A device preview says what a tap does on its own pill, and keeps its clipboard in the menu.
        if (!live || explained.current || preview) return;
        explained.current = true;
        if (!openedBefore) {
            setOpenedBefore(true);
            say(desktopCopy.gestureHint, HINT_MS);
        } else if (!clipboardAvailable) {
            say(desktopCopy.clipboardUnavailable);
        }
    }, [live, openedBefore, setOpenedBefore, clipboardAvailable, say, preview]);

    // An open still waiting after a moment is waiting on the computer's
    // screen-sharing prompt, whether or not a grant was saved (the portal may
    // have revoked it), so the phone says where to look and how long the host
    // waits, counted from when the open was sent.
    const waitingOnOpen = snapshot.status === 'opening' && openSentAt !== null;
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!waitingOnOpen) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [waitingOnOpen]);
    React.useEffect(() => {
        if (snapshot.status !== 'opening') setOpenSentAt(null);
    }, [snapshot.status]);
    const consentSecondsLeft = waitingOnOpen && now - openSentAt >= CONSENT_HINT_AFTER_MS
        ? Math.ceil((openSentAt + DESKTOP_CONSENT_WAIT_MS - now) / 1000)
        : null;
    const described = describeDesktopOverlay(snapshot, openedBefore, consentSecondsLeft);
    const copy = previewCopy[kind];
    // A device preview the app put back on its own waits for Watch, like the desktop.
    const previewStatus = !preview ? null
        : !started && !closed ? { title: copy.name, detail: target?.title, spinner: false, action: { label: 'Watch', exit: false } }
        : resuming && !closed ? { title: copy.opening, spinner: true }
        : dropped && !closed && (snapshot.status === 'opening' || snapshot.status === 'connecting') ? null
        : describePreviewOverlay(snapshot, kind, closed);
    const status: { title: string; detail?: string; command?: string; spinner: boolean; action?: string } = previewStatus !== null
        ? { ...previewStatus, action: previewStatus.action?.label }
        : started
            ? { ...described, action: described.canRetry ? 'Try again' : undefined }
            : { title: desktopCopy.stoppedTitle, detail: desktopCopy.stoppedBody, command: undefined, spinner: false, action: desktopCopy.startAction };
    const overlayShown = preview ? previewStatus !== null : !live;
    const onStatusAction = previewStatus?.action?.exit === true ? onExit : started ? retry : start;
    const shownNotice = live ? notice?.text ?? null : null;
    // The row stays while the keyboard is still on its way down, fading with it.
    const web = Platform.OS === 'web';
    const keyRowShown = controlling && (keyboardOpen || keyboard.isVisible || (web && motion.visible));
    // A phone on its side has little height once the keyboard is up: the
    // header steps aside, and the round controls sit at the ends of the key
    // row instead of above it.
    const screen = Dimensions.get('screen');
    const compact = screen.width > screen.height;
    const compactKeyboard = compact && (keyboard.isVisible || (web && motion.visible));
    const headerShown = !compactKeyboard;
    const popupReady = !keyboard.isVisible && !(web && motion.visible);
    const rise = compact ? (DESKTOP_KEY_ROW_HEIGHT - BUTTON) / 2 : DESKTOP_KEY_ROW_HEIGHT + ABOVE_KEYS;
    const clearance = compact ? (DESKTOP_KEY_ROW_HEIGHT + BUTTON) / 2 + PICTURE_GAP / 2 : rise + BUTTON + PICTURE_GAP;
    const statusLabel = live ? desktopCopy.liveLabel : snapshot.status === 'reconnecting' ? desktopCopy.reconnectingTitle : status.spinner ? desktopCopy.connectingLabel : null;
    const reconnecting = snapshot.status === 'reconnecting' || (preview && dropped && !live);
    const previewStatusLine: { label: string; color: string; spinner?: boolean } | null = !preview ? null
        : resuming && !closed ? { label: desktopCopy.connectingLabel, color: theme.colors.textSecondary, spinner: true }
        : closed || snapshot.status === 'ended' ? { label: previewCopy.closedLabel, color: theme.colors.textSecondary }
        : live && armed ? { label: previewCopy.controlLabel, color: theme.colors.status.working }
        : live ? { label: previewCopy.liveLabel, color: theme.colors.status.connected }
        : reconnecting ? { label: desktopCopy.reconnectingTitle.replace('…', ''), color: theme.colors.textSecondary, spinner: true }
        : status.spinner ? { label: desktopCopy.connectingLabel, color: theme.colors.textSecondary, spinner: true }
        : null;
    // Docked in a light app, the letterbox is a quiet grey so the page's own colours read true.
    const stageColor = docked && !theme.dark ? '#F5F5F5' : '#000';
    const panelColor = docked ? theme.colors.surface : '#000';

    // The key row rides on the keyboard and fades in as it rises; the
    // controls rise over it by the same measure, so the keyboard, the row,
    // the controls and the picture arrive as one movement. The keyboard's
    // height already covers the home indicator, so the inset that lifts them
    // at rest is let go as the keyboard comes up.
    const { height: keyboardOffset, progress: keyboardShown } = motion;
    const [noOverlapReady, setNoOverlapReady] = React.useState(false);
    React.useEffect(() => {
        setNoOverlapReady(false);
        if (!web || motion.visible || !(keyboardOpen || keyboard.isVisible)) return;
        // Wait for the phone's viewport to move before treating focus as a hardware keyboard.
        const timer = setTimeout(() => setNoOverlapReady(true), 180);
        return () => clearTimeout(timer);
    }, [web, motion.visible, keyboardOpen, keyboard.isVisible]);
    const noOverlapKeys = web && !motion.visible && (keyboardOpen || keyboard.isVisible) && noOverlapReady;
    const bottomInset = insets.bottom;
    const keyRowMotion = useAnimatedStyle(() => {
        const shown = noOverlapKeys ? 1 : keyboardShown.value;
        return {
            opacity: shown,
            transform: [{ translateY: keyboardOffset.value + bottomInset * shown }],
        };
    });
    const controlsMotion = useAnimatedStyle(() => {
        const shown = noOverlapKeys ? 1 : keyboardShown.value;
        return {
            transform: [{ translateY: keyboardOffset.value + bottomInset * shown - shown * (rise - REST_GAP) }],
        };
    });

    const control = (pressed: boolean, on = false): ViewStyle => ({
        width: BUTTON,
        height: BUTTON,
        borderRadius: BUTTON / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: pressed || on ? theme.colors.terminalChrome.clusterPressed : theme.colors.terminalChrome.cluster,
    });
    const card: ViewStyle = {
        position: 'absolute',
        borderRadius: 20,
        paddingVertical: 6,
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        shadowColor: '#000',
        shadowOpacity: 0.4,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 12,
        zIndex: 3,
    };
    const toggleMenu = (target: 'more' | 'help') => {
        if (menu !== target && (keyboardOpen || keyboard.isVisible || motion.visible)) {
            session.hideKeyboard();
            setKeyboardOpen(false);
        }
        setMenu((open) => (open === target ? null : target));
    };
    const menuRow = (label: string, icon: React.ComponentProps<typeof Ionicons>['name'], onPress: () => void, options: { selected?: boolean; disabled?: boolean } = {}) => (
        <Pressable
            key={label}
            onPress={() => { setMenu(null); onPress(); }}
            disabled={options.disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: options.selected, disabled: options.disabled }}
            style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: theme.colors.surfacePressed }, options.disabled && styles.disabled]}
        >
            <Ionicons name={icon} size={18} color={theme.colors.textSecondary} />
            <Text style={[styles.menuLabel, { color: theme.colors.text }]}>{label}</Text>
            {options.selected === true && <Ionicons name="checkmark" size={17} color={theme.colors.text} />}
        </Pressable>
    );
    const disc = (pressed: boolean, on = false): ViewStyle => ({
        width: DISC,
        height: DISC,
        borderRadius: DISC / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: docked
            ? (pressed || on ? theme.colors.surfacePressed : theme.colors.surfaceHighest)
            : (pressed || on ? theme.colors.terminalChrome.clusterPressed : theme.colors.terminalChrome.cluster),
    });
    const headerMark = ({ pressed }: { pressed: boolean }) => [styles.headerButton, pressed && styles.pressed];
    const popIn = FadeIn.duration(140).reduceMotion(ReduceMotion.System);
    const popOut = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

    return (
        <Animated.View ref={rootRef} onLayout={measureFrame} style={[styles.screen, { backgroundColor: panelColor }, from !== undefined && styles.clipped, growStyle]}>
            {/* A device preview: what it is, the device it is on, whether it
                is live, and the less-used actions. Docked, it closes in place. */}
            {headerShown && preview && <View style={[styles.header, docked && [styles.dockedHeader, { backgroundColor: panelColor, borderColor: theme.colors.divider }]]}>
                {!docked && <Pressable onPress={leave} accessibilityRole="button" accessibilityLabel="Back to the conversation" hitSlop={12} style={headerMark}>
                    <Ionicons name="arrow-back" size={18} color={theme.colors.text} />
                </Pressable>}
                <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={`${copy.name}${target?.title ? `, ${target.title}` : ''}${previewStatusLine === null ? '' : `, ${previewStatusLine.label}`}`}>
                    <Ionicons name={previewIcon(kind)} size={14} color={theme.colors.textSecondary} />
                    <Text numberOfLines={1} style={[styles.titleText, styles.previewName, { color: theme.colors.text }]}>{copy.name}</Text>
                    {target?.title !== undefined && <Text numberOfLines={1} style={[styles.titleText, styles.previewTitle, { color: theme.colors.textSecondary }]}>{target.title}</Text>}
                </View>
                {/* Driving it, the agent holds off until it is handed back. The
                    control sits in the bar, never over the picture's own status bar. */}
                {controlling ? (
                    <Animated.View entering={popIn}>
                        <Pressable onPress={disarm} accessibilityRole="button" accessibilityLabel={previewCopy.handBack} accessibilityHint={previewCopy.controlTitle} hitSlop={8} style={({ pressed }) => [styles.handBack, { backgroundColor: theme.colors.button.primary.background }, pressed && styles.pressed]}>
                            <Text style={[styles.handBackLabel, { color: theme.colors.button.primary.tint }]}>{previewCopy.handBack}</Text>
                        </Pressable>
                    </Animated.View>
                ) : previewStatusLine !== null && (
                    <Animated.View key={previewStatusLine.label} entering={popIn} style={styles.statusLine}>
                        {previewStatusLine.spinner === true
                            ? <ActivityIndicator size={10} color={previewStatusLine.color} />
                            : <View style={[styles.statusDot, { backgroundColor: previewStatusLine.color }]} />}
                        <Text numberOfLines={1} style={[styles.statusText, { color: previewStatusLine.color }]}>{previewStatusLine.label}</Text>
                    </Animated.View>
                )}
                <Pressable onPress={() => toggleMenu('more')} accessibilityRole="button" accessibilityLabel={`${copy.name} actions`} accessibilityState={{ expanded: menu === 'more' }} hitSlop={8} style={headerMark}>
                    <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.text} />
                </Pressable>
                {docked && <Pressable onPress={onExit} accessibilityRole="button" accessibilityLabel={`Close the ${copy.name.toLowerCase()}`} hitSlop={8} style={headerMark}>
                    <Ionicons name="close" size={20} color={theme.colors.text} />
                </Pressable>}
            </View>}
            {/* The conversation's own header line, so opening the desktop
                changes what is under it and nothing above: back, the
                conversation, help, and the less-used actions. */}
            {headerShown && !preview && <View style={styles.header}>
                <Pressable onPress={onExit} accessibilityRole="button" accessibilityLabel="Back to the conversation" hitSlop={12} style={headerMark}>
                    <Ionicons name="arrow-back" size={18} color={theme.colors.text} />
                </Pressable>
                <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={`${heading}${statusLabel === null ? '' : `, desktop ${statusLabel.toLowerCase()}`}`}>
                    {leading ?? <Ionicons name="desktop-outline" size={14} color={theme.colors.textSecondary} />}
                    <Text numberOfLines={1} style={[styles.titleText, { color: theme.colors.text }]}>{heading}</Text>
                </View>
                <Pressable onPress={() => toggleMenu('help')} accessibilityRole="button" accessibilityLabel="Desktop gestures" accessibilityState={{ expanded: menu === 'help' }} hitSlop={8} style={headerMark}>
                    <Ionicons name="help-circle-outline" size={19} color={theme.colors.text} />
                </Pressable>
                <Animated.View entering={popIn}>
                    <Pressable onPress={() => toggleMenu('more')} accessibilityRole="button" accessibilityLabel="Desktop actions" accessibilityState={{ expanded: menu === 'more' }} hitSlop={8} style={headerMark}>
                        <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.text} />
                    </Pressable>
                </Animated.View>
            </View>}

            <View style={styles.body}>
                <DesktopView
                    sessionId={session.nativeId}
                    // On its side with the keyboard up, the compact row sits above the picture, never over it.
                    style={[styles.surface, preview && { backgroundColor: stageColor, marginBottom: TOOLBAR + bottomInset }, compactKeyboard && styles.belowCompactHeader]}
                    accessibilityLabel={preview ? copy.stage : `${computerName} desktop`}
                    keyboardClearance={clearance}
                    // The top is paid by the container, and a preview's bottom by its toolbar margin.
                    insets={{ left: docked ? 0 : insets.left, right: insets.right, bottom: preview ? 0 : insets.bottom }}
                    gestures={!preview ? 'desktop' : 'device'}
                />

                {/* Reconnecting keeps the last frame, dimmed, and says so above it. */}
                {preview && reconnecting && (
                    <Animated.View entering={popIn} exiting={popOut} pointerEvents="none" style={[StyleSheet.absoluteFill, styles.dim]}>
                        <View style={[styles.pill, styles.topPill, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.glass.border }]}>
                            <ActivityIndicator size="small" color={theme.colors.text} />
                            <Text accessibilityLiveRegion="polite" style={[styles.armLabel, { color: theme.colors.text }]}>{desktopCopy.reconnectingTitle}</Text>
                        </View>
                    </Animated.View>
                )}

                {/* The start is quiet — a small spinner and one line on the
                    surface's own black — and it fades as the first picture
                    comes up out of that black beneath it. It has no fill of
                    its own: a fill over a video surface hides the picture
                    until the fill is gone, which reads as a cut. */}
                {overlayShown && (
                    <Animated.View exiting={FadeOut.duration(250).reduceMotion(ReduceMotion.System)} style={[styles.overlay, preview && { bottom: TOOLBAR + bottomInset }]}>
                        {status.spinner && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                        <Text style={[styles.overlayTitle, { color: theme.colors.text }]}>{status.title}</Text>
                        {status.detail !== undefined && (
                            <Text style={[styles.overlayDetail, { color: theme.colors.textSecondary }]}>{status.detail}</Text>
                        )}
                        {status.command !== undefined && (
                            <Pressable
                                onPress={() => void copyCommand(status.command!)}
                                accessibilityRole="button"
                                accessibilityLabel={commandCopied ? 'Copied' : 'Copy the command'}
                                style={({ pressed }) => [styles.command, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.glass.border }, pressed && styles.pressed]}
                            >
                                <Text numberOfLines={3} style={[styles.commandText, { color: theme.colors.text }]}>{status.command}</Text>
                                <Text style={[styles.commandCopy, { color: theme.colors.textSecondary }]}>{commandCopied ? 'Copied' : 'Copy'}</Text>
                            </Pressable>
                        )}
                        {status.action !== undefined && (
                            <Pressable
                                onPress={onStatusAction}
                                accessibilityRole="button"
                                accessibilityLabel={status.action}
                                style={({ pressed }) => [styles.action, { backgroundColor: theme.colors.button.primary.background }, pressed && styles.pressed]}
                            >
                                <Text style={[styles.actionLabel, { color: theme.colors.button.primary.tint }]}>{status.action}</Text>
                            </Pressable>
                        )}
                    </Animated.View>
                )}

                {/* Back without a tap: the picture shows, control waits for
                    one. The tap that turns it on is not sent to the desktop. */}
                {live && !armed && !closed && (
                    <Pressable
                        onPress={arm}
                        disabled={viewOnly}
                        accessibilityRole={viewOnly ? 'text' : 'button'}
                        accessibilityLabel={viewOnly ? previewCopy.viewOnlyTitle : preview ? previewCopy.armTitle : desktopCopy.armTitle}
                        accessibilityHint={viewOnly ? copy.viewOnlyBody : preview ? previewCopy.armHint : desktopCopy.armHint}
                        style={[styles.armCover, { paddingBottom: insets.bottom + REST_GAP + (preview ? TOOLBAR : 0) }]}
                    >
                        <Animated.View entering={popIn} pointerEvents="none" style={[styles.armPill, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.glass.border }]}>
                            <Ionicons name={viewOnly ? 'eye-outline' : 'hand-left-outline'} size={16} color={theme.colors.text} />
                            <Text style={[styles.armLabel, { color: theme.colors.text }]}>{viewOnly ? previewCopy.viewOnlyTitle : preview ? previewCopy.armTitle : desktopCopy.armTitle}</Text>
                        </Animated.View>
                    </Pressable>
                )}

                {compactKeyboard && (
                    <View pointerEvents="box-none" style={styles.compactHeader}>
                        <Pressable onPress={leave} accessibilityRole="button" accessibilityLabel="Back to the conversation" style={({ pressed }) => control(pressed)}>
                            <Ionicons name="arrow-back" size={18} color={theme.colors.text} />
                        </Pressable>
                        {preview && controlling && (
                            <Pressable onPress={disarm} accessibilityRole="button" accessibilityLabel={previewCopy.handBack} accessibilityHint={previewCopy.controlTitle} hitSlop={8} style={({ pressed }) => [styles.handBack, { backgroundColor: theme.colors.button.primary.background, alignSelf: 'center' }, pressed && styles.pressed]}>
                                <Text style={[styles.handBackLabel, { color: theme.colors.button.primary.tint }]}>{previewCopy.handBack}</Text>
                            </Pressable>
                        )}
                        <Pressable onPress={() => toggleMenu('more')} accessibilityRole="button" accessibilityLabel="Desktop actions" accessibilityState={{ expanded: menu === 'more' }} style={({ pressed }) => control(pressed, menu === 'more')}>
                            <Ionicons name="ellipsis-vertical" size={18} color={theme.colors.text} />
                        </Pressable>
                    </View>
                )}

                {menu !== null && <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(null)} accessibilityLabel="Close menu" />}

                {menu === 'help' && popupReady && (
                    <Animated.View entering={popIn} exiting={popOut} style={[card, styles.topCard, { width: Math.min(windowWidth - 16, 320) }]}>
                        {(preview ? PREVIEW_GESTURES[kind] : GESTURES).map(([gesture, effect]) => (
                            <View key={gesture} style={[styles.helpRow, compact && styles.compactHelpRow]} accessible accessibilityLabel={`${gesture}: ${effect}`}>
                                <Text style={[styles.helpGesture, { color: theme.colors.textSecondary }]}>{gesture}</Text>
                                <Text style={[styles.helpEffect, { color: theme.colors.text }]}>{effect}</Text>
                            </View>
                        ))}
                    </Animated.View>
                )}

                {menu === 'more' && popupReady && (
                    <Animated.View entering={popIn} exiting={popOut} style={[card, styles.topCard]}>
                        {menuRow('Gestures', 'help-circle-outline', () => toggleMenu('help'))}
                        {preview && live && clipboardAvailable && menuRow('Clipboard', 'clipboard-outline', () => { arm(); setMenu('clipboard'); })}
                        {live && menuRow('Fit to screen', 'scan-outline', session.fitToView)}
                        {!preview && (live || landscape) && Platform.OS === 'android' && menuRow('Landscape', 'phone-landscape-outline', toggleLandscape, { selected: landscape })}
                        {menuRow(preview ? 'Close' : 'Disconnect', preview ? 'close-outline' : 'power-outline', preview ? leave : onExit)}
                    </Animated.View>
                )}

                {keyRowShown && (
                    // Untouchable until the keyboard has brought it up: a row
                    // still waiting at the bottom would take the desktop's taps.
                    <Animated.View pointerEvents={web ? (motion.visible || noOverlapKeys ? 'auto' : 'none') : (keyboard.isVisible ? 'auto' : 'none')} style={[styles.keyRow, { bottom: bottomInset, paddingHorizontal: compact ? EDGE + BUTTON + 4 : 0 }, keyRowMotion]}>
                        <DesktopKeyRow session={session} />
                    </Animated.View>
                )}

                {controlling && menu === 'clipboard' && clipboardAvailable && (
                    <Animated.View entering={popIn} exiting={popOut} style={[card, styles.clipboardCard, { bottom: bottomInset + REST_GAP + BUTTON + 10 }, controlsMotion]}>
                        {menuRow('Copy to Phone', 'copy-outline', () => void copyFromDesktop(), { disabled: clipboardBusy })}
                        {menuRow('Paste from Phone', 'clipboard-outline', () => void pasteToDesktop(), { disabled: clipboardBusy })}
                    </Animated.View>
                )}

                {/* A device preview keeps its toolbar in view: the device keys
                    and the keyboard. Dim until it is live. */}
                {preview && !(viewOnly && !live) && previewStatus?.action?.exit !== true && (
                    <Animated.View pointerEvents="box-none" style={[styles.toolbar, { height: TOOLBAR + bottomInset, paddingBottom: bottomInset, backgroundColor: panelColor }, docked && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }, controlsMotion]}>
                        {shownNotice !== null && (
                            <View pointerEvents="none" style={[styles.noticeLane, { bottom: TOOLBAR + bottomInset + 4 }]}>
                                <View style={[styles.notice, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.glass.border }]}>
                                    <Text accessibilityLiveRegion="polite" numberOfLines={3} style={[styles.noticeText, { color: theme.colors.text }]}>{shownNotice}</Text>
                                </View>
                            </View>
                        )}
                        {PREVIEW_KEYS[kind].map((key) => (
                            <Pressable key={key.label} onPress={() => pressToolbarKey(key)} disabled={!live || viewOnly} accessibilityRole="button" accessibilityLabel={key.label} style={({ pressed }) => [disc(pressed), (!live || viewOnly) && styles.disabled]}>
                                <Ionicons name={key.icon} size={18} color={theme.colors.text} />
                            </Pressable>
                        ))}
                        <View style={[styles.separator, { backgroundColor: theme.colors.divider }]} />
                        {kind === 'android' && (
                            <Pressable onPress={() => pressToolbarKey({ label: 'Rotate', icon: 'sync-outline', name: 'ArrowLeft', modifiers: ['Control'] })} disabled={!live || viewOnly} accessibilityRole="button" accessibilityLabel="Rotate" style={({ pressed }) => [disc(pressed), (!live || viewOnly) && styles.disabled]}>
                                <Ionicons name="sync-outline" size={18} color={theme.colors.text} />
                            </Pressable>
                        )}
                        {!viewOnly && kind !== 'ios' && (
                            <Pressable onPress={toggleKeyboard} disabled={!live} accessibilityRole="button" accessibilityLabel={keyboardOpen ? 'Hide keyboard' : 'Keyboard'} accessibilityState={{ selected: keyboardOpen }} style={({ pressed }) => [disc(pressed, keyboardOpen), !live && styles.disabled]}>
                                <MaterialCommunityIcons name={keyboardOpen ? 'keyboard-close-outline' : 'keyboard-outline'} size={20} color={theme.colors.text} />
                            </Pressable>
                        )}
                    </Animated.View>
                )}

                {controlling && !preview && (
                    <Animated.View pointerEvents="box-none" style={[styles.controls, { bottom: bottomInset + REST_GAP }, controlsMotion]}>
                        {shownNotice !== null && (
                            <View pointerEvents="none" style={styles.noticeLane}>
                                <View style={[styles.notice, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.glass.border }]}>
                                    <Text accessibilityLiveRegion="polite" numberOfLines={3} style={[styles.noticeText, { color: theme.colors.text }]}>{shownNotice}</Text>
                                </View>
                            </View>
                        )}

                        {clipboardAvailable ? (
                            <Pressable onPress={() => setMenu((open) => (open === 'clipboard' ? null : 'clipboard'))} accessibilityRole="button" accessibilityLabel="Clipboard" accessibilityState={{ expanded: menu === 'clipboard', busy: clipboardBusy }} style={({ pressed }) => control(pressed, menu === 'clipboard')}>
                                {clipboardBusy
                                    ? <ActivityIndicator size="small" color={theme.colors.text} />
                                    : <Ionicons name="clipboard-outline" size={20} color={theme.colors.text} />}
                            </Pressable>
                        ) : <View />}
                        <Pressable onPress={toggleKeyboard} accessibilityRole="button" accessibilityLabel={keyboardOpen ? 'Hide keyboard' : 'Keyboard'} accessibilityState={{ selected: keyboardOpen }} style={({ pressed }) => control(pressed, keyboardOpen)}>
                            <MaterialCommunityIcons name={keyboardOpen ? 'keyboard-close-outline' : 'keyboard-outline'} size={21} color={theme.colors.text} />
                        </Pressable>
                    </Animated.View>
                )}
            </View>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    // `flex: 1` alone collapses to nothing inside a web route that has no
    // sized ancestor; the explicit percentage is what gives the live surface a
    // box on both platforms.
    screen: { flex: 1, width: '100%', height: '100%', backgroundColor: '#000' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, minHeight: 32, backgroundColor: '#000' },
    headerButton: { minWidth: 32, minHeight: 30, alignItems: 'center', justifyContent: 'center' },
    title: { flex: 1, minWidth: 0, minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 3 },
    titleText: { flexShrink: 1, fontSize: 13, fontWeight: '500', opacity: 0.88 },
    body: { flex: 1, minHeight: 0 },
    surface: { flex: 1 },
    compactHeader: { position: 'absolute', top: 8, left: EDGE, right: EDGE, height: BUTTON, flexDirection: 'row', justifyContent: 'space-between', zIndex: 2 },
    belowCompactHeader: { marginTop: 8 + BUTTON + 8 },
    overlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        paddingHorizontal: 36,
    },
    overlayTitle: { ...Typography.default(), fontSize: 16, lineHeight: 22, textAlign: 'center' },
    overlayDetail: { ...Typography.default(), fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: -4 },
    command: { alignSelf: 'stretch', borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
    commandText: { ...Typography.mono(), fontSize: 12, lineHeight: 17 },
    commandCopy: { ...Typography.default(), fontSize: 13, alignSelf: 'flex-end' },
    action: {
        marginTop: 6,
        height: 44,
        minWidth: 140,
        paddingHorizontal: 20,
        borderRadius: ui.radius.control,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionLabel: { ...Typography.default('semiBold'), fontSize: 14 },
    topCard: { top: 4, right: 8, minWidth: 220, maxWidth: '88%' },
    clipboardCard: { left: EDGE, minWidth: 220, maxWidth: 300 },
    menuRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18 },
    menuLabel: { ...Typography.default(), flex: 1, fontSize: 15 },
    helpRow: { flexDirection: 'row', alignItems: 'baseline', gap: 14, paddingHorizontal: 18, paddingVertical: 7 },
    compactHelpRow: { paddingVertical: 2 },
    helpGesture: { ...Typography.default(), width: 100, fontSize: 14, lineHeight: 18 },
    helpEffect: { ...Typography.default(), flex: 1, fontSize: 14, lineHeight: 18 },
    keyRow: { position: 'absolute', left: 0, right: 0, backgroundColor: '#000' },
    controls: {
        position: 'absolute',
        left: EDGE,
        right: EDGE,
        height: BUTTON,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    noticeLane: { position: 'absolute', left: 0, right: 0, bottom: BUTTON + 12, alignItems: 'center' },
    notice: {
        maxWidth: '96%',
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
    },
    noticeText: { ...Typography.default(), fontSize: 13, lineHeight: 18, textAlign: 'center' },
    armCover: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'flex-end' },
    armPill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth },
    armLabel: { ...Typography.default(), fontSize: 14 },
    clipped: { overflow: 'hidden' },
    dockedHeader: { minHeight: 44, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
    previewName: { flexShrink: 0, opacity: 1 },
    previewTitle: { fontWeight: '400', opacity: 1 },
    statusLine: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0, paddingHorizontal: 4 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusText: { ...Typography.default(), fontSize: 11, fontWeight: '500' },
    dim: { backgroundColor: 'rgba(0, 0, 0, 0.55)' },
    pill: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingLeft: 14, paddingRight: 6, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
    topPill: { position: 'absolute', top: 12, alignSelf: 'center', paddingRight: 14 },
    handBack: { height: 26, borderRadius: 13, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
    handBackLabel: { ...Typography.default('semiBold'), fontSize: 12 },
    toolbar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12 },
    separator: { width: StyleSheet.hairlineWidth, height: 22, marginHorizontal: 2 },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.6 },
});

