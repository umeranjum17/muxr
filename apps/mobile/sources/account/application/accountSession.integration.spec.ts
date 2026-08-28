import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
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
    clientConnects: 0,
    socketStatus: 'disconnected',
    socketError: null as string | null,
    ready: false,
    machineReplaceFlags: [] as boolean[],
    sessionReplaceFlags: [] as boolean[],
    lifecycleScopes: [] as string[],
    lifecycleAuthorities: [] as string[],
    lifecycleCatalogError: Object.assign(new Error('older host'), { code: 'host-contract-mismatch' }) as Error & { code?: string },
}));

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
        constructor(options: { token?: string; onTicketRejected?: () => void }) {
            harness.clientOptions.push(options);
        }
        connect() {
            harness.clientConnects += 1;
            queueMicrotask(() => {
                this.state = 'open';
                for (const listener of this.listeners) listener('open');
            });
        }
        close() { this.state = 'closed'; }
        onStateChange(listener: (state: string) => void) { this.listeners.push(listener); return () => undefined; }
        onEvent() { return () => undefined; }
        async request(type: string) {
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
            sessions: {},
            sessionsLoaded: false,
            setSocketStatus: (status: string) => { harness.socketStatus = status; },
            setSocketError: (message: string | null) => { harness.socketError = message; },
            applyMachines: (_machines: unknown[], replace = false) => { harness.machineReplaceFlags.push(replace); },
            applySessions: (_sessions: unknown[], replace = false) => { harness.sessionReplaceFlags.push(replace); },
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

import { finishHostedEmailLogin } from './hostedEmailLogin';
import {
    setAccountCredentialRejectedHandler,
    sync,
    syncCreate,
    syncReconnect,
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
        harness.clientConnects = 0;
        harness.socketStatus = 'disconnected';
        harness.ready = false;
        harness.machineReplaceFlags.length = 0;
        harness.sessionReplaceFlags.length = 0;
        harness.lifecycleScopes.length = 0;
        harness.lifecycleAuthorities.length = 0;
        harness.lifecycleCatalogError = Object.assign(new Error('older host'), { code: 'host-contract-mismatch' });
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
