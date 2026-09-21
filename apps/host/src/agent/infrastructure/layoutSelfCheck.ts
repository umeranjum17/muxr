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
import { AgentRouteStore, isMuxrLaunchSession, shouldAdoptPublishedLaunch, type HerdrAgentSessionRef } from './agentRouteStore.js';
import { closeAgent, isRetryableHerdr } from './agentClose.js';
import { RealtimeCodingCoordinator, type RealtimeCoordinationDiagnostic } from './realtimeCoordinator.js';
import { closeExactPane, closeExactTab, closeExactWorkspace, herdrAgentIsPromptable, isRetryableCloseFailure, mergeHerdrAgentEvent, promptHerdrAgent, promptPromptableHerdrAgent, resolveClosePaneId, sendKeysToLiveAgent } from './herdrSessionSource.js';
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
): Promise<{ ok: boolean; data?: string; code?: string; error?: string }> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buf = '';
        socket.on('data', (chunk) => { buf += chunk.toString('utf8'); });
        socket.on('end', () => {
            try { resolve(JSON.parse(buf) as { ok: boolean; data?: string; code?: string; error?: string }); } catch (error) { reject(error); }
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
    const launchSession: HerdrAgentSessionRef = {
        source: 'muxr:launch',
        agent: 'cursor',
        kind: 'id',
        value: 'launch-generation',
    };
    const publishedLaunch: HerdrAgentSessionRef = {
        source: 'herdr:cursor',
        agent: 'cursor',
        kind: 'id',
        value: 'generation-cursor',
    };
    const launchRoute = routeStore.bind(launchSession).route;
    assert(isMuxrLaunchSession(launchSession) === true, 'muxr launch identity is marked as a launch session');
    assert(routeStore.reconcile([sessionA, launchSession]).length === 0
        && routeStore.get(launchRoute)?.source === launchSession.source
        && routeStore.get(launchRoute)?.value === launchSession.value,
        'reconcile keeps an in-flight launch generation');
    assert(routeStore.adopt(launchSession, publishedLaunch)?.route === launchRoute
        && routeStore.route(publishedLaunch) === launchRoute
        && routeStore.get(launchRoute)?.value === publishedLaunch.value,
        'a launch generation keeps its route when Herdr publishes the session');
    assert(routeStore.reconcile([sessionA, publishedLaunch]).length === 0
        && routeStore.get(launchRoute)?.source === 'herdr:cursor',
        'reconcile keeps the adopted Herdr session');
    assert(routeStore.reconcile([sessionA])[0]?.route === launchRoute && routeStore.get(launchRoute) === undefined,
        'reconcile drops a vanished launch route');
    const mismatchedLaunch: HerdrAgentSessionRef = {
        source: 'herdr:codex',
        agent: 'codex',
        kind: 'id',
        value: 'generation-codex',
    };
    assert(shouldAdoptPublishedLaunch(launchSession, publishedLaunch) === true
        && shouldAdoptPublishedLaunch(launchSession, mismatchedLaunch) === false,
        'kind mismatch does not adopt a published session onto the launch route');
    assert(herdrAgentIsPromptable({}, 'idle') === true
        && herdrAgentIsPromptable({ launch_pending: true }, 'idle') === false
        && herdrAgentIsPromptable({ interactive_ready: false }, 'idle') === false,
        'a kind that never reports interactive_ready is still promptable once idle');

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
    const replacementPanes = new Set([pelican.pane_id]);
    const occupiedPanes = new Set([pelican.pane_id]);
    const replacementResolution = {
        paneExists: (paneId: string) => replacementPanes.has(paneId),
        paneHasAgent: (paneId: string) => occupiedPanes.has(paneId),
    };
    assert(resolveClosePaneId({
        sessionId: routeA,
        rememberedPaneId: movedBadger.pane_id,
        ...replacementResolution,
    }) === undefined, 'removed Badger route cannot close Pelican through its remembered pane');
    assert(resolveClosePaneId({
        sessionId: `shell:${pelican.pane_id}`,
        ...replacementResolution,
    }) === undefined, 'stale shell route cannot close a replacement agent occupying its pane');
    let ambiguousCloseError: unknown;
    let ambiguousFallbackReads = 0;
    try {
        resolveClosePaneId({
            sessionId: routeB,
            currentAgentPaneIds: ['w9:p7', 'w9:p8'],
            rememberedPaneId: pelican.pane_id,
            paneExists: () => { ambiguousFallbackReads += 1; return true; },
            paneHasAgent: () => { ambiguousFallbackReads += 1; return false; },
        });
    } catch (error) {
        ambiguousCloseError = error;
    }
    assert(ambiguousCloseError instanceof Error
        && 'code' in ambiguousCloseError
        && ambiguousCloseError.code === 'agent-route-ambiguous'
        && ambiguousFallbackReads === 0,
    'ambiguous Agent Route fails terminally before remembered-pane fallback or close mutation');

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
    assert(
        herdrAgentIsPromptable({}, 'idle')
        && herdrAgentIsPromptable({}, 'working')
        && herdrAgentIsPromptable({}, 'blocked')
        && herdrAgentIsPromptable({}, 'done')
        && !herdrAgentIsPromptable({}, 'starting')
        && !herdrAgentIsPromptable({}, 'failed')
        && !herdrAgentIsPromptable({}, 'unknown')
        && !herdrAgentIsPromptable({ interactive_ready: false, launch_pending: true }, 'idle'),
        'omitted interactive_ready is promptable when idle/working/blocked/done, not when starting or explicitly unready',
    );
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
    const explicitCloseCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const livePanes: Record<string, { pane_id: string; tab_id: string }> = {
        'w4:p1': { pane_id: 'w4:p1', tab_id: 'w4:t1' },
        'w4:p2': { pane_id: 'w4:p2', tab_id: 'w4:t1' },
        'w7:p1': { pane_id: 'w7:p1', tab_id: 'w7:t1' },
    };
    const liveTabs: Record<string, { tab_id: string; workspace_id: string; pane_count: number; label: string }> = {
        'w4:t1': { tab_id: 'w4:t1', workspace_id: 'w4', pane_count: 2, label: 'Code' },
        'w4:t2': { tab_id: 'w4:t2', workspace_id: 'w4', pane_count: 1, label: 'Review' },
        'w4:t3': { tab_id: 'w4:t3', workspace_id: 'w4', pane_count: 1, label: 'Docs' },
        'w7:t1': { tab_id: 'w7:t1', workspace_id: 'w7', pane_count: 1, label: 'Solo' },
        'w8:t1': { tab_id: 'w8:t1', workspace_id: 'w8', pane_count: 1, label: 'Last' },
    };
    const liveWorkspaces: Record<string, {
        workspace_id: string;
        tab_count: number;
        label: string;
        worktree?: { repo_key: string; is_linked_worktree: boolean };
    }> = {
        w4: { workspace_id: 'w4', tab_count: 3, label: 'App' },
        w5: { workspace_id: 'w5', tab_count: 1, label: 'Parent', worktree: { repo_key: 'repo', is_linked_worktree: false } },
        w6: { workspace_id: 'w6', tab_count: 1, label: 'Linked', worktree: { repo_key: 'repo', is_linked_worktree: true } },
        w7: { workspace_id: 'w7', tab_count: 1, label: 'One' },
        w8: { workspace_id: 'w8', tab_count: 1, label: 'One' },
    };
    const explicitCloseClient = {
        call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
            explicitCloseCalls.push({ method, params });
            if (method === 'pane.get') return { pane: livePanes[String(params.pane_id)] } as T;
            if (method === 'tab.get') return { tab: liveTabs[String(params.tab_id)] } as T;
            if (method === 'workspace.get') return { workspace: liveWorkspaces[String(params.workspace_id)] } as T;
            if (method === 'workspace.list') return { workspaces: Object.values(liveWorkspaces) } as T;
            return undefined as T;
        },
    };
    await closeExactPane(explicitCloseClient, 'w4:p1');
    await closeExactTab(explicitCloseClient, 'w4:t2');
    let paneWidenError: unknown;
    try { await closeExactPane(explicitCloseClient, 'w7:p1'); }
    catch (error) { paneWidenError = error; }
    let tabWidenError: unknown;
    try { await closeExactTab(explicitCloseClient, 'w8:t1'); }
    catch (error) { tabWidenError = error; }
    const paneWidenCode = paneWidenError !== null && typeof paneWidenError === 'object' && 'code' in paneWidenError
        ? paneWidenError.code
        : undefined;
    const tabWidenCode = tabWidenError !== null && typeof tabWidenError === 'object' && 'code' in tabWidenError
        ? tabWidenError.code
        : undefined;
    assert(paneWidenCode === 'pane-close-would-widen' && tabWidenCode === 'tab-close-would-widen'
        && !explicitCloseCalls.some((call) => call.method === 'pane.close' && call.params.pane_id === 'w7:p1')
        && !explicitCloseCalls.some((call) => call.method === 'tab.close' && call.params.tab_id === 'w8:t1'),
        'Close pane and Close tab refuse hidden widening without mutation');
    await closeExactWorkspace(explicitCloseClient, 'w4');
    await closeExactWorkspace(explicitCloseClient, 'w6');
    assert(JSON.stringify(explicitCloseCalls.filter((call) => call.method.endsWith('.close'))) === JSON.stringify([
        { method: 'pane.close', params: { pane_id: 'w4:p1' } },
        { method: 'tab.close', params: { tab_id: 'w4:t2' } },
        { method: 'workspace.close', params: { workspace_id: 'w4' } },
        { method: 'workspace.close', params: { workspace_id: 'w6' } },
    ]), 'Close pane, Close tab, and Close workspace each issue exactly their named live Herdr RPC');
    let groupCloseError: unknown;
    try { await closeExactWorkspace(explicitCloseClient, 'w5'); }
    catch (error) { groupCloseError = error; }
    const groupCloseCode = groupCloseError !== null && typeof groupCloseError === 'object' && 'code' in groupCloseError
        ? groupCloseError.code
        : undefined;
    assert(groupCloseCode === 'worktree-group-confirmation-required'
        && !explicitCloseCalls.some((call) => call.method === 'workspace.close' && call.params.workspace_id === 'w5'),
        'parent worktree workspace requires an explicit group action without mutation');
    assert(explicitCloseCalls.every(({ method }) => !method.startsWith('worktree.')), 'no ordinary close action can close a worktree group');

    // The close ladder is host code; drive it directly against fixture topology.
    const sanitizedRetryCodes = ['EACCES', 'ECONNRESET', 'ETIMEDOUT'];
    assert(sanitizedRetryCodes.every((code) => {
        const error = new Error(`herdr: session.snapshot: ${code}`);
        return isRetryableHerdr(error) && isRetryableCloseFailure(error);
    }), 'sanitized socket permission, reset, and timeout codes stay retryable at the host boundary');
    type ClosePhase = 'split' | 'two-tabs' | 'last-tab' | 'group' | 'herdr-group' | 'revalidation-outage' | 'empty' | 'outage';
    let closePhase: ClosePhase = 'split';
    let revalidationSnapshots = 0;
    const hostCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const snapshots: Record<Exclude<ClosePhase, 'outage' | 'revalidation-outage'>, Record<string, unknown>> = {
        split: {
            panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
            tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', pane_count: 2, label: 'Code' }],
            workspaces: [{ workspace_id: 'w1', tab_count: 1, label: 'App' }],
        },
        'two-tabs': {
            panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
            tabs: [
                { tab_id: 'w1:t1', workspace_id: 'w1', pane_count: 1, label: 'Review' },
                { tab_id: 'w1:t2', workspace_id: 'w1', pane_count: 1, label: 'Docs' },
            ],
            workspaces: [{ workspace_id: 'w1', tab_count: 2, label: 'App' }],
        },
        'last-tab': {
            panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
            tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', pane_count: 1, label: 'Review' }],
            workspaces: [{ workspace_id: 'w1', tab_count: 1, label: 'App' }],
        },
        group: {
            panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
            tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', pane_count: 1, label: 'Review' }],
            workspaces: [
                { workspace_id: 'w1', tab_count: 1, label: 'App', worktree: { repo_key: 'repo', repo_name: 'repo', is_linked_worktree: false } },
                { workspace_id: 'w2', tab_count: 1, label: 'Linked', worktree: { repo_key: 'repo', repo_name: 'repo', is_linked_worktree: true } },
            ],
        },
        empty: { panes: [], tabs: [], workspaces: [] },
        'herdr-group': {
            panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
            tabs: [
                { tab_id: 'w1:t1', workspace_id: 'w1', pane_count: 1, label: 'Review' },
                { tab_id: 'w1:t2', workspace_id: 'w1', pane_count: 1, label: 'Docs' },
            ],
            workspaces: [{ workspace_id: 'w1', tab_count: 2, label: 'App' }],
        },
    };
    const hostCall = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        hostCalls.push({ method, params });
        if (closePhase === 'outage') throw new Error('herdr: session.snapshot: connect ECONNREFUSED');
        if (method === 'session.snapshot') {
            if (closePhase === 'revalidation-outage') {
                revalidationSnapshots += 1;
                if (revalidationSnapshots > 1) throw new Error('herdr: session.snapshot: connect ECONNREFUSED');
                return { snapshot: snapshots['herdr-group'] };
            }
            return { snapshot: snapshots[closePhase] };
        }
        if (method === 'tab.close' && (closePhase === 'herdr-group' || closePhase === 'revalidation-outage')) {
            throw new Error('herdr: confirmation_required: closing this tab would close a worktree group');
        }
        if (method === 'pane.close' || method === 'tab.close' || method === 'workspace.close') return {};
        throw new Error(`unexpected ${method}`);
    };

    closePhase = 'split';
    const paneClosed = await closeAgent({ paneId: 'w1:p1', call: hostCall });
    assert(paneClosed.status === 'closed' && hostCalls.some((call) => call.method === 'pane.close'),
        'unconfirmed split-pane close issues exact pane.close');

    closePhase = 'two-tabs';
    const beforeTabAsk = hostCalls.length;
    const tabAsk = await closeAgent({ paneId: 'w1:p1', call: hostCall });
    assert(tabAsk.status === 'confirmationRequired' && tabAsk.scope === 'tab' && tabAsk.label === 'Review'
        && !hostCalls.slice(beforeTabAsk).some((call) => call.method.endsWith('.close')),
        'last pane in a multi-tab workspace asks for tab confirmation without mutation');
    assert(!hostCalls.some((call) => call.method === 'tab.close' || call.method === 'workspace.close'),
        'cancel is no additional request: unconfirmed close never widens');

    closePhase = 'last-tab';
    const beforeWorkspaceAsk = hostCalls.length;
    const workspaceAsk = await closeAgent({ paneId: 'w1:p1', confirmedScope: 'tab', call: hostCall });
    assert(workspaceAsk.status === 'confirmationRequired' && workspaceAsk.scope === 'workspace' && workspaceAsk.label === 'App'
        && !hostCalls.slice(beforeWorkspaceAsk).some((call) => call.method === 'tab.close'),
        'confirmed tab after topology change to a last tab returns the newly required workspace scope');

    closePhase = 'group';
    const beforeGroupAsk = hostCalls.length;
    const groupAsk = await closeAgent({ paneId: 'w1:p1', confirmedScope: 'workspace', call: hostCall });
    assert(groupAsk.status === 'confirmationRequired' && groupAsk.scope === 'worktreeGroup' && groupAsk.label === 'repo'
        && !hostCalls.slice(beforeGroupAsk).some((call) => call.method === 'workspace.close'),
        'confirmed workspace on a parent worktree group asks for worktreeGroup without mutation');

    const groupClosed = await closeAgent({ paneId: 'w1:p1', confirmedScope: 'worktreeGroup', call: hostCall });
    assert(groupClosed.status === 'closed'
        && hostCalls.some((call) => call.method === 'workspace.close' && call.params.workspace_id === 'w1'),
        'confirmed worktreeGroup invokes exact workspace.close');

    closePhase = 'herdr-group';
    const herdrGroup = await closeAgent({ paneId: 'w1:p1', confirmedScope: 'tab', call: hostCall });
    assert(herdrGroup.status === 'confirmationRequired' && herdrGroup.scope === 'workspace',
        'a raced Herdr tab no-widen response asks for the exact next workspace scope');
    const beyondConfirmed = await closeAgent({ paneId: 'w1:p1', confirmedScope: 'workspace', call: hostCall });
    assert(beyondConfirmed.status === 'confirmationRequired' && beyondConfirmed.scope === 'worktreeGroup',
        'a Herdr refusal asks strictly beyond both the attempted tab and confirmed workspace');

    closePhase = 'revalidation-outage';
    revalidationSnapshots = 0;
    const revalidationDown = await closeAgent({ paneId: 'w1:p1', confirmedScope: 'tab', call: hostCall });
    assert(revalidationDown.status === 'retryable',
        'temporary outage while revalidating a Herdr refusal never reports the pane already gone');

    closePhase = 'empty';
    const gone = await closeAgent({ paneId: 'w1:p1', call: hostCall });
    assert(gone.status === 'closed' && gone.alreadyGone === true
        && !hostCalls.slice(-2).some((call) => call.method.endsWith('.close')),
        'already missing pane maps to closed alreadyGone');

    closePhase = 'outage';
    const down = await closeAgent({ paneId: 'w1:p1', call: hostCall });
    assert(down.status === 'retryable', 'temporary Herdr socket failure is retryable');

    const socketDir = mkdtempSync(join(tmpdir(), 'pph-coord-check-'));
    const socketPath = join(socketDir, 'realtime-coding.sock');
    const prompts: string[] = [];
    const cranePrompts: string[] = [];
    const coordinationDiagnostics: RealtimeCoordinationDiagnostic[] = [];
    const sentKeys: Array<{ sessionId: string; keys: string[] }> = [];
    const promptTargets: Record<string, string> = { pp_john: 'w1:p1', pp_crane: 'w1:p3' };
    const herdrPromptClient = {
        call: async <T>(_method: string, params: Record<string, unknown> = {}): Promise<T> => {
            const prompt = String(params.text ?? '');
            const target = String(params.target ?? '');
            const paneId = prompt.startsWith('wrong pane')
                ? 'w1:p2'
                : target || 'w1:p1';
            if (prompt.startsWith('malformed')) return { type: 'agent_prompted', agent: { pane_id: paneId } } as T;
            return {
                type: 'agent_prompted',
                agent: {
                    terminal_id: 'terminal-one',
                    agent_status: 'idle',
                    workspace_id: 'w1',
                    tab_id: 'w1:t1',
                    pane_id: paneId,
                    focused: false,
                    revision: 1,
                },
            } as T;
        },
    };
    const coordinatorAgents = [
        { sessionId: 'pp_john', cwd: '/repo', agentName: 'John', taskTitle: 'Harden audio', agentKind: 'pi', agentStatus: 'idle' as const, promptable: true },
        { sessionId: 'pp_maria', cwd: '/repo', agentName: 'Maria', taskTitle: 'Ship settings', agentKind: 'pi', agentStatus: 'working' as const, promptable: true },
        { sessionId: 'pp_crane', cwd: '/repo', agentName: 'crane', taskTitle: 'Health check', agentKind: 'pi', agentStatus: 'working' as const, promptable: true },
    ];
    let catalogFreshness: 'fresh' | 'last-known' = 'fresh';
    let failRead = false;
    const coordinator = new RealtimeCodingCoordinator(socketPath, {
        list: async () => ({ agents: coordinatorAgents, freshness: catalogFreshness, ...(catalogFreshness === 'last-known' ? { failureCode: 'roster-unavailable' as const } : {}) }),
        activity: async () => [],
        start: async () => ({ accepted: false }),
        prompt: async (sessionId, text) => {
            await promptHerdrAgent(herdrPromptClient, { sessionId, paneId: promptTargets[sessionId] ?? 'w1:p1' }, text);
            if (sessionId === 'pp_crane') cranePrompts.push(text);
            else prompts.push(text);
        },
        sendKeys: async (sessionId, keys) => { sentKeys.push({ sessionId, keys }); },
        read: async (sessionId) => {
            if (failRead) throw new Error('secret=bad-token /private/path pp_hidden');
            return { text: sessionId === 'pp_crane' ? 'health marker: no code changes' : '', truncated: false };
        },
        status: async (sessionId) => sessionId === 'pp_crane' ? 'working' : 'idle',
        watch: async () => ({ status: 'idle', detail: 'John is idle' }),
        focus: async () => undefined,
    }, undefined, (event) => { coordinationDiagnostics.push(event); });
    await coordinator.start();
    try {
    const access = coordinator.issueCapability({ cwd: '/repo', sessionId: 'pp_john', provider: 'gemini' });
    const healthAccess = coordinator.issueCapability({ cwd: '/repo', sessionId: 'pp_john', provider: 'gemini' });
    const roster = await ask(socketPath, healthAccess.capability, { method: 'list' });
    assert(roster.ok && roster.data?.includes(`of ${coordinatorAgents.length} agents`) === true
        && roster.data.includes('crane'), 'fresh Realtime roster lists the dynamic agent count and crane label');
    const craneStatus = await ask(socketPath, healthAccess.capability, { method: 'status', agent: 'crane' });
    const craneRead = await ask(socketPath, healthAccess.capability, { method: 'read', agent: 'crane', lines: 40 });
    const cranePrompt = await ask(socketPath, healthAccess.capability, {
        method: 'prompt', agent: 'crane', text: 'health check only; no code changes', operationId: 'op-crane',
    });
    assert(craneStatus.data === 'crane is working.'
        && craneRead.data?.includes('health marker: no code changes') === true
        && cranePrompt.data === 'Queued: instruction for crane.'
        && cranePrompts.length === 1
        && cranePrompts[0] === 'health check only; no code changes\n\ncame from a real-time agent',
    'crane status, untrusted output, and one stamped prompt use the exact resolved Agent Route');
    const absent = await ask(socketPath, healthAccess.capability, { method: 'status', agent: 'not-present' });
    assert(absent.ok && absent.data?.includes('could not find') === true && cranePrompts.length === 1,
        'a fresh absent name is honest and does not mutate');
    coordinatorAgents.push({ ...coordinatorAgents[2]!, sessionId: 'pp_crane_duplicate' });
    const ambiguous = await ask(socketPath, healthAccess.capability, { method: 'prompt', agent: 'crane', text: 'must not send', operationId: 'op-crane-ambiguous' });
    assert(ambiguous.ok && ambiguous.data?.includes('More than one') === true && cranePrompts.length === 1,
        'duplicate visible names ask for clarification without mutation');
    coordinatorAgents.pop();
    catalogFreshness = 'last-known';
    const staleMissing = await ask(socketPath, healthAccess.capability, { method: 'status', agent: 'not-present' });
    assert(staleMissing.ok && staleMissing.data?.includes('live agent roster is unavailable') === true,
        'a last-known roster never claims that a name is absent');
    const staleList = await ask(socketPath, healthAccess.capability, { method: 'list', limit: 3 });
    const staleDiagnostic = coordinationDiagnostics.filter((event) => event.operation === 'list').at(-1);
    assert(staleList.ok && staleDiagnostic?.code === 'roster-unavailable' && staleDiagnostic.outcome === 'unavailable',
        'a last-known roster journals the degraded outcome with its reason');
    catalogFreshness = 'fresh';
    failRead = true;
    const safeReadFailure = await ask(socketPath, healthAccess.capability, { method: 'read', agent: 'crane' });
    failRead = false;
    const readDiagnostic = coordinationDiagnostics.filter((event) => event.operation === 'read').at(-1);
    assert(!safeReadFailure.ok && safeReadFailure.code === 'output-unavailable'
        && safeReadFailure.error === 'The agent output could not be read. No action was performed.'
        && readDiagnostic?.code === 'output-unavailable'
        && !JSON.stringify(safeReadFailure).includes('bad-token')
        && !JSON.stringify(safeReadFailure).includes('/private/path')
        && !JSON.stringify(safeReadFailure).includes('pp_hidden')
        && !JSON.stringify(readDiagnostic).includes('bad-token')
        && !JSON.stringify(readDiagnostic).includes('/private/path')
        && !JSON.stringify(readDiagnostic).includes('pp_hidden'),
    'host failures retain only a closed safe output code and copy');
    coordinator.revokeCapability(healthAccess.capability);
    const first = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    const replayed = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'Keep going.', operationId: 'op-0' });
    assert(first.data === 'Queued: instruction for John.' && replayed.data === first.data && prompts.length === 1,
        'an accepted operation id replays the exact queued receipt without rerunning the mutation');
    assert(prompts[0] === 'Keep going.\n\ncame from a real-time agent', 'only the realtime transport stamps its queued prompt at the message-origin boundary');
    const missingTarget = await ask(socketPath, access.capability, { method: 'prompt', text: 'missing target', operationId: 'op-missing' });
    const wrongPane = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'wrong pane', operationId: 'op-wrong-pane' });
    const malformed = await ask(socketPath, access.capability, { method: 'prompt', agent: 'John', text: 'malformed receipt', operationId: 'op-malformed' });
    assert(missingTarget.ok === true && missingTarget.data?.startsWith('No prompt sent.') === true
        && missingTarget.data.includes('John, Harden audio') && !missingTarget.data.includes('pp_john')
        && wrongPane.ok === false && wrongPane.code === 'prompt-outcome-unknown'
        && malformed.ok === false && malformed.code === 'prompt-outcome-unknown' && prompts.length === 1,
        'missing targets and malformed or wrong-pane Herdr receipts cannot produce a queued confirmation');
    const taskStatus = await ask(socketPath, access.capability, { method: 'status', agent: 'Harden audio' });
    assert(taskStatus.data === 'John is idle.', 'a unique Task Title resolves to its Agent Name');
    const idleWatch = await ask(socketPath, access.capability, { method: 'watch', agent: 'John', operationId: 'watch-idle' });
    assert(idleWatch.data === 'Confirmed: John is idle.', 'idle is spoken as idle, without duplicated watch wording or finished');
    assert(idleWatch.data !== undefined && !/finish/i.test(idleWatch.data), 'idle is not spoken as finished');
    const keyAccess = coordinator.issueCapability({ cwd: '/repo', sessionId: 'pp_john', provider: 'gemini' });
    const unknownKey = await ask(socketPath, keyAccess.capability, { method: 'key', agent: 'John', key: 'ctrl-x', operationId: 'key-unknown' });
    assert(unknownKey.data?.includes('not available') === true && sentKeys.length === 0, 'unknown key clarifies without mutation');
    const providerKindKey = await ask(socketPath, keyAccess.capability, { method: 'key', agent: 'pi', key: 'escape', operationId: 'key-provider-kind' });
    assert(providerKindKey.data?.includes('could not find') === true && sentKeys.length === 0, 'Agent Kind never substitutes for Agent Name or Task Title');
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
    const revokedAccess = coordinator.issueCapability({ cwd: '/repo', sessionId: 'pp_john', provider: 'gemini' });
    coordinator.revokeCapability(revokedAccess.capability);
    const revoked = await ask(socketPath, revokedAccess.capability, { method: 'list' });
    assert(!revoked.ok && revoked.code === 'capability-revoked'
        && revoked.error === 'Voice coordination is no longer authorized. No action was performed.',
    'revoked Realtime capability fails closed before any roster action');
    coordinator.revokeCapability(access.capability);
    } finally {
        await coordinator.close();
    }

    console.log('layout snapshot self-check passed');
}

demo().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
