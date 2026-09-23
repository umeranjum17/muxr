import * as React from 'react';
import { Animated, Easing, ViewStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

export interface StatusDotProps {
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: ViewStyle;
}

const EASE = Easing.inOut(Easing.quad);
/** Out and back in one period, each half eased like a single fade. */
const PULSE_EASING = (t: number) => (t < 0.5 ? EASE(t * 2) : EASE(2 - t * 2));

// A working agent's dot pulses for as long as it works, on every row and card
// that shows it, including screens left mounted under the one in front. A
// Reanimated loop here committed the whole app's shadow tree on every frame;
// one native-driven loop per dot sets the view's alpha and never wakes JS.
export const StatusDot = React.memo(({ color, isPulsing, size = 6, style }: StatusDotProps) => {
    const reduceMotion = useReducedMotion();
    // 0 is full strength, 1 the dimmest point of the pulse.
    const dim = React.useRef(new Animated.Value(0)).current;
    const opacity = React.useMemo(() => dim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }), [dim]);

    React.useEffect(() => {
        if (isPulsing && reduceMotion) {
            dim.setValue(1);
            return;
        }
        const animation = isPulsing
            ? Animated.loop(Animated.timing(dim, { toValue: 1, duration: 2000, easing: PULSE_EASING, useNativeDriver: true }))
            : Animated.timing(dim, { toValue: 0, duration: reduceMotion ? 0 : 200, easing: EASE, useNativeDriver: true });
        animation.start();
        return () => animation.stop();
    }, [isPulsing, reduceMotion, dim]);

    const baseStyle: ViewStyle = {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
    };

    return (
        <Animated.View
            // Decorative: parents convey status in text.
            accessible={false}
            style={[
                baseStyle,
                { opacity },
                style
            ]}
        />
    );
});
