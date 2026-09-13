import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_ID_PATTERN, PROMPT_SUBMISSION_CLOCK_SKEW_MS, PROMPT_SUBMISSION_MAX_TTL_MS } from '@muxr/contract';
import { atomicWriteJson } from '../../platform/atomicWriteJson.js';

/**
 * Same-device prompt receipts: a client that lost the answer to a prompt
 * (timeout, reconnect) resends it under the same `promptId` with the same
 * input, and the host runs it once. Same semantics as the peer receipt
 * boundary: a bounded validity window the client declares and the host
 * enforces, an input digest so a reused id cannot acknowledge a different
 * command, per-device and global capacity that refuses instead of evicting,
 * and receipts that outlive their validity window.
 *
 * Outcomes are replayed, never re-run: a completed prompt answers again, a
 * refusal the host made before dispatch answers the same refusal, and
 * anything that may have reached Herdr — a lost downstream answer, or a
 * receipt the host started and never finished because the process died —
 * stays uncertain. A deliberate new attempt is a new submission id.
 */
export interface PromptReceipts {
    once(deviceId: string, submission: PromptSubmission, run: () => Promise<null>): Promise<null>;
}

export interface PromptSubmission {
    promptId: unknown;
    notValidAfter: unknown;
    /** Everything that determines the side effect: session, text, attachments, behavior. */
    input: unknown;
}

interface Receipt {
    deviceId: string;
    promptId: string;
    requestHash: string;
    notValidAfter: number;
    state: 'started' | 'done' | 'uncertain' | 'refused';
    error?: { message: string; code?: string };
}

interface Ledger {
    revision: number;
    /** Set when a previously initialised ledger went missing: fence until every submission it could have held is expired. */
    quarantineUntil?: number;
    receipts: Receipt[];
}

const MAX_PER_DEVICE = 256;
const MAX_TOTAL = 4096;
const LEDGER = 'prompt-receipts.json';
/** Exists once a ledger was ever initialised, so a missing ledger reads as loss, not as a first run. */
const INITIALIZED_MARKER = 'prompt-receipts.initialized';

export class PromptReceiptError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'PromptReceiptError';
    }
}

/** Set on an error thrown after the prompt may have reached Herdr. */
export function markPromptDispatched<T>(error: T): T {
    if (error instanceof Error) Object.assign(error, { promptDispatched: true });
    return error;
}

function promptDispatched(error: unknown): boolean {
    return error instanceof Error && (error as { promptDispatched?: unknown }).promptDispatched === true;
}

const STATES = new Set(['started', 'done', 'uncertain', 'refused']);

function validReceipt(value: unknown): value is Receipt {
    if (typeof value !== 'object' || value === null) return false;
    const receipt = value as Record<string, unknown>;
    return typeof receipt.deviceId === 'string' && receipt.deviceId !== '' && receipt.deviceId.length <= 200
        && typeof receipt.promptId === 'string' && PROMPT_ID_PATTERN.test(receipt.promptId)
        && typeof receipt.requestHash === 'string' && /^[A-Za-z0-9_-]{43}$/.test(receipt.requestHash)
        && typeof receipt.notValidAfter === 'number' && Number.isFinite(receipt.notValidAfter)
        && typeof receipt.state === 'string' && STATES.has(receipt.state)
        && (receipt.error === undefined || (typeof receipt.error === 'object' && receipt.error !== null
            && typeof (receipt.error as { message?: unknown }).message === 'string'
            && ['undefined', 'string'].includes(typeof (receipt.error as { code?: unknown }).code)));
}

function validLedger(value: unknown): value is Ledger {
    if (typeof value !== 'object' || value === null) return false;
    const ledger = value as Record<string, unknown>;
    return typeof ledger.revision === 'number' && Number.isSafeInteger(ledger.revision)
        && (ledger.quarantineUntil === undefined || (typeof ledger.quarantineUntil === 'number' && Number.isFinite(ledger.quarantineUntil)))
        && Array.isArray(ledger.receipts) && ledger.receipts.every(validReceipt);
}

/**
 * Strict load: only a genuinely new ledger initialises. Anything unreadable
 * or malformed fails every identified prompt closed and is never overwritten.
 */
function loadLedger(dataDir: string, now: number): { ledger: Ledger } | { broken: string } {
    const path = join(dataDir, LEDGER);
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { broken: 'prompt receipt ledger is unreadable' };
        if (existsSync(join(dataDir, INITIALIZED_MARKER))) {
            // History is gone: the submissions it protected may still be
            // valid, so refuse identified prompts until all of them expired.
            return { ledger: { revision: 0, quarantineUntil: now + PROMPT_SUBMISSION_MAX_TTL_MS + PROMPT_SUBMISSION_CLOCK_SKEW_MS, receipts: [] } };
        }
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, INITIALIZED_MARKER), `${new Date(now).toISOString()}\n`, { mode: 0o600 });
        return { ledger: { revision: 0, receipts: [] } };
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!validLedger(parsed)) return { broken: 'prompt receipt ledger is malformed' };
        return { ledger: parsed };
    } catch {
        return { broken: 'prompt receipt ledger is malformed' };
    }
}

export function requestHash(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('base64url');
}

