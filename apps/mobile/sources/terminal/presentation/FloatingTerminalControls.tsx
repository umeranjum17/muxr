import * as React from 'react';
import { BackHandler, PanResponder, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { hapticsLight, hapticsSelection } from '@/components/haptics';
import { dockedRingOffsets, slotUnderFinger } from '../domain/ringGeometry';

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
    label: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    /** Count badge, e.g. Review changes · N; hidden while undefined. */
    badge?: number;
    run: () => void;
};

// The docked centre control and its ring: the centre lives in the composer's
// rail (the screen reserves its spot there), the slots bloom over the terminal.
const CENTER = 40;
const CENTER_ICON = 17;
// Slots render at a disc size that follows the terminal's width: the full
// 48dp discs on reference-width phones, a 44dp set on narrow PWA panes.
const slotSize = (width: number): number => (width < 340 ? 38 : 48);
const RING_CAP = 6;
const MOVE_THRESHOLD = 8;
const OPEN_MS = 160;
const CLOSE_MS = 120;
const LABEL_RADIUS = 132;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * The terminal's quick actions: a thumb-sized centre control docked in the
 * composer rail that blooms into a tight short-radius ring of small circular
 * actions over the terminal. Tap opens and it stays; press and slide to a
 slot and lift fires it in one motion; tap outside, lift on nothing, or
 * hardware back collapses it. The ring never dismisses the keyboard, and it
 * is the only quick-actions overlay at a time.
 */
