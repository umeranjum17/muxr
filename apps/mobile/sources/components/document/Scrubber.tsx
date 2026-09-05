import * as React from 'react';
import { Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    scrollTo,
    useAnimatedReaction,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
    type AnimatedRef,
    type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const SCRUB_WIDTH = 12;
/** VS Code's overview ruler floors a decoration at 6 CSS px and merges below that. */
const MIN_TICK = 6;
const MERGE_WITHIN = 2;
const THUMB_MIN = 24;

export interface ScrubTick {
    /** Fraction of the document, 0..1. */
    at: number;
    tone: 'added' | 'removed' | 'scope' | 'highlight';
    /** Row index to jump to when this tick is tapped. */
    row: number;
    label: string;
}

/** Ticks whose centres collide are one tick; a phone strip is ~1100 dp tall at most. */
function mergeTicks(ticks: ScrubTick[], height: number): ScrubTick[] {
    const sorted = [...ticks].sort((a, b) => a.at - b.at);
    const kept: ScrubTick[] = [];
    for (const tick of sorted) {
        const previous = kept[kept.length - 1];
        if (previous !== undefined && Math.abs(tick.at - previous.at) * height < MERGE_WITHIN) continue;
        kept.push(tick);
    }
    return kept;
}

/**
 * The document as a 12 dp strip: where the changes are, where you are, and a
 * handle to throw yourself at any of it. VS Code's overview ruler rather than
 * its minimap — a glyph map would cost 40-80 dp of a 411 dp screen to render
 * text nobody can read.
 *
 * The drag calls Reanimated's `scrollTo` from the gesture worklet, so the list
 * moves without the JS thread hearing about it, and the follow label is set
 * through `useAnimatedProps` for the same reason.
 */
export function Scrubber(props: {
    listRef: AnimatedRef<Animated.FlatList<never>>;
    scrollY: SharedValue<number>;
    height: number;
    contentHeight: number;
    viewportHeight: number;
    ticks: ScrubTick[];
    /** Offset of each row, so a tick tap can land on one. */
    offsets: number[];
    /** Given the list scroll offset this drag lands on, name the line there. */
    labelFor: (scrollOffset: number) => string;
}) {
    const { theme } = useUnistyles();
    const active = useSharedValue(0);
    const labelY = useSharedValue(0);
    const scrollable = Math.max(1, props.contentHeight - props.viewportHeight);
    const height = props.height;
    const merged = React.useMemo(() => mergeTicks(props.ticks, height), [height, props.ticks]);
    const labels = React.useMemo(() => merged.map((tick) => tick.label), [merged]);
    const fractions = React.useMemo(() => merged.map((tick) => tick.at), [merged]);

    const thumbHeight = Math.max(THUMB_MIN, (props.viewportHeight / Math.max(1, props.contentHeight)) * height);
    const thumbStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: (props.scrollY.value / scrollable) * (height - thumbHeight) }],
        opacity: active.value === 1 ? 1 : withDelay(900, withTiming(0.45, { duration: 200 })),
    }));
    const labelStyle = useAnimatedStyle(() => ({
        opacity: active.value,
        transform: [
            { translateY: labelY.value - 14 },
            { scale: active.value === 1 ? withSpring(1, { damping: 18, stiffness: 260 }) : 0.9 },
        ],
    }));
    // A worklet that sets `text` on an AnimatedTextInput paints nothing in
    // this build, so the label is real state.
    // Ticks only exist at changes, so between them the label had nothing to
    // say. With no number gutter on the surface, this strip is the one place
    // a line number is recoverable, so fall back to the continuous position
    // whenever the drag is not sitting on a change. Quantised to 1/200 of
    // the strip so this is a handful of updates across a drag, not one per
    // frame.
    const [label, setLabel] = React.useState('');
    const labelFor = props.labelFor;
    const resolve = React.useCallback((bucket: number) => {
        const fraction = bucket / 200;
        let nearest = 0;
        for (let index = 1; index < fractions.length; index += 1) {
            if (Math.abs((fractions[index] ?? 0) - fraction) < Math.abs((fractions[nearest] ?? 0) - fraction)) nearest = index;
        }
        const onTick = fractions.length > 0 && Math.abs((fractions[nearest] ?? 0) - fraction) < 0.01;
        // The same mapping `onUpdate` scrolls with. A fraction of the whole
        // content height is not where the list lands: only
        // `contentHeight - viewportHeight` is scrollable, so labelling by
        // content fraction ran ahead of the rows actually on screen.
        setLabel(onTick ? (labels[nearest] ?? '') : labelFor(fraction * scrollable));
    }, [fractions, labelFor, labels, scrollable]);
    useAnimatedReaction(
        () => Math.round(Math.min(1, Math.max(0, labelY.value / height)) * 200),
        (bucket, previous) => { if (bucket !== previous) scheduleOnRN(resolve, bucket); },
        [resolve, height],
    );

    const scrub = React.useMemo(
        () => Gesture.Pan()
            .activeOffsetY([-6, 6])
            .failOffsetX([-12, 12])
            .onBegin((event) => {
                active.value = 1;
                labelY.value = event.y;
            })
            .onUpdate((event) => {
                const y = Math.min(height, Math.max(0, event.y));
                labelY.value = y;
                scrollTo(props.listRef as never, 0, (y / height) * scrollable, false);
            })
            .onFinalize(() => { active.value = withTiming(0, { duration: 160 }); }),
        [active, height, labelY, props.listRef, scrollable],
    );

    const code = theme.colors.code;
    const toneColor = (tone: ScrubTick['tone']) => tone === 'added'
        ? code.addedMark
        : tone === 'removed'
            ? code.removedMark
            : tone === 'highlight'
                ? code.scopeMark
                : code.dim;

    return (
        <GestureDetector gesture={scrub}>
            <View
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel="Document position"
                // The touch target is 24 dp and invisible; the marks live
                // inside the row's own 16 dp right inset, so the strip costs
                // the code no columns at all.
                style={{ position: 'absolute', right: 0, top: 0, width: 24, height, justifyContent: 'flex-start' }}
            >
                {merged.map((tick, index) => (
                    <View
                        key={`${tick.row}:${index}`}
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            right: 4,
                            top: Math.min(height - MIN_TICK, tick.at * height),
                            width: 3,
                            height: tick.tone === 'scope' ? MIN_TICK : 8,
                            borderRadius: 1,
                            opacity: tick.tone === 'scope' ? 0.4 : 1,
                            backgroundColor: toneColor(tick.tone),
                        }}
                    />
                ))}
                <Animated.View
                    pointerEvents="none"
                    style={[
                        { position: 'absolute', right: 6, width: 3, height: thumbHeight, borderRadius: 2, backgroundColor: code.dim, opacity: 0.35 },
                        thumbStyle,
                    ]}
                />
                <Animated.View
                    pointerEvents="none"
                    style={[
                        {
                            position: 'absolute',
                            right: SCRUB_WIDTH + 8,
                            height: 24,
                            paddingHorizontal: 8,
                            borderRadius: 8,
                            justifyContent: 'center',
                            backgroundColor: code.pressed,
                        },
                        labelStyle,
                    ]}
                >
                    <Text numberOfLines={1} style={{ ...Typography.mono(), minWidth: 54, fontSize: 12, color: '#e6edf3' }}>
                        {label}
                    </Text>
                </Animated.View>
            </View>
        </GestureDetector>
    );
}
