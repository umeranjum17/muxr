import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAttentionStore } from './attentionStore.js';
import { waitForPersistedRevision } from '../../platform/persistedJson.js';

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
    it('decays at the TTL boundary, keeps waiting, and persists the prune across restart', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'attention-decay-'));
        const filePath = join(dir, 'attention.json');
        const start = 1_000_000_000_000;
        let current = start;
        const store = createAttentionStore(dir, () => new Date(current));
        const revisionOf = (value: unknown): number | undefined =>
            typeof (value as { revision?: unknown }).revision === 'number'
                ? ((value as { revision: number }).revision)
                : undefined;
        const ids = () => store.catalog().entries.map((entry) => entry.sessionId);

        store.set('wait', 'waiting', 'Which platform?');
        store.set('done', 'done', 'old finish');
        store.set('fail', 'failed', 'hit an error');

        current = start + 9 * 60_000;
        expect(ids().sort()).toEqual(['done', 'fail', 'wait']);

        current = start + 11 * 60_000;
        expect(ids().sort()).toEqual(['fail', 'wait']);

        current = start + 6 * 3600_000 + 1;
        expect(ids()).toEqual(['wait']);

        store.set('fresh', 'done', 'fresh finish');
        await waitForPersistedRevision(filePath, revisionOf, 6);
        expect(ids().sort()).toEqual(['fresh', 'wait']);

        const restarted = createAttentionStore(dir, () => new Date(current));
        expect(restarted.catalog().entries.map((entry) => entry.sessionId)).toEqual(['fresh']);
        const persisted = JSON.parse(readFileSync(filePath, 'utf8')).sessions;
        expect(persisted.done).toBeUndefined();
        expect(persisted.fail).toBeUndefined();
        expect(persisted.fresh).toBeDefined();
    });
});
