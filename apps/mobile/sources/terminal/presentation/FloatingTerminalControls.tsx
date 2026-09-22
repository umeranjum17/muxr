import * as React from 'react';
import { BackHandler, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, interpolateColor, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/catalog/store';
import { hapticsLight, hapticsSelection } from '@/components/haptics';
import { RING_CAPTION_WIDTH, clusterLayout, ringFan, slotUnderFinger, type ClusterLayout } from '../domain/ringGeometry';

/** Same contract as the old panel strip; the terminal view reports these. */
export type TerminalCommand = {
    label: string;
    icon: 'keyboard' | 'minus' | 'plus' | 'reset' | 'close' | 'branch' | 'folder' | 'tools';
    run: () => void;
    disabled?: boolean;
};

/** One ring slot: an action that fires on lift. */
export type RingSlot = {
    id: string;
    /** The action's name, as assistive tech reads it. */
    label: string;
    /** One word for the caption under the disc; falls back to `label`. The
     *  caption has one chord of room, so a name that would be clipped there
     *  says less than a shorter one that fits. */
    short?: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    /** Count badge, e.g. Review changes · N; hidden while undefined. */
    badge?: number;
    /** Opens the directional cluster in place of the ring instead of running. */
    opens?: 'cluster';
    run: () => void;
};

/** One key of the directional cluster: exact bytes, never an interpretation. */
export type ClusterKey = {
    id: string;
    label: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    /** Where it sits on the 3x3 cross. */
    at: 'up' | 'left' | 'centre' | 'right' | 'down';
    repeat?: boolean;
    run: () => void;
};

/** What the screen may do to the ring from outside it. */
export type RingHandle = { close: () => void };

/**
 * The floating control and its ring. The control belongs to the TERMINAL, not
 * to the composer: it rests on the terminal surface where the thumb left it,
 * and the arc is struck from wherever that is.
 */
const CENTER = 44;
const CENTER_ICON = 18;
/** Keep the resting control this far from the terminal's own edges. */
const EDGE = 16;
/** Where an untouched control rests: bottom-right, a thumb-reach up from the
 *  composer, clear of the centred jump-to-latest pill. */
const REST_BOTTOM_PAD = 72;
// Slots render at a disc size that follows the terminal's width: the full
// 48dp discs on reference-width phones, a 38dp set on narrow PWA panes.
const slotSize = (width: number): number => (width < 340 ? 38 : 48);
const RING_CAP = 6;
const MOVE_THRESHOLD = 8;
const PICKUP_MS = 400;
const OPEN_MS = 180;
const CLOSE_MS = 130;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * The terminal's quick actions: a floating control resting on the terminal
 * itself, blooming into a ring of labelled circular actions struck from that
 * control's own position. Tap opens and it stays; press and slide to a slot
 * and lift fires it in one motion; hold picks the control up and where it
 * comes to rest is remembered. Tap outside, lift on nothing, or hardware back
 * collapses it. The ring never dismisses the keyboard, and it is the only
 * quick-actions overlay at a time: the Arrows slot stands the control down and
 * hands the surface to the cluster, which dismisses through its own layer or
 * hardware back.
 *
 * Everything that moves per frame — the bloom, the highlight, the scrim, the
 * drag — is a shared value read on the UI thread. The component re-renders
 * when the ring opens, when it closes, and when a drag ends; never while one
 * of those is running.
 */
export const FloatingTerminalControls = React.forwardRef<RingHandle, {
    /** Region width (the terminal surface): the control and ring stay inside it. */
    width: number;
    /** The overlay's full height: terminal top down past the rails below it. */
    height: number;
    /** How much of that is terminal. The control rests only here, and the arc
     *  stays here too unless the terminal is too short to hold it. */
    terminalHeight: number;
    slots: readonly RingSlot[];
    /** The cross a slot with `opens: 'cluster'` summons. */
    clusterKeys?: readonly ClusterKey[];
    /** 0 at rest, 1 while the ring is open: the screen's rails recede by it. */
    dim: SharedValue<number>;
}>(function FloatingTerminalControls({ width, height, terminalHeight, slots, clusterKeys, dim }, handle) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const [rest, setRest] = useLocalSettingMutable('terminalCommandKeyDock');
    // Every action reaches every pane: the arc spends its gap and its disc
    // size before it would drop a slot, so no width cap may truncate the ring
    // (the reference 270dp phone lost its last action to one).
    const count = Math.min(slots.length, RING_CAP);
    // One overlay at a time: the cluster is the control's second mode, not a
    // second control. The ring is a pick-one-and-it-closes menu; the cluster is
    // a tool you press over and over, so it stays until it is dismissed and it
    // lays no scrim — the terminal it is steering has to stay readable behind
    // it. Holding them in one value is what keeps them from stacking.
    const [overlay, setOverlay] = React.useState<'none' | 'ring' | 'cluster'>('none');
    const open = overlay === 'ring';
    React.useImperativeHandle(handle, () => ({ close: () => setOverlay('none') }), []);

    // Where the control rests, in region coordinates. The fraction form is
    // what survives app restarts and terminal resizes.
    const travelX = Math.max(0, width - CENTER - EDGE * 2);
    const travelY = Math.max(0, terminalHeight - CENTER - EDGE * 2);
    const center = React.useMemo(() => {
        const y = EDGE + clamp01(rest?.fy ?? 1) * travelY + CENTER / 2 - (rest === null || rest === undefined ? Math.min(REST_BOTTOM_PAD, travelY) : 0);
        return {
            x: EDGE + clamp01(rest?.fx ?? 1) * travelX + CENTER / 2,
            // On a terminal shorter than the control plus its edge padding the
            // padding is what gives way, not the containment: the control sits
            // tight to the edge rather than hanging past it into the key row.
            y: Math.min(Math.max(y, CENTER / 2), Math.max(terminalHeight - CENTER / 2, CENTER / 2)),
        };
    }, [rest, travelX, travelY, terminalHeight]);
    const disc = slotSize(width);
    const fan = React.useMemo(
        () => ringFan(center, { width, height }, terminalHeight, count, disc),
        [center, width, height, terminalHeight, count, disc],
    );
    const offsets = fan.offsets;
    // The cluster's own placement, solved once per render. Null when the
    // terminal cannot hold a 38dp key.
    const clusterSpot = React.useMemo(
        () => (clusterKeys !== undefined && clusterKeys.length > 0
            ? clusterLayout(center, { width, height: terminalHeight })
            : null),
        [clusterKeys, center, width, terminalHeight],
    );
    // The cluster owns the surface while it is up, so the control stands down
    // and the two can never stack. A terminal too short to hold a 38dp key
    // declines the cluster, so the mode resolves to nothing the moment its
    // placement is gone: the control comes back as the open control rather
    // than latching a mode it cannot draw, and the next tap opens the ring.
    const cluster = overlay === 'cluster' && clusterSpot !== null;
    /** Either overlay is up, which is what the control's own state reflects. */
    const up = open || cluster;
    // A placement that disappears takes its mode with it, or the state left
    // behind re-arms the cluster by itself when the terminal grows back.
    React.useEffect(() => {
        if (overlay === 'cluster' && clusterSpot === null) setOverlay('none');
    }, [overlay, clusterSpot]);

    // The ring exists while it is open or while a sweep is in flight; one
    // shared progress drives both directions, so closing collapses the arc
    // back into the control with no second animation system.
    const [sweeping, setSweeping] = React.useState(false);
    const visible = open || sweeping;
    // The swept slot lives on the UI thread: a finger crossing the arc must
    // move highlights without re-rendering anything.
    const highlight = useSharedValue(-1);
    const progress = useSharedValue(0);
    const lifted = useSharedValue(0);
    React.useEffect(() => {
        const to = visible ? 1 : 0;
        if (reduceMotion) { progress.value = to; dim.value = to; return; }
        progress.value = withTiming(to, { duration: visible ? OPEN_MS : CLOSE_MS, easing: Easing.bezier(0.23, 1, 0.32, 1) });
        dim.value = withTiming(to, { duration: visible ? OPEN_MS : CLOSE_MS, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    }, [visible, reduceMotion, progress, dim]);
    React.useEffect(() => () => { dim.value = 0; }, [dim]);

    React.useEffect(() => {
        if (!up) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setOverlay('none'); return true; });
        return () => subscription.remove();
    }, [up]);

    // Everything the stable responder closures read, one ref behind.
    const live = React.useRef({ center, offsets, travelX, travelY });
    live.current = { center, offsets, travelX, travelY };
    const slotsRef = React.useRef(slots);
    slotsRef.current = slots;
    const gesture = React.useRef({
        phase: 'idle' as 'idle' | 'sweep' | 'drag',
        /** A hold asked to pick the control up. The drag itself begins when
         *  the responder is granted, so a hold that never moves leaves nothing
         *  half-started behind. */
        armed: false,
        grantDx: 0,
        grantDy: 0,
        /** The finger's offset from the control's centre when the sweep began. */
        fromCenterX: 0,
        fromCenterY: 0,
        grabX: 0,
        grabY: 0,
    });
    // The control's live position while a drag is in flight, as an offset from
    // where it rests. Nothing is committed until the finger lifts.
    const dragX = useSharedValue(0);
    const dragY = useSharedValue(0);

    const endSweep = React.useCallback(() => {
        setSweeping(false);
        highlight.value = -1;
    }, [highlight]);
    const fire = React.useCallback((index: number) => {
        hapticsSelection();
        endSweep();
        const slot = slotsRef.current[index];
        // A terminal too short to hold a 38dp key declines the cluster: the
        // slot's own run reports where the arrows still are instead.
        if (slot?.opens === 'cluster' && clusterSpot !== null) { setOverlay('cluster'); return; }
        setOverlay('none');
        slot?.run();
    }, [endSweep, clusterSpot]);
    const releaseDrag = React.useCallback(() => {
        if (gesture.current.phase !== 'drag') return;
        gesture.current.phase = 'idle';
        lifted.value = withTiming(0, { duration: 140 });
        const { center: from, travelX: rx, travelY: ry } = live.current;
        const x = from.x + dragX.value - CENTER / 2;
        const y = from.y + dragY.value - CENTER / 2;
        dragX.value = 0;
        dragY.value = 0;
        setRest({ fx: clamp01(rx === 0 ? 1 : (x - EDGE) / rx), fy: clamp01(ry === 0 ? 1 : (y - EDGE) / ry) });
    }, [dragX, dragY, lifted, setRest]);

    const pan = React.useRef(PanResponder.create({
        // The ring blooms on the first 8dp of travel rather than on
        // finger-down, which keeps tap discrimination on the platform's own
        // press path (Pressable) and avoids a second timing heuristic.
        onMoveShouldSetPanResponderCapture: (_event, state) => Math.hypot(state.dx, state.dy) >= MOVE_THRESHOLD,
        onPanResponderGrant: (event, state) => {
            const g = gesture.current;
            g.grantDx = state.dx;
            g.grantDy = state.dy;
            if (g.armed) {
                // The hold is the pickup: the drag owns the gesture from here,
                // and only its own release or terminate ends it.
                g.armed = false;
                g.phase = 'drag';
                g.grabX = dragX.value;
                g.grabY = dragY.value;
                lifted.value = withTiming(1, { duration: 140 });
                return;
            }
            // The responder IS the control, so the touch already answers where
            // the finger is relative to its centre. No window measurement, and
            // so no coordinate space to get wrong.
            g.fromCenterX = event.nativeEvent.locationX - CENTER / 2;
            g.fromCenterY = event.nativeEvent.locationY - CENTER / 2;
            g.phase = 'sweep';
            hapticsLight();
            // A slide off a held-open cluster switches modes; it never stacks
            // the ring's scrim and slots under the cross.
            setOverlay((current) => (current === 'cluster' ? 'none' : current));
            setSweeping(true);
        },
        onPanResponderMove: (_event, state) => {
            const g = gesture.current;
            if (g.phase === 'drag') {
                const { center: from, travelX: rx, travelY: ry } = live.current;
                dragX.value = clamp(g.grabX + state.dx - g.grantDx, EDGE + CENTER / 2 - from.x, EDGE + rx + CENTER / 2 - from.x);
                dragY.value = clamp(g.grabY + state.dy - g.grantDy, EDGE + CENTER / 2 - from.y, EDGE + ry + CENTER / 2 - from.y);
                return;
            }
            const index = slotUnderFinger({
                x: g.fromCenterX + (state.dx - g.grantDx),
                y: g.fromCenterY + (state.dy - g.grantDy),
            }, live.current.offsets);
            const next = index ?? -1;
            if (highlight.value !== next) {
                highlight.value = next;
                if (next >= 0) hapticsSelection();
            }
        },
        onPanResponderRelease: (_event, state) => {
            const g = gesture.current;
            g.armed = false;
            if (g.phase === 'drag') { releaseDrag(); return; }
            g.phase = 'idle';
            const index = slotUnderFinger({
                x: g.fromCenterX + (state.dx - g.grantDx),
                y: g.fromCenterY + (state.dy - g.grantDy),
            }, live.current.offsets);
            if (index !== null) { fire(index); return; }
            endSweep();
        },
        onPanResponderTerminate: () => {
            const g = gesture.current;
            g.armed = false;
            releaseDrag();
            g.phase = 'idle';
            endSweep();
        },
        onPanResponderTerminationRequest: () => false,
    })).current;

    const scrim = useAnimatedStyle(() => ({ opacity: progress.value }));
    const controlStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: dragX.value }, { translateY: dragY.value }, { scale: 1 + lifted.value * 0.08 }],
    }));

    // At rest the control is a quiet disc on the terminal; opening it raises
    // the same material to the ring's own weight rather than swapping it for a
    // different one.
    const controlSurface = useAnimatedStyle(() => ({
        // Interpolated, not switched at the midpoint: a step change in the
        // control's own fill is the one frame of the open that reads as a jump.
        backgroundColor: interpolateColor(progress.value, [0, 1], [theme.colors.terminalChrome.resting, theme.colors.terminalChrome.floating]),
        borderColor: interpolateColor(progress.value, [0, 1], [theme.colors.glass.border, theme.colors.glass.highlight]),
    }));

    if (count === 0) return null;
    // Below its own size the control cannot sit inside the terminal at all, and
    // this view does not clip: it would hang over the key row and take touches
    // meant for those keys. Refuse rather than misplace.
    if (terminalHeight < CENTER) return null;

    return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {/* The considered surface behind the ring: the terminal recedes so
                every action reads cleanly against it instead of floating naked
                over output. It is also the dismiss target — a lift anywhere off
                the arc closes. A sweep owns its own touches, so it never sees
                this. */}
            <Animated.View
                collapsable={false}
                pointerEvents={open ? 'auto' : 'none'}
                style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.terminalChrome.scrim }, scrim]}
            >
                {open && <Pressable style={StyleSheet.absoluteFill} accessible={false} accessibilityLabel="Close terminal quick actions" onPress={() => setOverlay('none')} />}
            </Animated.View>
            {slots.slice(0, offsets.length).map((slot, index) => (
                <RingSlotView
                    key={slot.id}
                    slot={slot}
                    index={index}
                    offset={offsets[index]!}
                    anchor={center}
                    region={{ width, height }}
                    progress={progress}
                    highlight={highlight}
                    reduceMotion={reduceMotion === true}
                    visible={visible}
                    disc={fan.disc}
                    caption={fan.captions}
                    onPress={() => fire(index)}
                />
            ))}
            {/* The cluster's own way out now that the control stands down: a
                transparent layer over the terminal, so a press anywhere off a
                key closes it while the terminal stays readable behind — no
                scrim. Hardware back closes it too. */}
            {cluster && (
                <Pressable
                    style={{ position: 'absolute', left: 0, top: 0, width, height: terminalHeight }}
                    accessible={false}
                    accessibilityLabel="Close arrow keys"
                    onPress={() => setOverlay('none')}
                />
            )}
            {clusterSpot !== null && cluster && clusterKeys !== undefined && (
                <ArrowCluster keys={clusterKeys} layout={clusterSpot} reduceMotion={reduceMotion === true} />
            )}
            {!cluster && (
            <Animated.View
                {...pan.panHandlers}
                collapsable={false}
                style={[{ position: 'absolute', left: center.x - CENTER / 2, top: center.y - CENTER / 2, width: CENTER, height: CENTER }, controlStyle]}
            >
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={up ? 'Close terminal quick actions' : 'Terminal quick actions'}
                    accessibilityHint="Quick actions around the control. Tap to open, press and slide to one, or hold to move it."
                    accessibilityState={{ expanded: up }}
                    accessibilityActions={[{ name: 'reset', label: 'Reset position' }]}
                    onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'reset') setRest(null); }}
                    // A still short touch is tap mode; the sweep never reaches
                    // here because the responder has claimed it, and a hold
                    // became a drag below.
                    onPress={() => { hapticsLight(); setOverlay(up ? 'none' : 'ring'); }}
                    onLongPress={() => {
                        gesture.current.armed = true;
                        setOverlay('none');
                        endSweep();
                        hapticsLight();
                    }}
                    // The press ends here whether it was tapped, held, or
                    // handed to the drag, so a hold that never moved cannot
                    // arm the next press-and-slide.
                    onPressOut={() => { gesture.current.armed = false; }}
                    delayLongPress={PICKUP_MS}
                    pressRetentionOffset={{ top: 40, bottom: 40, left: 40, right: 40 }}
                    hitSlop={8}
                    style={({ pressed }) => ({ width: CENTER, height: CENTER, opacity: pressed ? 0.85 : 1 })}
                >
                    <Animated.View style={[{
                        width: CENTER, height: CENTER, borderRadius: CENTER / 2,
                        alignItems: 'center', justifyContent: 'center',
                        borderWidth: StyleSheet.hairlineWidth,
                    }, controlSurface]}>
                        <RingGlyph progress={progress} pinned={cluster} color={theme.colors.text} />
                    </Animated.View>
                </Pressable>
            </Animated.View>
            )}
        </View>
    );
});

