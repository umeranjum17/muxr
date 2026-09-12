import { join } from 'node:path';
import { atomicWriteJson } from '../../platform/atomicWriteJson.js';
import { loadPersistedJson } from '../../platform/persistedJson.js';

/**
 * Same-device prompt receipts: a client that lost the answer to a prompt
 * (timeout, reconnect) resends it under the same `promptId`, and the host
 * runs it once. In-flight and completed submissions replay their outcome; a
 * submission the host started and never finished — the process died with the
 * prompt in its hands — fails closed instead of running again, because the
 * agent may already have it.
 *
 * The receipt is written before the prompt reaches the agent, so a restart
 * can tell "never ran" from "may have run". Definite failures clear the
 * receipt: the client saw the error, and a retry is a new attempt.
 */
export interface PromptReceipts {
    once(deviceId: string, promptId: string, run: () => Promise<null>): Promise<null>;
}

interface ReceiptFile {
    revision: number;
    receipts: Record<string, { state: 'started' | 'done'; at: string }>;
}

const PROMPT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_RECEIPTS = 500;
const MAX_AGE_MS = 24 * 60 * 60_000;

export class PromptUncertainError extends Error {
    readonly code = 'prompt-uncertain';
    constructor() {
        super('This message may already have reached the agent: the computer restarted while sending it. Check the terminal before sending it again.');
        this.name = 'PromptUncertainError';
    }
}

function valid(value: unknown): value is ReceiptFile {
    return typeof value === 'object' && value !== null
        && typeof (value as ReceiptFile).revision === 'number'
        && typeof (value as ReceiptFile).receipts === 'object' && (value as ReceiptFile).receipts !== null;
}

export function createPromptReceipts(dataDir: string, now: () => Date = () => new Date()): PromptReceipts {
    const filePath = join(dataDir, 'prompt-receipts.json');
    const loaded = loadPersistedJson(filePath, valid, { revision: 0, receipts: {} });
    let revision = loaded.revision;
    const receipts = new Map(Object.entries(loaded.receipts)
        .filter(([, receipt]) => (receipt.state === 'started' || receipt.state === 'done')
            && Number.isFinite(Date.parse(receipt.at)) && now().getTime() - Date.parse(receipt.at) <= MAX_AGE_MS));
    const inFlight = new Map<string, Promise<null>>();
    let writes = Promise.resolve();

    // Every state change lands on disk in order; the caller awaits the write
    // that must precede its side effect.
    function persist(): Promise<void> {
        for (const [key, receipt] of receipts) {
            if (now().getTime() - Date.parse(receipt.at) > MAX_AGE_MS) receipts.delete(key);
        }
        while (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value as string);
        revision += 1;
        const snapshot: ReceiptFile = { revision, receipts: Object.fromEntries(receipts) };
        writes = writes.then(() => atomicWriteJson(filePath, snapshot));
        return writes;
    }

    return {
        async once(deviceId, promptId, run) {
            if (!PROMPT_ID.test(promptId)) throw new Error('promptId must be 8-64 characters of [A-Za-z0-9_-]');
            const key = `${deviceId}\0${promptId}`;
            const pending = inFlight.get(key);
            if (pending !== undefined) return pending;
            const receipt = receipts.get(key);
            if (receipt?.state === 'done') return null;
            if (receipt?.state === 'started') throw new PromptUncertainError();
            receipts.set(key, { state: 'started', at: now().toISOString() });
            // No receipt on disk means no exactly-once guarantee: refuse rather
            // than run something a restart could not account for.
            await persist().catch(() => {
                receipts.delete(key);
                throw new Error('could not record the message before sending it; try again');
            });
            const execution = run().then(
                async (result) => {
                    receipts.set(key, { state: 'done', at: now().toISOString() });
                    await persist().catch(() => undefined);
                    return result;
                },
                async (error: unknown) => {
                    receipts.delete(key);
                    await persist().catch(() => undefined);
                    throw error;
                },
            ).finally(() => {
                if (inFlight.get(key) === execution) inFlight.delete(key);
            });
            inFlight.set(key, execution);
            return execution;
        },
    };
}
