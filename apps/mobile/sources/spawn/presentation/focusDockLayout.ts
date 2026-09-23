/** The open composer's back control: its inset below the safe area, and its size. */
export const FOCUS_BACK_TOP = 14;
export const FOCUS_BACK_SIZE = 52;
/** Air kept between the back control and the top of the dock. */
const BACK_CLEARANCE = 8;

/**
 * The tallest the open composer's dock (pickers, Start and the composer) may
 * be: from just under the back control down to where the keyboard, or the
 * screen edge, leaves it. Past this the dock scrolls instead of rising under
 * the back control and the status bar; a roomy phone never reaches it.
 *
 * `keyboard` is the keyboard's height as the dock's own translation reads it,
 * safe area included, so the dock gives that inset back while it is raised.
 */
export function focusDockMaxHeight(frame: { height: number; safeTop: number; safeBottom: number; keyboard: number }): number {
    const raised = frame.keyboard > 0 ? frame.keyboard - frame.safeBottom : 0;
    const top = frame.safeTop + FOCUS_BACK_TOP + FOCUS_BACK_SIZE + BACK_CLEARANCE;
    return Math.max(0, frame.height - top - raised);
}