/**
 * The directional cluster: the arrow keys as a thumb-sized cross floating on
 * the terminal, in the same material as the control that summoned it.
 *
 * It lays no scrim, unlike the ring. The cross is a tool for steering what is
 * behind it — a shell history, a TUI's selection — so the terminal has to stay
 * readable through it, and the keys are translucent for exactly that reason.
 * It stays up until it is dismissed, because the arrows are pressed in runs.
 *
 * The keys send the row's own bytes: nothing here interprets a key, it only
 * draws one at a size a thumb can find without looking.
 */
function ArrowCluster({ keys, layout, reduceMotion }: {
    keys: readonly ClusterKey[];
    /** The cluster's solved placement: a cross, or the short terminal's band. */
    layout: ClusterLayout;
    reduceMotion: boolean;
}) {
    const { theme } = useUnistyles();
    return (
        <Animated.View
            entering={reduceMotion ? undefined : FadeIn.duration(140)}
            exiting={reduceMotion ? undefined : FadeOut.duration(110)}
            style={{ position: 'absolute', left: layout.left, top: layout.top, width: layout.width, height: layout.height }}
        >
            {keys.map((key) => (
                <ClusterKeyView key={key.id} entry={key} theme={theme} size={layout.key} seat={layout.seats[key.at]} />
            ))}
        </Animated.View>
    );
}

