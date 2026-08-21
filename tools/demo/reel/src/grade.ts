import { Easing, interpolate } from 'remotion';
import { vignette } from '@remotion/effects/vignette';
import { noise } from '@remotion/effects/noise';
import { contrast } from '@remotion/effects/contrast';
import { brightness } from '@remotion/effects/brightness';
import { saturation } from '@remotion/effects/saturation';

/**
 * The grade.
 *
 * This is most of the gap between the earlier versions and something that
 * looks photographed. A screen recording composited straight onto a background
 * has three tells: pixels at pure 255 (nothing real clips that cleanly), a
 * perfectly even field (no lens falls off that little), and zero grain (no
 * sensor is that quiet). Fixing those three costs one pass and no 3D.
 *
 * `frame` seeds the noise so the grain moves; a still grain field reads as a
 * texture laid over the picture rather than as part of it.
 */
export const grade = (frame: number, ground: 'ink' | 'paper') => [
    // Pull the whites off the ceiling. A capture is full-range sRGB and real
    // footage never is. `contrast` is a multiplier around 1; `brightness` is an
    // OFFSET from -1 to 1 where 0 is unchanged — passing a multiplier-shaped
    // 0.96 here brightens almost to maximum and renders a white field.
    contrast({ amount: ground === 'ink' ? 0.94 : 0.97 }),
    brightness({ amount: ground === 'ink' ? -0.04 : -0.01 }),
    // The captures carry the app's status hues; nothing here should amplify them.
    saturation({ amount: 0.92 }),
    vignette({ amount: 0.5, radius: 0.62, feather: 0.35 }),
    noise({ amount: 0.055, seed: frame }),
];

/** Easing for anything the viewer is meant to notice arriving. */
export const OUT_EXPO = Easing.bezier(0.16, 1, 0.3, 1);
/** Easing for a move that should read as breathing, not as a gesture. */
export const BREATH = Easing.bezier(0.33, 0, 0.67, 1);
/** Easing for a press. Symmetric, because a finger is. */
export const PRESS = Easing.bezier(0.42, 0, 0.58, 1);

/**
 * A camera move, in perceptual scale.
 *
 * `output: 'perceptual-scale'` matters: interpolating scale linearly makes a
 * move appear to decelerate on its own, because apparent size is not linear in
 * scale factor. Every earlier version drifted a few percent on every shot,
 * which is the Ken Burns tell; here six of thirteen shots are locked off
 * completely, so a move means something on the ones that have it.
 */
export const push = (frame: number, frames: number, range?: [number, number]) =>
    range === undefined || range[0] === range[1]
        ? (range?.[0] ?? 1)
        : interpolate(frame, [0, frames], range, {
            easing: BREATH,
            output: 'perceptual-scale',
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        });

/**
 * Entrance for type. The image always leads: nothing typographic arrives on the
 * same frame as the picture it describes, or the viewer reads instead of looks.
 */
export const enter = (frame: number, at: number, dur = 14) =>
    interpolate(frame, [at, at + dur], [0, 1], { easing: OUT_EXPO, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

/** Exits are shorter than entrances and never the entrance reversed. */
export const exit = (frame: number, frames: number, dur = 9) =>
    interpolate(frame, [frames - dur, frames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
