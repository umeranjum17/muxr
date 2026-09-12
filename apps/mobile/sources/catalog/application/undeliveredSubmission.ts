/**
 * A first message that failed after its session already existed. The Dock
 * draft is cleared (starting again would spawn a second agent), so the text
 * and attachments wait here for the session's composer to pick up.
 */
import { create } from 'zustand';
import type { AttachmentPreview } from '../infrastructure/attachmentTypes';

export type UndeliveredSubmission = {
    sessionId: string;
    text: string;
    attachments: AttachmentPreview[];
    /** The failed send's identity, so the composer's resend runs once on the host. */
    promptId: string;
};

type UndeliveredSubmissionState = {
    bySession: Record<string, UndeliveredSubmission>;
    keep: (submission: UndeliveredSubmission) => void;
    take: (sessionId: string) => UndeliveredSubmission | undefined;
};

export const useUndeliveredSubmission = create<UndeliveredSubmissionState>()((set, get) => ({
    bySession: {},
    keep: (submission) => set((state) => ({ bySession: { ...state.bySession, [submission.sessionId]: submission } })),
    take: (sessionId) => {
        const submission = get().bySession[sessionId];
        if (!submission) return undefined;
        set((state) => {
            const { [sessionId]: _taken, ...rest } = state.bySession;
            return { bySession: rest };
        });
        return submission;
    },
}));
