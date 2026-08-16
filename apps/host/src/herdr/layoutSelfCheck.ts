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
    toHerdrRoot,
    toSnapshot,
    type HerdrLayoutNode,
} from './herdrSessionSource.js';
import { IdentityStore } from './identity.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

function demo(): void {
    const identity = new IdentityStore(mkdtempSync(join(tmpdir(), 'pph-layout-check-')));
    const base = { workspaceId: 'w1', tabId: 'w1:t1', cwd: '/repo', createdAt: '', ours: true };
    identity.put({ ...base, sessionId: 'a', paneId: 'w1:p1', kind: 'pi' });
    identity.put({ ...base, sessionId: 'b', paneId: 'w1:p3', kind: 'claude' });

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

    console.log('layout snapshot self-check passed');
}

demo();
