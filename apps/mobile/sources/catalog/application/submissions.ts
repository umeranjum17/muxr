/**
 * Prompt submissions, scoped to machine + session and kept outside any
 * screen: the immutable payload the host was asked to run (id, validity,
 * exact text with host paths, target), plus what a person needs to recover
 * it — the editable draft and the already-uploaded chips. A submission whose
 * answer was lost stays here until it is resent under its own identity or
 * discarded on purpose; leaving the screen or switching computers changes
 * nothing, and every outcome lands on the record it belongs to.
 */
import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';
import { PROMPT_SUBMISSION_MAX_TTL_MS } from '@muxr/contract';
import type { ComposerAttachment } from '@/components/ComposerAttachments';
import type { AttachmentPreview } from '../infrastructure/attachmentTypes';
import { encodeBase64 } from '@/encryption/base64';
import { readFileBytes } from '@/utils/readFileBytes';
import { UNSUPPORTED_HOST } from '../domain/connectionNegotiation';
import { sync } from './sync';

export type SubmissionIdentity = { promptId: string; notValidAfter: number };

export type SubmissionTarget = { machineId: string; sessionId: string };

export type Submission = SubmissionTarget & {
    readonly id: string;
    readonly notValidAfter: number;
    /** Exactly what was sent (draft plus host paths); the host digests this. */
    readonly text: string;
    readonly draft: string;
    /** Chips already on the host: restored, never uploaded twice. */
    readonly attachments: ComposerAttachment[];
    /** Previews that never reached the host (upload failed before dispatch). */
    readonly pendingUploads: AttachmentPreview[];
    /**
     * `unconfirmed`: the host may have it (lost answer); its identity is the
     * only safe way to send it again. `refused`: positively never dispatched;
     * a deliberate retry is a new submission.
     */
    readonly state: 'sending' | 'unconfirmed' | 'refused';
    readonly reason: string;
    /** The screen showed this outcome once; a later visit restores quietly. */
    readonly noticed: boolean;
};

type SubmissionsState = {
    byTarget: Record<string, Submission[]>;
    put: (submission: Submission) => void;
    remove: (target: SubmissionTarget, id: string) => void;
    notice: (target: SubmissionTarget, id: string) => void;
};

export function targetKey(target: SubmissionTarget): string {
    return `${target.machineId}\0${target.sessionId}`;
}

