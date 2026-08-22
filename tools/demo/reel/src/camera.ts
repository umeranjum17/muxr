import { spring } from 'remotion';
import { TOKENS, starts, FPS } from './config';

/** A camera pose: what world point sits at screen centre, and how close. */
export type Pose = { cx: number; cy: number; s: number };

/**
 * The one unbroken camera. Each entry is where the camera is heading from
 * that act on; between entries it glides on the critically-damped spring and
 * never bounces. There is no cut anywhere in this list — that is the film's
 * rule: the world is continuous, only the screens skip time.
 */
export const POSES: Array<{ at: number; pose: Pose }> = [
    { at: 0, pose: { cx: 960, cy: 540, s: 1 } },
    // The dive onto the prompt. The desk render is 1948px square drawn at 962,
    // so the prompt box lands at world (731, 859); 3.2x fills the frame with it.
    { at: starts.macro, pose: { cx: 731, cy: 859, s: 3.2 } },
    // Nobody answers: pull back until the terminal is small in the dark.
    { at: starts.c2, pose: { cx: 960, cy: 510, s: 0.62 } },
    // To the phone. It rises into (425, 540) while the desk parks right.
    { at: starts.c3, pose: { cx: 425, cy: 540, s: 1.15 } },
    // Widen for the hero: both screens, one frame.
    { at: starts.c4, pose: { cx: 960, cy: 540, s: 0.96 } },
    // Back to the phone for the finish,
    { at: starts.c5, pose: { cx: 425, cy: 540, s: 1.15 } },
    // a breath out for the herd card, a slow push back in on the herd,
    { at: starts.c6, pose: { cx: 425, cy: 540, s: 1.08 } },
    { at: starts.herd, pose: { cx: 425, cy: 540, s: 1.18 } },
    // and past the panels into the dark where the wordmark lives.
    { at: starts.end, pose: { cx: 425, cy: 540, s: 1.4 } },
];

/**
 * Sum-of-deltas: every glide contributes its own spring-scaled delta, so a
 * new move starting before the last has settled composes into one motion
 * instead of teleporting.
 */
export const cameraAt = (frame: number): Pose => {
    let cx = POSES[0].pose.cx;
    let cy = POSES[0].pose.cy;
    let s = POSES[0].pose.s;
    for (let i = 1; i < POSES.length; i += 1) {
        const { at, pose } = POSES[i];
        if (frame < at) break;
        const p = spring({ frame: frame - at, fps: FPS, config: TOKENS.motion.camera });
        const prev = POSES[i - 1].pose;
        cx += (pose.cx - prev.cx) * p;
        cy += (pose.cy - prev.cy) * p;
        s += (pose.s - prev.s) * p;
    }
    return { cx, cy, s };
};

/** Screen-space translation a pose produces (used for caption parallax). */
export const translationOf = (pose: Pose) => ({
    tx: 960 - pose.cx * pose.s,
    ty: 540 - pose.cy * pose.s,
});