export function FloatingTerminalControls({ open, onOpenChange, width, height, slots, anchor }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Region width (the terminal surface): the ring stays inside it. */
    width: number;
    /** Region height: terminal top down past the composer's top. */
    height: number;
    slots: readonly RingSlot[];
    /** Centre control position in region coordinates. */
    anchor: { x: number; y: number };
}) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    // Narrow panes carry five discs on the tight ellipse; reference-width
    // phones take all six.
    const count = Math.min(slots.length, RING_CAP, width < 340 ? 5 : RING_CAP);
    // Inside the region, always: a layout race between the rail's measurement
    // and the terminal's box must never park the centre off-screen.
    const center = React.useMemo(() => ({
        x: clamp(anchor.x, CENTER / 2 + 8, Math.max(CENTER / 2 + 8, width - CENTER / 2 - 8)),
        y: clamp(anchor.y, CENTER / 2 + 8, Math.max(CENTER / 2 + 8, height - CENTER / 2 - 8)),
    }), [anchor.x, anchor.y, width, height]);
    const disc = slotSize(width);
    const slotIcon = Math.round(disc * 0.4);
    // The fan solves on an elevation arc above the docked centre: slots stay
    // over the terminal, ring the thumb, and never wash over the composer.
    const offsets = React.useMemo(
        () => dockedRingOffsets(center, { width, height }, count, disc),
        [center, width, height, count, disc],
    );

    // The ring exists while the parent says open (tap mode) or while a sweep
    // is in flight; one shared progress drives both directions, so closing
    // collapses the fan back into the centre with no second animation system.
    const [sweeping, setSweeping] = React.useState(false);
    const visible = open || sweeping;
    const [highlight, setHighlight] = React.useState<number | null>(null);
    const progress = useSharedValue(0);
    React.useEffect(() => {
        if (reduceMotion) { progress.value = visible ? 1 : 0; return; }
        progress.value = withTiming(visible ? 1 : 0, { duration: visible ? OPEN_MS : CLOSE_MS, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    }, [visible, reduceMotion, progress]);

    React.useEffect(() => {
        if (!open) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onOpenChange(false); return true; });
        return () => subscription.remove();
    }, [onOpenChange, open]);

    // Everything the stable responder closures read, one ref behind.
    const live = React.useRef({ center, offsets });
    live.current = { center, offsets };
    const slotsRef = React.useRef(slots);
    slotsRef.current = slots;
    const gesture = React.useRef({
        phase: 'idle' as 'idle' | 'sweep',
        grantDx: 0,
        grantDy: 0,
        originX: 0,
        originY: 0,
    });
    const containerRef = React.useRef<View | null>(null);
    const containerOrigin = React.useRef({ x: 0, y: 0 });
    React.useEffect(() => {
        containerRef.current?.measureInWindow((x, y) => { containerOrigin.current = { x, y }; });
    }, [height, width]);

    const endSweep = React.useCallback(() => {
        setSweeping(false);
        setHighlight(null);
    }, []);
    const fire = React.useCallback((index: number) => {
        hapticsSelection();
        onOpenChange(false);
        endSweep();
        slotsRef.current[index]?.run();
    }, [endSweep, onOpenChange]);

    const sweep = React.useRef(PanResponder.create({
        // The ring fans on the first 8dp of travel rather than on finger-down,
        // which keeps tap discrimination on the platform's own press path
        // (Pressable) and avoids a second timing heuristic.
        onMoveShouldSetPanResponderCapture: (_event, pan) => Math.hypot(pan.dx, pan.dy) >= MOVE_THRESHOLD,
        onPanResponderGrant: (event, pan) => {
            gesture.current.grantDx = pan.dx;
            gesture.current.grantDy = pan.dy;
            gesture.current.originX = event.nativeEvent.pageX;
            gesture.current.originY = event.nativeEvent.pageY;
            gesture.current.phase = 'sweep';
            hapticsLight();
            setSweeping(true);
        },
        onPanResponderMove: (event, pan) => {
            const g = gesture.current;
            const finger = {
                x: g.originX + (pan.dx - g.grantDx) - containerOrigin.current.x,
                y: g.originY + (pan.dy - g.grantDy) - containerOrigin.current.y,
            };
            const now = live.current;
            const index = slotUnderFinger({ x: finger.x - now.center.x, y: finger.y - now.center.y }, now.offsets);
            setHighlight((current) => (current === index ? current : index));
        },
        onPanResponderRelease: (event, pan) => {
            gesture.current.phase = 'idle';
            const g = gesture.current;
            const finger = {
                x: g.originX + (pan.dx - g.grantDx) - containerOrigin.current.x,
                y: g.originY + (pan.dy - g.grantDy) - containerOrigin.current.y,
            };
            const now = live.current;
            const index = slotUnderFinger({ x: finger.x - now.center.x, y: finger.y - now.center.y }, now.offsets);
            if (index !== null) {
                fire(index);
                return;
            }
            endSweep();
        },
        onPanResponderTerminate: () => endSweep(),
        onPanResponderTerminationRequest: () => false,
    })).current;

    if (count === 0) return null;

    return (
        <View ref={containerRef} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {/* Tap mode only: a lift elsewhere dismisses. A sweep owns its
                touches, so it never sees this. */}
            {open && <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={() => onOpenChange(false)} />}
            {slots.slice(0, offsets.length).map((slot, index) => (
                <RingSlotView
                    key={slot.id}
                    slot={slot}
                    index={index}
                    offset={offsets[index]}
                    anchor={center}
                    region={{ width, height }}
                    progress={progress}
                    reduceMotion={reduceMotion === true}
                    visible={visible}
                    highlight={highlight}
                    disc={disc}
                    icon={slotIcon}
                    onPress={() => { onOpenChange(false); slot.run(); hapticsSelection(); }}
                />
            ))}
            {/* The docked centre control, drawn over the rail's reserved spot
                so the sweep responder and the ring live in one component. */}
            <Animated.View
                {...sweep.panHandlers}
                collapsable={false}
                style={[{ position: 'absolute', left: center.x - CENTER / 2, top: center.y - CENTER / 2, width: CENTER, height: CENTER }]}
            >
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={open ? 'Close terminal quick actions' : 'Terminal quick actions'}
                    accessibilityHint="Quick actions around your thumb. Tap to open, or press and slide to one."
                    accessibilityState={{ expanded: open }}
                    onPress={() => { hapticsLight(); onOpenChange(!open); }}
                    hitSlop={6}
                    style={({ pressed }) => ({
                        width: CENTER, height: CENTER, borderRadius: CENTER / 2,
                        alignItems: 'center', justifyContent: 'center',
                        opacity: pressed ? 0.78 : 1,
                    })}
                >
                    {Platform.OS === 'web'
                        ? <View style={{
                            width: CENTER, height: CENTER, borderRadius: CENTER / 2,
                            alignItems: 'center', justifyContent: 'center',
                            backgroundColor: visible ? theme.colors.glass.backgroundStrong : theme.colors.glass.backgroundSubtle,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: visible ? theme.colors.accent : theme.colors.glass.border,
                        }}>
                            <RingGlyph open={visible} color={visible ? theme.colors.accent : theme.colors.text} />
                        </View>
                        : <MobileGlassSurface intensity={76} interactive={false} style={{
                            width: CENTER, height: CENTER, borderRadius: CENTER / 2,
                            alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                            backgroundColor: visible ? theme.colors.glass.backgroundStrong : theme.colors.glass.backgroundSubtle,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: visible ? theme.colors.accent : theme.colors.glass.border,
                        }}>
                            <RingGlyph open={visible} color={visible ? theme.colors.accent : theme.colors.text} />
                        </MobileGlassSurface>}
                </Pressable>
            </Animated.View>
        </View>
    );
}

