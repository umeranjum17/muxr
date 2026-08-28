/**
 * Layout snapshot round-trip plus the IdentityStore flow: current schema only,
 * Human Name allocation, Agent Route across pane moves, voice replay fence.
 */

import {
    collectKinds,
    collectPaneIds,
    toHerdrRoot,
    toSnapshot,
    type HerdrLayoutNode,
} from '../domain/layout.js';
import { lifecycleReasonForObservation } from '../domain/lifecycle.js';
import { IdentityStore, parseTaskTitle } from './identity.js';
import { RealtimeCodingCoordinator } from './realtimeCoordinator.js';
import { createConnection } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

async function ask(
    socketPath: string,
    capability: string,
    request: Record<string, unknown>,
): Promise<{ ok: boolean; data?: string }> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buf = '';
        socket.on('data', (chunk) => { buf += chunk.toString('utf8'); });
        socket.on('end', () => {
            try { resolve(JSON.parse(buf) as { ok: boolean; data?: string }); } catch (error) { reject(error); }
        });
        socket.on('error', reject);
        socket.write(`${JSON.stringify({ id: '1', capability, request })}\n`);
    });
}

async function demo(): Promise<void> {
    const identity = new IdentityStore(mkdtempSync(join(tmpdir(), 'pph-layout-check-')));
    const john = identity.adopt({ paneId: 'w1:p1', workspaceId: 'w1', tabId: 'w1:t1', cwd: '/repo', displayName: 'John', kind: 'pi', ours: true });
    const maria = identity.adopt({ paneId: 'w1:p3', workspaceId: 'w1', tabId: 'w1:t1', cwd: '/repo', displayName: 'Maria', kind: 'claude', ours: true });
    assert(john.taskTitle === 'Pi task' && maria.taskTitle === 'Claude task', 'adopt fills a generic Task Title from Provider Kind');

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

    const snapshot = toSnapshot(live, (paneId) => identity.byPane(paneId)?.kind);
    assert(snapshot.type === 'split', 'root stays a split');
    assert(
        JSON.stringify(collectKinds(snapshot)) === JSON.stringify(['pi', undefined, 'claude']),
        'kinds follow leaf order, undefined where no agent',
    );
    assert(!JSON.stringify(snapshot).includes('w1:p'), 'snapshot carries no live pane ids');
    assert(JSON.stringify(snapshot).includes('/other'), 'per-pane cwd is preserved');

    const rebuilt = toHerdrRoot(snapshot);
    assert(rebuilt.type === 'split' && rebuilt.direction === 'right', 'direction preserved');
    assert(!JSON.stringify(rebuilt).includes('pane_id'), 'rebuilt tree has no pane ids');

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

    const solo = toSnapshot({ type: 'pane', pane_id: 'w1:p1' }, (paneId) => identity.byPane(paneId)?.kind);
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

    const staleDir = mkdtempSync(join(tmpdir(), 'pph-stale-identity-check-'));
    writeFileSync(join(staleDir, 'herdr-identity.json'), JSON.stringify({ sessions: [
        { sessionId: 'stable-d', paneId: 'p4', workspaceId: 'w1', tabId: 'w1:t1', cwd: '/repo', createdAt: '', ours: true, label: 'Cart Fix', displayName: 'Cart Fix' },
    ] }));
    const stale = new IdentityStore(staleDir);
    await stale.load();
    assert(stale.all().length === 0, 'old or invalid identity files rebuild empty from Herdr');

    assert(parseTaskTitle('pi') === undefined && parseTaskTitle('hi') === undefined && parseTaskTitle('pp_hidden') === undefined, 'provider kinds, greetings, and handles are not Task Titles');
    assert(parseTaskTitle('Falcon') === 'Falcon' && parseTaskTitle('Review monitoring') === 'Review monitoring', 'a real work phrase is a Task Title');

    const names = new IdentityStore(mkdtempSync(join(tmpdir(), 'pph-name-pool-')));
    const taken: string[] = [];
    for (let index = 0; index < 40; index += 1) {
        const reserved = names.reserve();
        assert(!taken.map((name) => name.toLocaleLowerCase()).includes(reserved.displayName.toLocaleLowerCase()), 'Human Names stay unique while reserved');
        names.adopt({
            sessionId: reserved.sessionId,
            paneId: `w1:p${index}`,
            workspaceId: 'w1',
            tabId: 'w1:t1',
            cwd: '/repo',
            displayName: reserved.displayName,
            kind: 'pi',
            ours: true,
        });
        reserved.release();
        taken.push(reserved.displayName);
    }
    assert(new Set(taken.map((name) => name.toLocaleLowerCase())).size === 40, 'the Human Name pool does not collide');

    const stableDir = mkdtempSync(join(tmpdir(), 'pph-stable-identity-check-'));
    const started = new IdentityStore(stableDir);
    const reserved = started.reserve('John');
    started.adopt({
        sessionId: reserved.sessionId,
        paneId: 'w1:p1',
        workspaceId: 'w1',
        tabId: 'w1:t1',
        cwd: '/repo',
        agentName: reserved.sessionId,
        displayName: reserved.displayName,
        taskTitle: 'Stabilize realtime voice',
        kind: 'codex',
        ours: true,
    });
    reserved.release();
    await started.flush();
    const rediscovered = new IdentityStore(stableDir);
    await rediscovered.load();
    const matched = rediscovered.byRoute(reserved.sessionId, 'w9:p7');
    assert(matched?.sessionId === reserved.sessionId, 'Agent Route wins before a changed pane id');
    const moved = rediscovered.observe({
        paneId: 'w9:p7',
        previousPaneId: 'w1:p1',
        workspaceId: 'w9',
        tabId: 'w9:t4',
        cwd: '/repo/worktree',
        agentName: reserved.sessionId,
        kind: 'codex',
        terminalTitle: 'Stabilize realtime voice',
    });
    assert(moved.identity.displayName === 'John', 'observation never promotes a Human Name');
    await rediscovered.flush();
    const afterMove = new IdentityStore(stableDir);
    await afterMove.load();
    const stable = afterMove.get(reserved.sessionId);
    assert(stable?.paneId === 'w9:p7' && stable.workspaceId === 'w9' && stable.tabId === 'w9:t4' && stable.cwd === '/repo/worktree', 'rediscovery persists coherent moved topology');
    assert(stable?.sessionId === reserved.sessionId && stable.displayName === 'John' && stable.taskTitle === 'Stabilize realtime voice' && stable.kind === 'codex', 'restart and move preserve Human Name, Agent Route, Task Title, and Provider Kind');

    const socketDir = mkdtempSync(join(tmpdir(), 'pph-coord-check-'));
    const socketPath = join(socketDir, 'realtime-coding.sock');
    let prompts = 0;
    const coordinator = new RealtimeCodingCoordinator(socketPath, {
        list: async () => [{ sessionId: 'pp_john', cwd: '/repo', displayName: 'John', taskTitle: 'Harden audio', kind: 'pi', status: 'idle' }],
        activity: async () => [],
        start: async () => ({ accepted: false }),
        prompt: async () => { prompts += 1; },
        read: async () => ({ text: '', truncated: false }),
        status: async () => 'idle',
        watch: async () => ({ status: 'idle', detail: 'John is idle' }),
        focus: async () => undefined,
    });
    await coordinator.start();
    const access = coordinator.issueCapability({ cwd: '/repo', sessionId: 'pp_john' });
    const first = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    const replayed = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    assert(first.ok === true && replayed.ok === true && prompts === 1, 'an accepted operation id replays without rerunning the mutation');
    const taskStatus = await ask(socketPath, access.capability, { method: 'status', agent: 'Harden audio' });
    assert(taskStatus.data === 'John is idle.', 'a unique Task Title resolves to its Human Name');
    const idleWatch = await ask(socketPath, access.capability, { method: 'watch', agent: 'John', operationId: 'watch-idle' });
    assert(idleWatch.data === 'Confirmed: John is idle.', 'idle is spoken as idle, without duplicated watch wording or finished');
    assert(idleWatch.data !== undefined && !/finish/i.test(idleWatch.data), 'idle is not spoken as finished');
    for (let index = 1; index <= 126; index += 1) {
        await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: `n${index}`, operationId: `op-${index}` });
    }
    assert(prompts === 127, 'accepted prompts occupy the replay fence');
    const overflow = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'overflow', operationId: 'op-overflow' });
    assert(overflow.ok === true && overflow.data !== undefined && overflow.data.includes('Too many') && prompts === 127, 'a full replay fence rejects new mutations instead of evicting an accepted id');
    const stillHeld = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    assert(stillHeld.ok === true && prompts === 127, 'the first accepted operation id still replays after the fence is full');
    coordinator.revokeCapability(access.capability);
    await coordinator.close();

    console.log('layout snapshot self-check passed');
}

demo().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
