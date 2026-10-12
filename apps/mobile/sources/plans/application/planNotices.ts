import { create } from 'zustand';

/** A short confirmation ("Added Work", "Moved to Work", "Started on Work").
 *  The overlay floats it on every screen but Accounts, so a notice that never
 *  clears sits over the terminal covering the agent's output: every notice
 *  clears by itself after a few seconds, like the other app toasts, while a
 *  tap or the next notice still clears it sooner. */
export interface PlanNotice {
    title: string;
    detail: string;
}

interface NoticeState {
    notice: PlanNotice | null;
}

export const useNotice = create<NoticeState>()(() => ({ notice: null }));

/** How long a notice stays up before it gets out of the way by itself,
 *  like the other app toasts (the desktop notice uses the same span). */
const NOTICE_MS = 4_000;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export function showNotice(title: string, detail: string): void {
    const notice = { title, detail };
    useNotice.setState({ notice });
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
        noticeTimer = null;
        // A replacing notice owns its own timer: only clear the one this
        // timer was set for.
        if (useNotice.getState().notice === notice) useNotice.setState({ notice: null });
    }, NOTICE_MS);
}

/** A tap on the notice clears it at once; its timer then finds nothing. */
export function dismissNotice(): void {
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }
    useNotice.setState({ notice: null });
}

/** Leaving the computer's accounts (or signing out of them) drops any notice
 *  with them; a pending timer then finds nothing. */
export function clearNotice(): void {
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }
    useNotice.setState({ notice: null });
}
