import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

/** Uneven on purpose; evenly stepped bars read as a loading spinner. */
const BARS = [0.45, 0.8, 1, 0.65, 0.9, 0.5, 0.75];

interface WaveProps {
    /** Full height in pixels of the tallest bar. */
    height: number;
    /** Moves while the agent talks, settles to a low idle line otherwise. */
    active: boolean;
    width?: number;
    gap?: number;
    color?: string;
    muted?: boolean;
}

/**
 * The voice, drawn as what it is. Replaces the gradient sphere, which was a
 * mascot from another app's design language and said nothing about state.
 */
export const VoiceWave = React.memo(function VoiceWave({
    height,
    active,
    width = 3,
    gap = 4,
    color = '#c8bfff',
    muted = false,
}: WaveProps) {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap, height }}>
            {BARS.map((peak, index) => (
                <Bar
                    key={index}
                    peak={peak}
                    index={index}
                    height={height}
                    width={width}
                    active={active && !muted}
                    color={muted ? '#6b7280' : color}
                />
            ))}
        </View>
    );
});

function Bar({
    peak,
    index,
    height,
    width,
    active,
    color,
}: {
    peak: number;
    index: number;
    height: number;
    width: number;
    active: boolean;
    color: string;
}) {
    const level = useSharedValue(0.25);
    const reduceMotion = useReducedMotion();

    React.useEffect(() => {
        if (!active || reduceMotion) {
            level.value = withTiming(reduceMotion && active ? 0.6 : 0.22, { duration: 220 });
            return;
        }
        // Staggered so the bars never march in step, which looks mechanical.
        const duration = 300 + index * 45;
        level.value = withRepeat(withTiming(peak, { duration }), -1, true);
    }, [active, index, level, peak, reduceMotion]);

    // scaleY keeps the wave off the layout thread; a fixed height box means
    // siblings never reflow while it moves.
    const style = useAnimatedStyle(() => ({ transform: [{ scaleY: level.value }] }));

    return <Animated.View style={[{ width, height, borderRadius: width / 2, backgroundColor: color }, style]} />;
}