/**
 * The centre's mark. A broken circle here read as a progress spinner — the one
 * thing a resting control must never say — and a bespoke arc of dots read as
 * nothing at all. This is the ordinary "more controls" grid at rest, turning
 * into the close it actually is once the ring is open, so the same thumb that
 * opened it knows without looking what a second tap will do.
 */
function RingGlyph({ open, color }: { open: boolean; color: string }) {
    const reduceMotion = useReducedMotion();
    const bloom = useSharedValue(0);
    React.useEffect(() => {
        if (reduceMotion) { bloom.value = open ? 1 : 0; return; }
        bloom.value = withTiming(open ? 1 : 0, { duration: open ? OPEN_MS : CLOSE_MS, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    }, [open, reduceMotion, bloom]);
    const resting = useAnimatedStyle(() => ({ opacity: 1 - bloom.value, transform: [{ rotate: `${bloom.value * 90}deg` }] }));
    const opened = useAnimatedStyle(() => ({ opacity: bloom.value, transform: [{ rotate: `${(bloom.value - 1) * 90}deg` }] }));
    const layer: StyleProp<ViewStyle> = [StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }];
    return (
        <View accessible={false} style={{ width: CENTER_ICON, height: CENTER_ICON }}>
            <Animated.View style={[layer, resting]}><Ionicons name="grid-outline" size={CENTER_ICON} color={color} /></Animated.View>
            <Animated.View style={[layer, opened]}><Ionicons name="close" size={CENTER_ICON + 4} color={color} /></Animated.View>
        </View>
    );
}

/**
 * One slot disc plus its on-highlight label chip. The disc travels from the
 * anchor to its arc position on open (staggered in arc order) and collapses
 * back together on close; reduced motion fades it in place instead.
 */
function RingSlotView({ slot, index, offset, anchor, region, progress, reduceMotion, visible, highlight, disc, icon, onPress }: {
    slot: RingSlot;
    index: number;
    /** Slot centre as an offset from the anchor's centre. */
    offset: { x: number; y: number };
    anchor: { x: number; y: number };
    region: { width: number; height: number };
    progress: SharedValue<number>;
    reduceMotion: boolean;
    visible: boolean;
    highlight: number | null;
    disc: number;
    icon: number;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    // The stagger lives inside the interpolation: each slot's own progress is
    // the shared one shifted by its arc-order delay, so opening fans out and
    // closing still collapses together (the shift applies on the way in only).
    const stagger = 0.11;
    const travel = useAnimatedStyle(() => {
        const local = Math.max(0, Math.min(1, (progress.value - index * stagger) / (1 - index * stagger)));
        return {
            transform: [
                { translateX: offset.x * local },
                { translateY: offset.y * local },
                { scale: highlight === index ? 1.12 : 1 },
            ],
            opacity: reduceMotion ? progress.value : local * (highlight !== null && highlight !== index ? 0.45 : 1),
        };
    });
    const chipAngle = Math.atan2(offset.y, offset.x);
    const chipX = anchor.x + LABEL_RADIUS * Math.cos(chipAngle);
    const chipY = anchor.y + LABEL_RADIUS * Math.sin(chipAngle);
    const chipRight = chipX > region.width / 2;
    const badge = slot.badge !== undefined && slot.badge > 0 ? (slot.badge > 99 ? '99+' : String(slot.badge)) : null;
    const SLOT = disc;
    const SLOT_ICON = icon;
    const glass = (accent: boolean): StyleProp<ViewStyle> => ({
        width: SLOT, height: SLOT, borderRadius: SLOT / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: accent ? theme.colors.glass.backgroundStrong : theme.colors.glass.backgroundSubtle,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: accent ? theme.colors.accent : theme.colors.glass.border,
    });
    return <>
        <Animated.View
            pointerEvents={visible ? 'auto' : 'none'}
            accessibilityElementsHidden={!visible}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
            style={[{ position: 'absolute', left: anchor.x - SLOT / 2, top: anchor.y - SLOT / 2, width: SLOT, height: SLOT }, travel]}
        >
            <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={badge !== null ? `${slot.label}, ${slot.badge}` : slot.label}
                disabled={!visible}
                onPress={onPress}
                style={({ pressed }) => ({
                    width: SLOT, height: SLOT, borderRadius: SLOT / 2,
                    alignItems: 'center', justifyContent: 'center',
                    opacity: pressed ? 0.78 : 1,
                })}
            >
                {Platform.OS === 'web'
                    ? <View style={{
                        ...glass(highlight === index),
                        shadowColor: theme.colors.glass.shadow, shadowOffset: { width: 0, height: 8 }, shadowRadius: 18, shadowOpacity: 1,
                    }}>
                        <Ionicons name={slot.icon} size={SLOT_ICON} color={theme.colors.text} />
                    </View>
                    : <MobileGlassSurface intensity={76} interactive={false} style={glass(highlight === index)}>
                        <Ionicons name={slot.icon} size={SLOT_ICON} color={theme.colors.text} />
                    </MobileGlassSurface>}
                {badge !== null && <View style={{
                    position: 'absolute', top: -3, right: -3, minWidth: 16, height: 16, borderRadius: 8,
                    paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: theme.colors.accent,
                }}>
                    <Text style={{ color: theme.colors.surface, fontSize: 10, lineHeight: 12, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{badge}</Text>
                </View>}
            </Pressable>
        </Animated.View>
        {/* The label names the highlighted slot, one at a time, on its outward
            ray — slid horizontally so it never leaves the region, never
            rotated. */}
        {highlight === index && visible && <View
            pointerEvents="none"
            style={{
                position: 'absolute',
                top: Math.max(8, Math.min(region.height - 34, chipY - 12)),
                left: chipRight ? undefined : Math.min(Math.max(8, chipX), Math.max(8, region.width - 100)),
                right: chipRight ? Math.min(Math.max(8, region.width - chipX), Math.max(8, region.width - 100)) : undefined,
                borderRadius: 6,
                paddingHorizontal: 6, paddingVertical: 3,
                backgroundColor: theme.colors.glass.backgroundStrong,
                borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.glass.border,
            }}
        >
            <Text style={{ color: theme.colors.text, fontSize: 11, lineHeight: 15, fontWeight: '600' }}>{slot.label}</Text>
        </View>}
    </>;
}
