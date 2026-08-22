import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
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
 * The realtime control: a live line, not a second microphone. The mic beside it
 * captures dictation; this one opens something that answers, so the two must not
 * be two readings of the same audio glyph.
 *
 * It holds still once connected. A control that sits in the composer all session
 * is seen hundreds of times a day, and permanent motion there is noise; only the
 * wait for a session has anything to say.
 */
export function RealtimeGlyph({ size, state, color }: { size: number; state: RealtimeSessionState; color: string }) {
    const reduceMotion = useReducedMotion();
    const breath = useSharedValue(1);
    const connecting = state === 'connecting';

    React.useEffect(() => {
        if (!connecting || reduceMotion) {
            breath.set(1);
            return;
        }
        breath.set(withRepeat(withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true));
        return () => cancelAnimation(breath);
    }, [connecting, reduceMotion, breath]);

    const style = useAnimatedStyle(() => ({ opacity: breath.get() }));

    return (
        <Animated.View style={style}>
            <Ionicons name={state === 'disconnected' ? 'pulse-outline' : 'pulse'} size={size} color={color} />
        </Animated.View>
    );
}
