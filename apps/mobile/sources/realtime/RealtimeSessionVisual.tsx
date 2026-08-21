import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
    cancelAnimation,
    Easing,
    ReduceMotion,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';
import { subscribeEnergy } from './audioEnergy';
import type { RealtimeSessionState } from './realtimeSessionState';

/**
 * Lightweight voice activity: one semantic headset inside two breathing rings.
 * The old Skia galaxy rebuilt hundreds of paths per frame and could lose its
 * Android EGL context when realtime opened. This stays on Reanimated's UI
 * thread and changes only opacity and transforms.
 */
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
    const breath = useSharedValue(0);
    const input = useSharedValue(0);
    const output = useSharedValue(0);
    const live = state !== 'disconnected';

    React.useEffect(() => {
        if (reduceMotion || !live) {
            breath.set(0.35);
            return;
        }
        breath.set(withRepeat(withTiming(1, { duration: state === 'thinking' ? 1_600 : 2_400, easing: Easing.inOut(Easing.ease), reduceMotion: ReduceMotion.System }), -1, true));
        return () => cancelAnimation(breath);
    }, [breath, live, reduceMotion, state]);

    React.useEffect(() => subscribeEnergy((direction, raw) => {
        const level = muted ? 0 : Math.max(0, Math.min(1, raw));
        const target = direction === 'input' ? input : output;
        target.set(withSequence(
            withTiming(level, { duration: 70, reduceMotion: ReduceMotion.System }),
            withDelay(90, withTiming(0, { duration: 420, reduceMotion: ReduceMotion.System })),
        ));
    }), [input, muted, output]);

    const outerStyle = useAnimatedStyle(() => {
        const level = Math.max(input.get(), output.get());
        return {
            opacity: live ? 0.14 + breath.get() * 0.12 + level * 0.2 : 0.08,
            transform: [{ scale: 0.9 + breath.get() * 0.08 + level * 0.16 }],
        };
    });
    const innerStyle = useAnimatedStyle(() => {
        const level = Math.max(input.get(), output.get());
        return {
            opacity: live ? 0.28 + level * 0.28 : 0.14,
            transform: [{ scale: 0.96 + level * 0.12 }],
        };
    });
    const coreStyle = useAnimatedStyle(() => {
        const level = Math.max(input.get(), output.get());
        return { transform: [{ scale: 1 + level * 0.08 }] };
    });

    const tint = muted ? '#9aa0a8' : '#f7f8fb';
    const border = muted ? 'rgba(255, 106, 94, 0.6)' : 'rgba(247, 248, 251, 0.34)';
    const core = Math.max(28, size * 0.44);

    return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View style={[{
                position: 'absolute',
                width: size * 0.88,
                height: size * 0.88,
                borderRadius: size,
                borderWidth: Math.max(1, size * 0.006),
                borderColor: border,
                backgroundColor: 'rgba(247, 248, 251, 0.06)',
            }, outerStyle]} />
            <Animated.View style={[{
                position: 'absolute',
                width: size * 0.66,
                height: size * 0.66,
                borderRadius: size,
                borderWidth: Math.max(1, size * 0.006),
                borderColor: border,
            }, innerStyle]} />
            <Animated.View style={[{
                width: core,
                height: core,
                borderRadius: core / 2,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: live ? '#202329' : '#17191d',
                borderWidth: 1,
                borderColor: border,
            }, coreStyle]}>
                <Ionicons name={muted ? 'mic-off-outline' : 'headset-outline'} size={Math.max(15, size * 0.19)} color={tint} />
            </Animated.View>
        </View>
    );
});
