import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAttentionStore } from './attentionStore.js';
import { waitForPersistedRevision } from './persistedJson.js';

function storeWith(sessions: unknown): ReturnType<typeof createAttentionStore> {
    const dir = mkdtempSync(join(tmpdir(), 'attention-'));
    writeFileSync(join(dir, 'attention.json'), JSON.stringify({ revision: 7, sessions }));
    return createAttentionStore(dir);
}

describe('createAttentionStore', () => {
    it('drops persisted reasons this build no longer knows', () => {
        // 'flagged' was removed with the milestone plumbing; a file written by
        // an older host still names it, and publishing it crashed the inbox.
        const store = storeWith({
            s1: { flagged: { detail: 'old milestone', at: new Date().toISOString() } },
            s2: { done: { detail: 'Agent finished', at: new Date().toISOString() } },
        });
        const entries = store.catalog().entries;
        expect(entries.map((entry) => entry.sessionId)).toEqual(['s2']);
        expect(entries[0]?.reason).toBe('done');
    });

    it('drops persisted waiting rows that no promise can clear', () => {
        const store = storeWith({
            s1: { waiting: { detail: 'Replace goal?', at: new Date().toISOString() } },
        });
        expect(store.catalog().entries).toEqual([]);
    });
});

describe('attention decay', () => {
    function storeWithClock(): { store: ReturnType<typeof createAttentionStore>; setNow: (ms: number) => void } {
        const dir = mkdtempSync(join(tmpdir(), 'attention-decay-'));
        let current = 1_000_000_000_000;
        const store = createAttentionStore(dir, () => new Date(current));
        return { store, setNow: (ms: number) => { current = ms; } };
    }

    it('waiting never decays', () => {
        const { store, setNow } = storeWithClock();
        setNow(1_000_000_000_000);
        store.set('s1', 'waiting', 'Which platform?');
        setNow(1_000_000_000_000 + 7 * 3600_000);
        expect(store.catalog().entries.map((entry) => entry.sessionId)).toEqual(['s1']);
    });

    it('done decays after 10 minutes', () => {
        const { store, setNow } = storeWithClock();
        setNow(1_000_000_000_000);
        store.set('s1', 'done', 'Agent finished');
        setNow(1_000_000_000_000 + 9 * 60_000);
        expect(store.catalog().entries.map((entry) => entry.sessionId)).toEqual(['s1']);
        setNow(1_000_000_000_000 + 11 * 60_000);
        expect(store.catalog().entries).toEqual([]);
    });

    it('drops anything older than 6 hours', () => {
        const { store, setNow } = storeWithClock();
        setNow(1_000_000_000_000);
        store.set('s1', 'failed', 'hit an error');
        setNow(1_000_000_000_000 + 6 * 3600_000 + 1);
        expect(store.catalog().entries).toEqual([]);
    });

    it('removes decayed rows from persistence on the next write', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'attention-decay-persist-'));
        const filePath = join(dir, 'attention.json');
        let current = 1_000_000_000_000;
        const store = createAttentionStore(dir, () => new Date(current));
        const revisionOf = (value: unknown): number | undefined =>
            typeof (value as { revision?: unknown }).revision === 'number'
                ? ((value as { revision: number }).revision)
                : undefined;

        store.set('s1', 'done', 'old finish');
        current += 11 * 60_000; // s1 now past the done TTL
        store.set('s2', 'done', 'fresh finish');
        await waitForPersistedRevision(filePath, revisionOf, 2);

        current += 5 * 60_000; // s2 still under the TTL
        expect(store.catalog().entries.map((entry) => entry.sessionId)).toEqual(['s2']);
        await waitForPersistedRevision(filePath, revisionOf, 3);

        const restarted = createAttentionStore(dir, () => new Date(current));
        expect(restarted.catalog().entries.map((entry) => entry.sessionId)).toEqual(['s2']);
        expect(JSON.parse(readFileSync(filePath, 'utf8')).sessions.s1).toBeUndefined();
    });
});