function ClusterKeyView({ entry, theme, size, seat }: { entry: ClusterKey; theme: ReturnType<typeof useUnistyles>['theme']; size: number; seat: { left: number; top: number } }) {
    // Hold to repeat, the same 80ms the key row uses, so a long press walks
    // history at the same speed from either surface.
    const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const stop = React.useCallback(() => {
        if (timer.current !== null) { clearInterval(timer.current); timer.current = null; }
    }, []);
    React.useEffect(() => stop, [stop]);
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={entry.label}
            onPress={() => { hapticsSelection(); entry.run(); }}
            onLongPress={entry.repeat !== true ? undefined : () => { stop(); timer.current = setInterval(() => entry.run(), 80); }}
            delayLongPress={400}
            onPressOut={stop}
            style={({ pressed }) => ({
                position: 'absolute',
                left: seat.left,
                top: seat.top,
                width: size,
                height: size,
                borderRadius: Math.round(size * 0.3),
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? theme.colors.terminalChrome.clusterPressed : theme.colors.terminalChrome.cluster,
            })}
        >
            {/* Full white, not the text grey: the glyph is the whole point of
                the key and it has to survive whatever the terminal draws
                behind it. */}
            <Ionicons name={entry.icon} size={Math.round(size * 0.5) + (entry.at === 'centre' ? 2 : 0)} color="#ffffff" />
        </Pressable>
    );
}

