import { join } from 'node:path';
import { ATTENTION_REASONS, type AttentionCatalog, type AttentionEntry, type AttentionReason, attentionRank } from '@muxr/contract';
import { createPersistQueue, loadPersistedJson } from '../../platform/persistedJson.js';

interface HeldReason {
    detail: string;
    at: string;
}

interface AttentionFile {
    revision: number;
    /** sessionId -> reason -> what to show. A session can hold several at once. */
    sessions: Record<string, Partial<Record<AttentionReason, HeldReason>>>;
}

export interface AttentionStore {
    catalog(): AttentionCatalog;
    /** No-op when the same reason already holds with the same detail. Returns whether anything changed. */
    set(sessionId: string, reason: AttentionReason, detail: string, at?: string): boolean;
    /** Clear the named reasons, or every reason for the session when none are named. */
    clear(sessionId: string, ...reasons: AttentionReason[]): boolean;
}

/** 'done' rows are noise after ten minutes: the work is finished, the row isn't. */
const DONE_TTL_MS = 10 * 60_000;
/** Nothing survives past six hours -- a stalled turn is a dead turn. */
const HARD_CAP_MS = 6 * 60 * 60_000;

function isAttentionFile(value: unknown): value is AttentionFile {
    return (
        typeof value === 'object' &&
        value !== null &&
        'revision' in value &&
        typeof (value as AttentionFile).revision === 'number' &&
        'sessions' in value &&
        typeof (value as AttentionFile).sessions === 'object' &&
        (value as AttentionFile).sessions !== null
    );
}

export function createAttentionStore(dataDir: string, now: () => Date = () => new Date()): AttentionStore {
    const filePath = join(dataDir, 'attention.json');
    const persisted = loadPersistedJson(filePath, isAttentionFile, { revision: 0, sessions: {} });
    let revision = persisted.revision;
    const held = new Map<string, Map<AttentionReason, HeldReason>>();
    for (const [sessionId, reasons] of Object.entries(persisted.sessions)) {
        const restored = new Map<AttentionReason, HeldReason>();
        for (const [reason, value] of Object.entries(reasons)) {
            // `waiting` is backed by an in-memory promise in PluginAskRegistry.
            // A restart drops that promise, so a restored row could never clear:
            // it would sit in the inbox pointing at a question nobody can answer.
            if (reason === 'waiting' || value === undefined) continue;
            // A file written by an older build can name a reason this one no
            // longer has; publishing it would strand a row no client can render.
            if (!(ATTENTION_REASONS as readonly string[]).includes(reason)) continue;
            restored.set(reason as AttentionReason, value);
        }
        if (restored.size > 0) held.set(sessionId, restored);
    }
    const persist = createPersistQueue(filePath);

    function bump(): void {
        revision += 1;
        const sessions: AttentionFile['sessions'] = {};
        for (const [sessionId, reasons] of held) sessions[sessionId] = Object.fromEntries(reasons);
        persist.schedule({ revision, sessions });
    }

    return {
        catalog(): AttentionCatalog {
            const nowMs = now().getTime();
            let pruned = false;
            const entries: AttentionEntry[] = [];
            for (const [sessionId, reasons] of held) {
                let winner: AttentionEntry | undefined;
                for (const [reason, value] of reasons) {
                    const ageMs = nowMs - Date.parse(value.at);
                    // `waiting` is a question parked until a human answers it --
                    // it never decays. `done` stale is noise after 10m; anything
                    // else older than 6h is dead. Pruning here (catalog is the
                    // read path the client polls) also drops them from the next
                    // persisted write, since bump serializes current held state.
                    if (
                        reason !== 'waiting' &&
                        (ageMs > HARD_CAP_MS || (reason === 'done' && ageMs > DONE_TTL_MS))
                    ) {
                        reasons.delete(reason);
                        pruned = true;
                        continue;
                    }
                    if (winner !== undefined && attentionRank(reason) >= attentionRank(winner.reason)) continue;
                    winner = { sessionId, reason, detail: value.detail, at: value.at };
                }
                if (reasons.size === 0) held.delete(sessionId);
                if (winner !== undefined) entries.push(winner);
            }
            if (pruned) bump();
            entries.sort(
                (left, right) =>
                    attentionRank(left.reason) - attentionRank(right.reason) || right.at.localeCompare(left.at),
            );
            return { revision, entries };
        },

        set(sessionId, reason, detail, at): boolean {
            const reasons = held.get(sessionId) ?? new Map<AttentionReason, HeldReason>();
            // status.update fires per token, so re-asserting an unchanged reason
            // must not bump the revision and re-publish the whole catalog.
            const existing = reasons.get(reason);
            if (existing?.detail === detail) return false;
            reasons.set(reason, { detail, at: at ?? now().toISOString() });
            held.set(sessionId, reasons);
            bump();
            return true;
        },

        clear(sessionId, ...reasons): boolean {
            const current = held.get(sessionId);
            if (current === undefined) return false;
            if (reasons.length === 0) {
                held.delete(sessionId);
                bump();
                return true;
            }
            let changed = false;
            for (const reason of reasons) changed = current.delete(reason) || changed;
            if (current.size === 0) held.delete(sessionId);
            if (changed) bump();
            return changed;
        },
    };
}
