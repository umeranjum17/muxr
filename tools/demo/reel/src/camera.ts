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
    // The bug: a mild dive toward the fix hunk in the upper terminal.
    { at: 0, pose: { cx: 960, cy: 420, s: 1.35 } },
    // The tests: a fresh screen, content at the top, a gentle push.
    { at: starts.fix, pose: { cx: 960, cy: 340, s: 1.4 } },
    // The wall: the prompt large, motion stopped.
    { at: starts.wall, pose: { cx: 771, cy: 622, s: 1.6 } },
    // To the phone: it rises into (425, 540) while the desk parks right.
    { at: starts.moves, pose: { cx: 425, cy: 540, s: 1.15 } },
    // Widen for the approval: both screens, room for the words below.
    { at: starts.approval, pose: { cx: 960, cy: 575, s: 0.88 } },
    // The run: a slow drift toward the phone's half of the pair.
    { at: starts.run, pose: { cx: 860, cy: 575, s: 0.9 } },
    // The result, on the phone — seated left so the words own the right.
    { at: starts.result, pose: { cx: 550, cy: 540, s: 1.15 } },
    // The capability run: the phone holds its seat; the lens breathes.
    { at: starts.diffs, pose: { cx: 550, cy: 540, s: 1.18 } },
    { at: starts.inbox, pose: { cx: 550, cy: 540, s: 1.14 } },
    { at: starts.voice, pose: { cx: 550, cy: 520, s: 1.2 } },
    { at: starts.herd, pose: { cx: 550, cy: 540, s: 1.15 } },
    { at: starts.relay, pose: { cx: 550, cy: 540, s: 1.18 } },
    // The phone bows out; one line owns the dark.
    { at: starts.forget, pose: { cx: 550, cy: 540, s: 1.3 } },
    // Past the panels into the close.
    { at: starts.end, pose: { cx: 550, cy: 540, s: 1.45 } },
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
