import { callPlugin } from '@/plugins/callPlugin';
import { sanitizePersistedVoiceReport, isTrustedVoiceName, type PersistedVoiceReport } from '@/sync/agentWatch';
import { storage } from '@/sync/storage';
import {
    realtimeGeneration,
    realtimeSessionSnapshot,
    realtimeWatching,
    registerRealtimeWatchActivation,
    cancelRealtimeReportWait,
    sleepAfterReports,
    speakReport,
    startRealtimeSession,
    stopRealtimeReportProvider,
} from '@/realtime/realtimeSessionState';

export interface VoiceReportInput {
    sessionId: string;
    from: string;
    status: string;
    displayName?: string;
    taskTitle?: string;
    eventId?: string;
    lifecycleStateSince?: number;
    loadTail?: () => Promise<string>;
}

type RuntimeReport = {
    scope: string;
    generation: number;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    enrichment: Promise<string | undefined>;
    cancelled: Promise<void>;
    cancel: () => void;
    settled: boolean;
};
const runtime = new Map<string, RuntimeReport>();
let draining = false;
let scheduled = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let providerGeneration: number | null = null;
let activeReportGeneration: number | null = null;

export class VoiceReportAdmissionError extends Error {
    constructor(message: string, readonly retryable: boolean) { super(message); }
}

registerRealtimeWatchActivation(() => scheduleDrain());
storage.subscribe((state, previous) => {
    if (state.voiceReportScopeGeneration !== previous.voiceReportScopeGeneration) {
        if (activeReportGeneration !== null) cancelRealtimeReportWait(activeReportGeneration);
        if (providerGeneration !== null) stopRealtimeReportProvider(providerGeneration);
        for (const [key, report] of runtime) {
            if (report.generation !== state.voiceReportScopeGeneration) settleRuntime(key, report, new VoiceReportScopeChangedError());
        }
        activeReportGeneration = null;
        providerGeneration = null;
    }
    if (state.voicePendingReports !== previous.voicePendingReports) scheduleDrain();
});

/** Persist structured identity first; optional terminal enrichment can only follow admission. */
export function wakeAndReport(input: VoiceReportInput, loadTail?: () => Promise<string>): Promise<void> {
    const identity = input.eventId ?? `${input.sessionId}:${input.from}:${input.status}:${input.lifecycleStateSince ?? ''}`;
    const displayName = input.displayName?.trim();
    const taskTitle = input.taskTitle?.trim();
    if (input.from !== 'working') {
        return Promise.reject(new VoiceReportAdmissionError('Invalid voice report.', false));
    }
    if (!['idle', 'done', 'blocked', 'failed'].includes(input.status)) {
        return Promise.reject(new VoiceReportAdmissionError('Invalid voice report.', false));
    }
    if (!displayName || !taskTitle) {
        return Promise.reject(new VoiceReportAdmissionError('Invalid voice report.', false));
    }
    if (!isTrustedVoiceName(displayName)) {
        return Promise.reject(new VoiceReportAdmissionError('Invalid voice report.', false));
    }
    const report: PersistedVoiceReport = {
        identity, sessionId: input.sessionId, from: input.from, status: input.status,
        displayName, taskTitle, attempts: 0, readyAt: 0,
    };
    const snapshot = storage.getState();
    const runtimeKey = runtimeIdentity(snapshot.voiceReportScope, snapshot.voiceReportScopeGeneration, identity);
    if (snapshot.voiceDeliveredReportIds.includes(identity)) return Promise.resolve();
    const persisted = snapshot.voicePendingReports.some((entry) => entry.identity === identity);
    if (!persisted && !realtimeWatching()) return Promise.resolve();
    const admission = persisted ? 'pending' : snapshot.admitVoiceReport(report);
    if (admission === 'delivered') return Promise.resolve();
    if (admission === 'full') return Promise.reject(new VoiceReportAdmissionError('Voice report queue rejected admission: full.', true));
    if (admission === 'invalid') return Promise.reject(new VoiceReportAdmissionError('Invalid voice report.', false));
    const existing = runtime.get(runtimeKey);
    if (existing !== undefined) { scheduleDrain(); return existing.promise; }
    const tailLoader = loadTail ?? input.loadTail;
    const created = createRuntime(snapshot.voiceReportScope, snapshot.voiceReportScopeGeneration,
        tailLoader === undefined ? Promise.resolve(undefined) : boundedTail(tailLoader));
    runtime.set(runtimeKey, created);
    scheduleDrain();
    return created.promise;
}

function runtimeFor(scope: string, generation: number, report: PersistedVoiceReport): RuntimeReport {
    const key = runtimeIdentity(scope, generation, report.identity);
    const existing = runtime.get(key);
    if (existing !== undefined) return existing;
    const restored = createRuntime(scope, generation, Promise.resolve(undefined));
    void restored.promise.catch(() => {});
    runtime.set(key, restored);
    return restored;
}

function createRuntime(scope: string, generation: number, enrichment: Promise<string | undefined>): RuntimeReport {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let cancel!: () => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const cancelled = new Promise<void>((done) => { cancel = done; });
    return { scope, generation, promise, resolve, reject, enrichment, cancelled, cancel, settled: false };
}

