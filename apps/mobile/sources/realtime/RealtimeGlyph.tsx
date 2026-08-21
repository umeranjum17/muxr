import * as React from 'react';
import { View } from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import type { RealtimeSessionState } from './realtimeSessionState';

/**
 * The realtime control, in miniature: the same lit core the conversation screen
 * draws, with one orbit around it. A mic is a thing you speak into and this is a
 * thing that answers, so the two controls beside each other must not be two
 * variations of a microphone.
 *
 * It holds still once connected. A control that sits in the composer all session
 * is seen hundreds of times a day, and permanent motion there is noise; the ring
 * only turns while there is something to wait for.
 */
export function RealtimeGlyph({ size, state, color }: { size: number; state: RealtimeSessionState; color: string }) {
    const reduceMotion = useReducedMotion();
    const turn = useSharedValue(0);
    const connecting = state === 'connecting';

    React.useEffect(() => {
        if (!connecting || reduceMotion) {
            turn.set(0);
            return;
        }
        turn.set(withRepeat(withTiming(1, { duration: 1_500, easing: Easing.linear }), -1, false));
        return () => cancelAnimation(turn);
    }, [connecting, reduceMotion, turn]);

    const dot = Math.max(3, size * 0.16);
    // Thin ellipse, small core. Any rounder and the pair reads as an eye rather
    // than as something in orbit around a light.
    // Flatten first, turn second: the ellipse tips over its own centre the way
    // an orbit seen edge-on does, instead of sweeping like a clock hand.
    const style = useAnimatedStyle(() => ({
        transform: [{ rotate: `${-24 + turn.get() * 360}deg` }, { scaleY: 0.3 }],
    }));

    return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View style={[{
                position: 'absolute',
                width: size,
                height: size,
                borderRadius: size / 2,
                borderWidth: 1.4,
                borderColor: color,
            }, style]} />
            <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
        </View>
    );
}
