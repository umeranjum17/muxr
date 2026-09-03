import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
    const sessionReplaceFlags: boolean[] = [];
    const sessions: Record<string, { id: string; terminalTitle?: string }> = {};
    return {
        connection: {
            mode: 'hosted' as 'hosted' | 'local',
            relayUrl: 'ws://relay.test',
            machineId: '',
            token: '',
            lastSessionCwd: '',
            recentSessionCwds: [] as string[],
        },
        grant: undefined as { machineId: string; relayUrl: string; credential: string } | undefined,
        clientOptions: [] as Array<{ token?: string; onTicketRejected?: () => void }>,
        clients: [] as Array<{ state: string }>,
        clientConnects: 0,
        clientCloses: 0,
        blockNextMachines: false,
        blockedMachines: undefined as Promise<void> | undefined,
        blockedMachinesStarted: false,
        blockedMachinesFinished: false,
        machineSnapshots: [] as string[],
        socketStatus: 'disconnected',
        socketError: null as string | null,
        ready: false,
        machineReplaceFlags: [] as boolean[],
        sessionReplaceFlags,
        lifecycleScopes: [] as string[],
        lifecycleAuthorities: [] as string[],
        lifecycleCatalogError: Object.assign(new Error('older host'), { code: 'host-contract-mismatch' }) as Error & { code?: string },
        sessions,
        eventListeners: [] as Array<(sessionId: string, event: { type: string; session?: { id: string; terminalTitle?: string } }) => void>,
        applySessions: vi.fn((next: Array<{ id: string; terminalTitle?: string }>, replace = false) => {
            sessionReplaceFlags.push(replace);
            if (replace) {
                for (const id of Object.keys(sessions)) delete sessions[id];
            }
            for (const session of next) sessions[session.id] = session;
        }),
    };
});

vi.mock('expo-crypto', () => ({ randomUUID: () => 'login-device' }));
vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' }, Platform: { OS: 'android' } }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: () => 'session' }));
vi.mock('@/connection', () => ({
    DEFAULT_CONNECTION: { ...harness.connection },
    getCachedConnectionSettings: () => harness.connection,
    loadConnectionSettingsAsync: async () => harness.connection,
}));
vi.mock('@/pairing/e2ee', () => ({
    getOrCreateHostedDeviceKey: vi.fn(async () => ({
        publicKey: 'device-public',
        secretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })),
    getCachedHostedGrant: () => harness.grant,
    loadHostedGrant: async () => harness.grant,
    refreshHostedGrant: async () => harness.grant,
}));
vi.mock('@/pairing/infrastructure/muxrClient', () => ({
    MuxrClient: class {
        state = 'closed';
        private listeners: Array<(state: string) => void> = [];
        private readonly index: number;
        constructor(options: { token?: string; onTicketRejected?: () => void }) {
            this.index = harness.clients.length;
            harness.clientOptions.push(options);
            harness.clients.push(this);
        }
        connect() {
            harness.clientConnects += 1;
            this.state = 'connecting';
            queueMicrotask(() => {
                this.state = 'open';
                for (const listener of this.listeners) listener('open');
            });
        }
        close() { harness.clientCloses += 1; this.state = 'closed'; }
        isLive() { return this.state === 'open'; }
        onStateChange(listener: (state: string) => void) { this.listeners.push(listener); return () => undefined; }
        onEvent(listener: (sessionId: string, event: { type: string; session?: { id: string; terminalTitle?: string } }) => void) {
            harness.eventListeners.push(listener);
            return () => undefined;
        }
        async request(type: string) {
            if (type === 'machines.list') {
                if (harness.blockNextMachines) {
                    harness.blockNextMachines = false;
                    harness.blockedMachinesStarted = true;
                    await harness.blockedMachines;
                    harness.blockedMachinesFinished = true;
                }
                return [{ id: `client-${this.index}` }];
            }
            if (type === 'herdr.tree') return { workspaces: [] };
            if (type === 'attention.catalog') return { revision: 0, entries: [] };
            if (type === 'lifecycle.catalog') throw harness.lifecycleCatalogError;
            return [];
        }
    },
}));
vi.mock('../../catalog/infrastructure/encryption/encryption', () => ({
    Encryption: { create: async () => ({ anonID: 'account-device' }) },
}));
vi.mock('../../catalog/infrastructure/sessionMapping', () => ({
    applyStatusToSession: (session: unknown) => session,
    machineInfoToMachine: (machine: unknown) => machine,
    sessionInfoToSession: (session: unknown) => session,
}));
vi.mock('../../catalog/application/storage', () => ({
    storage: {
        getState: () => ({
            sessions: harness.sessions,
            sessionsLoaded: false,
            setSocketStatus: (status: string) => { harness.socketStatus = status; },
            setSocketError: (message: string | null) => { harness.socketError = message; },
            applyMachines: (machines: unknown[], replace = false) => {
                harness.machineReplaceFlags.push(replace);
                const id = (machines[0] as { id?: string } | undefined)?.id;
                if (id !== undefined) harness.machineSnapshots.push(id);
            },
            applySessions: harness.applySessions,
            deleteSession: (sessionId: string) => { delete harness.sessions[sessionId]; },
            applyHerdrTree: vi.fn(),
            markSessionsLoaded: vi.fn(),
            applyAttentionCatalog: vi.fn(),
            applyLifecycleCatalog: vi.fn(),
            setLifecycleAuthority: (authority: string) => { harness.lifecycleAuthorities.push(authority); },
            setLifecycleScope: (scope: string) => { harness.lifecycleScopes.push(scope); },
            resetLifecycleCatalog: vi.fn(),
            applyReady: () => { harness.ready = true; },
        }),
    },
}));

