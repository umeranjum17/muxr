import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentWatchStores } from '../application/watchStores.js';
import type { SessionEventBody } from '@muxr/contract';
import { waitForPersistedRevision } from '../../platform/persistedJson.js';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function isRevisionFile(value: unknown): number | undefined {
    if (typeof value === 'object' && value !== null && 'revision' in value) {
        const revision = (value as { revision: unknown }).revision;
        return typeof revision === 'number' ? revision : undefined;
    }
    return undefined;
}

async function runSelfCheck(): Promise<void> {
    const dataDir = mkdtempSync(join(tmpdir(), 'muxr-domain-'));
    const now = (): Date => new Date('2026-07-27T12:00:00.000Z');
    const unreadPath = join(dataDir, 'unread.json');
    const attentionPath = join(dataDir, 'attention.json');
    const lifecyclePath = join(dataDir, 'lifecycle-activity.json');

    try {
        const stores = createAgentWatchStores({ dataDir, now });

        // unread: increment, acknowledge clears, revision advances
        const unread0 = stores.unread.catalog();
        assert(unread0.revision === 0, 'unread starts at revision 0');
        assert(unread0.entries.length === 0, 'unread starts empty');

        const unread1 = stores.unread.noteActivity('s1', '/tmp/a');
        assert(unread1.revision === 1, 'noteActivity bumps revision');
        assert(unread1.entries.length === 1, 'noteActivity adds entry');
        assert(unread1.entries[0]?.unreadCount === 1, 'unread count is 1');

        const unread2 = stores.unread.noteActivity('s1', '/tmp/a');
        assert(unread2.revision === 2, 'second noteActivity bumps revision');
        assert(unread2.entries[0]?.unreadCount === 2, 'unread count increments');

        const unread3 = stores.unread.acknowledge('s1');
        assert(unread3.revision === 3, 'acknowledge bumps revision');
        assert(unread3.entries.length === 0, 'acknowledge clears entry');

        // attention: set, most-urgent-wins, self-clearing
        assert(stores.attention.catalog().revision === 0, 'attention starts at revision 0');
        assert(stores.attention.catalog().entries.length === 0, 'attention starts empty');

        stores.attention.set('s1', 'done', 'Agent finished');
        assert(stores.attention.catalog().entries.length === 1, 'set creates an entry');
        assert(stores.attention.catalog().entries[0]?.reason === 'done', 'the only reason held wins');

        // A session holding several reasons is still one row: the most urgent.
        stores.attention.set('s1', 'waiting', 'Which platform?');
        const afterWaiting = stores.attention.catalog();
        assert(afterWaiting.entries.length === 1, 'one session is one row');
        assert(afterWaiting.entries[0]?.reason === 'waiting', 'waiting outranks done');
        assert(afterWaiting.entries[0]?.detail === 'Which platform?', 'the winning reason supplies the detail');

        // status.update fires per token: re-asserting must not churn the catalog.
        const revisionBeforeRepeat = stores.attention.catalog().revision;
        assert(!stores.attention.set('s1', 'waiting', 'Which platform?'), 'an unchanged reason reports no change');
        assert(stores.attention.catalog().revision === revisionBeforeRepeat, 'an unchanged reason must not bump revision');

        // Answering clears only that reason; the underlying done row survives.
        stores.attention.clear('s1', 'waiting');
        assert(stores.attention.catalog().entries[0]?.reason === 'done', 'clearing one reason falls back to the next');

        stores.attention.set('s2', 'blocked', 'Goal blocked: needs auth');
        assert(stores.attention.catalog().entries.length === 2, 'each session contributes one row');
        assert(stores.attention.catalog().entries[0]?.sessionId === 's2', 'rows sort by urgency, not arrival');

        // Opening a session clears everything but waiting -- the one row that
        // means the turn is parked until a human types.
        stores.attention.clear('s2');
        assert(stores.attention.catalog().entries.length === 1, 'clearing a session drops its row');

        stores.lifecycle.transition('stable', 'Maria', 'working', 'agent-working', 'Realtime Stability');
        const privateTitle = stores.lifecycle.transition(
            'private-title',
            'Maria',
            'working',
            'agent-working',
            '\u00a0/Users/owner/private/task',
        );
        assert(privateTitle?.taskTitle === undefined, 'leading whitespace cannot bypass lifecycle Task Title path rejection');
        const firstFailure = stores.lifecycle.transition('corrected', 'John', 'failed', 'start-launch-failed');
        assert(firstFailure !== undefined, 'first lifecycle outcome is recorded');
        assert(
            stores.lifecycle.transition('corrected', 'John', 'failed', 'start-launch-failed') === undefined,
            'an exact lifecycle duplicate is deduped',
        );
        assert(stores.lifecycle.latestFor('corrected')?.reasonCode === 'start-launch-failed', 'failed reconciliation preserves the start-related reason');
        const correctedFailure = stores.lifecycle.transition('corrected', 'John', 'failed', 'agent-runtime-failed');
        assert(correctedFailure !== undefined, 'same state with corrected reason is recorded');
        assert(stores.lifecycle.latestFor('corrected')?.reasonCode === 'agent-runtime-failed', 'corrected reason becomes current');
        assert(stores.lifecycle.catalog().events.filter((event) => event.sessionId === 'corrected').length === 2, 'corrected reason appends exactly one event');
        for (let index = 0; index < 60; index += 1) {
            stores.lifecycle.transition(`other-${index}`, 'John', 'done', 'agent-done');
        }
        assert(stores.lifecycle.catalog().events.length === 50, 'lifecycle digest stays bounded');
        assert(stores.lifecycle.latestFor('stable')?.state === 'working', 'current lifecycle survives unrelated digest eviction');

        await waitForPersistedRevision(unreadPath, isRevisionFile, unread3.revision);
        await waitForPersistedRevision(attentionPath, isRevisionFile, stores.attention.catalog().revision);
        await waitForPersistedRevision(lifecyclePath, isRevisionFile, stores.lifecycle.catalog().revision);

        // simulated restart: revision must continue increasing, not reset
        const restarted = createAgentWatchStores({ dataDir, now });
        assert(restarted.lifecycle.latestFor('stable')?.state === 'working', 'current lifecycle survives restart outside the digest');
        assert(restarted.lifecycle.latestFor('corrected')?.reasonCode === 'agent-runtime-failed', 'corrected lifecycle reason survives restart');
        const unreadAfterRestart = restarted.unread.catalog();
        assert(unreadAfterRestart.revision === unread3.revision, 'unread revision survives restart');
        assert(unreadAfterRestart.entries.length === 0, 'unread entries survive restart');

        restarted.unread.noteActivity('s-restart', '/tmp/restart');
        assert(restarted.unread.catalog().revision === unread3.revision + 1, 'unread revision keeps increasing after restart');

        const attentionAfterRestart = restarted.attention.catalog();
        assert(
            attentionAfterRestart.revision === stores.attention.catalog().revision,
            'attention revision survives restart',
        );
        assert(attentionAfterRestart.entries[0]?.reason === 'done', 'a finished agent still needs you after a restart');

        // A restored `waiting` row could never be answered: the promise behind it
        // died with the old process. Dropping it beats stranding it in the inbox.
        restarted.attention.set('s-ghost', 'waiting', 'answer me');
        await waitForPersistedRevision(attentionPath, isRevisionFile, restarted.attention.catalog().revision);
        const afterGhostRestart = createAgentWatchStores({ dataDir, now }).attention.catalog();
        assert(
            !afterGhostRestart.entries.some((entry) => entry.sessionId === 's-ghost'),
            'waiting must not survive a restart',
        );

        // corrupt persisted file must not crash construction
        writeFileSync(unreadPath, '{not-json', { encoding: 'utf8' });
        const afterCorruptUnread = createAgentWatchStores({ dataDir, now }).unread.catalog();
        assert(afterCorruptUnread.revision === 0, 'corrupt unread file starts empty');
        assert(afterCorruptUnread.entries.length === 0, 'corrupt unread file has no entries');

        writeFileSync(attentionPath, '[]', { encoding: 'utf8' });
        const afterCorruptAttention = createAgentWatchStores({ dataDir, now }).attention.catalog();
        assert(afterCorruptAttention.revision === 0, 'corrupt attention file starts empty');
        assert(afterCorruptAttention.entries.length === 0, 'corrupt attention file has no entries');
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
    process.stdout.write('PASS: domain selfCheck (unread, attention, lifecycle)\n');
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
    runSelfCheck().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FAIL: domain selfCheck: ${message}\n`);
        process.exitCode = 1;
    });
}