export function createPromptReceipts(dataDir: string, now: () => number = () => Date.now()): PromptReceipts {
    const loaded = loadLedger(dataDir, now());
    const filePath = join(dataDir, LEDGER);
    const ledger: Ledger = 'ledger' in loaded ? loaded.ledger : { revision: 0, receipts: [] };
    const broken = 'broken' in loaded ? loaded.broken : undefined;
    const receipts = new Map<string, Receipt>(ledger.receipts.map((receipt) => [`${receipt.deviceId}\0${receipt.promptId}`, receipt]));
    const inFlight = new Map<string, { requestHash: string; promise: Promise<null> }>();
    let revision = ledger.revision;
    let writes: Promise<void> = Promise.resolve();
    // A missing ledger with a marker is loss; persist the quarantine so a
    // second restart inside the window cannot shorten it.
    if (ledger.quarantineUntil !== undefined && broken === undefined && !existsSync(filePath)) void persist();

    function prune(): void {
        const time = now();
        for (const [key, receipt] of receipts) {
            if (receipt.notValidAfter <= time) receipts.delete(key);
        }
    }

    // Serialised; one failed write reports to its caller and the chain recovers.
    function persist(): Promise<void> {
        revision += 1;
        const snapshot: Ledger = {
            revision,
            ...(ledger.quarantineUntil === undefined ? {} : { quarantineUntil: ledger.quarantineUntil }),
            receipts: [...receipts.values()],
        };
        const run = writes.then(() => atomicWriteJson(filePath, snapshot));
        writes = run.then(() => undefined, () => undefined);
        return run;
    }

    function replay(receipt: Receipt): null {
        if (receipt.state === 'done') return null;
        if (receipt.state === 'refused' && receipt.error !== undefined) throw new PromptReceiptError(receipt.error.message, receipt.error.code ?? 'prompt-refused');
        throw new PromptReceiptError('This message may already have reached the agent. Check the terminal; sending it again will not run it twice.', 'prompt-uncertain');
    }

    return {
        once(deviceId, submission, run) {
            if (broken !== undefined) return Promise.reject(new PromptReceiptError(`${broken}; the computer cannot confirm a message runs once until it is repaired`, 'prompt-ledger-unreadable'));
            const { promptId, notValidAfter } = submission;
            if (typeof promptId !== 'string' || !PROMPT_ID_PATTERN.test(promptId)) {
                return Promise.reject(new PromptReceiptError('promptId must be 8-64 characters of [A-Za-z0-9_-]', 'prompt-invalid'));
            }
            const time = now();
            if (typeof notValidAfter !== 'number' || !Number.isFinite(notValidAfter)) {
                return Promise.reject(new PromptReceiptError('promptNotValidAfter must be an epoch time', 'prompt-invalid'));
            }
            if (notValidAfter <= time) return Promise.reject(new PromptReceiptError('This message is too old to send again. Check the terminal, then write it as a new message.', 'prompt-expired'));
            if (notValidAfter > time + PROMPT_SUBMISSION_MAX_TTL_MS + PROMPT_SUBMISSION_CLOCK_SKEW_MS) {
                return Promise.reject(new PromptReceiptError('prompt validity window is too long', 'prompt-invalid'));
            }
            if (ledger.quarantineUntil !== undefined && ledger.quarantineUntil > time) {
                return Promise.reject(new PromptReceiptError('The computer lost its record of recent messages. Check the terminal before sending anything again; this clears on its own within two hours.', 'prompt-history-lost'));
            }
            const hash = requestHash({ notValidAfter, input: submission.input });
            const key = `${deviceId}\0${promptId}`;
            const running = inFlight.get(key);
            if (running !== undefined) {
                if (running.requestHash !== hash) return Promise.reject(new PromptReceiptError('This message id was already used for a different message.', 'prompt-conflict'));
                return running.promise;
            }
            prune();
            const existing = receipts.get(key);
            if (existing !== undefined) {
                if (existing.requestHash !== hash) return Promise.reject(new PromptReceiptError('This message id was already used for a different message.', 'prompt-conflict'));
                try { return Promise.resolve(replay(existing)); } catch (error) { return Promise.reject(error); }
            }
            let perDevice = 0;
            for (const receipt of receipts.values()) if (receipt.deviceId === deviceId) perDevice += 1;
            if (perDevice >= MAX_PER_DEVICE || receipts.size >= MAX_TOTAL) {
                return Promise.reject(new PromptReceiptError('The computer is holding too many recent messages from this device; wait a few minutes and try again.', 'prompt-capacity'));
            }
            const receipt: Receipt = { deviceId, promptId, requestHash: hash, notValidAfter, state: 'started' };
            receipts.set(key, receipt);
            const promise = (async (): Promise<null> => {
                try {
                    // No fence on disk, no dispatch.
                    await persist();
                } catch {
                    receipts.delete(key);
                    throw new PromptReceiptError('could not record the message before sending it; try again', 'prompt-ledger-write');
                }
                try {
                    const result = await run();
                    receipt.state = 'done';
                    await persist().catch(() => undefined);
                    return result;
                } catch (error) {
                    const code = (error as { code?: unknown }).code;
                    if (promptDispatched(error)) {
                        receipt.state = 'uncertain';
                    } else {
                        receipt.state = 'refused';
                        receipt.error = { message: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) };
                    }
                    await persist().catch(() => undefined);
                    return replay(receipt);
                } finally {
                    inFlight.delete(key);
                }
            })();
            inFlight.set(key, { requestHash: hash, promise });
            return promise;
        },
    };
}
