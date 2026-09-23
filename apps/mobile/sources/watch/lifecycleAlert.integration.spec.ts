import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LifecycleEvent } from '@muxr/contract';

const harness = vi.hoisted(() => ({
    // The phone's notification shade, keyed the way Android keys an app's
    // notifications: by the tag Expo passes, which is the request identifier.
    shade: new Map<string, string>(),
    // Every post, including one that replaces a row: each one alerts again.
    posted: [] as string[],
    issued: [] as Array<{ identifier: string; date: number }>,
    postGate: null as null | { started: () => void; wait: Promise<void> },
    appState: 'active',
    appStateListeners: new Set<(state: string) => void>(),
    eventListeners: [] as Array<(sessionId: string, event: unknown) => void>,
    mmkv: new Map<string, string>(),
    catalog: { revision: 1, events: [] as LifecycleEvent[] },
    catalogRead: null as null | (() => void),
    machinesGate: null as null | Promise<void>,
    permissionPending: false,
    nativeShade: [] as string[],
    nativeFinishedPosts: 0,
    nativeFinishedUpdates: 0,
}));

vi.mock('expo-notifications', () => ({
    scheduleNotificationAsync: vi.fn(async (request: { identifier?: string; content: { body: string } }) => {
        const gate = harness.postGate;
        harness.postGate = null;
        if (gate) {
            gate.started();
            await gate.wait;
        }
        // Expo invents a fresh identifier when the caller gives none.
        const identifier = request.identifier ?? `expo-${Math.random()}`;
        harness.shade.set(identifier, request.content.body);
        harness.posted.push(request.content.body);
        harness.issued.push({ identifier, date: harness.issued.length + 1 });
        return identifier;
    }),
    dismissNotificationAsync: vi.fn(async (identifier: string) => { harness.shade.delete(identifier); }),
}));
vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return harness.appState; },
        addEventListener: (_type: string, listener: (state: string) => void) => {
            harness.appStateListeners.add(listener);
            return { remove: () => harness.appStateListeners.delete(listener) };
        },
    },
    Platform: { OS: 'android' },
}));
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return harness.mmkv.get(key); }
        set(key: string, value: string) { harness.mmkv.set(key, value); }
        delete(key: string) { harness.mmkv.delete(key); }
    },
}));
vi.mock('@/modal', () => ({ Modal: { confirm: async () => false } }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('@/conversation/session', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/conversation/session')>(),
    boundRealtimeSession: () => null,
    useRealtimeMuted: () => false,
    useRealtimeSessionState: () => ({ state: 'disconnected' }),
    retryVadStandby: async () => undefined,
}));
vi.mock('@/utils/nativePushNotifications', () => ({ registerNativePushNotifications: async () => undefined }));
vi.mock('@/utils/microphonePermissions', () => ({
    requestNotificationPermission: () => harness.permissionPending ? new Promise<boolean>(() => undefined) : Promise.resolve(true),
}));
vi.mock('@/../modules/voice-overlay', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/../modules/voice-overlay')>(),
    updateVoiceNotification: (herd: { mode: string; name: string; eventKey: string }, _voice: string, _name: string, _muted: boolean, agents: Array<{ id: string; name: string; status: string; focused: boolean }>) => {
        if (herd.mode === 'attention') {
            harness.nativeShade = agents.filter((agent) => agent.status === 'blocked' && !agent.focused).map((agent) => `${agent.name} needs you`);
        } else if (herd.mode === 'finished') {
            harness.nativeFinishedUpdates += 1;
            const completed = herd.eventKey.slice('finished:'.length).split(',');
            const visible = agents.filter((agent) => completed.includes(encodeURIComponent(agent.id)) && !agent.focused);
            harness.nativeShade = agents.length === 0 ? [`${herd.name} finished`] : visible.map((agent) => `${agent.name} finished`);
            harness.nativeFinishedPosts += harness.nativeShade.length;
        } else {
            harness.nativeShade = [];
        }
        return true;
    },
    clearVoiceNotification: () => undefined,
    startHerdKeepalive: () => true,
    stopHerdKeepalive: () => undefined,
    supportsPromotedNotifications: () => false,
    canPostPromotedNotifications: () => false,
}));
vi.mock('@/connection', () => {
    const settings = { mode: 'local', relayUrl: 'ws://relay.test', machineId: 'machine-a', token: 'device', lastSessionCwd: '', recentSessionCwds: [] };
    return {
        DEFAULT_CONNECTION: settings,
        getCachedConnectionSettings: () => settings,
        loadConnectionSettingsAsync: async () => settings,
        sshTunnelAvailable: () => false,
    };
});
vi.mock('@/pairing/e2ee', () => ({
    getCachedHostedGrant: () => undefined,
    loadHostedGrant: async () => undefined,
    refreshHostedGrant: async () => undefined,
}));
vi.mock('@/pairing/infrastructure/muxrClient', () => ({
    MuxrClient: class {
        state = 'open';
        connect() {}
        close() {}
        isLive() { return true; }
        onStateChange() { return () => undefined; }
        onEvent(listener: (sessionId: string, event: unknown) => void) {
            harness.eventListeners.push(listener);
            return () => undefined;
        }
        async request(type: string) {
            if (type === 'machines.list' && harness.machinesGate) await harness.machinesGate;
            if (type === 'herdr.tree') return { workspaces: [] };
            if (type === 'attention.catalog') return { revision: 0, entries: [] };
            if (type === 'lifecycle.catalog') {
                const catalog = harness.catalog;
                harness.catalogRead?.();
                return catalog;
            }
            return [];
        }
    },
}));
vi.mock('../catalog/infrastructure/encryption/encryption', () => ({
    Encryption: { create: async () => ({ anonID: 'phone' }) },
}));
vi.mock('@/herd', async () => {
    const { herdrPaneForSession } = await vi.importActual<typeof import('@/herd/domain/agentPresentation')>('@/herd/domain/agentPresentation');
    const { lifecycleNotificationCopy } = await vi.importActual<typeof import('@/herd/domain/herd')>('@/herd/domain/herd');
    return {
        herdrPaneForSession,
        lifecycleNotificationCopy,
        getSessionName: (session: { id: string }) => session.id,
        getSessionSubtitle: () => '',
        getSessionAvatarId: (session: { id: string }) => session.id,
    };
});

