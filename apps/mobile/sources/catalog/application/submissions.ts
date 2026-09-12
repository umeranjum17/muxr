/**
 * Prompt submissions, scoped to the session and kept outside any screen: the
 * immutable payload the host was asked to run (id, validity, exact text with
 * host paths), plus what a person needs to recover it — the editable draft and
 * the already-uploaded chips. A submission whose answer was lost stays here
 * until it is resent under its own identity, discarded on purpose, or
 * replaced by an intentionally different message; leaving the screen changes
 * nothing.
 */
import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';
import { PROMPT_SUBMISSION_MAX_TTL_MS } from '@muxr/contract';
import type { ComposerAttachment } from '@/components/ComposerAttachments';
import type { AttachmentPreview } from '../infrastructure/attachmentTypes';
import { encodeBase64 } from '@/encryption/base64';
import { readFileBytes } from '@/utils/readFileBytes';
import { UNSUPPORTED_HOST } from '../domain/promptSubmission';
import { sync } from './sync';

export type SubmissionIdentity = { promptId: string; notValidAfter: number };

export type Submission = {
    readonly id: string;
    readonly sessionId: string;
    readonly notValidAfter: number;
    /** Exactly what was sent (draft plus host paths); the host digests this. */
    readonly text: string;
    readonly draft: string;
    /** Chips already on the host: restored, never uploaded twice. */
    readonly attachments: ComposerAttachment[];
    /** Previews that never reached the host (upload failed before dispatch). */
    readonly pendingUploads: AttachmentPreview[];
    readonly state: 'sending' | 'unconfirmed' | 'refused';
    readonly reason: string;
    /** The screen showed this outcome once; a later visit restores quietly. */
    readonly noticed: boolean;
};

type SubmissionsState = {
    bySession: Record<string, Submission[]>;
    put: (submission: Submission) => void;
    remove: (sessionId: string, id: string) => void;
    notice: (sessionId: string, id: string) => void;
};

export const useSubmissions = create<SubmissionsState>()((set) => ({
    bySession: {},
    put: (submission) => set((state) => ({
        bySession: {
            ...state.bySession,
            [submission.sessionId]: [...(state.bySession[submission.sessionId] ?? []).filter((entry) => entry.id !== submission.id), submission],
        },
    })),
    remove: (sessionId, id) => set((state) => ({
        bySession: { ...state.bySession, [sessionId]: (state.bySession[sessionId] ?? []).filter((entry) => entry.id !== id) },
    })),
    notice: (sessionId, id) => set((state) => ({
        bySession: {
            ...state.bySession,
            [sessionId]: (state.bySession[sessionId] ?? []).map((entry) => entry.id === id ? { ...entry, noticed: true } : entry),
        },
    })),
}));

// Shorter than the host's ceiling so clock skew never turns a valid resend
// into an expired one.
const SUBMISSION_TTL_MS = PROMPT_SUBMISSION_MAX_TTL_MS - 15 * 60_000;

export function newSubmissionIdentity(): SubmissionIdentity {
    return { promptId: randomUUID(), notValidAfter: Date.now() + SUBMISSION_TTL_MS };
}

const UNCONFIRMED = "Your computer didn't answer. If it received the message, it runs once: sending it again won't repeat it.";

/**
 * Only a lost answer is uncertain: the request may have reached the agent.
 * Everything the host or the app refused before sending is definite.
 */
export function uncertainFailure(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'prompt-uncertain' || code === 'prompt-history-lost') return true;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /timed out|connection lost|client closed/i.test(message);
}

export function recoverable(sessionId: string): Submission[] {
    return (useSubmissions.getState().bySession[sessionId] ?? []).filter((entry) => entry.state !== 'sending');
}

export type SubmitPromptCommand = {
    sessionId: string;
    draft: string;
    attachments: ComposerAttachment[];
    /** Previews still to upload (Dock first prompt). */
    uploads?: AttachmentPreview[];
    source?: string;
};

export type SubmitPromptResult =
    | { ok: true; submission: Submission }
    | { ok: false; submission: Submission; error: unknown };

function composeText(draft: string, attachments: ComposerAttachment[]): string {
    return [draft.trim(), ...attachments.flatMap((image) => image.path === undefined ? [] : [image.path])].filter((part) => part !== '').join(' ');
}

/**
 * Send one submission. An unchanged resend of a recovered submission — same
 * text, same uploaded chips, nothing new to upload — keeps its identity so
 * the host runs it at most once; anything else is a new submission.
 */
export async function submitPrompt(command: SubmitPromptCommand): Promise<SubmitPromptResult> {
    const { sessionId } = command;
    const { put, remove } = useSubmissions.getState();
    let attachments = command.attachments;
    const uploads = command.uploads ?? [];
    let text = composeText(command.draft, attachments);
    const previous = uploads.length === 0 ? recoverable(sessionId).find((entry) => entry.text === text && entry.pendingUploads.length === 0) : undefined;
    const identity: SubmissionIdentity = previous === undefined ? newSubmissionIdentity() : { promptId: previous.id, notValidAfter: previous.notValidAfter };
    const base = { id: identity.promptId, sessionId, notValidAfter: identity.notValidAfter, draft: command.draft, noticed: false } as const;
    put({ ...base, text, attachments, pendingUploads: uploads, state: 'sending', reason: '' });
    if (uploads.length > 0) {
        // Uploads happen before the prompt exists on the host: a failure here
        // never reached the agent and keeps the previews for a plain retry.
        try {
            attachments = [...attachments, ...await uploadAttachments(sessionId, uploads)];
            text = composeText(command.draft, attachments);
            put({ ...base, text, attachments, pendingUploads: [], state: 'sending', reason: '' });
        } catch (error) {
            const submission: Submission = { ...base, text, attachments, pendingUploads: uploads, state: 'refused', reason: failureReason(error) };
            put(submission);
            return { ok: false, submission, error };
        }
    }
    try {
        await sync.sendMessage(sessionId, text, { ...identity, ...(command.source === undefined ? {} : { source: command.source }) });
        remove(sessionId, identity.promptId);
        return { ok: true, submission: { ...base, text, attachments, pendingUploads: [], state: 'sending', reason: '' } };
    } catch (error) {
        const uncertain = uncertainFailure(error);
        const hostSaidUncertain = (error as { code?: unknown } | null)?.code === 'prompt-uncertain' || (error as { code?: unknown } | null)?.code === 'prompt-history-lost';
        const submission: Submission = {
            ...base, text, attachments, pendingUploads: [],
            state: uncertain ? 'unconfirmed' : 'refused',
            reason: uncertain && !hostSaidUncertain ? UNCONFIRMED : failureReason(error),
        };
        put(submission);
        return { ok: false, submission, error };
    }
}

function failureReason(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'host-unsupported') return UNSUPPORTED_HOST;
    return error instanceof Error ? error.message : String(error ?? 'The message was not sent.');
}

async function uploadAttachments(sessionId: string, previews: AttachmentPreview[]): Promise<ComposerAttachment[]> {
    const attachments = [];
    for (const preview of previews) {
        attachments.push({ name: preview.name, mimeType: preview.mimeType, data: encodeBase64(await readFileBytes(preview.uri)) });
    }
    const saved = await sync.request('session.saveAttachments', { sessionId, attachments });
    if (saved.savedPaths.length !== previews.length) throw new Error('The host did not confirm every image. Please attach them again.');
    return saved.savedPaths.map((path, index) => ({ id: previews[index]!.id, uri: previews[index]!.uri, name: previews[index]!.name, path }));
}
