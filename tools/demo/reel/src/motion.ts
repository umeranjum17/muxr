import { Easing, interpolate } from 'remotion';

/** Fast out, long tail. Everything in the film moves on this. */
export const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const ink = '#0d0d0f';
export const paper = '#ffffff';
export const dim = '#8b8b90';

/** The app's status hues — the only colour the film adds. sessionUtils.ts:132 */
export const status = { working: '#0A84FF', blocked: '#FF453A', done: '#30D158' };

/** 0 → 1 over `duration` frames starting at `delay`. */
export const enter = (frame: number, delay = 0, duration = 26) =>
    interpolate(frame - delay, [0, duration], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: EASE,
    });

/**
 * A short lift at the end of a beat. Kept short on purpose: the edit already
 * crossfades, and a long fade here on top of that leaves the better part of a
 * second of empty frame at every cut.
 */
export const leave = (frame: number, total: number, tail = 6) =>
    interpolate(frame, [total - tail, total - 1], [1, 0.35], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: EASE,
    });

/**
 * Depth is one number. Everything that reads as distance — how blurred a layer
 * is, how far it sits back in the dark, and how much of the drift it takes —
 * comes off it, so a layer can be placed by saying how far away it is rather
 * than by tuning three properties.
 */
export const depthOf = (depth: number) => ({
    blur: depth <= 0 ? 0 : 2.6 * depth ** 1.35,
    veil: depth <= 0 ? 0 : Math.min(0.62, 0.2 * depth),
    parallax: 1 / (1 + depth * 0.85),
});

/** A slow lateral drift across the beat, which depth then divides between layers. */
export const drift = (frame: number, total: number, amount = 46) =>
    interpolate(frame, [0, Math.max(1, total)], [amount, -amount], { extrapolateRight: 'clamp' });
