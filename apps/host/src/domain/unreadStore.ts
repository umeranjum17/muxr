import { join } from 'node:path';
import type { SessionUnreadEntry, UnreadCatalog } from '@muxr/contract';
import { createPersistQueue, loadPersistedJson } from './persistedJson.js';

interface UnreadRecord extends SessionUnreadEntry {
    /** Monotonic per-session activity sequence for throughSeq acknowledgement. */
    seq: number;
}

interface UnreadFile {
    revision: number;
    records: UnreadRecord[];
}

export interface UnreadStore {
    catalog(): UnreadCatalog;
    acknowledge(sessionId: string, throughSeq?: number): UnreadCatalog;
    noteActivity(sessionId: string, cwd: string): UnreadCatalog;
}

function isUnreadFile(value: unknown): value is UnreadFile {
    return (
        typeof value === 'object' &&
        value !== null &&
        'revision' in value &&
        typeof (value as UnreadFile).revision === 'number' &&
        'records' in value &&
        Array.isArray((value as UnreadFile).records)
    );
}

export function createUnreadStore(dataDir: string, now: () => Date = () => new Date()): UnreadStore {
    const filePath = join(dataDir, 'unread.json');
    const persisted = loadPersistedJson(filePath, isUnreadFile, { revision: 0, records: [] });
    let revision = persisted.revision;
    const bySession = new Map<string, UnreadRecord>(persisted.records.map((record) => [record.sessionId, record]));
    const persist = createPersistQueue(filePath);

    function persistNow(): void {
        persist.schedule({ revision, records: [...bySession.values()] });
    }

    function snapshot(): UnreadCatalog {
        const entries = [...bySession.values()]
            .map(({ sessionId, cwd, unreadCount, lastActivityAt }) => ({
                sessionId,
                cwd,
                unreadCount,
                lastActivityAt,
            }))
            .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
        return { revision, entries };
    }

    function bump(): UnreadCatalog {
        revision += 1;
        persistNow();
        return snapshot();
    }

    return {
        catalog: snapshot,

        noteActivity(sessionId: string, cwd: string): UnreadCatalog {
            const existing = bySession.get(sessionId);
            const nextSeq = (existing?.seq ?? 0) + 1;
            bySession.set(sessionId, {
                sessionId,
                cwd,
                unreadCount: (existing?.unreadCount ?? 0) + 1,
                lastActivityAt: now().toISOString(),
                seq: nextSeq,
            });
            return bump();
        },

        acknowledge(sessionId: string, throughSeq?: number): UnreadCatalog {
            const existing = bySession.get(sessionId);
            if (existing === undefined) return snapshot();
            if (throughSeq !== undefined && existing.seq > throughSeq) return snapshot();
            bySession.delete(sessionId);
            return bump();
        },
    };
}