function runtimeIdentity(scope: string, generation: number, identity: string): string {
    return `${scope}:${generation}:${identity}`;
}

class VoiceReportScopeChangedError extends Error {
    constructor() { super('Voice report scope changed.'); }
}

function settleRuntime(key: string, report: RuntimeReport, error?: Error): void {
    if (report.settled) return;
    report.settled = true;
    runtime.delete(key);
    if (error === undefined) report.resolve();
    else { report.cancel(); report.reject(error); }
}

async function boundedTail(load: () => Promise<string>): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            load(),
            new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 3_000); }),
        ]);
    } catch {
        return undefined;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function priority(status: string): number {
    if (status === 'blocked') return 0;
    if (status === 'failed' || status === 'error' || status === 'timeout') return 1;
    return 2;
}

function scheduleDrain(): void {
    if (scheduled || draining || !realtimeWatching()) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void drain(); });
}

function scheduleRetry(at: number): void {
    if (retryTimer !== null || !realtimeWatching()) return;
    retryTimer = setTimeout(() => { retryTimer = null; scheduleDrain(); }, Math.max(0, at - Date.now()));
}

async function drain(): Promise<void> {
    if (draining || !realtimeWatching()) return;
    const entered = storage.getState();
    const drainScope = entered.voiceReportScope;
    const drainGeneration = entered.voiceReportScopeGeneration;
    draining = true;
    try {
        while (realtimeWatching() && sameScope(drainScope, drainGeneration)) {
            const state = storage.getState();
            for (const report of state.voicePendingReports) {
                if (!state.voiceDeliveredReportIds.includes(report.identity)) continue;
                state.discardVoiceReport(report.identity);
                const key = runtimeIdentity(drainScope, drainGeneration, report.identity);
                const current = runtime.get(key);
                if (current !== undefined) settleRuntime(key, current);
            }
            const reports = [...storage.getState().voicePendingReports]
                .sort((left, right) => priority(left.status) - priority(right.status));
            const input = reports.find((entry) => entry.readyAt <= Date.now());
            if (input === undefined) {
                if (reports.length > 0) scheduleRetry(Math.min(...reports.map((entry) => entry.readyAt)));
                break;
            }
            const key = runtimeIdentity(drainScope, drainGeneration, input.identity);
            const current = runtimeFor(drainScope, drainGeneration, input);
            const tail = await Promise.race([current.enrichment, current.cancelled.then(() => undefined)]);
            if (!realtimeWatching() || !sameScope(drainScope, drainGeneration)) {
                settleRuntime(key, current, new VoiceReportScopeChangedError());
                break;
            }
            try {
                const clean = sanitizePersistedVoiceReport(input);
                if (clean === null) {
                    storage.getState().discardVoiceReport(input.identity);
                    settleRuntime(key, current, new Error('Invalid voice report.'));
                    continue;
                }
                const snapshot = realtimeSessionSnapshot();
                if (snapshot.state === 'disconnected' && !snapshot.starting) {
                    if (!startRealtimeSession(clean.sessionId)) throw new Error('Voice session could not start.');
                    providerGeneration = realtimeGeneration();
                }
                activeReportGeneration = realtimeGeneration();
                const response = await Promise.race([
                    callPlugin<{ say: string }>('voice.report', {
                        displayName: clean.displayName, taskTitle: clean.taskTitle,
                        status: clean.status, outcome: clean.status, ...(tail ? { tail } : {}),
                    }),
                    current.cancelled.then(() => undefined),
                ]);
                if (!sameScope(drainScope, drainGeneration)) {
                    settleRuntime(key, current, new VoiceReportScopeChangedError());
                    break;
                }
                if (response === undefined) break;
                await Promise.race([speakReport(response.say), current.cancelled]);
                if (!sameScope(drainScope, drainGeneration)) {
                    settleRuntime(key, current, new VoiceReportScopeChangedError());
                    break;
                }
                storage.getState().deliverVoiceReport(clean.identity);
                settleRuntime(key, current);
            } catch (error) {
                if (!sameScope(drainScope, drainGeneration)) {
                    settleRuntime(key, current, new VoiceReportScopeChangedError());
                    break;
                }
                const attempts = input.attempts + 1;
                const readyAt = Date.now() + Math.min(1_000 * 2 ** (attempts - 1), 30_000);
                storage.getState().updateVoiceReportRetry(input.identity, attempts, readyAt);
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`voice report failed: ${message.slice(0, 300)}`);
                continue;
            } finally {
                activeReportGeneration = null;
            }
        }
        await Promise.resolve();
    } finally {
        draining = false;
        if (!sameScope(drainScope, drainGeneration)) { scheduleDrain(); return; }
        const pending = storage.getState().voicePendingReports;
        if (realtimeWatching() && pending.length === 0 && providerGeneration !== null) {
            const ownsProvider = providerGeneration === realtimeGeneration();
            providerGeneration = null;
            if (ownsProvider) sleepAfterReports();
        } else if (realtimeWatching() && retryTimer === null && pending.length > 0) scheduleDrain();
    }
}

function sameScope(scope: string, generation: number): boolean {
    const current = storage.getState();
    return current.voiceReportScope === scope && current.voiceReportScopeGeneration === generation;
}
