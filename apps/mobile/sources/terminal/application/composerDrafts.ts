import { create } from 'zustand';
import { targetKey, type SubmissionTarget } from '@/catalog/application/submissions';

/**
 * The editable, unsent composer text of every terminal, keyed by computer +
 * session and kept outside the screen lifecycle: leaving a terminal and
 * coming back — or holding drafts in two terminals at once — never loses
 * what was typed. Only a send clears its own target; pending submissions
 * (submissions.ts) stay separate and immutable.
 */
type ComposerDraftsState = {
    byTarget: Record<string, string>;
    set: (target: SubmissionTarget, text: string) => void;
};

export const useComposerDrafts = create<ComposerDraftsState>()((set) => ({
    byTarget: {},
    set: (target, text) => set((state) => {
        const key = targetKey(target);
        if ((state.byTarget[key] ?? '') === text) return state;
        const { [key]: _previous, ...rest } = state.byTarget;
        return { byTarget: text === '' ? rest : { ...rest, [key]: text } };
    }),
}));

export function composerDraft(target: SubmissionTarget): string {
    return useComposerDrafts.getState().byTarget[targetKey(target)] ?? '';
}
