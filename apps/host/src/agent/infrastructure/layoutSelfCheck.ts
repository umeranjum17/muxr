/**
 * Layout snapshot round-trip plus canonical Herdr Agent Name and stable Agent
 * Route behavior across pane moves.
 */

import {
    collectKinds,
    collectPaneIds,
    toHerdrRoot,
    toSnapshot,
    type HerdrLayoutNode,
} from '../domain/layout.js';
import { lifecycleReasonForObservation } from '../domain/lifecycle.js';
import { AgentRouteStore, type HerdrAgentSessionRef } from './agentRouteStore.js';
import { RealtimeCodingCoordinator } from './realtimeCoordinator.js';
import { closeAgentRoute, closeExactPane, closeExactTab, closeExactWorkspace, mergeHerdrAgentEvent, promptHerdrAgent, promptPromptableHerdrAgent, sendKeysToLiveAgent } from './herdrSessionSource.js';
import { createConnection } from 'node:net';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
    const kindByPane: Record<string, string | undefined> = {
        'w1:p1': 'pi',
        'w1:p3': 'claude',
    };

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

    const snapshot = toSnapshot(live, (paneId) => kindByPane[paneId]);
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

    const solo = toSnapshot({ type: 'pane', pane_id: 'w1:p1' }, (paneId) => kindByPane[paneId]);
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

    const readyEventState = { pane_id: 'w1:p1', interactive_ready: true, launch_pending: false };
    const partialStatusEvent = mergeHerdrAgentEvent(readyEventState, { pane_id: 'w1:p1', agent_status: 'idle' });
    const explicitReadinessEvent = mergeHerdrAgentEvent(readyEventState, {
        pane_id: 'w1:p1',
        interactive_ready: false,
        launch_pending: true,
    });
    assert(partialStatusEvent.interactive_ready === true && partialStatusEvent.launch_pending === false
        && explicitReadinessEvent.interactive_ready === false && explicitReadinessEvent.launch_pending === true,
    'partial Herdr events preserve readiness while explicit readiness replaces it');
    const routeDir = mkdtempSync(join(tmpdir(), 'muxr-route-flow-'));
    writeFileSync(join(routeDir, 'herdr-identity.json'), JSON.stringify({
        sessions: [{ sessionId: 'stale', agentName: 'Badger' }],
    }));
    const routeStore = new AgentRouteStore(routeDir);
    await routeStore.load();
    assert(routeStore.all().length === 0, 'obsolete identity files are ignored without pane migration');
    const sessionA: HerdrAgentSessionRef = {
        source: 'herdr:pi',
        agent: 'pi',
        kind: 'id',
        value: 'generation-a',
    };
    const sessionB: HerdrAgentSessionRef = {
        source: 'herdr:pi',
        agent: 'pi',
        kind: 'id',
        value: 'generation-b',
    };
    const badger = { name: 'Badger', agent_session: sessionA, pane_id: 'w1:p1' };
    const routeA = routeStore.bind(sessionA).route;
    const movedBadger = { ...badger, pane_id: 'w9:p7' };
    assert(routeStore.bind(movedBadger.agent_session).route === routeA && movedBadger.name === 'Badger',
        'Badger session A keeps its route across a pane move');

    const removed = routeStore.reconcile([sessionB]);
    const pelican = {
        name: 'Pelican',
        agent_session: sessionB,
        pane_id: 'w9:p7',
        interactive_ready: false,
        launch_pending: true,
    };
    const routeB = routeStore.bind(sessionB).route;
    assert(removed[0]?.route === routeA && routeStore.get(routeA) === undefined && routeB !== routeA && pelican.name === 'Pelican',
        'Pelican session B removes Badger and receives a distinct current route');

    const promptCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const promptClient = {
        call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
            promptCalls.push({ method, params });
            return {
                type: 'agent_prompted',
                agent: {
                    terminal_id: 'terminal',
                    agent_status: 'idle',
                    workspace_id: 'workspace',
                    tab_id: 'tab',
                    pane_id: pelican.pane_id,
                    focused: false,
                    revision: 1,
                },
            } as T;
        },
    };
    let notReady = false;
    try {
        await promptPromptableHerdrAgent(promptClient, { sessionId: routeB, paneId: pelican.pane_id }, false, 'too early');
    } catch (error) {
        notReady = error instanceof Error && 'code' in error && error.code === 'agent-not-ready';
    }
    assert(notReady && promptCalls.length === 0, 'Pelican starting is not promptable and sends zero Herdr prompts');
    pelican.interactive_ready = true;
    pelican.launch_pending = false;
    await promptPromptableHerdrAgent(promptClient, { sessionId: routeB, paneId: pelican.pane_id }, true, 'continue');
    assert(promptCalls.length === 1, 'ready Pelican keeps route B and queues exactly one prompt');
    await routeStore.flush();
    const restartedRoutes = new AgentRouteStore(routeDir);
    await restartedRoutes.load();
    assert((statSync(join(routeDir, 'herdr-routes.json')).mode & 0o077) === 0,
        'route bindings persist owner-only');
    assert(restartedRoutes.route(sessionB) === routeB && restartedRoutes.route(sessionA) === undefined,
        'host restart restores only current Pelican route B');

    const herdrKeyCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const keyClient = {
        call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
            herdrKeyCalls.push({ method, params });
            return undefined as T;
        },
    };
    await sendKeysToLiveAgent(keyClient, { sessionId: routeB, paneId: pelican.pane_id }, ['escape']);
    assert(herdrKeyCalls[0]?.params.target === pelican.pane_id,
        'runtime controls resolve through current route B');
    const stopCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let failStopClose = false;
    const stopClient = {
        call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
            stopCalls.push({ method, params });
            if (failStopClose) throw new Error('close failed');
            return undefined as T;
        },
    };
    const stopPanes = new Map([
        ['w1:p2', { tab_id: 'w1:t1' }],
        ['w1:p3', { tab_id: 'w1:t1' }],
        ['w1:p4', { tab_id: 'w1:t2' }],
    ]);
    const stopTabs = new Map([
        ['w1:t1', { workspace_id: 'w1' }],
        ['w1:t2', { workspace_id: 'w1' }],
    ]);
    const cleanupCalls: string[] = [];
    const recordCleanup = (target: { sessionId: string }): void => { cleanupCalls.push(target.sessionId); };
    await closeAgentRoute(
        stopClient,
        { sessionId: 'route-selected', paneId: 'w1:p2' },
        stopPanes,
        stopTabs,
        recordCleanup,
    );
    await closeAgentRoute(
        stopClient,
        { sessionId: 'route-sole', paneId: 'w1:p4' },
        stopPanes,
        stopTabs,
        recordCleanup,
    );
    assert(JSON.stringify(stopCalls) === JSON.stringify([
        { method: 'pane.close', params: { pane_id: 'w1:p2' } },
        { method: 'tab.close', params: { tab_id: 'w1:t2' } },
    ]), 'session.stop closes one selected pane in a split tab and one selected sole-pane tab');
    assert(JSON.stringify(cleanupCalls) === JSON.stringify(['route-selected', 'route-sole']),
        'route-owned state cleans up only after each successful exact close');
    stopPanes.set('w2:p4', { tab_id: 'w2:t4' });
    stopTabs.set('w2:t4', { workspace_id: 'w2' });
    let lastTabStopError: unknown;
    try {
        await closeAgentRoute(
            stopClient,
            { sessionId: 'route-last-tab', paneId: 'w2:p4' },
            stopPanes,
            stopTabs,
            recordCleanup,
        );
    } catch (error) {
        lastTabStopError = error;
    }
    const lastTabStopCode = lastTabStopError !== null && typeof lastTabStopError === 'object' && 'code' in lastTabStopError
        ? lastTabStopError.code
        : undefined;
    assert(lastTabStopCode === 'tab-close-would-widen' && stopCalls.length === 2 && cleanupCalls.length === 2,
        'Stop agent refuses a sole last tab instead of closing its workspace');
    stopPanes.set('w3:p1', { tab_id: 'w3:t1' });
    stopTabs.set('w3:t1', { workspace_id: 'w3' });
    stopTabs.set('w3:t2', { workspace_id: 'w3' });
    failStopClose = true;
    try {
        await closeAgentRoute(
            stopClient,
            { sessionId: 'route-failed-close', paneId: 'w3:p1' },
            stopPanes,
            stopTabs,
            recordCleanup,
        );
    } catch {}
    assert(cleanupCalls.length === 2, 'failed exact close leaves route cleanup untouched');
    const explicitCloseCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const explicitCloseClient = {
        call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
            explicitCloseCalls.push({ method, params });
            return undefined as T;
        },
    };
    const explicitPanes = new Map([
        ['w4:p1', { tab_id: 'w4:t1' }],
        ['w4:p2', { tab_id: 'w4:t1' }],
    ]);
    const explicitTabs = new Map([
        ['w4:t2', { workspace_id: 'w4' }],
        ['w4:t3', { workspace_id: 'w4' }],
    ]);
    await closeExactPane(explicitCloseClient, 'w4:p1', explicitPanes);
    await closeExactTab(explicitCloseClient, 'w4:t2', explicitTabs);
    let paneWidenError: unknown;
    try { await closeExactPane(explicitCloseClient, 'w7:p1', new Map([['w7:p1', { tab_id: 'w7:t1' }]])); }
    catch (error) { paneWidenError = error; }
    let tabWidenError: unknown;
    try { await closeExactTab(explicitCloseClient, 'w8:t1', new Map([['w8:t1', { workspace_id: 'w8' }]])); }
    catch (error) { tabWidenError = error; }
    const paneWidenCode = paneWidenError !== null && typeof paneWidenError === 'object' && 'code' in paneWidenError
        ? paneWidenError.code
        : undefined;
    const tabWidenCode = tabWidenError !== null && typeof tabWidenError === 'object' && 'code' in tabWidenError
        ? tabWidenError.code
        : undefined;
    assert(paneWidenCode === 'pane-close-would-widen' && tabWidenCode === 'tab-close-would-widen'
        && explicitCloseCalls.length === 2, 'Close pane and Close tab refuse hidden widening without mutation');
    await closeExactWorkspace(explicitCloseClient, 'w4', new Map([['w4', { workspace_id: 'w4' }]]));
    const groupedWorkspaces = new Map([
        ['w5', { workspace_id: 'w5', worktree: { repo_key: 'repo', is_linked_worktree: false } }],
        ['w6', { workspace_id: 'w6', worktree: { repo_key: 'repo', is_linked_worktree: true } }],
    ]);
    await closeExactWorkspace(explicitCloseClient, 'w6', groupedWorkspaces);
    assert(JSON.stringify(explicitCloseCalls) === JSON.stringify([
        { method: 'pane.close', params: { pane_id: 'w4:p1' } },
        { method: 'tab.close', params: { tab_id: 'w4:t2' } },
        { method: 'workspace.close', params: { workspace_id: 'w4' } },
        { method: 'workspace.close', params: { workspace_id: 'w6' } },
    ]), 'Close pane, Close tab, and Close workspace each issue exactly their named Herdr RPC');
    let groupCloseError: unknown;
    try { await closeExactWorkspace(explicitCloseClient, 'w5', groupedWorkspaces); }
    catch (error) { groupCloseError = error; }
    const groupCloseCode = groupCloseError !== null && typeof groupCloseError === 'object' && 'code' in groupCloseError
        ? groupCloseError.code
        : undefined;
    assert(groupCloseCode === 'worktree-group-confirmation-required' && explicitCloseCalls.length === 4, 'parent worktree workspace requires an explicit group action without mutation');
    assert(explicitCloseCalls.every(({ method }) => !method.startsWith('worktree.')), 'no ordinary close action can close a worktree group');

    const socketDir = mkdtempSync(join(tmpdir(), 'pph-coord-check-'));
    const socketPath = join(socketDir, 'realtime-coding.sock');
    const prompts: string[] = [];
    const sentKeys: Array<{ sessionId: string; keys: string[] }> = [];
    const herdrPromptClient = {
        call: async <T>(_method: string, params: Record<string, unknown> = {}): Promise<T> => {
            const prompt = String(params.text ?? '');
            if (prompt.startsWith('malformed')) return { type: 'agent_prompted', agent: { pane_id: 'w1:p1' } } as T;
            return {
                type: 'agent_prompted',
                agent: {
                    terminal_id: 'terminal-one',
                    agent_status: 'idle',
                    workspace_id: 'w1',
                    tab_id: 'w1:t1',
                    pane_id: prompt.startsWith('wrong pane') ? 'w1:p2' : 'w1:p1',
                    focused: false,
                    revision: 1,
                },
            } as T;
        },
    };
    const coordinatorAgents = [
        { sessionId: 'pp_john', cwd: '/repo', displayName: 'John', taskTitle: 'Harden audio', kind: 'pi', status: 'idle' },
        { sessionId: 'pp_maria', cwd: '/repo', displayName: 'Maria', taskTitle: 'Ship settings', kind: 'pi', status: 'working' },
    ];
    const coordinator = new RealtimeCodingCoordinator(socketPath, {
        list: async () => coordinatorAgents,
        activity: async () => [],
        start: async () => ({ accepted: false }),
        prompt: async (_sessionId, text) => {
            await promptHerdrAgent(herdrPromptClient, { sessionId: 'pp_john', paneId: 'w1:p1' }, text);
            prompts.push(text);
        },
        sendKeys: async (sessionId, keys) => { sentKeys.push({ sessionId, keys }); },
        read: async () => ({ text: '', truncated: false }),
        status: async () => 'idle',
        watch: async () => ({ status: 'idle', detail: 'John is idle' }),
        focus: async () => undefined,
    });
    await coordinator.start();
    const access = coordinator.issueCapability({ cwd: '/repo', sessionId: 'pp_john', provider: 'gemini' });
    const first = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    const replayed = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    assert(first.data === 'Queued: instruction for John.' && replayed.data === first.data && prompts.length === 1,
        'an accepted operation id replays the exact queued receipt without rerunning the mutation');
    assert(prompts[0] === 'Keep going.\n\ncame from a real-time agent', 'only the realtime transport stamps its queued prompt at the message-origin boundary');
    const missingTarget = await ask(socketPath, access.capability, { method: 'prompt', text: 'missing target', operationId: 'op-missing' });
    const wrongPane = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'wrong pane', operationId: 'op-wrong-pane' });
    const malformed = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'malformed receipt', operationId: 'op-malformed' });
    assert(missingTarget.ok === false && wrongPane.ok === false && malformed.ok === false && prompts.length === 1,
        'missing targets and malformed or wrong-pane Herdr receipts cannot produce a queued confirmation');
    const taskStatus = await ask(socketPath, access.capability, { method: 'status', agent: 'Harden audio' });
    assert(taskStatus.data === 'John is idle.', 'a unique Task Title resolves to its Agent Name');
    const idleWatch = await ask(socketPath, access.capability, { method: 'watch', agent: 'John', operationId: 'watch-idle' });
    assert(idleWatch.data === 'Confirmed: John is idle.', 'idle is spoken as idle, without duplicated watch wording or finished');
    assert(idleWatch.data !== undefined && !/finish/i.test(idleWatch.data), 'idle is not spoken as finished');
    const keyAccess = coordinator.issueCapability({ cwd: '/repo', sessionId: 'pp_john', provider: 'gemini' });
    const unknownKey = await ask(socketPath, keyAccess.capability, { method: 'key', agent: 'John', key: 'ctrl-x', operationId: 'key-unknown' });
    assert(unknownKey.data?.includes('not available') === true && sentKeys.length === 0, 'unknown key clarifies without mutation');
    const ambiguousKey = await ask(socketPath, keyAccess.capability, { method: 'key', agent: 'pi', key: 'escape', operationId: 'key-ambiguous' });
    assert(ambiguousKey.data?.includes('More than one') === true && sentKeys.length === 0, 'ambiguous provider kind clarifies without sending a key');
    const uniqueKey = await ask(socketPath, keyAccess.capability, { method: 'key', agent: 'Harden audio', key: 'Escape', operationId: 'key-unique' });
    assert(uniqueKey.data === 'Confirmed: Escape was sent to John.'
        && JSON.stringify(sentKeys) === JSON.stringify([{ sessionId: 'pp_john', keys: ['escape'] }]), 'unique Task Title sends an allowlisted key through its Agent Route');
    coordinator.revokeCapability(keyAccess.capability);
    for (let index = 1; index <= 126; index += 1) {
        await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: `n${index}`, operationId: `op-${index}` });
    }
    assert(prompts.length === 127, 'accepted prompts occupy the replay fence');
    const overflow = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'overflow', operationId: 'op-overflow' });
    assert(overflow.ok === true && overflow.data !== undefined && overflow.data.includes('Too many') && prompts.length === 127, 'a full replay fence rejects new mutations instead of evicting an accepted id');
    const stillHeld = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    assert(stillHeld.ok === true && prompts.length === 127, 'the first accepted operation id still replays after the fence is full');
    coordinator.revokeCapability(access.capability);
    await coordinator.close();

    console.log('layout snapshot self-check passed');
}

demo().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
