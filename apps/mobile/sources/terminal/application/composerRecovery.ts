import { Modal } from '@/modal';
import type { ComposerAttachment } from '@/components/ComposerAttachments';
import { composeText, recoverable, submitPrompt, useSubmissions, type Submission, type SubmissionTarget, type SubmitPromptResult } from '@/catalog/application/submissions';

export interface ComposerPorts {
    /** Put a recovered submission's draft and uploaded chips into the composer. */
    restore(submission: Submission): void;
    /** Clear the composer for a send. */
    clear(): void;
}

/**
 * One screen opening's ownership of submission recovery for one target
 * (computer + session): which submission the composer currently holds, what
 * a Send retries, and which outcomes were shown. Everything durable is in the
 * submissions store; this only decides, for a live screen generation, what
 * to restore and what to notice. A generation that ended ignores late
 * actions.
 */
export class ComposerRecovery {
    private restoredId: string | null = null;
    private alive = true;

    constructor(readonly target: SubmissionTarget, private readonly ports: ComposerPorts) {}

    dispose(): void {
        this.alive = false;
    }

    /** The submission the composer holds (a Send retries exactly this one). */
    get restored(): string | null {
        return this.restoredId;
    }

    /**
     * Reconcile the target's waiting submissions with the composer: show a
     * fresh outcome once, restore into an empty composer exactly once per
     * opening, and never touch any other submission.
     */
    reconcile(composerEmpty: boolean): void {
        if (!this.alive) return;
        const waiting = recoverable(this.target);
        const unnoticed = waiting.find((entry) => !entry.noticed);
        if (unnoticed !== undefined) {
            useSubmissions.getState().notice(this.target, unnoticed.id);
            const title = unnoticed.state === 'unconfirmed' ? 'Not confirmed' : 'Message not sent';
            if (composerEmpty && this.restoredId === null) {
                this.restore(unnoticed);
                Modal.alert(title, unnoticed.reason);
                return;
            }
            Modal.alert(title, `${unnoticed.reason} Your earlier message is kept.`, [
                { text: 'Discard it', style: 'cancel', onPress: () => { if (this.alive) useSubmissions.getState().remove(this.target, unnoticed.id); } },
                { text: 'Put it back', onPress: () => this.restore(unnoticed) },
            ]);
            return;
        }
        // A reopened screen starts empty while a noticed submission still
        // waits: put the latest one back quietly, once per opening.
        if (composerEmpty && this.restoredId === null && waiting.length > 0) this.restore(waiting[waiting.length - 1]!);
    }

    private restore(submission: Submission): void {
        if (!this.alive || this.restoredId === submission.id) return;
        this.restoredId = submission.id;
        this.ports.restore(submission);
    }

    /**
     * Send what the composer holds. The held submission, if any, is the one
     * being retried: unchanged and unconfirmed keeps its identity; anything
     * else is a new submission, with notice when an unconfirmed one was
     * replaced. No other submission is touched.
     */
    async send(draft: string, attachments: ComposerAttachment[]): Promise<SubmitPromptResult | undefined> {
        if (composeText(draft, attachments) === '') return undefined;
        const retryOf = this.restoredId ?? undefined;
        const selected = retryOf === undefined ? undefined : recoverable(this.target).find((entry) => entry.id === retryOf);
        this.restoredId = null;
        this.ports.clear();
        const result = await submitPrompt({ ...this.target, draft, attachments, ...(retryOf === undefined ? {} : { retryOf }) });
        if (this.alive && selected !== undefined && selected.state === 'unconfirmed' && result.submission.id !== selected.id) {
            Modal.alert('Sent as a new message', 'Your earlier unconfirmed message was different. If the computer received it, it still runs once.');
        }
        return result;
    }
}
