import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLifecycle, HerdrTreeWorkspace } from '@muxr/contract';
import type { Session } from './storageTypes';
import { completionAlerts, completionNotificationState, herdNotificationState, HERD_STATUS_LABELS, sortHerd } from '../utils/herd';
import { normalizeRequestFailure, requestRequiresE2ee } from '@muxr/contract';
import { buildSpaceRows, lifecycleTree } from '../utils/herdTree';
import { selectLiveTerminalCards } from '../utils/liveTerminalOrder';

const request = vi.fn();
const sessions = {} as Record<string, unknown>;

vi.mock('../state/connectionSettings', () => ({
    getCachedConnectionSettings: () => ({ machineId: 'machine' }),
}));
vi.mock('./sync', () => ({ sync: { request, refreshSessions: vi.fn() } }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions, updateSession: vi.fn() }) } }));
import { applyStatusToSession, sessionInfoToSession } from './sessionMapping';

async function spawn(options: { modelMode?: string; effortLevel?: string }) {
    const { machineSpawnNewSession } = await import('./ops');
    return machineSpawnNewSession({ machineId: 'm', directory: '/tmp', ...options });
}

describe('session sync flow', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        request.mockReset();
        for (const key of Object.keys(sessions)) delete sessions[key];
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
        });
        expect(mapped.metadata?.paneId).toBe('%1');

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
                sessions.s1 = {};
                return {
                    info: { id: 's1' },
                    status: { sessionId: 's1', isStreaming: false, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 } },
                };
            }
            throw new Error(`unexpected request: ${method}`);
        });

        await expect(spawn({ modelMode: 'moonshot:kimi-k3', effortLevel: 'high' })).resolves.toEqual({
            type: 'success',
            sessionId: 's1',
        });
        expect(request.mock.calls).toEqual([['session.start', { cwd: '/tmp' }]]);
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
                summary: { text: 'muxr', updatedAt: 1 },
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
            mode: 'finished', count: 1, name: 'muxr', names: 'muxr', eventKey: `finished:${encodeURIComponent(session.id)}`,
        });
        // One stable grouped state replaces working -> blocked -> finished;
        // repeated renders produce the same key, so native dismissal is not reposted.
        expect(completionNotificationState(completed).eventKey).toBe(finishedNotification.eventKey);
        expect(JSON.stringify([workingNotification, blockedNotification, finishedNotification].map(({ name, names }) => ({ name, names })))).not.toContain(session.id);

        const offline = stage('done', false);
        expect(HERD_STATUS_LABELS[offline[0].status]).toBe('Offline');
        expect(herdNotificationState(offline, 'error').mode).toBe('offline');

        expect(normalizeRequestFailure('plugin.call', 'handler is not a function').code).toBe('host-contract-mismatch');
        expect(normalizeRequestFailure('plugin.call', 'handler is not a function').message).not.toContain('handler is not a function');
        expect(['plugin.approve', 'plugin.invoke', 'plugin.call', 'herdr.cli'].every(requestRequiresE2ee)).toBe(true);
        expect(requestRequiresE2ee('session.list')).toBe(false);
    });
});
