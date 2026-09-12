import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The certified duplicate and its neighbours, driven through the real
 * submission model with only the wire faked: a lost answer keeps the exact
 * sent payload and identity outside any screen; an unchanged resend reuses
 * both; A/B failures out of order recover independently; an edited message
 * is a new one; a Dock first prompt with an attachment resends its host
 * paths without uploading again; an older host is refused with the truth.
 */
const wire = vi.hoisted(() => ({
    sent: [] as Array<{ sessionId: string; text: string; promptId: string; notValidAfter: number }>,
    uploads: 0,
    uploadFails: false,
    answer: null as null | ((call: { text: string }) => Promise<void>),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++uuidSeq}` }));
let uuidSeq = 0;
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async () => new Uint8Array([1, 2, 3]) }));
vi.mock('./sync', () => ({
    sync: {
        sendMessage: async (sessionId: string, text: string, options: { promptId: string; notValidAfter: number }) => {
            wire.sent.push({ sessionId, text, promptId: options.promptId, notValidAfter: options.notValidAfter });
            await wire.answer!({ text });
        },
        request: async (type: string, params: { attachments: unknown[] }) => {
            if (type !== 'session.saveAttachments') throw new Error(`unexpected ${type}`);
            if (wire.uploadFails) throw new Error('attachment upload failed');
            wire.uploads += 1;
            return { savedPaths: params.attachments.map((_item, index) => `/home/u/.muxr/attachments/img-${wire.uploads}-${index}.png`) };
        },
    },
}));

import { recoverable, submitPrompt, useSubmissions } from './submissions';
import { UNSUPPORTED_HOST } from '../domain/promptSubmission';
import type { AttachmentPreview } from '../infrastructure/attachmentTypes';

const lost = async () => { throw new Error('request timed out: session.prompt (connection reset; try again after muxr reconnects)'); };
const accepted = async () => undefined;

beforeEach(() => {
    wire.sent = [];
    wire.uploads = 0;
    wire.uploadFails = false;
    wire.answer = accepted;
    uuidSeq = 0;
    useSubmissions.setState({ bySession: {} });
});

describe('prompt submissions survive lost answers with one identity', () => {
    it('keeps the exact payload and identity of a lost answer and resends it unchanged under the same id', async () => {
        wire.answer = lost;
        const first = await submitPrompt({ sessionId: 's1', draft: 'printf once', attachments: [] });
        expect(first).toMatchObject({ ok: false, submission: { state: 'unconfirmed', text: 'printf once', id: 'uuid-1' } });
        expect(first.submission.reason).toContain("won't repeat it");
        // Another screen, later: the record is still there, unnoticed until shown.
        expect(recoverable('s1')).toMatchObject([{ id: 'uuid-1', noticed: false }]);

        wire.answer = accepted;
        const resend = await submitPrompt({ sessionId: 's1', draft: 'printf once', attachments: [] });
        expect(resend.ok).toBe(true);
        expect(wire.sent.map((call) => call.promptId)).toEqual(['uuid-1', 'uuid-1']);
        expect(wire.sent[0]!.notValidAfter).toBe(wire.sent[1]!.notValidAfter);
        expect(recoverable('s1')).toEqual([]);
    });

    it('recovers A and B independently when they fail out of order, and an edited message is new', async () => {
        const answers = new Map<string, () => Promise<void>>();
        wire.answer = ({ text }) => answers.get(text)!();
        let failA!: () => void;
        let failB!: () => void;
        answers.set('A', () => new Promise((_resolve, reject) => { failA = () => reject(new Error('connection lost')); }));
        answers.set('B', () => new Promise((_resolve, reject) => { failB = () => reject(new Error('connection lost')); }));
        const a = submitPrompt({ sessionId: 's1', draft: 'A', attachments: [] });
        const b = submitPrompt({ sessionId: 's1', draft: 'B', attachments: [] });
        failB();
        await b;
        failA();
        await a;
        expect(recoverable('s1').map((entry) => [entry.id, entry.text, entry.state]).sort()).toEqual([['uuid-1', 'A', 'unconfirmed'], ['uuid-2', 'B', 'unconfirmed']]);

        // Discard B on purpose; resend A: A's identity, nothing minted.
        useSubmissions.getState().remove('s1', 'uuid-2');
        wire.answer = accepted;
        await submitPrompt({ sessionId: 's1', draft: 'A', attachments: [] });
        expect(wire.sent.at(-1)).toMatchObject({ text: 'A', promptId: 'uuid-1' });
        expect(recoverable('s1')).toEqual([]);

        // A restored draft the person edited is a different message.
        wire.answer = lost;
        await submitPrompt({ sessionId: 's1', draft: 'C', attachments: [] });
        wire.answer = accepted;
        await submitPrompt({ sessionId: 's1', draft: 'C, but faster', attachments: [] });
        expect(wire.sent.slice(-2).map((call) => call.promptId)).toEqual(['uuid-3', 'uuid-4']);
        // The unconfirmed C stays recoverable until the screen resolves it.
        expect(recoverable('s1').map((entry) => entry.id)).toEqual(['uuid-3']);
    });

    it('resends a Dock first prompt with an attachment under its id and host paths without uploading again', async () => {
        wire.answer = lost;
        const preview = { id: 'p1', uri: 'file:///tmp/a.png', name: 'a.png', mimeType: 'image/png' } as AttachmentPreview;
        const first = await submitPrompt({ sessionId: 's-new', draft: 'look at this', attachments: [], uploads: [preview], source: 'new_session' });
        expect(first).toMatchObject({ ok: false, submission: { state: 'unconfirmed', id: 'uuid-1', text: 'look at this /home/u/.muxr/attachments/img-1-0.png', pendingUploads: [] } });
        expect(first.submission.attachments).toMatchObject([{ id: 'p1', path: '/home/u/.muxr/attachments/img-1-0.png' }]);
        expect(wire.uploads).toBe(1);

        // The session composer restores draft + chips; an unchanged resend is the same submission.
        wire.answer = accepted;
        const resend = await submitPrompt({ sessionId: 's-new', draft: first.submission.draft, attachments: first.submission.attachments });
        expect(resend.ok).toBe(true);
        expect(wire.uploads).toBe(1);
        expect(wire.sent.map((call) => [call.promptId, call.text])).toEqual([
            ['uuid-1', 'look at this /home/u/.muxr/attachments/img-1-0.png'],
            ['uuid-1', 'look at this /home/u/.muxr/attachments/img-1-0.png'],
        ]);

        // An upload that fails never reached the agent: definite, previews
        // kept for a plain retry, and nothing was sent under that id.
        wire.uploadFails = true;
        const failedUpload = await submitPrompt({ sessionId: 's-new', draft: 'again', attachments: [], uploads: [{ ...preview, id: 'p2' }] });
        expect(failedUpload).toMatchObject({ ok: false, submission: { state: 'refused', reason: 'attachment upload failed' } });
        expect(failedUpload.submission.pendingUploads).toMatchObject([{ id: 'p2' }]);
        expect(wire.sent).toHaveLength(2);
    });

    it('refuses an older host without receipts instead of promising a safe resend', async () => {
        wire.answer = async () => { throw Object.assign(new Error(UNSUPPORTED_HOST), { code: 'host-unsupported' }); };
        const result = await submitPrompt({ sessionId: 's1', draft: 'ls', attachments: [] });
        expect(result).toMatchObject({ ok: false, submission: { state: 'refused', reason: UNSUPPORTED_HOST } });
        expect(result.submission.reason).not.toContain("won't repeat it");
    });
});