import { storage } from '../../catalog/application/storage';
import { finishHostedEmailLogin } from './hostedEmailLogin';
import {
    setAccountCredentialRejectedHandler,
    sync,
    syncCreate,
    syncReconnect,
    syncResume,
} from '@/catalog/sync';

const originalFetch = globalThis.fetch;

function response(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('hosted account-only lifecycle', () => {
    beforeEach(() => {
        harness.connection.mode = 'hosted';
        harness.connection.machineId = '';
        harness.grant = undefined;
        harness.clientOptions.length = 0;
        harness.clients.length = 0;
        harness.clientConnects = 0;
        harness.clientCloses = 0;
        harness.blockNextMachines = false;
        harness.blockedMachines = undefined;
        harness.blockedMachinesStarted = false;
        harness.blockedMachinesFinished = false;
        harness.machineSnapshots.length = 0;
        harness.socketStatus = 'disconnected';
        harness.ready = false;
        harness.machineReplaceFlags.length = 0;
        harness.sessionReplaceFlags.length = 0;
        harness.lifecycleScopes.length = 0;
        harness.lifecycleAuthorities.length = 0;
        harness.lifecycleCatalogError = Object.assign(new Error('older host'), { code: 'host-contract-mismatch' });
        harness.eventListeners.length = 0;
        for (const id of Object.keys(harness.sessions)) delete harness.sessions[id];
        harness.applySessions.mockClear();
    });

    afterEach(() => {
        setAccountCredentialRejectedHandler(undefined);
        vi.stubGlobal('fetch', originalFetch);
    });

    it('survives no-machine startup, reconnects with the stored grant, and logs out only on account rejection', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(response(200, { access_token: 'pck_account' }))
            .mockResolvedValueOnce(response(200, { machines: [] }))
            .mockResolvedValueOnce(response(200, { account: { email: 'owner@example.com' } }))
            .mockRejectedValueOnce(new Error('relay temporarily offline'))
            .mockResolvedValueOnce(response(200, { account: { email: 'owner@example.com' } }))
            .mockResolvedValueOnce(response(200, { account: { email: 'owner@example.com' } }))
            .mockResolvedValueOnce(response(200, { account: { email: 'owner@example.com' } }))
            .mockResolvedValueOnce(response(401, { error: 'unauthorized' }));
        vi.stubGlobal('fetch', fetch);

        const credentials = await finishHostedEmailLogin({
            base: 'http://relay.test',
            email: 'owner@example.com',
            userCode: 'ABCDEF',
        }, '123456');
        expect(credentials.machineId).toBeUndefined();

        let authenticated = true;
        setAccountCredentialRejectedHandler(() => { authenticated = false; });
        await syncCreate(credentials);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
        expect(harness.ready).toBe(true);
        expect(harness.socketStatus).toBe('disconnected');
        expect(harness.clientOptions).toHaveLength(0);

        await expect(sync.refreshHerdTree()).resolves.toEqual({ workspaces: [], herdrConnected: undefined });
        await expect(syncReconnect()).resolves.toBeUndefined();
        await expect(sync.refreshAccountSession()).resolves.toBe('valid');
        expect(authenticated).toBe(true);
        expect(harness.clientOptions).toHaveLength(0);

        const machineReplacementsBeforePairing = harness.machineReplaceFlags.length;
        const sessionReplacementsBeforePairing = harness.sessionReplaceFlags.length;
        harness.connection.machineId = 'machine-a';
        harness.grant = { machineId: 'machine-a', relayUrl: 'ws://relay.test', credential: 'stored-grant' };
        await syncCreate({ ...credentials, token: 'stale-login-token' });
        await vi.waitFor(() => expect(harness.clientConnects).toBe(1));
        expect(harness.machineReplaceFlags.length).toBeGreaterThan(machineReplacementsBeforePairing);
        expect(harness.sessionReplaceFlags.length).toBeGreaterThan(sessionReplacementsBeforePairing);
        expect(harness.machineReplaceFlags.at(-1)).toBe(true);
        expect(harness.sessionReplaceFlags.at(-1)).toBe(true);
        expect(harness.clientOptions).toHaveLength(1);
        expect(harness.clientOptions[0].token).toBe('stored-grant');
        expect(harness.lifecycleScopes).toContain('account-device:account');
        expect(harness.lifecycleScopes).toContain('account-device:machine-a');
        expect(harness.lifecycleAuthorities).toEqual(['account-device', 'account-device']);

        const connectedClient = harness.clients[0];
        await syncResume();
        connectedClient.state = 'connecting';
        await syncResume();
        expect(harness.clientOptions).toHaveLength(1);
        expect(harness.clientConnects).toBe(1);
        expect(harness.clientCloses).toBe(0);

        connectedClient.state = 'stale';
        await Promise.all([syncResume(), syncResume()]);
        expect(harness.clientOptions).toHaveLength(2);
        expect(harness.clientConnects).toBe(2);
        expect(harness.clientCloses).toBe(1);

        harness.clients[1].state = 'closed';
        await Promise.all([syncResume(), syncResume()]);
        expect(harness.clientOptions).toHaveLength(2);
        expect(harness.clientConnects).toBe(3);
        expect(harness.clientCloses).toBe(1);

        await syncReconnect();
        expect(harness.clientOptions).toHaveLength(3);
        expect(harness.clientConnects).toBe(4);
        expect(harness.clientCloses).toBe(2);

        let releaseBlockedMachines!: () => void;
        harness.blockedMachines = new Promise((resolve) => { releaseBlockedMachines = resolve; });
        harness.blockNextMachines = true;
        harness.clients.at(-1)!.state = 'closed';
        const resume = syncResume();
        await vi.waitFor(() => expect(harness.blockedMachinesStarted).toBe(true));
        await Promise.all([resume, syncReconnect(), syncReconnect()]);
        expect(harness.clientOptions).toHaveLength(4);
        expect(harness.clientConnects).toBe(6);
        expect(harness.clientCloses).toBe(3);
        expect(harness.machineSnapshots.at(-1)).toBe('client-3');
        expect(harness.clients.filter((client) => client.state !== 'closed')).toEqual([harness.clients[3]]);

        releaseBlockedMachines();
        await vi.waitFor(() => expect(harness.blockedMachinesFinished).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(harness.machineSnapshots.at(-1)).toBe('client-3');

        await syncResume();
        expect(harness.clientOptions).toHaveLength(4);
        expect(harness.clientConnects).toBe(6);
        expect(harness.clientCloses).toBe(3);

        harness.lifecycleCatalogError = new Error('relay temporarily offline');
        await expect(sync.refreshSessions()).rejects.toThrow('relay temporarily offline');
        harness.lifecycleCatalogError = Object.assign(new Error('older host'), { code: 'host-contract-mismatch' });

        harness.clientOptions[0].onTicketRejected?.();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(7));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(authenticated).toBe(true);

        await expect(sync.refreshAccountSession()).rejects.toMatchObject({ name: 'AccountCredentialRejectedError' });
        expect(authenticated).toBe(false);
    });
});

