import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { MOTION, hairlineEasing, reduceMotion as systemReduceMotion, timing } from '@/constants/motion';
import { withAlpha } from './ui';

/**
 * Indeterminate 2px bar: says "working" under a caption without taking the
 * content's place. The shell paints first; this is the only loading signal
 * a region shows. The track keeps its 2px when idle so content never jumps.
 */
export function LoadingHairline({ active, width: fixedWidth }: { active: boolean; width?: number }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const [measured, setMeasured] = React.useState(0);
    const width = fixedWidth ?? measured;
    const progress = useSharedValue(0);
    React.useEffect(() => {
        if (!active || reduceMotion) {
            cancelAnimation(progress);
            progress.value = 0;
            return;
        }
        progress.value = withRepeat(withTiming(1, timing(MOTION.hairline, hairlineEasing)), -1, false, undefined, systemReduceMotion);
        return () => cancelAnimation(progress);
    }, [active, reduceMotion, progress]);
    const animated = useAnimatedStyle(() => ({ transform: [{ translateX: (progress.value * 1.35 - 0.35) * width }] }));
    const onLayout = React.useCallback((event: LayoutChangeEvent) => setMeasured(event.nativeEvent.layout.width), []);
    if (!active) return <View style={{ height: 2, marginBottom: 8 }} />;
    return (
        <View onLayout={fixedWidth === undefined ? onLayout : undefined} accessibilityRole="progressbar" accessibilityLabel="Loading" style={{ height: 2, marginBottom: 8, borderRadius: 1, overflow: 'hidden', backgroundColor: withAlpha(theme.colors.accent, 0.16) }}>
            {reduceMotion
                ? <View style={{ height: 2, width: '100%', backgroundColor: withAlpha(theme.colors.accent, 0.5) }} />
                : <Animated.View style={[{ height: 2, width: '35%', borderRadius: 1, backgroundColor: theme.colors.accent }, animated]} />}
        </View>
    );
}
