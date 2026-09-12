import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The certified duplicate and its neighbours, driven through the production
 * composer recovery (ComposerRecovery + the submissions store + submitPrompt)
 * with only the wire faked: a lost answer keeps the exact payload and
 * identity outside the screen; A/B out of order recover independently and
 * retrying one never touches the other; a definite pre-dispatch refusal
 * gets a fresh identity on retry while an uncertain one keeps its identity
 * even when a later attempt is refused; an attachment-only submission
 * restores idempotently across a remount; two computers with the same route
 * never see each other's drafts; a screen generation that ended cannot act.
 */
const wire = vi.hoisted(() => ({
    sent: [] as Array<{ sessionId: string; text: string; promptId: string; notValidAfter: number; machineId: string }>,
    uploads: 0,
    uploadFails: false,
    answer: null as null | ((call: { text: string; promptId: string }) => Promise<void>),
    alerts: [] as Array<{ title: string; message: string; actions?: Array<{ text: string; onPress?: () => void }> }>,
}));
let uuidSeq = 0;
vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++uuidSeq}` }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async () => new Uint8Array([1, 2, 3]) }));
vi.mock('@/modal', () => ({
    Modal: {
        alert: (title: string, message: string, actions?: Array<{ text: string; onPress?: () => void }>) => { wire.alerts.push({ title, message, ...(actions === undefined ? {} : { actions }) }); },
    },
}));
vi.mock('@/catalog/application/sync', () => ({
    sync: {
        sendMessage: async (sessionId: string, text: string, options: { promptId: string; notValidAfter: number; machineId: string }) => {
            wire.sent.push({ sessionId, text, promptId: options.promptId, notValidAfter: options.notValidAfter, machineId: options.machineId });
            await wire.answer!({ text, promptId: options.promptId });
        },
        saveAttachments: async (_machineId: string, _sessionId: string, attachments: unknown[]) => {
            if (wire.uploadFails) throw new Error('attachment upload failed');
            wire.uploads += 1;
            return { savedPaths: attachments.map((_item, index) => `/home/u/.muxr/attachments/img-${wire.uploads}-${index}.png`) };
        },
    },
}));

import { ComposerRecovery, type ComposerPorts } from './composerRecovery';
import { composerDraft, useComposerDrafts } from './composerDrafts';
import { recoverable, submitPrompt, useSubmissions, type Submission } from '@/catalog/application/submissions';
import { ConnectionNegotiation, hostConfirmsPromptsRunOnce } from '@/catalog/domain/connectionNegotiation';
import type { AttachmentPreview } from '@/catalog/infrastructure/attachmentTypes';
import type { ComposerAttachment } from '@/components/ComposerAttachments';

const lost = async () => { throw new Error('request timed out: session.prompt (connection reset; try again after muxr reconnects)'); };
const accepted = async () => undefined;
const refusedNotReady = async () => { throw Object.assign(new Error('That agent is still starting.'), { code: 'agent-not-ready' }); };

/** A screen opening: the composer state ComposerRecovery drives. */
function opening(machineId: string, sessionId: string) {
    // As TerminalScreen does: the editable draft starts from its own
    // computer+session entry and every change writes through.
    const target = { machineId, sessionId };
    const composer = { draft: composerDraft(target), attachments: [] as ComposerAttachment[], uploads: [] as AttachmentPreview[] };
    const setDraft = (text: string) => { composer.draft = text; useComposerDrafts.getState().set(target, text); };
    const ports: ComposerPorts = {
        restore: (submission: Submission) => {
            // Recovery-owned text is shown, not stored as typed.
            composer.draft = [submission.draft, composer.draft].filter((part) => part !== '').join('\n');
            composer.attachments = [...submission.attachments, ...composer.attachments];
            composer.uploads = [...composer.uploads, ...submission.pendingUploads];
        },
        clear: () => { setDraft(''); composer.attachments = []; },
    };
    const recovery = new ComposerRecovery(target, ports);
    const empty = () => composer.draft === '' && composer.attachments.length === 0 && composer.uploads.length === 0;
    return { composer, recovery, type: setDraft, reconcile: () => recovery.reconcile(empty()), send: () => recovery.send(composer.draft, composer.attachments) };
}

beforeEach(() => {
    wire.sent = [];
    wire.uploads = 0;
    wire.uploadFails = false;
    wire.answer = accepted;
    wire.alerts = [];
    uuidSeq = 0;
    useSubmissions.setState({ byTarget: {} });
    useComposerDrafts.setState({ byTarget: {} });
});

describe('composer recovery keeps one identity per submission', () => {
    it('restores a lost answer once and resends it unchanged under the same id, surviving a remount', async () => {
        wire.answer = lost;
        const first = opening('mac', 's1');
        first.composer.draft = 'printf once';
        await first.send();
        first.reconcile();
        expect(wire.alerts).toMatchObject([{ title: 'Not confirmed' }]);
        expect(first.composer.draft).toBe('printf once');
        expect(first.recovery.restored).toBe('uuid-1');
        // Reconciling again (store change, re-render) does not restore twice.
        first.reconcile();
        expect(first.composer.draft).toBe('printf once');

        // Navigate away and back: a new opening restores the same waiting
        // submission quietly, exactly once.
        first.recovery.dispose();
        const second = opening('mac', 's1');
        second.reconcile();
        second.reconcile();
        expect(second.composer.draft).toBe('printf once');
        expect(wire.alerts).toHaveLength(1);
        wire.answer = accepted;
        await second.send();
        expect(wire.sent.map((call) => [call.promptId, call.text, call.machineId])).toEqual([['uuid-1', 'printf once', 'mac'], ['uuid-1', 'printf once', 'mac']]);
        expect(wire.sent[0]!.notValidAfter).toBe(wire.sent[1]!.notValidAfter);
        expect(recoverable({ machineId: 'mac', sessionId: 's1' })).toEqual([]);
    });

    it('keeps A and B independent: retrying A retains B, a refused C retains both, stale actions cannot act', async () => {
        const answers = new Map<string, (call: { promptId: string }) => Promise<void>>();
        wire.answer = (call) => answers.get(call.text)!(call);
        let failA!: () => void;
        let failB!: () => void;
        answers.set('A', () => new Promise((_resolve, reject) => { failA = () => reject(new Error('connection lost')); }));
        answers.set('B', () => new Promise((_resolve, reject) => { failB = () => reject(new Error('connection lost')); }));
        const screen = opening('mac', 's1');
        screen.composer.draft = 'A';
        const a = screen.send();
        screen.composer.draft = 'B';
        const b = screen.send();
        failB();
        await b;
        screen.reconcile();
        // B failed first into an empty composer: restored and held.
        expect(screen.composer.draft).toBe('B');
        expect(screen.recovery.restored).toBe('uuid-2');
        failA();
        await a;
        screen.reconcile();
        // A's outcome arrives while B is held: offered, not forced.
        const offer = wire.alerts.at(-1)!;
        expect(offer.message).toContain('Your earlier message is kept');
        expect(screen.composer.draft).toBe('B');

        // Resend the held B unchanged: B's identity; A untouched.
        wire.answer = accepted;
        await screen.send();
        expect(wire.sent.at(-1)).toMatchObject({ text: 'B', promptId: 'uuid-2' });
        expect(recoverable({ machineId: 'mac', sessionId: 's1' }).map((entry) => entry.id)).toEqual(['uuid-1']);

        // A new C that is refused touches neither A nor itself becomes uncertain.
        wire.answer = refusedNotReady;
        screen.composer.draft = 'C';
        await screen.send();
        expect(recoverable({ machineId: 'mac', sessionId: 's1' }).map((entry) => [entry.id, entry.state])).toEqual([['uuid-1', 'unconfirmed'], ['uuid-3', 'refused']]);

        // The offer's "Put it back" from this opening restores A; after the
        // screen generation ends, its actions do nothing.
        offer.actions!.find((action) => action.text === 'Put it back')!.onPress!();
        expect(screen.composer.draft).toBe('A');
        screen.recovery.dispose();
        offer.actions!.find((action) => action.text === 'Discard it')!.onPress!();
        expect(recoverable({ machineId: 'mac', sessionId: 's1' }).map((entry) => entry.id)).toEqual(['uuid-1', 'uuid-3']);
    });

    it('gives a definite pre-dispatch refusal a fresh id on retry, and keeps an uncertain id even when a later attempt is refused', async () => {
        wire.answer = refusedNotReady;
        const screen = opening('mac', 's1');
        screen.composer.draft = 'run it';
        await screen.send();
        screen.reconcile();
        expect(wire.alerts.at(-1)).toMatchObject({ title: 'Message not sent', message: 'That agent is still starting.' });
        expect(screen.composer.draft).toBe('run it');
        // The agent becomes ready; the unchanged retry is a new submission and executes.
        wire.answer = accepted;
        await screen.send();
        expect(wire.sent.map((call) => call.promptId)).toEqual(['uuid-1', 'uuid-2']);
        expect(recoverable({ machineId: 'mac', sessionId: 's1' })).toEqual([]);

        // Uncertain, then the retry is refused (validity expired on the host):
        // the record stays unconfirmed under its original id.
        wire.answer = lost;
        screen.composer.draft = 'maybe ran';
        await screen.send();
        screen.reconcile();
        wire.answer = async () => { throw Object.assign(new Error('This message is too old to send again.'), { code: 'prompt-expired' }); };
        await screen.send();
        expect(wire.sent.slice(-2).map((call) => call.promptId)).toEqual(['uuid-3', 'uuid-3']);
        expect(recoverable({ machineId: 'mac', sessionId: 's1' })).toMatchObject([{ id: 'uuid-3', state: 'unconfirmed', reason: 'This message is too old to send again.' }]);
    });

    it('restores an attachment-only submission idempotently: one chip, no second upload, the original id and payload', async () => {
        const preview = { id: 'p1', uri: 'file:///tmp/a.png', name: 'a.png', mimeType: 'image/png' } as AttachmentPreview;
        wire.answer = lost;
        // Dock first prompt: attachment only, answer lost while the terminal is not open.
        const first = await submitPrompt({ machineId: 'mac', sessionId: 's-new', draft: '', attachments: [], uploads: [preview], source: 'new_session' });
        expect(first).toMatchObject({ ok: false, submission: { state: 'unconfirmed', id: 'uuid-1', text: '/home/u/.muxr/attachments/img-1-0.png' } });
        expect(wire.uploads).toBe(1);

        const screen = opening('mac', 's-new');
        screen.reconcile();
        screen.reconcile();
        expect(screen.composer.attachments).toHaveLength(1);
        expect(screen.composer.draft).toBe('');
        screen.recovery.dispose();
        const reopened = opening('mac', 's-new');
        reopened.reconcile();
        reopened.reconcile();
        expect(reopened.composer.attachments).toHaveLength(1);
        wire.answer = accepted;
        await reopened.send();
        expect(wire.uploads).toBe(1);
        expect(wire.sent.map((call) => [call.promptId, call.text])).toEqual([
            ['uuid-1', '/home/u/.muxr/attachments/img-1-0.png'],
            ['uuid-1', '/home/u/.muxr/attachments/img-1-0.png'],
        ]);

        // Text plus attachment keeps working the same way, and an upload that
        // fails before dispatch is definite with its previews kept.
        wire.uploadFails = true;
        const failedUpload = await submitPrompt({ machineId: 'mac', sessionId: 's-new', draft: 'again', attachments: [], uploads: [{ ...preview, id: 'p2' }] });
        expect(failedUpload).toMatchObject({ ok: false, submission: { state: 'refused', reason: 'attachment upload failed' } });
        expect(failedUpload.submission.pendingUploads).toMatchObject([{ id: 'p2' }]);
        expect(wire.sent).toHaveLength(2);
    });

    it('partitions submissions by computer: the same shell route on another host sees nothing and sends to its own machine', async () => {
        wire.answer = lost;
        const onA = opening('host-a', 'shell:p2');
        onA.composer.draft = 'rm -rf build';
        await onA.send();
        onA.reconcile();
        onA.recovery.dispose();
        // Switch to host B with the same route: nothing of A's is restored.
        const onB = opening('host-b', 'shell:p2');
        onB.reconcile();
        expect(onB.composer.draft).toBe('');
        expect(recoverable({ machineId: 'host-b', sessionId: 'shell:p2' })).toEqual([]);
        wire.answer = accepted;
        onB.composer.draft = 'ls';
        await onB.send();
        expect(wire.sent.at(-1)).toMatchObject({ machineId: 'host-b', text: 'ls' });
        // Back on A, A's own submission is still waiting under its id.
        const backOnA = opening('host-a', 'shell:p2');
        backOnA.reconcile();
        expect(backOnA.composer.draft).toBe('rm -rf build');
        expect(backOnA.recovery.restored).toBe('uuid-1');
    });

    it('binds negotiated support to the exact connection: a reconnect to an older host is unsupported until renegotiated', () => {
        const negotiation = new ConnectionNegotiation<{ id: string }>();
        const client = { id: 'transport-1' };
        const epoch = negotiation.current;
        expect(negotiation.record(client, epoch, ['prompt-receipts'])).toBe(true);
        expect(hostConfirmsPromptsRunOnce(negotiation.capabilitiesFor(client, epoch))).toBe(true);
        // The socket closes: support is gone synchronously.
        negotiation.invalidate();
        expect(negotiation.capabilitiesFor(client, epoch)).toBeUndefined();
        expect(negotiation.isNegotiated(client)).toBe(false);
        // A catalog answer that started before the close is stale and ignored.
        expect(negotiation.record(client, epoch, ['prompt-receipts'])).toBe(false);
        expect(negotiation.isNegotiated(client)).toBe(false);
        // The reopened connection reaches an older host.
        expect(negotiation.record(client, negotiation.current, [])).toBe(true);
        expect(hostConfirmsPromptsRunOnce(negotiation.capabilitiesFor(client))).toBe(false);
        // A replaced transport never inherits the old one's negotiation.
        const replacement = { id: 'transport-2' };
        expect(negotiation.capabilitiesFor(replacement)).toBeUndefined();
    });

    it('keeps two unsent drafts in two terminals across leaving and returning, and clears only the one that is sent', async () => {
        // F1: type in A, Back, type in B, Back, return to each.
        const a1 = opening('mac', 'shell:w2:p1');
        a1.type('F1 draft one unsent 日本語');
        a1.recovery.dispose();
        const b1 = opening('mac', 'shell:w3:p1');
        expect(b1.composer.draft).toBe('');
        b1.type('F1 draft two unsent');
        b1.recovery.dispose();
        const a2 = opening('mac', 'shell:w2:p1');
        a2.reconcile();
        expect(a2.composer.draft).toBe('F1 draft one unsent 日本語');
        a2.recovery.dispose();
        const b2 = opening('mac', 'shell:w3:p1');
        b2.reconcile();
        expect(b2.composer.draft).toBe('F1 draft two unsent');
        // The same route on another computer has its own, empty, draft.
        expect(opening('other', 'shell:w2:p1').composer.draft).toBe('');
        // Sending B clears B's draft only; A's stays for its next opening.
        await b2.send();
        expect(wire.sent.at(-1)).toMatchObject({ text: 'F1 draft two unsent', sessionId: 'shell:w3:p1' });
        expect(composerDraft({ machineId: 'mac', sessionId: 'shell:w3:p1' })).toBe('');
        expect(composerDraft({ machineId: 'mac', sessionId: 'shell:w2:p1' })).toBe('F1 draft one unsent 日本語');
        // A lost answer restores into the (now empty) draft store of that target.
        wire.answer = lost;
        const a3 = opening('mac', 'shell:w2:p1');
        await a3.send();
        expect(composerDraft({ machineId: 'mac', sessionId: 'shell:w2:p1' })).toBe('');
        a3.reconcile();
        expect(a3.composer.draft).toBe('F1 draft one unsent 日本語');
    });
});
