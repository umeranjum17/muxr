/**
 * Swiping between agents is a pager, not a gesture that fires a navigation
 * once the finger lifts. The terminal follows the finger, the neighbouring
 * agent's screen comes in beside it, and the release settles on whichever page
 * the drag and its speed chose. Everything moving runs on the UI thread.
 *
 * The neighbours are on the page before the drag begins, drawn from each
 * pane's last read screen, so nothing arrives blank. The route changes only
 * once the page has settled, and the arriving screen holds the same picture
 * until its own terminal paints over it.
 */

import * as React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, PointerType } from 'react-native-gesture-handler';
import Animated, { FadeOut, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';
import { AgentGlyph } from '@/components/AgentGlyph';
import { hapticsSelection } from '@/components/haptics';
import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/catalog/store';
import { agentLabels, agentStatusColor, HERD_STATUS_LABELS, isShellLabels, type LiveTerminalOrderCard } from '@/herd';
import { refreshPaneSnapshot, usePaneSnapshot } from '../application/paneSnapshots';
import { terminalColumns } from '../application/recentOutput';
import { openTerminalAhead } from '../application/terminalAhead';
import { FONT_STEPS, clampFontIndex } from '../domain/fontSteps';

/** The screen's own edges stay with the system's back gesture. */
const EDGE_INSET = 24;
/**
 * Horizontal travel that makes a drag a page turn. iOS claims it sooner: the
 * terminal's own scroll recogniser takes any drag at 10pt, and whichever
 * recogniser starts first keeps the touch.
 */
const X_ACTIVATE = Platform.OS === 'ios' ? 8 : 12;
/**
 * Vertical travel that makes it a scroll instead. The browser terminal starts
 * scrolling at 8px and nothing can call that back, so there the pager steps
 * aside at the same distance; elsewhere a turned page cancels the scroll.
 */
const Y_FAIL = Platform.OS === 'web' ? 8 : 12;
/** A finger that rests this long before travelling is selecting text. */
const INTENT_WINDOW = 400;
/** Two fingers that spread or close this much before travelling are a pinch. */
const PINCH_SPREAD = 0.15;
/** The seam between two terminals, in the chrome's ink. */
const PAGE_GAP = 12;
/**
 * A release turns the page when it is a flick -- quick enough and far enough
 * to mean it, the same bar the document swipe uses -- or when a slower drag
 * has carried the page this share of the way. A flick back cancels either.
 */
const FLING_VELOCITY = 450;
const FLING_DISTANCE = 24;
const COMMIT_SHARE = 0.4;
/** The platform's end-of-content curve: how hard an end resists. */
const RESISTANCE = 0.55;
/**
 * A lively spring that is clamped where it lands: it arrives with the flick's
 * own speed and stops dead on the page, with no slow tail to wait out before
 * the next agent's terminal can start.
 */
const SETTLE = { stiffness: 380, damping: 30, mass: 1, overshootClamping: true, reduceMotion: ReduceMotion.System } as const;
/** How old a neighbour's screen may be when the terminal opens, and when a finger lands. */
const WARM_ON_OPEN_MS = 5_000;
const WARM_ON_TOUCH_MS = 3_000;
const STATE_ACTIVE = 4;
const STATE_CANCELLED = 3;
// Ghostty's cell is the face's ascent plus descent; the web's is xterm's.
const LINE_HEIGHT = Platform.OS === 'web' ? 1.2 : 1.32;
/** The bundled mono face's advance, as a share of its size. */
const MONO_ADVANCE = 0.6;
const TERMINAL_INK = '#d8d8d2';

// The one pane a swipe is on its way to, so its screen can keep the picture.
let arriving: string | null = null;
// Every terminal on this phone is laid out at one size, so the last cell a
// live grid measured is the cell a neighbour's screen will be drawn in.
let lastCellWidth = 0;

/** Whether this pane's screen is being reached by a page turn, which already shows its picture. */
export function arrivingBySwipe(sessionId: string): boolean {
    return arriving === sessionId;
}

function follow(dx: number, width: number, hasPrevious: boolean, hasNext: boolean): number {
    'worklet';
    const page = width + PAGE_GAP;
    if (dx > 0 ? hasPrevious : hasNext) return Math.max(-page, Math.min(page, dx));
    const extent = Math.max(width, 1);
    return Math.sign(dx) * extent * (1 - 1 / ((Math.abs(dx) * RESISTANCE) / extent + 1));
}

/**
 * A pane's last read screen, set the way the terminal sets it: the newest line
 * at the bottom, and a line wider than the phone cut at the edge rather than
 * wrapped. The read is at the desk's width, so the cut is honest about it.
 */
const PaneSnapshot = React.memo(({ sessionId, fontSize }: { sessionId: string; fontSize: number }) => {
    const text = usePaneSnapshot(sessionId);
    const lines = React.useMemo(() => (text ?? '').replace(/\s+$/, '').split('\n'), [text]);
    const lineHeight = fontSize * LINE_HEIGHT;
    return (
        <View pointerEvents="none" style={styles.snapshot}>
            {lines.map((line, index) => (
                <Text key={index} numberOfLines={1} ellipsizeMode="clip" style={[styles.line, { fontSize, lineHeight }]}>
                    {line === '' ? ' ' : line}
                </Text>
            ))}
        </View>
    );
});

/** The page beside this one: the agent's screen, and whose it is. */
const PeerPage = React.memo(({ card, fontSize }: { card: LiveTerminalOrderCard; fontSize: number }) => {
    const { theme } = useUnistyles();
    const labels = agentLabels(card);
    const status = agentStatusColor(card.agentStatus, theme);
    const statusLabel = card.agentStatus === 'idle' || card.agentStatus === 'unknown' ? undefined : HERD_STATUS_LABELS[card.agentStatus];
    return (
        <>
            <PaneSnapshot sessionId={card.id} fontSize={fontSize} />
            <View style={[styles.identity, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                <AgentGlyph name={isShellLabels(labels) ? 'shell' : labels.agentKind ?? labels.agentName} size={14} />
                <Text numberOfLines={1} style={[styles.identityTitle, { color: theme.colors.text }]}>{labels.taskTitle}</Text>
                {statusLabel !== undefined && <View style={[styles.identityDot, { backgroundColor: status.color }]} />}
            </View>
        </>
    );
});

export interface AgentPagerProps {
    sessionId: string;
    previous?: LiveTerminalOrderCard;
    next?: LiveTerminalOrderCard;
    /** The pane's status; the picture a swipe arrived with stays until it first paints. */
    status: string;
    /** A drag with no agent on either side ends here. */
    onNothingThere: () => void;
    onSwitch: (sessionId: string) => void;
    /** The live terminal, beneath everything the pane draws over it. */
    terminal: (onFirstFrameWritten: () => void) => React.ReactNode;
    children?: React.ReactNode;
}

export function AgentPager({ sessionId, previous, next, status, onNothingThere, onSwitch, terminal, children }: AgentPagerProps) {
    const { theme } = useUnistyles();
    // A snapshot is set in the live grid's own cell, so a page arrives at the
    // size it will stay: the renderers size their faces differently, but both
    // report how many columns the page holds.
    const [pageWidth, setPageWidth] = React.useState(0);
    const columns = terminalColumns(sessionId);
    if (columns > 0 && pageWidth > 0) lastCellWidth = pageWidth / columns;
    const settingSize = FONT_STEPS[clampFontIndex(useLocalSetting('terminalFontIndex'))];
    const swipe = useLocalSetting('terminalSwipeFingers');
    const fingers = swipe === 'two' ? 2 : 1;
    const fontSize = lastCellWidth > 0 ? lastCellWidth / MONO_ADVANCE : settingSize;
    const width = useSharedValue(0);
    const offset = useSharedValue(0);
    const hasPrevious = useSharedValue(previous !== undefined);
    const hasNext = useSharedValue(next !== undefined);
    const startedAt = useSharedValue(0);
    const startSpread = useSharedValue(0);
    const committed = useSharedValue(0);
    const [arrived] = React.useState(() => arrivingBySwipe(sessionId));
    // The picture holds until the terminal has painted once: through the
    // attach and the wait for its first frame, never over an error or later.
    const [painted, setPainted] = React.useState(false);
    const onFirstFrameWritten = React.useCallback(() => setPainted(true), []);
    const holdPicture = arrived && !painted && (status === 'connecting' || status === 'reconnecting' || status === 'live');
    React.useEffect(() => {
        if (arriving === sessionId) arriving = null;
    }, [sessionId]);

    const peers = React.useRef({ previous, next });
    peers.current = { previous, next };
    React.useEffect(() => {
        hasPrevious.value = previous !== undefined;
        hasNext.value = next !== undefined;
    }, [hasNext, hasPrevious, next, previous]);

    const warm = React.useCallback((maxAgeMs: number) => {
        const { previous: before, next: after } = peers.current;
        if (before !== undefined) void refreshPaneSnapshot(before.id, maxAgeMs);
        if (after !== undefined) void refreshPaneSnapshot(after.id, maxAgeMs);
    }, []);
    React.useEffect(() => { warm(WARM_ON_OPEN_MS); }, [previous?.id, next?.id, warm]);

    const nothingThere = React.useRef(onNothingThere);
    nothingThere.current = onNothingThere;
    const switchTo = React.useRef(onSwitch);
    switchTo.current = onSwitch;
    // +1 is the next agent: the page the finger pulled in from the right. The
    // page a release commits to is the one it lands on, even if the strip
    // changes while it settles; its terminal starts opening at the release.
    const committedTo = React.useRef<string | undefined>(undefined);
    const commit = React.useCallback((direction: 1 | -1) => {
        const target = direction === 1 ? peers.current.next : peers.current.previous;
        committedTo.current = target?.id;
        hapticsSelection();
        if (target !== undefined) openTerminalAhead(target.id);
    }, []);
    const arrive = React.useCallback(() => {
        const target = committedTo.current;
        committedTo.current = undefined;
        if (target === undefined) {
            committed.value = 0;
            offset.value = withSpring(0, SETTLE);
            return;
        }
        arriving = target;
        switchTo.current(target);
    }, [committed, offset]);
    const release = React.useCallback(() => {
        if (peers.current.previous === undefined && peers.current.next === undefined) nothingThere.current();
    }, []);

    const pan = React.useMemo(() => Gesture.Pan()
        .enabled(swipe !== 'off')
        .minPointers(fingers)
        .maxPointers(fingers)
        .activeOffsetX([-X_ACTIVATE, X_ACTIVATE])
        .failOffsetY([-Y_FAIL, Y_FAIL])
        .hitSlop({ horizontal: -EDGE_INSET })
        .onTouchesDown((event, manager) => {
            // A mouse on the web is selecting text; a finger or a pen turns
            // pages -- once the last turn has landed.
            if (event.pointerType === PointerType.MOUSE || committed.value === 1) {
                manager.fail();
                return;
            }
            const [a, b] = event.allTouches;
            if (a !== undefined && b !== undefined) startSpread.value = Math.hypot(a.x - b.x, a.y - b.y);
        })
        .onTouchesMove((event, manager) => {
            if (event.state === STATE_ACTIVE) return;
            // Resting first and then moving is the terminal's text selection.
            if (fingers === 1 && Date.now() - startedAt.value > INTENT_WINDOW) manager.fail();
            // Two fingers moving apart or together are zooming, not switching.
            const [a, b] = event.allTouches;
            if (fingers === 2 && a !== undefined && b !== undefined && startSpread.value > 0
                && Math.abs(Math.hypot(a.x - b.x, a.y - b.y) / startSpread.value - 1) > PINCH_SPREAD) manager.fail();
        })
        .onBegin(() => {
            startedAt.value = Date.now();
            scheduleOnRN(warm, WARM_ON_TOUCH_MS);
        })
        .onUpdate((event) => {
            offset.value = follow(event.translationX, width.value, hasPrevious.value, hasNext.value);
        })
        .onEnd((event) => {
            const travel = event.translationX;
            const direction = travel < 0 ? 1 : -1;
            const open = direction === 1 ? hasNext.value : hasPrevious.value;
            const flung = Math.abs(event.velocityX) >= FLING_VELOCITY && Math.abs(travel) >= FLING_DISTANCE;
            const turns = flung ? Math.sign(event.velocityX) === Math.sign(travel) : Math.abs(travel) >= width.value * COMMIT_SHARE;
            if (!open || !turns) {
                offset.value = withSpring(0, { ...SETTLE, velocity: event.velocityX });
                if (!open) scheduleOnRN(release);
                return;
            }
            committed.value = 1;
            scheduleOnRN(commit, direction);
            offset.value = withSpring(-direction * (width.value + PAGE_GAP), { ...SETTLE, velocity: event.velocityX }, (finished) => {
                if (finished === true) scheduleOnRN(arrive);
            });
        })
        .onFinalize((event) => {
            if (committed.value === 1 || event.state !== STATE_CANCELLED) return;
            offset.value = withSpring(0, SETTLE);
        }), [arrive, commit, committed, fingers, hasNext, hasPrevious, offset, release, startSpread, startedAt, swipe, warm, width]);

    // Android's terminal is a native view with its own touch handling. Once
    // the pager takes a drag, this hands the terminal a cancel for it, so a
    // turned page never leaves a long press or a fling running behind it.
    const terminalTouch = React.useMemo(() => Gesture.Native(), []);

    const current = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
    const before = useAnimatedStyle(() => ({
        opacity: width.value > 0 ? 1 : 0,
        transform: [{ translateX: offset.value - width.value - PAGE_GAP }],
    }));
    const after = useAnimatedStyle(() => ({
        opacity: width.value > 0 ? 1 : 0,
        transform: [{ translateX: offset.value + width.value + PAGE_GAP }],
    }));

    const page = <Animated.View style={[styles.page, current]}>
        {Platform.OS === 'android'
            ? <GestureDetector gesture={terminalTouch}><View collapsable={false} style={styles.page}>{terminal(onFirstFrameWritten)}</View></GestureDetector>
            : terminal(onFirstFrameWritten)}
        {holdPicture && (
            <Animated.View pointerEvents="none" exiting={FadeOut.duration(140).reduceMotion(ReduceMotion.System)} style={StyleSheet.absoluteFill}>
                <PaneSnapshot sessionId={sessionId} fontSize={fontSize} />
            </Animated.View>
        )}
        {children}
    </Animated.View>;

    return (
        <GestureDetector gesture={pan} touchAction="pan-y" userSelect="auto" enableContextMenu>
            <View
                collapsable={false}
                onLayout={(event) => {
                    width.value = event.nativeEvent.layout.width;
                    setPageWidth(event.nativeEvent.layout.width);
                }}
                style={[styles.page, { overflow: 'hidden', backgroundColor: theme.colors.terminalChrome.chrome }]}
            >
                {previous !== undefined && (
                    <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[StyleSheet.absoluteFill, before]}>
                        <PeerPage card={previous} fontSize={fontSize} />
                    </Animated.View>
                )}
                {next !== undefined && (
                    <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[StyleSheet.absoluteFill, after]}>
                        <PeerPage card={next} fontSize={fontSize} />
                    </Animated.View>
                )}
                {page}
            </View>
        </GestureDetector>
    );
}

const styles = StyleSheet.create({
    page: { flex: 1 },
    snapshot: {
        flex: 1,
        justifyContent: 'flex-end',
        overflow: 'hidden',
        backgroundColor: '#0c0c0b',
    },
    line: {
        ...Typography.mono(),
        color: TERMINAL_INK,
    },
    identity: {
        position: 'absolute',
        top: 12,
        alignSelf: 'center',
        maxWidth: '80%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
    },
    identityTitle: { flexShrink: 1, fontSize: 12, fontWeight: '500' },
    identityDot: { width: 6, height: 6, borderRadius: 3 },
});
