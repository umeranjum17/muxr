import { Easing, ReduceMotion, type EasingFunction, type EasingFunctionFactory } from 'react-native-reanimated';

/**
 * The motion vocabulary. One curve family, a handful of durations; anything
 * that moves picks from here so the app reads as one instrument. Every
 * timing honours the system reduce-motion setting: entrances lose their
 * rise and stagger and become short fades.
 */
export const MOTION = {
    /** Press feedback (BubblePressable, MobileGlass). */
    press: 65,
    /** Chip select, badge change, link chip exit. */
    fast: 120,
    /** Fades, sheet content, header backdrop, modal enter, palette. */
    base: 200,
    /** Focus mode reveal, drawer, screen list stagger. */
    slow: 320,
    /** Every dismissal. */
    exit: 140,
    /** Per-item stagger, capped so long lists never crawl in. */
    stagger: 40,
    staggerCap: 8,
    /** StatusDot only. */
    pulse: 1000,
    /** LoadingHairline only. */
    hairline: 900,
} as const;

/** The house curve: quick out, long settle. */
export const houseEasing = Easing.bezier(0.23, 1, 0.32, 1);
export const pressEasing = Easing.out(Easing.quad);
export const exitEasing = Easing.in(Easing.cubic);
export const hairlineEasing = Easing.inOut(Easing.ease);

export const reduceMotion = ReduceMotion.System;

/** withTiming config that follows the vocabulary and the system setting. */
export function timing(duration: number, easing: EasingFunction | EasingFunctionFactory = houseEasing) {
    return { duration, easing, reduceMotion };
}

/** Stagger delay for the n-th item of an entering list. */
export function staggerDelay(index: number): number {
    return Math.min(index, MOTION.staggerCap) * MOTION.stagger;
}
