import * as React from 'react';
import { Text, View } from 'react-native';
import Animated, { useAnimatedReaction, useAnimatedStyle, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export const PIN_HEIGHT = 26;

/**
 * What you are inside of, pinned to the top of the panel.
 *
 * The label is React state, not an animated prop: a worklet writing `text`
 * into an `AnimatedTextInput` paints nothing in this build. The row under the
 * top edge is found on the UI thread by binary search and only crosses to JS
 * when the enclosing scope actually changes, which over a whole fling is a
 * handful of updates rather than one per frame.
 */
export function ScopePin(props: {
    scrollY: SharedValue<number>;
    /** Content offset of each item, length items+1. */
    offsets: number[];
    /** Label index for each item; -1 where nothing encloses it. */
    labelOfItem: number[];
    labels: string[];
    tones: Array<'scope' | 'added' | 'removed'>;
}) {
    const { theme } = useUnistyles();
    const code = theme.colors.code;
    const [index, setIndex] = React.useState(-1);
    const { offsets, labelOfItem } = props;

    useAnimatedReaction(
        () => {
            const y = props.scrollY.value;
            if (y <= 0) return -1;
            let low = 0;
            let high = labelOfItem.length - 1;
            while (low < high) {
                const mid = (low + high + 1) >> 1;
                if ((offsets[mid] ?? 0) <= y) low = mid; else high = mid - 1;
            }
            return labelOfItem[low] ?? -1;
        },
        (next, previous) => { if (next !== previous) scheduleOnRN(setIndex, next); },
        [offsets, labelOfItem],
    );

    const style = useAnimatedStyle(() => ({ opacity: withTiming(index < 0 ? 0 : 1, { duration: 120 }) }));
    const tone = props.tones[index] ?? 'scope';
    const bar = tone === 'added' ? code.addedMark : tone === 'removed' ? code.removedMark : code.scopeMark;

    return (
        <Animated.View
            pointerEvents="none"
            style={[{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: PIN_HEIGHT,
                justifyContent: 'center',
                paddingLeft: 16,
                paddingRight: 24,
                backgroundColor: code.surfaceRaised,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: code.hairline,
            }, style]}
        >
            <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: bar }} />
            <Text numberOfLines={1} style={{ ...Typography.mono('semiBold'), fontSize: 12, color: code.text }}>
                {props.labels[index] ?? ''}
            </Text>
        </Animated.View>
    );
}
