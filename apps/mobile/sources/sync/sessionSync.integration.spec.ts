import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLifecycle, HerdrTreeWorkspace, LifecycleEvent } from '@muxr/contract';
import type { Session } from './storageTypes';
import { completionAlerts, completionNotificationState, completionTransition, herdNotificationState, HERD_STATUS_LABELS, lifecycleNotificationCopy, lifecycleNotificationState, sortHerd } from '../utils/herd';
import { normalizeRequestFailure, requestRequiresE2ee } from '@muxr/contract';
import { buildSpaceRows, lifecycleTree, paneDisplayName, paneTaskTitle } from '../utils/herdTree';
import { selectLiveTerminalCards } from '../utils/liveTerminalOrder';

const request = vi.fn();
const refreshSessions = vi.fn();
const mmkvValues = vi.hoisted(() => {
    Object.assign(globalThis, { __DEV__: false });
    return new Map<string, string>();
});

vi.mock('../state/connectionSettings', () => ({
    getCachedConnectionSettings: () => ({ machineId: 'machine' }),
}));
vi.mock('./sync', () => ({ sync: { request, refreshSessions } }));
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return mmkvValues.get(key); }
        set(key: string, value: string) { mmkvValues.set(key, value); }
        delete(key: string) { mmkvValues.delete(key); }
    },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/utils/sessionUtils', () => ({
    getSessionName: (session: Session) => session.metadata?.summary?.text ?? session.id,
    getSessionSubtitle: () => '',
    getSessionAvatarId: (session: Session) => session.id,
}));
import { applyStatusToSession, sessionInfoToSession } from './sessionMapping';
import { storage } from './storage';

async function spawn(options: { modelMode?: string; effortLevel?: string; displayName?: string }) {
    const { machineSpawnNewSession } = await import('./ops');
    return machineSpawnNewSession({ machineId: 'm', directory: '/tmp', ...options });
}

