import * as React from 'react';
import { Canvas, Circle, RadialGradient, vec } from '@shopify/react-native-skia';
import Animated, {
    cancelAnimation,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import type { RealtimeSessionState } from './realtimeSessionState';

export const RealtimeSessionVisual = React.memo(function RealtimeSessionVisual({
    size,
    state,
    muted,
}: {
    size: number;
    state: RealtimeSessionState;
    muted: boolean;
}) {
    const reduceMotion = useReducedMotion();
    const phase = useSharedValue(0.35);
    React.useEffect(() => {
        if (reduceMotion) {
            phase.value = 0.5;
            return;
        }
        phase.value = withRepeat(withTiming(1, { duration: state === 'speaking' ? 700 : 1800 }), -1, true);
        return () => cancelAnimation(phase);
    }, [phase, reduceMotion, state]);
    const motion = useAnimatedStyle(() => ({
        transform: reduceMotion ? [] : [{ scale: 0.97 + phase.value * 0.03 }],
    }));
    const colors = muted
        ? ['#17181b', '#75454d', '#d4a0a6']
        : state === 'speaking'
          ? ['#15181e', '#596783', '#dce2ec']
          : state === 'thinking' || state === 'connecting'
            ? ['#18171b', '#665f70', '#e2dee7']
            : ['#131a19', '#4f756b', '#dce8e4'];
    const label = muted
        ? 'Realtime session indicator, microphone muted'
        : state === 'speaking'
          ? 'Realtime session indicator, speaking'
          : state === 'thinking' || state === 'connecting'
            ? 'Realtime session indicator, thinking'
            : 'Realtime session indicator, listening';

    return (
        <Animated.View
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
            style={[
                {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    overflow: 'hidden',
                    backgroundColor: '#151619',
                    elevation: Math.round(size * 0.05),
                },
                motion,
            ]}
        >
            <Canvas style={{ width: size, height: size }}>
                <Circle cx={size / 2} cy={size / 2} r={size * 0.49}>
                    <RadialGradient c={vec(size * 0.34, size * 0.28)} r={size * 0.72} colors={colors} />
                </Circle>
                <Circle cx={size * 0.58} cy={size * 0.64} r={size * 0.26} opacity={0.38}>
                    <RadialGradient
                        c={vec(size * 0.5, size * 0.55)}
                        r={size * 0.38}
                        colors={['rgba(255,255,255,0.5)', 'rgba(155,180,255,0.16)', 'rgba(20,24,38,0)']}
                    />
                </Circle>
            </Canvas>
        </Animated.View>
    );
});
