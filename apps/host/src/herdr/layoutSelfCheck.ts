/**
 * Layout snapshot round-trip.
 *
 * The transforms are recursive and the apply path relies on one specific
 * invariant: collectKinds and collectPaneIds must walk the tree in the SAME
 * order, because that positional match is how a recorded agent kind finds the
 * new pane herdr just created for it. Get the order wrong and agents silently
 * launch in the wrong panes.
 */

import {
    collectKinds,
    collectPaneIds,
    lifecycleReasonForObservation,
    toHerdrRoot,
    toSnapshot,
    type HerdrLayoutNode,
} from './herdrSessionSource.js';
import { IdentityStore, promotedHerdrDisplayName, reconcileHerdrIdentity } from './identity.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

async function demo(): Promise<void> {
    const identity = new IdentityStore(mkdtempSync(join(tmpdir(), 'pph-layout-check-')));
    const base = { workspaceId: 'w1', tabId: 'w1:t1', cwd: '/repo', createdAt: '', ours: true };
    identity.put({ ...base, sessionId: 'a', paneId: 'w1:p1', displayName: 'John', kind: 'pi' });
    identity.put({ ...base, sessionId: 'b', paneId: 'w1:p3', displayName: 'Maria', kind: 'claude' });

    // (p1 | (p2 / p3)) -- asymmetric on purpose so a left/right swap shows up.
    const live: HerdrLayoutNode = {
        type: 'split',
        direction: 'right',
        ratio: 0.5,
        first: { type: 'pane', pane_id: 'w1:p1', cwd: '/repo' },
        second: {
            type: 'split',
            direction: 'down',
            ratio: 0.4,
            first: { type: 'pane', pane_id: 'w1:p2', cwd: '/repo' },
            second: { type: 'pane', pane_id: 'w1:p3', cwd: '/other' },
        },
    };

    const snapshot = toSnapshot(live, identity);
    assert(snapshot.type === 'split', 'root stays a split');

    // Kinds land on the right leaves, and a pane with no agent stays undefined.
    assert(
        JSON.stringify(collectKinds(snapshot)) === JSON.stringify(['pi', undefined, 'claude']),
        'kinds follow leaf order, undefined where no agent',
    );

    // Live pane ids must NOT survive into a saved snapshot; they are stale on restore.
    assert(!JSON.stringify(snapshot).includes('w1:p'), 'snapshot carries no live pane ids');
    assert(JSON.stringify(snapshot).includes('/other'), 'per-pane cwd is preserved');

    // Rebuilding for herdr keeps shape and cwd but adds no pane ids or commands.
    const rebuilt = toHerdrRoot(snapshot);
    assert(rebuilt.type === 'split' && rebuilt.direction === 'right', 'direction preserved');
    assert(!JSON.stringify(rebuilt).includes('pane_id'), 'rebuilt tree has no pane ids');

    // The invariant the apply path depends on: same tree shape => same walk order.
    const applied: HerdrLayoutNode = {
        type: 'split',
        direction: 'right',
        ratio: 0.5,
        first: { type: 'pane', pane_id: 'w9:p7' },
        second: {
            type: 'split',
            direction: 'down',
            ratio: 0.4,
            first: { type: 'pane', pane_id: 'w9:p8' },
            second: { type: 'pane', pane_id: 'w9:p9' },
        },
    };
    const kinds = collectKinds(snapshot);
    const panes = collectPaneIds(applied);
    assert(kinds.length === panes.length, 'one slot per leaf in both walks');
    const pairs = kinds.map((kind, index) => `${kind ?? '-'}@${panes[index]}`);
    assert(
        JSON.stringify(pairs) === JSON.stringify(['pi@w9:p7', '-@w9:p8', 'claude@w9:p9']),
        `kind/pane pairing drifted: ${pairs.join(' ')}`,
    );

    // A single-pane tab is the common case and must not throw.
    const solo = toSnapshot({ type: 'pane', pane_id: 'w1:p1' }, identity);
    assert(collectKinds(solo).length === 1, 'single pane yields one slot');
    assert(
        lifecycleReasonForObservation('failed', undefined, 'start-timeout') === 'start-timeout',
        'failed reconciliation without a live agent preserves the start failure chronology',
    );
    assert(
        lifecycleReasonForObservation('failed', undefined, 'start-launch-failed') === 'start-launch-failed',
        'launch failure reconciliation does not emit a duplicate runtime failure',
    );
    assert(
        lifecycleReasonForObservation('failed', 'failed', 'start-timeout') === 'agent-runtime-failed',
        'an observed live agent failure is classified as runtime failure',
    );

    const migrationDir = mkdtempSync(join(tmpdir(), 'pph-identity-check-'));
    const legacyBase = { workspaceId: 'w1', tabId: 'w1:t1', cwd: '/repo', createdAt: '', ours: true };
    writeFileSync(join(migrationDir, 'herdr-identity.json'), JSON.stringify({ sessions: [
        { ...legacyBase, sessionId: 'stable-d', paneId: 'p4', label: 'Cart Fix', displayName: 'Cart Fix' },
        { ...legacyBase, sessionId: 'stable-c', paneId: 'p3', displayName: 'Maria 2' },
        { ...legacyBase, sessionId: 'stable-b', paneId: 'p2', displayName: ' maria ' },
        { ...legacyBase, sessionId: 'stable-a', paneId: 'p1', displayName: 'Maria' },
    ] }));
    const migrated = new IdentityStore(migrationDir);
    await migrated.load();
    assert(migrated.get('stable-a')?.displayName === 'Maria', 'stable ordering preserves one base display name');
    assert(migrated.get('stable-b')?.displayName === 'maria 3', 'duplicate display name skips an existing visible suffix');
    assert(migrated.get('stable-c')?.displayName === 'Maria 2', 'existing safe suffix remains stable');
    assert(migrated.get('stable-d')?.displayName !== 'Cart Fix' && migrated.get('stable-d')?.taskTitle === 'Cart Fix', 'legacy work label becomes the task, not a teammate name');
    const restarted = new IdentityStore(migrationDir);
    await restarted.load();
    assert(restarted.get('stable-b')?.displayName === 'maria 3', 'display-name migration persists across restart');

    const stableDir = mkdtempSync(join(tmpdir(), 'pph-stable-identity-check-'));
    const started = new IdentityStore(stableDir);
    started.put({
        sessionId: 'pp_stable_voice',
        paneId: 'w1:p1',
        workspaceId: 'w1',
        tabId: 'w1:t1',
        cwd: '/repo',
        agentName: 'pp_stable_voice',
        displayName: 'John',
        taskTitle: 'Stabilize realtime voice',
        kind: 'codex',
        autoLabel: true,
        createdAt: new Date().toISOString(),
        ours: true,
    });
    await started.flush();
    const rediscovered = new IdentityStore(stableDir);
    await rediscovered.load();
    const matched = rediscovered.matchAgent('pp_stable_voice', 'w9:p7');
    assert(matched?.sessionId === 'pp_stable_voice', 'stable app agent token wins before a changed pane id');
    assert(promotedHerdrDisplayName(matched!, 'pp_hidden', rediscovered.all()) === undefined, 'internal names cannot replace spoken identity');
    assert(promotedHerdrDisplayName(matched!, 'Maria', [
        ...rediscovered.all(),
        { ...matched!, sessionId: 'pp_other', paneId: 'w2:p1', displayName: 'Maria' },
    ]) === undefined, 'duplicate human names cannot replace spoken identity');
    const promoted = promotedHerdrDisplayName(matched!, 'Nora', rediscovered.all());
    assert(promoted === 'Nora', 'a unique explicit rename promotes the auto display name');
    rediscovered.put({ ...reconcileHerdrIdentity(matched!, {
        paneId: 'w9:p7',
        workspaceId: 'w9',
        tabId: 'w9:t4',
        cwd: '/repo/worktree',
        agentName: 'pp_stable_voice',
        kind: 'codex',
        taskTitle: 'Stabilize realtime voice',
        displayName: promoted!,
    }), label: 'Nora', autoLabel: false });
    await rediscovered.flush();
    const afterMove = new IdentityStore(stableDir);
    await afterMove.load();
    const stable = afterMove.get('pp_stable_voice');
    assert(stable?.paneId === 'w9:p7' && stable.workspaceId === 'w9' && stable.tabId === 'w9:t4' && stable.cwd === '/repo/worktree', 'rediscovery persists coherent moved topology');
    assert(stable?.sessionId === 'pp_stable_voice' && stable.displayName === 'Nora' && stable.taskTitle === 'Stabilize realtime voice' && stable.kind === 'codex', 'restart and move preserve promoted spoken name, stable session, task title, and kind');

    console.log('layout snapshot self-check passed');
}

demo().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