describe('session sync flow', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        refreshSessions.mockReset();
        request.mockReset();
        storage.setState({ sessions: {} });
        storage.getState().setLifecycleAuthority('test-authority');
        storage.getState().setLifecycleScope('test-authority:machine');
        storage.getState().resetLifecycleCatalog();
        mmkvValues.clear();
    });

    it('maps a raw herdr pane and starts the session without leaking host-owned model options', async () => {
        const mapped = sessionInfoToSession({
            id: 'session-a',
            paneId: '%1',
            cwd: '/work/alpha',
            path: '/work/alpha',
            created: '2026-01-01T00:00:00Z',
            modified: '2026-01-01T00:00:00Z',
            messageCount: 0,
            firstMessage: '',
            displayName: 'Maria',
            taskTitle: 'Stabilizing realtime voice',
        });
        expect(mapped.metadata?.paneId).toBe('%1');
        expect(mapped.metadata?.summary?.text).toBe('Stabilizing realtime voice');
        expect(mapped.metadata?.displayName).toBe('Maria');

        const lifecycle = (agentStatus: 'working' | 'done') => ({
            sessionId: mapped.id,
            agentStatus,
            isStreaming: agentStatus === 'working',
            tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
        });
        const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const working = applyStatusToSession(mapped, lifecycle('working'));
        expect(working.metadata?.lifecycleStateSince).toBe(10_000);
        now.mockReturnValue(20_000);
        expect(applyStatusToSession(working, lifecycle('working')).metadata?.lifecycleStateSince).toBe(10_000);
        expect(applyStatusToSession(working, lifecycle('done')).metadata?.lifecycleStateSince).toBe(20_000);

        request.mockImplementation(async (method: string) => {
            if (method === 'session.start') {
                storage.setState({ sessions: { s1: {} as Session } });
                return {
                    info: { id: 's1' },
                    status: { sessionId: 's1', isStreaming: false, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 } },
                };
            }
            throw new Error(`unexpected request: ${method}`);
        });

        await expect(spawn({ modelMode: 'moonshot:kimi-k3', effortLevel: 'high', displayName: 'Maria' })).resolves.toEqual({
            type: 'success',
            sessionId: 's1',
        });
        expect(request.mock.calls).toEqual([['session.start', { cwd: '/tmp', displayName: 'Maria' }]]);

        request.mockResolvedValue({
            acceptance: {
                outcome: 'failed', state: 'failed', displayName: 'Maria',
                code: 'start-launch-failed', message: 'unsafe backend detail',
            },
        });
        await expect(spawn({ displayName: 'Maria' })).resolves.toEqual({
            type: 'error', errorMessage: 'Maria could not start.',
        });
    });

    it('waits for a newly started session to become visible before routing', async () => {
        request.mockResolvedValue({
            info: { id: 'delayed' },
            status: { sessionId: 'delayed', isStreaming: false, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 } },
        });
        refreshSessions.mockImplementation(async () => {
            if (refreshSessions.mock.calls.length === 3) storage.setState({ sessions: { delayed: {} as Session } });
        });

        await expect(spawn({})).resolves.toEqual({ type: 'success', sessionId: 'delayed' });
        expect(refreshSessions).toHaveBeenCalledTimes(3);
    });

    it('keeps Spaces, Live Terminals and completion on one canonical pane lifecycle', () => {
        // Deliberately stale transcript/session state: this used to make Live say
        // Done while the same herdr.tree pane remained blue/working in Spaces.
        const session = {
            id: 'session-a',
            active: true,
            presence: 'online',
            updatedAt: 1,
            thinking: false,
            metadata: {
                summary: { text: 'Maria', updatedAt: 1 },
                agentStatus: 'done',
                lifecycleStateSince: 1,
                provider: { id: 'pi', kind: 'pi', name: 'Pi' },
            },
        } as Session;
        const canonicalTree = (agentStatus: AgentLifecycle): HerdrTreeWorkspace[] => [{
            workspaceId: 'workspace-a',
            label: '/work/muxr',
            focused: true,
            agentStatus,
            tabs: [{
                tabId: 'tab-a',
                focused: true,
                agentStatus,
                panes: [{
                    paneId: 'pane-a',
                    tabId: 'tab-a',
                    sessionId: session.id,
                    agentKind: 'pi',
                    displayName: 'Maria',
                    taskTitle: 'Stabilizing realtime voice',
                    agentStatus,
                    focused: true,
                }],
            }],
        }];

        const stage = (status: AgentLifecycle, connected = true) => {
            const tree = lifecycleTree(canonicalTree(status), connected);
            const spacesStatus = buildSpaceRows(tree, new Set(['workspace-a']), '')[0].panes[0].agentStatus;
            const notificationPanes = sortHerd([session], tree);
            const liveStatus = selectLiveTerminalCards([session], notificationPanes)[0].status;
            expect({ spacesStatus, liveStatus, notificationStatus: notificationPanes[0].status }).toEqual({
                spacesStatus: connected ? status : 'unknown',
                liveStatus: connected ? status : 'unknown',
                notificationStatus: connected ? status : 'unknown',
            });
            return notificationPanes;
        };

        const working = stage('working');
        const pane = canonicalTree('working')[0].tabs[0].panes[0];
        expect({ primary: paneTaskTitle(pane), secondary: paneDisplayName(pane), kind: pane.agentKind }).toEqual({
            primary: 'Stabilizing realtime voice', secondary: 'Maria', kind: 'pi',
        });
        expect(working[0]).toMatchObject({ name: 'Maria', taskTitle: 'Stabilizing realtime voice' });
        expect(selectLiveTerminalCards([session], working)[0].title).toBe('Stabilizing realtime voice');
        expect(HERD_STATUS_LABELS[working[0].status]).toBe('Working');
        const workingNotification = herdNotificationState(working, 'connected');
        expect(workingNotification).toMatchObject({ mode: 'working', count: 1, eventKey: `working:${encodeURIComponent(session.id)}` });
        expect(completionAlerts(working, { [session.id]: 'done' })).toEqual([]);

        const blocked = stage('blocked');
        expect(HERD_STATUS_LABELS[blocked[0].status]).toBe('Needs you');
        const blockedNotification = herdNotificationState(blocked, 'connected');
        expect(blockedNotification).toMatchObject({ mode: 'attention', count: 1, eventKey: `attention:${encodeURIComponent(session.id)}` });

        const waiting = stage('idle');
        expect(HERD_STATUS_LABELS[waiting[0].status]).toBe('Waiting');
        expect(herdNotificationState(waiting, 'connected').mode).toBe('idle');

        const done = stage('done');
        expect(HERD_STATUS_LABELS[done[0].status]).toBe('Done');
        const completed = completionAlerts(done, { [session.id]: 'blocked' });
        expect(completed.map((pane) => pane.id)).toEqual([session.id]);
        expect(completionAlerts(done, { [session.id]: 'idle' })).toEqual([]);
        const finishedNotification = completionNotificationState(completed);
        expect(finishedNotification).toEqual({
            mode: 'finished', count: 1, name: 'Maria', names: 'Maria', eventKey: `finished:${encodeURIComponent(session.id)}`,
        });
        // One stable grouped state replaces working -> blocked -> finished;
        // repeated renders produce the same key, so native dismissal is not reposted.
        expect(completionNotificationState(completed).eventKey).toBe(finishedNotification.eventKey);
        expect(JSON.stringify([workingNotification, blockedNotification, finishedNotification].map(({ name, names }) => ({ name, names })))).not.toContain(session.id);

        const offline = stage('done', false);
        expect(HERD_STATUS_LABELS[offline[0].status]).toBe('Offline');
        expect(herdNotificationState(offline, 'error').mode).toBe('offline');

        // A reconnect blip between working and done must still produce exactly
        // one completion: the offline all-unknown snapshot may not become the
        // baseline, and the fresh connected tree fires the alert once.
        const armed = completionTransition(working, true, null);
        expect(armed.completed).toEqual([]);
        const gap = completionTransition(offline, false, armed.baseline);
        expect(gap.completed).toEqual([]);
        expect(gap.baseline).toBe(armed.baseline);
        const reconnected = completionTransition(done, true, gap.baseline);
        expect(reconnected.completed.map((pane) => pane.id)).toEqual([session.id]);
        expect(completionTransition(done, true, reconnected.baseline).completed).toEqual([]);

        expect(normalizeRequestFailure('plugin.call', 'handler is not a function').code).toBe('host-contract-mismatch');
        expect(normalizeRequestFailure('plugin.call', 'handler is not a function').message).not.toContain('handler is not a function');
        expect(['plugin.approve', 'plugin.invoke', 'plugin.call', 'herdr.cli'].every(requestRequiresE2ee)).toBe(true);
        expect(requestRequiresE2ee('session.list')).toBe(false);
    });

    it('reconciles structured lifecycle activity once across live replay, reconnect and restart', async () => {
        const event = (eventId: string, state: AgentLifecycle, at: string): LifecycleEvent => ({
            eventId,
            sessionId: 'session-secret-42',
            displayName: 'Maria',
            state,
            reasonCode: state === 'starting' ? 'start-requested'
                : state === 'working' ? 'agent-working'
                    : state === 'blocked' ? 'agent-blocked'
                        : state === 'failed' ? 'agent-runtime-failed' : 'agent-done',
            at,
            taskTitle: 'Stabilizing realtime voice',
        });
        const initial = event('event-initial', 'working', '2026-08-27T10:00:00.000Z');
        const prebaseline = event('event-prebaseline', 'blocked', '2026-08-27T09:59:00.000Z');
        const working = event('event-working', 'working', '2026-08-27T10:01:00.000Z');
        const blocked = event('event-blocked', 'blocked', '2026-08-27T10:02:00.000Z');
        const failed = event('event-failed', 'failed', '2026-08-27T10:03:00.000Z');
        const done = event('event-done', 'done', '2026-08-27T10:04:00.000Z');
        const pushBeforeCatalog = event('event-push-before-catalog', 'blocked', '2026-08-27T10:06:00.000Z');
        const state = storage.getState();

        // A live exception can beat the first catalog response. Preserve it as
        // new while keeping the actual catalog history quiet.
        state.setLifecycleAuthority('');
        state.acknowledgeLifecyclePush(pushBeforeCatalog.eventId, 'machine');
        state.setLifecycleAuthority('test-authority');
        expect(state.applyLifecycleEvent(prebaseline)).toEqual([]);
        expect(state.applyLifecycleCatalog({ revision: 1, events: [initial] })).toEqual([prebaseline]);
        expect(storage.getState().lifecycleEvents).toEqual([initial, prebaseline]);
        expect(storage.getState().pendingLifecycleEvents).toEqual([prebaseline]);
        state.markLifecyclePresented(prebaseline.eventId);
        expect(state.applyLifecycleEvent(working)).toEqual([]);

        expect(state.applyLifecycleEvent(blocked)).toEqual([blocked]);
        expect(state.applyLifecycleEvent(blocked)).toEqual([]);
        expect(state.applyLifecycleCatalog({ revision: 2, events: [pushBeforeCatalog, blocked, working, initial] })).toEqual([]);
        expect(storage.getState().pendingLifecycleEvents.map((entry) => entry.eventId)).toEqual(['event-blocked']);
        state.markLifecyclePresented(blocked.eventId);

        expect(state.applyLifecycleEvent(failed)).toEqual([failed]);
        expect(state.applyLifecycleEvent(done)).toEqual([done]);
        const pending = storage.getState().pendingLifecycleEvents;
        expect(pending.find((entry) => entry.state !== 'done')).toEqual(failed);
        expect(pending.map((entry) => entry.eventId)).toEqual(['event-done', 'event-failed']);
        const startFailed = { ...failed, eventId: 'event-start-failed', reasonCode: 'start-launch-failed' as const };
        expect([failed, startFailed, done].map(lifecycleNotificationCopy)).toEqual([
            'Maria failed.', 'Maria could not start.', 'Maria finished.',
        ]);
        expect([failed, done].map(lifecycleNotificationState)).toMatchObject([
            { mode: 'attention', name: 'Maria', names: 'Maria' },
            { mode: 'finished', name: 'Maria', names: 'Maria' },
        ]);
        expect(JSON.stringify([failed, startFailed, done].map(lifecycleNotificationCopy))).not.toMatch(/session-secret|event-|\/|prompt|output|credential/i);
        state.markLifecyclePresented(failed.eventId);
        state.markLifecyclePresented(done.eventId);

        // A repeated frame and the reconnect catalog are both idempotent.
        expect(state.applyLifecycleEvent(done)).toEqual([]);
        expect(state.applyLifecycleCatalog({ revision: 3, events: [done, failed, blocked, working, initial] })).toEqual([]);
        expect(storage.getState().pendingLifecycleEvents).toEqual([]);

        // A relay push owns its visible alert. Acknowledging its canonical id
        // before reconciliation prevents the local catalog path reposting it.
        const pushed = event('event-pushed', 'blocked', '2026-08-27T10:05:00.000Z');
        state.acknowledgeLifecyclePush(pushed.eventId, 'machine');
        expect(state.applyLifecycleCatalog({ revision: 4, events: [pushed, done, failed, blocked, working, initial] })).toEqual([]);
        expect(storage.getState().pendingLifecycleEvents).toEqual([]);

        // A machine-B push received while A is active belongs only to B.
        const machineBPush = event('event-machine-b', 'blocked', '2026-08-27T10:07:00.000Z');
        state.setLifecycleScope('test-authority:machine-b');
        expect(state.applyLifecycleCatalog({ revision: 1, events: [done] })).toEqual([]);
        state.setLifecycleScope('test-authority:machine');
        state.acknowledgeLifecyclePush(machineBPush.eventId, 'machine-b');
        expect(state.applyLifecycleCatalog({ revision: 5, events: [machineBPush, pushed, done, failed, blocked, working, initial] })).toEqual([machineBPush]);
        state.setLifecycleScope('test-authority:machine-b');
        expect(state.applyLifecycleCatalog({ revision: 2, events: [machineBPush, done] })).toEqual([]);
        state.setLifecycleScope('test-authority:machine');

        // A different account/machine scope gets its own quiet bootstrap and
        // cannot inherit this scope's presented ids.
        state.setLifecycleScope('other-authority:other-machine');
        expect(state.applyLifecycleCatalog({ revision: 1, events: [pushed, done] })).toEqual([]);
        state.setLifecycleScope('test-authority:machine');
        expect(state.applyLifecycleCatalog({ revision: 4, events: [pushed, done, failed, blocked, working, initial] })).toEqual([]);

        // Module re-evaluation simulates the store/app restarting while MMKV remains.
        vi.resetModules();
        const restarted = (await import('./storage')).storage;
        restarted.getState().setLifecycleScope('test-authority:machine');
        expect(restarted.getState().lifecycleCatalogInitialized).toBe(true);
        expect(restarted.getState().applyLifecycleCatalog({ revision: 4, events: [pushed, done, failed, blocked, working, initial] })).toEqual([]);
        expect(restarted.getState().pendingLifecycleEvents).toEqual([]);
    });
});
