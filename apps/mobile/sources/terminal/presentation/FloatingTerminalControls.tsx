import * as React from 'react';
import { BackHandler, PanResponder, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/catalog/store';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { hapticsLight, hapticsSelection } from '@/components/haptics';
import { RING_SLOT_SIZE, ringSlotOffsets, slotUnderFinger } from '../domain/ringGeometry';

/** Same contract as the old panel strip; the ⋮ View group renders these rows. */
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

const KEY = 48;
const KEY_ICON = 20;
const KEY_EDGE = 16;
// The untouched puck rests a thumb-reach above the bottom edge, clear of the
// jump-to-bottom pill that lives at the corner.
const KEY_DEFAULT_BOTTOM_PAD = 64;
// Slots render at the geometry's disc size; the ring never holds more than
// five because a longer arc runs out of comfortable thumb angles.
const SLOT = RING_SLOT_SIZE;
const SLOT_ICON = 20;
const RING_CAP = 5;
const MOVE_THRESHOLD = 8;
const PICKUP_MS = 400;
const OPEN_MS = 160;
const CLOSE_MS = 120;
const LABEL_RADIUS = 132;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * The one way into the terminal's quick actions: a floating command puck over
 * the terminal, in the app's own glass language, carrying the sparkles mark
 * that reads as a command palette. Tap opens the ring and it stays; press and
 * slide to a slot and lift fires it in one motion; hold to move the puck,
 * and where it rests is remembered across sessions. The ring never dismisses
 * the keyboard, and it is the only quick-actions overlay at a time.
 */
export function FloatingTerminalControls({ open, onOpenChange, width, height, slots }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Terminal surface width: the puck stays inside it. */
    width: number;
    /** Height of the region the puck may rest in: terminal top down to the composer's top. */
    height: number;
    slots: readonly RingSlot[];
}) {
    const { theme } = useUnistyles();
    const [keyDock, setKeyDock] = useLocalSettingMutable('terminalCommandKeyDock');
    const reduceMotion = useReducedMotion();
    const count = Math.min(slots.length, RING_CAP);

    const anchor = React.useMemo(() => {
        const rx = Math.max(0, width - KEY - KEY_EDGE * 2);
        const ry = Math.max(0, height - KEY - KEY_EDGE * 2);
        const fx = clamp01(keyDock?.fx ?? 1);
        const fy = clamp01(keyDock?.fy ?? 1);
        return {
            x: KEY_EDGE + fx * rx + KEY / 2,
            y: KEY_EDGE + fy * ry + KEY / 2 - (keyDock === null || keyDock === undefined ? Math.min(KEY_DEFAULT_BOTTOM_PAD, Math.max(0, ry)) : 0),
        };
    }, [width, height, keyDock]);
    const offsets = React.useMemo(() => ringSlotOffsets(anchor, { width, height }, count), [anchor, width, height, count]);

    // The ring exists while the parent says open (tap mode) or while a sweep
    // is in flight; one shared progress drives both directions, so closing
    // collapses the fan back into the puck with no second animation system.
    const [sweeping, setSweeping] = React.useState(false);
    const visible = open || sweeping;
    const [highlight, setHighlight] = React.useState<number | null>(null);
    const progress = useSharedValue(0);
    React.useEffect(() => {
        if (reduceMotion) { progress.value = visible ? 1 : 0; return; }
        progress.value = withTiming(visible ? 1 : 0, { duration: visible ? OPEN_MS : CLOSE_MS, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    }, [visible, reduceMotion, progress]);

    // Puck position in region coordinates; the fraction form is what survives
    // app restarts and terminal resizes.
    const keyX = useSharedValue(anchor.x - KEY / 2);
    const keyY = useSharedValue(anchor.y - KEY / 2);
    const [dragging, setDragging] = React.useState(false);
    React.useEffect(() => {
        if (!dragging) {
            keyX.value = anchor.x - KEY / 2;
            keyY.value = anchor.y - KEY / 2;
        }
    }, [anchor, dragging, keyX, keyY]);
    const resetKeyPosition = React.useCallback(() => {
        setKeyDock(null);
    }, [setKeyDock]);

    React.useEffect(() => {
        if (!open) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onOpenChange(false); return true; });
        return () => subscription.remove();
    }, [onOpenChange, open]);

    // Everything the stable responder closures read, one ref behind.
    const live = React.useRef({ anchor, offsets, width, height, keyX, keyY });
    live.current = { anchor, offsets, width, height, keyX, keyY };
    const slotsRef = React.useRef(slots);
    slotsRef.current = slots;
    const gesture = React.useRef({
        phase: 'idle' as 'idle' | 'sweep' | 'drag',
        grantDx: 0,
        grantDy: 0,
        originX: 0,
        originY: 0,
        grabX: 0,
        grabY: 0,
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
    const persistDrag = React.useCallback(() => {
        const { width: w, height: h, keyX: x, keyY: y } = live.current;
        const rx = Math.max(0, w - KEY - KEY_EDGE * 2);
        const ry = Math.max(0, h - KEY - KEY_EDGE * 2);
        setKeyDock({ fx: clamp01(rx === 0 ? 1 : (x.value - KEY_EDGE) / rx), fy: clamp01(ry === 0 ? 1 : (y.value - KEY_EDGE) / ry) });
    }, [setKeyDock]);
    const releaseDrag = React.useCallback(() => {
        if (gesture.current.phase !== 'drag') return;
        gesture.current.phase = 'idle';
        setDragging(false);
        persistDrag();
    }, [persistDrag]);
    const fire = React.useCallback((index: number) => {
        hapticsSelection();
        onOpenChange(false);
        endSweep();
        slotsRef.current[index]?.run();
    }, [endSweep, onOpenChange]);

    const puckDrag = React.useRef(PanResponder.create({
        // ponytail: the ring fans on the first 8dp of travel rather than on
        // finger-down, which keeps tap discrimination on the platform's own
        // press path (Pressable) and avoids a second timing heuristic.
        onMoveShouldSetPanResponderCapture: (_event, pan) => {
            const g = gesture.current;
            return Math.hypot(pan.dx, pan.dy) >= MOVE_THRESHOLD || g.phase === 'drag';
        },
        onPanResponderGrant: (event, pan) => {
            const g = gesture.current;
            g.grantDx = pan.dx;
            g.grantDy = pan.dy;
            g.originX = event.nativeEvent.pageX;
            g.originY = event.nativeEvent.pageY;
            if (g.phase === 'drag') {
                g.grabX = live.current.keyX.value;
                g.grabY = live.current.keyY.value;
                return;
            }
            g.phase = 'sweep';
            hapticsLight();
            setSweeping(true);
        },
        onPanResponderMove: (_event, pan) => {
            const g = gesture.current;
            if (g.phase === 'drag') {
                const rx = Math.max(0, live.current.width - KEY - KEY_EDGE * 2);
                const ry = Math.max(0, live.current.height - KEY - KEY_EDGE * 2);
                live.current.keyX.value = KEY_EDGE + Math.max(0, Math.min(rx, g.grabX - KEY_EDGE + pan.dx));
                live.current.keyY.value = KEY_EDGE + Math.max(0, Math.min(ry, g.grabY - KEY_EDGE + pan.dy));
                return;
            }
            const finger = {
                x: g.originX + (pan.dx - g.grantDx) - containerOrigin.current.x,
                y: g.originY + (pan.dy - g.grantDy) - containerOrigin.current.y,
            };
            const anchorNow = live.current.anchor;
            const index = slotUnderFinger({ x: finger.x - anchorNow.x, y: finger.y - anchorNow.y }, live.current.offsets);
            setHighlight((current) => (current === index ? current : index));
        },
        onPanResponderRelease: (_event, pan) => {
            const g = gesture.current;
            if (g.phase === 'drag') {
                releaseDrag();
                return;
            }
            g.phase = 'idle';
            const finger = {
                x: g.originX + (pan.dx - g.grantDx) - containerOrigin.current.x,
                y: g.originY + (pan.dy - g.grantDy) - containerOrigin.current.y,
            };
            const anchorNow = live.current.anchor;
            const index = slotUnderFinger({ x: finger.x - anchorNow.x, y: finger.y - anchorNow.y }, live.current.offsets);
            if (index !== null) {
                fire(index);
                return;
            }
            endSweep();
        },
        onPanResponderTerminate: () => {
            releaseDrag();
            endSweep();
        },
        onPanResponderTerminationRequest: () => false,
    })).current;

    const keyPosition = useAnimatedStyle(() => ({ transform: [{ translateX: keyX.value }, { translateY: keyY.value }] }));

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
                    anchor={anchor}
                    region={{ width, height }}
                    progress={progress}
                    reduceMotion={reduceMotion === true}
                    visible={visible}
                    highlight={highlight}
                    onPress={() => { onOpenChange(false); slot.run(); hapticsSelection(); }}
                />
            ))}
            <Animated.View
                {...puckDrag.panHandlers}
                collapsable={false}
                onTouchStart={(event) => event.stopPropagation()}
                onTouchMove={(event) => event.stopPropagation()}
                onTouchEnd={(event) => event.stopPropagation()}
                style={[{ position: 'absolute', top: 0, left: 0, width: KEY, height: KEY }, keyPosition]}
            >
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={open ? 'Close terminal quick actions' : 'Terminal quick actions'}
                    accessibilityHint="Quick actions around your thumb. Tap to open, or press and slide to one. Hold to move."
                    accessibilityState={{ expanded: open }}
                    accessibilityActions={[{ name: 'reset', label: 'Reset position' }]}
                    onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'reset') resetKeyPosition(); }}
                    // A still short touch is tap mode; the sweep never reaches
                    // here because the responder has claimed it, and a hold
                    // became a drag below.
                    onPress={() => { hapticsLight(); onOpenChange(!open); }}
                    onLongPress={() => {
                        gesture.current.phase = 'drag';
                        setDragging(true);
                        endSweep();
                        hapticsLight();
                    }}
                    onPressOut={releaseDrag}
                    delayLongPress={PICKUP_MS}
                    pressRetentionOffset={{ top: 40, bottom: 40, left: 40, right: 40 }}
                    hitSlop={6}
                    style={({ pressed }) => ({
                        width: KEY, height: KEY, borderRadius: KEY / 2,
                        alignItems: 'center', justifyContent: 'center',
                        opacity: pressed ? 0.78 : 1,
                        transform: [{ scale: dragging ? 1.08 : 1 }],
                    })}
                >
                    {Platform.OS === 'web'
                        ? <View style={{
                            width: KEY, height: KEY, borderRadius: KEY / 2,
                            alignItems: 'center', justifyContent: 'center',
                            backgroundColor: theme.colors.glass.backgroundStrong,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: visible ? theme.colors.accent : theme.colors.glass.border,
                            shadowColor: theme.colors.glass.shadow, shadowOffset: { width: 0, height: 8 },
                            shadowRadius: 18, shadowOpacity: 1,
                        }}>
                            <Ionicons name={open ? 'close' : 'sparkles'} size={KEY_ICON} color={theme.colors.text} />
                        </View>
                        : <MobileGlassSurface intensity={76} interactive={false} style={{
                            width: KEY, height: KEY, borderRadius: KEY / 2,
                            alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                            backgroundColor: visible ? theme.colors.glass.backgroundStrong : theme.colors.glass.backgroundSubtle,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: visible ? theme.colors.accent : theme.colors.glass.border,
                        }}>
                            <Ionicons name={open ? 'close' : 'sparkles'} size={KEY_ICON} color={theme.colors.text} />
                        </MobileGlassSurface>}
                </Pressable>
            </Animated.View>
        </View>
    );
}

/**
 * One slot disc plus its on-highlight label chip. The disc travels from the
 * anchor to its arc position on open (staggered in arc order) and collapses
 * back together on close; reduced motion fades it in place instead.
 */
function RingSlotView({ slot, index, offset, anchor, region, progress, reduceMotion, visible, highlight, onPress }: {
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