/**
 * The control's mark. A broken circle here read as a progress spinner — the
 * one thing a resting control must never say — and a bespoke arc of dots read
 * as nothing at all. This is the ordinary "more controls" grid at rest,
 * turning into the close it actually is once the ring is open, so the same
 * thumb that opened it knows without looking what a second tap will do. Both
 * marks are drawn from the ring's own progress, so the swap rides the bloom
 * instead of running a second animation off a re-render.
 */
function RingGlyph({ progress, pinned, color }: { progress: SharedValue<number>; pinned: boolean; color: string }) {
    const resting = useAnimatedStyle(() => ({ opacity: pinned ? 0 : 1 - progress.value, transform: [{ rotate: `${progress.value * 90}deg` }] }));
    const opened = useAnimatedStyle(() => ({ opacity: pinned ? 1 : progress.value, transform: [{ rotate: `${(progress.value - 1) * 90}deg` }] }));
    const layer = { ...StyleSheet.absoluteFillObject, alignItems: 'center' as const, justifyContent: 'center' as const };
    return (
        <View accessible={false} style={{ width: CENTER_ICON, height: CENTER_ICON }}>
            <Animated.View style={[layer, resting]}><Ionicons name="grid-outline" size={CENTER_ICON} color={color} /></Animated.View>
            <Animated.View style={[layer, opened]}><Ionicons name="close" size={CENTER_ICON + 4} color={color} /></Animated.View>
        </View>
    );
}

