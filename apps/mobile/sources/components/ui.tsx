/**
 * The spec every surface renders to. Panels, sheets, trees and lists each grew
 * their own label voice, bar geometry and card radius, and five defensible
 * surfaces read as five different apps. These are the shared parts; a surface
 * that needs a different number changes it here, for everyone.
 *
 * Colour law: chrome is neutral, one accent carries emphasis, and status hues
 * are spent on text, dots and small glyphs — never on a fill wider than a
 * number. A 300pt amber bar is 1800 square points of alarm for a meter that is
 * merely full.
 */

import * as React from 'react';
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';

export const ui = {
    radius: { card: 12, control: 10, meter: 2 },
    /** Cards pad 14, rows breathe 10 vertically: a phone row stays under 44pt. */
    space: { card: 14, row: 10 },
    icon: { meta: 12, row: 16, chrome: 20 },
    meterHeight: 4,
} as const;

export function cardStyle(theme: Theme): ViewStyle {
    return {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: ui.radius.card,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    };
}

export function withAlpha(color: string, alpha: number): string {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
    if (hex === undefined) return color;
    const full = hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex;
    const value = Number.parseInt(full, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha.toFixed(3)})`;
}

/**
 * Sentence case, not uppercase: a screen with six tracked-out capital labels
 * shouts six times before it says anything.
 */
export function SectionLabel({ children, style, numberOfLines }: { children: React.ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
    const { theme } = useUnistyles();
    return (
        <Text {...(numberOfLines === undefined ? {} : { numberOfLines })} style={[{ color: withAlpha(theme.colors.textSecondary, 0.85), fontSize: 12, lineHeight: 16, fontWeight: '600', ...Typography.default('semiBold') }, style]}>
            {children}
        </Text>
    );
}

/**
 * One bar for meters, limits and row progress. Always neutral: rank comes from
 * `emphasis`, and whatever the bar is warning about says so in its number.
 */
export function Meter({ ratio, emphasis = 1, delay = 0, style }: { ratio: number; emphasis?: number; delay?: number; style?: StyleProp<ViewStyle> }) {
    const { theme } = useUnistyles();
    const reduceMotion = useReducedMotion();
    const target = Math.max(0, Math.min(1, ratio));
    const width = useSharedValue(reduceMotion ? target : 0);
    React.useEffect(() => {
        width.value = reduceMotion ? target : withDelay(delay, withTiming(target, { duration: 380, easing: Easing.bezier(0.23, 1, 0.32, 1) }));
    }, [delay, reduceMotion, target, width]);
    const animated = useAnimatedStyle(() => ({ width: `${width.value * 100}%` }));
    return (
        <View style={[{ height: ui.meterHeight, borderRadius: ui.radius.meter, backgroundColor: withAlpha(theme.colors.accent, 0.1), overflow: 'hidden' }, style]}>
            <Animated.View style={[{ height: '100%', borderRadius: ui.radius.meter, backgroundColor: withAlpha(theme.colors.accent, Math.max(0.35, emphasis)) }, animated]} />
        </View>
    );
}
