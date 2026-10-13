import { create } from 'zustand';

/** A short confirmation ("Added Work", "Moved to Work", "Started on Work").
 *  It is rendered only on the Accounts screen, in the list's own layout
 *  flow, so it never floats over an agent terminal. Every notice clears by
 *  itself after a few seconds, like the other app toasts, while a tap or
 *  the next notice still clears it sooner. */
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

/** Clears the notice at once: a tap on it, or the computer's connection
 *  changing under it. Its timer then finds nothing. */
export function dismissNotice(): void {
    if (noticeTimer !== null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }
    useNotice.setState({ notice: null });
}