/**
 * One slot: a disc on the ring's material with its action named underneath.
 * Every slot is captioned, so the ring is readable the first time rather than
 * six glyphs to be learned. The disc travels from the control to its arc
 * position on open (staggered in arc order) and collapses back into it on
 * close; reduced motion fades it in place instead.
 */
function RingSlotView({ slot, index, offset, anchor, region, progress, highlight, reduceMotion, visible, disc, caption, onPress }: {
    slot: RingSlot;
    index: number;
    /** Slot centre as an offset from the anchor's centre. */
    offset: { x: number; y: number };
    anchor: { x: number; y: number };
    region: { width: number; height: number };
    progress: SharedValue<number>;
    highlight: SharedValue<number>;
    reduceMotion: boolean;
    visible: boolean;
    disc: number;
    /** False only where the pane was too tight to place one; the label still
     *  names the disc to assistive tech either way. */
    caption: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    // The stagger lives inside the interpolation: each slot's own progress is
    // the shared one shifted by its arc-order delay, so opening fans out and
    // closing collapses back together, all on the UI thread.
    const stagger = 0.08;
    const icon = Math.round(disc * 0.4);
    // The slot is laid out ON the control and travels out to its arc position,
    // so the bloom and the collapse are one transform. `nudge` is the only
    // static correction: a slot whose caption would otherwise overhang the
    // pane's edge arrives that much further inboard, and still leaves from the
    // control it opened out of.
    const labelWidth = RING_CAPTION_WIDTH(disc);
    const left = anchor.x - labelWidth / 2;
    const nudge = clamp(left + offset.x, 2, Math.max(2, region.width - labelWidth - 2)) - (left + offset.x);
    const travel = useAnimatedStyle(() => {
        const local = Math.max(0, Math.min(1, (progress.value - index * stagger) / (1 - index * stagger)));
        const lit = highlight.value === index;
        const other = highlight.value >= 0 && !lit;
        return {
            transform: [
                { translateX: (offset.x + nudge) * local },
                { translateY: offset.y * local },
                { scale: (reduceMotion ? 1 : 0.6 + local * 0.4) * (lit ? 1.12 : 1) },
            ],
            opacity: (reduceMotion ? progress.value : local) * (other ? 0.5 : 1),
        };
    });
    const surface = useAnimatedStyle(() => ({
        backgroundColor: highlight.value === index ? theme.colors.surfaceHighest : theme.colors.terminalChrome.floating,
        borderColor: highlight.value === index ? theme.colors.accent : theme.colors.glass.border,
    }));
    const captionTone = useAnimatedStyle(() => ({ color: highlight.value === index ? theme.colors.text : theme.colors.textSecondary }));
    const badge = slot.badge !== undefined && slot.badge > 0 ? (slot.badge > 99 ? '99+' : String(slot.badge)) : null;
    return (
        <Animated.View
            pointerEvents={visible ? 'box-none' : 'none'}
            accessibilityElementsHidden={!visible}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
            style={[{ position: 'absolute', left, top: anchor.y - disc / 2, width: labelWidth, alignItems: 'center' }, travel]}
        >
            <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={badge !== null ? `${slot.label}, ${slot.badge}` : slot.label}
                disabled={!visible}
                onPress={onPress}
                style={({ pressed }) => ({ width: disc, height: disc, opacity: pressed ? 0.8 : 1 })}
            >
                <Animated.View style={[{
                    width: disc, height: disc, borderRadius: disc / 2,
                    alignItems: 'center', justifyContent: 'center',
                    borderWidth: StyleSheet.hairlineWidth,
                }, surface]}>
                    <Ionicons name={slot.icon} size={icon} color={theme.colors.text} />
                </Animated.View>
                {badge !== null && <View style={{
                    position: 'absolute', top: -3, right: -3, minWidth: 16, height: 16, borderRadius: 8,
                    paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: theme.colors.status.working,
                }}>
                    <Text style={{ color: '#ffffff', fontSize: 10, lineHeight: 12, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{badge}</Text>
                </View>}
            </Pressable>
            {caption && <Animated.Text
                accessible={false}
                numberOfLines={1}
                style={[{
                    marginTop: 5,
                    width: labelWidth,
                    textAlign: 'center',
                    fontSize: 10,
                    lineHeight: 13,
                    fontWeight: '500',
                }, captionTone]}
            >{slot.short ?? slot.label}</Animated.Text>}
        </Animated.View>
    );
}