describe('session sync flow', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('merges inbound session.updated frames into one store write per 250 ms window', async () => {
        harness.connection.mode = 'hosted';
        harness.connection.machineId = 'machine-a';
        harness.grant = { machineId: 'machine-a', relayUrl: 'ws://relay.test', credential: 'stored-grant' };
        harness.eventListeners.length = 0;
        for (const id of Object.keys(harness.sessions)) delete harness.sessions[id];

        await syncReconnect();
        await vi.waitFor(() => expect(harness.eventListeners.length).toBeGreaterThan(0));

        for (let index = 0; index < 30; index += 1) {
            const id = `session-${index}`;
            harness.sessions[id] = { id, terminalTitle: `title-${index}-v1` };
        }
        const applySessions = storage.getState().applySessions;
        applySessions.mockClear();

        vi.useFakeTimers();
        const emit = (
            sessionId: string,
            event: { type: string; session?: { id: string; terminalTitle: string } },
        ) => {
            for (const listener of harness.eventListeners) listener(sessionId, event);
        };

        for (let index = 0; index < 30; index += 1) {
            const id = `session-${index}`;
            emit(id, {
                type: 'session.updated',
                session: { id, terminalTitle: `title-${index}-v2` },
            });
            if (index === 2) emit('session-0', { type: 'session.removed' });
            vi.advanceTimersByTime(1000 / 30);
        }
        vi.advanceTimersByTime(250);

        expect(applySessions.mock.calls.length).toBeLessThanOrEqual(5);
        expect(applySessions).toHaveBeenCalled();
        expect(storage.getState().sessions['session-0']).toBeUndefined();
        for (let index = 1; index < 30; index += 1) {
            expect(storage.getState().sessions[`session-${index}`]?.terminalTitle).toBe(`title-${index}-v2`);
        }
    });
});