import { storage } from '@/catalog/store';
import { KernelNotifications } from '@/herd/presentation/KernelNotifications';
import { sync, syncCreate } from '@/catalog/sync';
import { agentOnScreen, focusedAgentRoute, notificationResponseKey, subscribeFocusedAgent } from '@/watch/lifecycleAlert';

let sequence = 0;

function agentChanges(sessionId: string, agentName: string, state: LifecycleEvent['state']): void {
    sequence += 1;
    const reasonCode = state === 'blocked' ? 'agent-blocked' : 'agent-working';
    const event: LifecycleEvent = {
        eventId: `event-${sequence}`,
        sessionId,
        agentName,
        state,
        reasonCode,
        reason: reasonCode,
        at: new Date(Date.now() + sequence).toISOString(),
    };
    for (const listener of harness.eventListeners) listener(sessionId, { type: 'lifecycle.update', event });
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function shade(): string[] {
    return [...harness.shade.values()];
}

function appBecomes(state: string): void {
    harness.appState = state;
    for (const listener of harness.appStateListeners) listener(state);
}

describe('agent lifecycle alerts on the phone', () => {
    beforeEach(() => {
        harness.shade.clear();
        harness.posted.length = 0;
        harness.issued.length = 0;
        harness.postGate = null;
        harness.catalog = { revision: 1, events: [] };
        harness.catalogRead = null;
        harness.machinesGate = null;
        harness.permissionPending = false;
        harness.nativeShade = [];
        harness.nativeFinishedPosts = 0;
        harness.nativeFinishedUpdates = 0;
        harness.appState = 'active';
    });

    it('stays quiet about the agent on screen and keeps one alert per agent', async () => {
        await syncCreate({ token: 'device', secret: 'A'.repeat(43) });
        await vi.waitFor(() => expect(storage.getState().lifecycleCatalogAvailable).toBe(true));

        // Lamb's terminal is open while lamb stops for three permission prompts.
        const focusHistory: Array<string | null> = [];
        const unsubscribe = subscribeFocusedAgent(() => focusHistory.push(focusedAgentRoute()));
        const leaveLamb = agentOnScreen('route-lamb');
        expect(focusedAgentRoute()).toBe('route-lamb');
        for (let prompt = 0; prompt < 3; prompt += 1) {
            agentChanges('route-lamb', 'lamb', 'working');
            agentChanges('route-lamb', 'lamb', 'blocked');
        }
        await settle();
        expect(harness.posted).toEqual([]);

        // Back on Home: lamb asks twice more and ewe once. One row per agent.
        leaveLamb();
        agentChanges('route-lamb', 'lamb', 'blocked');
        agentChanges('route-lamb', 'lamb', 'working');
        agentChanges('route-lamb', 'lamb', 'blocked');
        agentChanges('route-ewe', 'ewe', 'blocked');
        await settle();
        expect(shade()).toEqual(['lamb needs attention.', 'ewe needs attention.']);
        // Each new request alerts once, even when frames arrive together.
        expect([...harness.posted].sort()).toEqual(['ewe needs attention.', 'lamb needs attention.', 'lamb needs attention.']);
        const [firstLamb, secondLamb] = harness.issued.filter((_, index) => harness.posted[index] === 'lamb needs attention.');
        expect(firstLamb.identifier).toBe(secondLamb.identifier);
        const notification = (issued: { identifier: string; date: number }) => ({
            request: { identifier: issued.identifier }, date: issued.date,
        }) as Parameters<typeof notificationResponseKey>[0];
        expect(notificationResponseKey(notification(firstLamb))).not.toBe(notificationResponseKey(notification(secondLamb)));
        expect(notificationResponseKey(notification(firstLamb))).toBe(notificationResponseKey(notification(firstLamb)));

        // Opening lamb clears lamb's row and leaves ewe's.
        const leaveAgain = agentOnScreen('route-lamb');
        await settle();
        expect(shade()).toEqual(['ewe needs attention.']);

        // The phone locked on lamb's terminal is not looking at it; coming back is.
        appBecomes('background');
        expect(focusedAgentRoute()).toBeNull();
        agentChanges('route-lamb', 'lamb', 'working');
        agentChanges('route-lamb', 'lamb', 'blocked');
        await settle();
        expect(shade()).toEqual(['ewe needs attention.', 'lamb needs attention.']);
        appBecomes('active');
        await settle();
        expect(shade()).toEqual(['ewe needs attention.']);
        leaveAgain();
        expect(focusedAgentRoute()).toBeNull();
        agentChanges('route-ewe', 'ewe', 'working');
        await settle();
        expect(shade()).toEqual([]);

        let started!: () => void;
        let release!: () => void;
        const posting = new Promise<void>((resolve) => { started = resolve; });
        const wait = new Promise<void>((resolve) => { release = resolve; });
        harness.postGate = { started, wait };
        agentChanges('route-ewe', 'ewe', 'blocked');
        await posting;
        agentChanges('route-ewe', 'ewe', 'working');
        release();
        await settle();
        expect(shade()).toEqual([]);

        const replayEvent = (state: LifecycleEvent['state'], offset: number): LifecycleEvent => ({
            eventId: `replay-${offset}`,
            sessionId: 'route-ram',
            agentName: 'ram',
            state,
            reasonCode: state === 'blocked' ? 'agent-blocked' : state === 'failed' ? 'agent-runtime-failed' : 'agent-working',
            at: new Date(Date.now() + offset).toISOString(),
        });
        const blocked = replayEvent('blocked', 100);
        const failed = replayEvent('failed', 101);
        harness.catalog = { revision: 2, events: [failed, blocked] };
        await sync.refreshSessions();
        await settle();
        expect(shade()).toEqual(['ram failed.']);
        expect(harness.posted.filter((body) => body.startsWith('ram '))).toEqual(['ram failed.']);

        const resolved = replayEvent('working', 102);
        harness.catalog = { revision: 3, events: [resolved, failed, blocked] };
        await sync.refreshSessions();
        await settle();
        expect(shade()).toEqual(['ram failed.']);
        agentChanges('route-ram', 'ram', 'working');
        await settle();
        expect(shade()).toEqual([]);

        let catalogRead!: () => void;
        let releaseCatalog!: () => void;
        const read = new Promise<void>((resolve) => { catalogRead = resolve; });
        harness.catalogRead = catalogRead;
        harness.machinesGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
        harness.catalog = { revision: 4, events: [resolved, failed, blocked] };
        const refresh = sync.refreshSessions();
        await read;
        sequence += 200;
        agentChanges('route-ram', 'ram', 'blocked');
        await settle();
        releaseCatalog();
        await refresh;
        await settle();
        expect(shade()).toEqual(['ram needs attention.']);

        expect(focusHistory).toEqual(['route-lamb', null, 'route-lamb', null, 'route-lamb', null]);
        unsubscribe();
    });

    it('clears native attention on focus before permission resolves', async () => {
        harness.permissionPending = true;
        storage.setState({
            socketStatus: 'connected',
            lifecycleCatalogAvailable: false,
            herdrWorkspaces: [{
                workspaceId: 'workspace-a', label: 'Work', focused: true, agentStatus: 'blocked',
                tabs: [{ tabId: 'tab-a', focused: true, agentStatus: 'blocked', panes: [{
                    paneId: 'pane-a', tabId: 'tab-a', sessionId: 'route-lamb',
                    agentName: 'lamb', agentStatus: 'blocked', promptable: true, focused: true,
                }] }],
            }],
            localSettings: {
                ...storage.getState().localSettings,
                backgroundConnectionPrompted: true,
                promotedNotificationsPrompted: true,
                lifecycleNotificationLevel: 'all',
            },
        });
        harness.nativeShade = ['lamb needs you'];
        let screen!: ReturnType<typeof TestRenderer.create>;
        await act(async () => { screen = TestRenderer.create(React.createElement(KernelNotifications)); });
        expect(harness.nativeShade).toEqual(['lamb needs you']);
        let leave!: () => void;
        await act(async () => { leave = agentOnScreen('route-lamb'); });
        expect(harness.nativeShade).toEqual([]);
        await act(async () => { leave(); });
        expect(harness.nativeShade).toEqual(['lamb needs you']);
        await act(async () => { leave = agentOnScreen('route-lamb'); });
        harness.permissionPending = false;
        await act(async () => {
            const [workspace] = storage.getState().herdrWorkspaces;
            storage.getState().applyHerdrTree([{ ...workspace, agentStatus: 'done', tabs: workspace.tabs.map((tab) => ({
                ...tab, agentStatus: 'done', panes: tab.panes.map((pane) => ({ ...pane, agentStatus: 'done' })),
            })) }]);
        });
        expect(harness.nativeFinishedUpdates).toBeGreaterThan(0);
        expect(harness.nativeShade).toEqual([]);
        expect(harness.nativeFinishedPosts).toBe(0);
        await act(async () => { leave(); screen.unmount(); });
    });
});