export const useSubmissions = create<SubmissionsState>()((set) => ({
    byTarget: {},
    put: (submission) => set((state) => {
        const key = targetKey(submission);
        return { byTarget: { ...state.byTarget, [key]: [...(state.byTarget[key] ?? []).filter((entry) => entry.id !== submission.id), submission] } };
    }),
    remove: (target, id) => set((state) => {
        const key = targetKey(target);
        return { byTarget: { ...state.byTarget, [key]: (state.byTarget[key] ?? []).filter((entry) => entry.id !== id) } };
    }),
    notice: (target, id) => set((state) => {
        const key = targetKey(target);
        return { byTarget: { ...state.byTarget, [key]: (state.byTarget[key] ?? []).map((entry) => entry.id === id ? { ...entry, noticed: true } : entry) } };
    }),
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
    if (typeof code === 'string') return false;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /timed out|connection lost|client closed/i.test(message);
}

/** Submissions waiting on this target, oldest first. */
export function recoverable(target: SubmissionTarget): Submission[] {
    return (useSubmissions.getState().byTarget[targetKey(target)] ?? []).filter((entry) => entry.state !== 'sending');
}

export type SubmitPromptCommand = SubmissionTarget & {
    draft: string;
    attachments: ComposerAttachment[];
    /** Previews still to upload (Dock first prompt). */
    uploads?: AttachmentPreview[];
    /**
     * The one recovered submission this send retries. Its identity is kept
     * only when it is unconfirmed and the payload is unchanged; a refused one
     * was never dispatched, so a deliberate retry is a new submission.
     */
    retryOf?: string;
    source?: string;
};

export type SubmitPromptResult =
    | { ok: true; submission: Submission }
    | { ok: false; submission: Submission; error: unknown };

export function composeText(draft: string, attachments: ComposerAttachment[]): string {
    return [draft.trim(), ...attachments.flatMap((image) => image.path === undefined ? [] : [image.path])].filter((part) => part !== '').join(' ');
}

/**
 * Send one submission. Only the selected recovered submission is reconciled:
 * an unchanged resend of an unconfirmed one keeps its identity (the host runs
 * it at most once) and is the same record; anything else is a new record and
 * touches nothing else on the target.
 */
export async function submitPrompt(command: SubmitPromptCommand): Promise<SubmitPromptResult> {
    const target: SubmissionTarget = { machineId: command.machineId, sessionId: command.sessionId };
    const { put, remove } = useSubmissions.getState();
    let attachments = command.attachments;
    const uploads = command.uploads ?? [];
    let text = composeText(command.draft, attachments);
    const selected = command.retryOf === undefined ? undefined : recoverable(target).find((entry) => entry.id === command.retryOf);
    const unchanged = selected !== undefined && selected.state === 'unconfirmed' && selected.text === text && uploads.length === 0 && selected.pendingUploads.length === 0;
    const identity: SubmissionIdentity = unchanged ? { promptId: selected.id, notValidAfter: selected.notValidAfter } : newSubmissionIdentity();
    // A refused (never dispatched) selection is superseded by this deliberate
    // new attempt; an unconfirmed one that changed stays, because the host
    // may still run it.
    if (selected !== undefined && !unchanged && selected.state === 'refused') remove(target, selected.id);
    const base = { ...target, id: identity.promptId, notValidAfter: identity.notValidAfter, draft: command.draft, noticed: false } as const;
    put({ ...base, text, attachments, pendingUploads: uploads, state: 'sending', reason: '' });
    if (uploads.length > 0) {
        // Uploads happen before the prompt exists on the host: a failure here
        // never reached the agent and keeps the previews for a plain retry.
        try {
            attachments = [...attachments, ...await uploadAttachments(target, uploads)];
            text = composeText(command.draft, attachments);
            put({ ...base, text, attachments, pendingUploads: [], state: 'sending', reason: '' });
        } catch (error) {
            const submission: Submission = { ...base, text, attachments, pendingUploads: uploads, state: 'refused', reason: failureReason(error) };
            put(submission);
            return { ok: false, submission, error };
        }
    }
    try {
        await sync.sendMessage(target.sessionId, text, { ...identity, machineId: target.machineId, ...(command.source === undefined ? {} : { source: command.source }) });
        remove(target, identity.promptId);
        return { ok: true, submission: { ...base, text, attachments, pendingUploads: [], state: 'sending', reason: '' } };
    } catch (error) {
        const uncertain = uncertainFailure(error);
        const hostSaidUncertain = (error as { code?: unknown } | null)?.code === 'prompt-uncertain' || (error as { code?: unknown } | null)?.code === 'prompt-history-lost';
        // A later refusal of an unchanged resend (expired, unsupported host,
        // connection changed…) never proves the original was not received:
        // uncertainty is kept, with the refusal as the reason.
        const submission: Submission = {
            ...base, text, attachments, pendingUploads: [],
            state: uncertain || unchanged ? 'unconfirmed' : 'refused',
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

async function uploadAttachments(target: SubmissionTarget, previews: AttachmentPreview[]): Promise<ComposerAttachment[]> {
    const attachments = [];
    for (const preview of previews) {
        attachments.push({ name: preview.name, mimeType: preview.mimeType, data: encodeBase64(await readFileBytes(preview.uri)) });
    }
    const saved = await sync.saveAttachments(target.machineId, target.sessionId, attachments);
    if (saved.savedPaths.length !== previews.length) throw new Error('The host did not confirm every image. Please attach them again.');
    return saved.savedPaths.map((path, index) => ({ id: previews[index]!.id, uri: previews[index]!.uri, name: previews[index]!.name, path }));
}
