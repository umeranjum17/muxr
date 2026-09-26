import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
    const sessionReplaceFlags: boolean[] = [];
    const sessions: Record<string, { id: string; taskTitle?: string }> = {};
    return {
        connection: {
            mode: 'hosted' as 'hosted' | 'local',
            relayUrl: 'ws://relay.test',
            machineId: '',
            token: '',
            lastSessionCwd: '',
            recentSessionCwds: [] as string[],
        },
        grant: undefined as { machineId: string; relayUrl: string } | undefined,
        clientOptions: [] as Array<{ grant?: unknown; token?: string; onTicketRejected?: () => void }>,
        clients: [] as Array<{ status: string; fire: (status: string) => void }>,
        clientConnects: 0,
        clientCloses: 0,
        blockNextMachines: false,
        blockNextSessions: false,
        blockNextTree: false,
        blockedTree: undefined as Promise<void> | undefined,
        treeRequestStarted: false,
        blockedSessions: undefined as Promise<void> | undefined,
        sessionsRequestStarted: false,
        treeResponses: [] as Array<{ workspaces: Array<{ workspaceId: string; tabs: [] }> }>,
        sessionsLoaded: false,
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
        eventListeners: [] as Array<(sessionId: string, event: { type: string; session?: { id: string; taskTitle?: string } }) => void>,
        applySessions: vi.fn((next: Array<{ id: string; taskTitle?: string }>, replace = false) => {
            sessionReplaceFlags.push(replace);
            if (replace) {
                for (const id of Object.keys(sessions)) delete sessions[id];
            }
            for (const session of next) sessions[session.id] = session;
        }),
    };
});

vi.mock('expo-crypto', () => ({ randomUUID: () => 'login-device' }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => undefined,
    deleteItemAsync: async () => undefined,
}));
vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' }, Platform: { OS: 'android' } }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/herd', () => ({ getSessionName: () => 'session' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('../../catalog/application/persistence', () => ({ saveHomeSnapshot: vi.fn() }));
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

// The cloud machine's link grant: link-derivable without the selfhost source.
vi.mock('@/pairing/infrastructure/linkGrant', () => ({
    deriveLinkGrant: (grant: { machineId: string; relayUrl: string } | undefined) => {
        if (grant === undefined) return undefined;
        return {
            v: 1 as const,
            secretKey: grant.machineId,
            host: 'bWFjaGluZUJveEtleQ',
            hostName: 'Desk',
            urls: [`${grant.relayUrl.replace(/^ws/, 'ws')}/link/v1/cloud`],
            device: { id: '', name: 'Phone', role: 'control' as const },
        };
    },
}));

vi.mock('@byokit/link', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@byokit/link')>();
    class FakeDeviceLink {
        private static instances: FakeDeviceLink[] = [];
        private listeners: Array<(s: string) => void> = [];
        private internalState = 'closed';
        get status(): string { return this.internalState; }
        set status(value: string) {
            this.internalState = value;
            for (const listener of this.listeners) listener(value);
        }
        constructor(public grant: unknown, public o: { onStatus?: (s: string) => void; onEvent?: (e: unknown) => void; onError?: (e: unknown) => void } = {}) {
            FakeDeviceLink.instances.push(this);
            harness.clients.push(this);
            harness.clientOptions.push({ grant: this.grant });
            // Link frames arrive as `{ type: 'session.event', sessionId, event }`;
            // bridge them so tests drive events the way the old client delivered them.
            harness.eventListeners.push((sessionId: string, event: unknown) => {
                this.o.onEvent?.({ type: 'session.event', sessionId, event });
            });
            // byokit DeviceLink dials in its constructor; mirror that here.
            harness.clientConnects += 1;
            this.fire('connecting');
            queueMicrotask(() => this.fire('online'));
        }
        connect() {
            this.fire('connecting');
            queueMicrotask(() => this.fire('online'));
        }
        stop() {
            harness.clientCloses += 1;
            this.fire('closed');
        }
        fire(status: string) {
            this.internalState = status as never;
            this.o.onStatus?.(status);
            for (const listener of this.listeners) listener(status);
        }
        onStatus(listener: (s: string) => void) { this.listeners.push(listener); return () => undefined; }
        onEvent(listener: (e: unknown) => void) { return this.o.onEvent?.(listener) ?? (() => undefined); }
        onError() { return () => undefined; }
        async request(op: string) {
            return { type: 'result', ok: true, data: await FakeDeviceLink.respond(op, this) };
        }
        private static async respond(op: string, link: FakeDeviceLink) {
            if (op === 'machines.list') {
                if (harness.blockNextMachines) {
                    harness.blockNextMachines = false;
                    harness.blockedMachinesStarted = true;
                    await harness.blockedMachines;
                    harness.blockedMachinesFinished = true;
                }
                return [{ id: `client-${FakeDeviceLink.instances.indexOf(link)}` }];
            }
            if (op === 'herdr.tree') {
                if (harness.blockNextTree) {
                    harness.blockNextTree = false;
                    harness.treeRequestStarted = true;
                    await harness.blockedTree;
                }
                return harness.treeResponses.shift() ?? { workspaces: [] };
            }
            if (op === 'session.list') {
                if (harness.blockNextSessions) {
                    harness.blockNextSessions = false;
                    harness.sessionsRequestStarted = true;
                    await harness.blockedSessions;
                }
                return [{ id: 'agent' }];
            }
            if (op === 'attention.catalog') return { revision: 0, entries: [] };
            if (op === 'lifecycle.catalog') throw harness.lifecycleCatalogError;
            return [];
        }
    }
    return { ...actual, DeviceLink: FakeDeviceLink as never };
});

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
            sessionsLoaded: harness.sessionsLoaded,
            lifecycleEvents: [],
            herdrWorkspaces: [],
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
            pruneSpacePins: vi.fn(),
            applyHomeSnapshot: vi.fn(),
            restoreHome: vi.fn(),
            markSessionsLoaded: () => { harness.sessionsLoaded = true; },
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
import { saveHomeSnapshot } from '../../catalog/application/persistence';
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
        harness.blockNextSessions = false;
        harness.blockNextTree = false;
        harness.blockedTree = undefined;
        harness.treeRequestStarted = false;
        harness.blockedSessions = undefined;
        harness.sessionsRequestStarted = false;
        harness.treeResponses.length = 0;
        harness.sessionsLoaded = false;
        vi.mocked(saveHomeSnapshot).mockClear();
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
            .mockImplementation(async () => response(401, { error: 'unauthorized' }));
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
        harness.grant = {
            machineId: 'machine-a', relayUrl: 'ws://relay.test',
            deviceKey: { publicKey: 'device-public', secretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            machineBoxPublicKey: 'bWFjaGluZS1ib3gta2V5LWJhc2U2NC0zMmJ5dGVzMjMyMQ',
        } as never;
        await syncCreate({ ...credentials, token: 'stale-login-token' });
        await vi.waitFor(() => expect(harness.clientConnects).toBe(1));
        expect(harness.machineReplaceFlags.length).toBeGreaterThan(machineReplacementsBeforePairing);
        expect(harness.sessionReplaceFlags.length).toBeGreaterThan(sessionReplacementsBeforePairing);
        expect(harness.machineReplaceFlags.at(-1)).toBe(true);
        expect(harness.sessionReplaceFlags.at(-1)).toBe(true);
        expect(harness.clientOptions).toHaveLength(1);
        expect(harness.lifecycleScopes).toContain('account-device:account');
        expect(harness.lifecycleScopes).toContain('account-device:machine-a');
        expect(harness.lifecycleAuthorities).toEqual(['account-device', 'account-device']);

        const connectedClient = harness.clients[0];
        await syncResume();
        connectedClient.fire('connecting');
        await syncResume();
        expect(harness.clientOptions).toHaveLength(1);
        expect(harness.clientConnects).toBe(1);
        expect(harness.clientCloses).toBe(0);

        // On the link, a host that no longer admits the device signals the
        // terminal 'removed' — the analogue of the old transport's stale.
        connectedClient.fire('removed');
        await Promise.all([syncResume(), syncResume()]);
        expect(harness.clientOptions).toHaveLength(2);
        expect(harness.clientConnects).toBe(2);
        expect(harness.clientCloses).toBe(1);

        harness.clients[1].fire('closed');
        await Promise.all([syncResume(), syncResume()]);
        // A closed link hands 'closed' up, so the session layer rebuilds the
        // client instead of resuming the dead one.
        expect(harness.clientOptions).toHaveLength(2);
        expect(harness.clientConnects).toBe(2);
        expect(harness.clientCloses).toBe(1);

        await syncReconnect();
        expect(harness.clientOptions).toHaveLength(3);
        expect(harness.clientConnects).toBe(3);
        expect(harness.clientCloses).toBe(2);

        expect(harness.machineSnapshots.at(-1)).toBe('client-2');
        const openClients = harness.clients.filter((client) => client.status !== 'closed');
        expect(openClients).toEqual([harness.clients.at(-1)]);


        harness.lifecycleCatalogError = new Error('relay temporarily offline');
        await expect(sync.refreshSessions()).rejects.toThrow('relay temporarily offline');
        harness.lifecycleCatalogError = Object.assign(new Error('older host'), { code: 'host-contract-mismatch' });

        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
        expect(authenticated).toBe(true);

        await expect(sync.refreshAccountSession()).rejects.toMatchObject({ name: 'AccountCredentialRejectedError' });
        expect(authenticated).toBe(false);
    }, 30_000);
});

describe('session sync flow', () => {
    it('saves a newer confirmed tree after a superseded catalog pass completes', async () => {
        harness.connection.mode = 'hosted';
        harness.connection.machineId = 'machine-a';
        harness.grant = {
            machineId: 'machine-a', relayUrl: 'ws://relay.test',
            deviceKey: { publicKey: 'device-public', secretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            machineBoxPublicKey: 'bWFjaGluZS1ib3gta2V5LWJhc2U2NC0zMmJ5dGVzMjMyMQ',
        } as never;
        await syncCreate({ token: 'account', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
        await vi.waitFor(() => expect(harness.sessionsLoaded).toBe(true));
        await sync.refreshSessions();
        vi.mocked(saveHomeSnapshot).mockClear();

        let releaseSessions!: () => void;
        harness.blockedSessions = new Promise<void>((resolve) => { releaseSessions = resolve; });
        harness.blockNextSessions = true;
        const oldTree = { workspaces: [{ workspaceId: 'old', tabs: [] as [] }] };
        const newTree = { workspaces: [{ workspaceId: 'new', tabs: [] as [] }] };
        harness.treeResponses.push(oldTree, newTree);
        const catalog = sync.refreshSessions();
        await vi.waitFor(() => expect(harness.sessionsRequestStarted).toBe(true));
        await sync.refreshHerdTree();
        releaseSessions();
        await catalog;
        expect(vi.mocked(saveHomeSnapshot).mock.calls.at(-1)?.[1]).toEqual(newTree.workspaces);
        expect(vi.mocked(saveHomeSnapshot).mock.calls.at(-1)?.[2]).toEqual([{ id: 'agent' }]);

        // If the newer tree arrives after the catalog, its own confirmation saves Home.
        vi.mocked(saveHomeSnapshot).mockClear();
        harness.treeResponses.push(oldTree, newTree);
        let releaseCatalog!: () => void;
        let releaseTree!: () => void;
        harness.blockedSessions = new Promise<void>((resolve) => { releaseCatalog = resolve; });
        harness.blockNextSessions = true;
        harness.blockedTree = new Promise<void>((resolve) => { releaseTree = resolve; });
        const lateCatalog = sync.refreshSessions();
        await vi.waitFor(() => expect(harness.treeResponses.length).toBe(1));
        harness.blockNextTree = true;
        const newerTree = sync.refreshHerdTree();
        await vi.waitFor(() => expect(harness.treeRequestStarted).toBe(true));
        releaseCatalog();
        await lateCatalog;
        releaseTree();
        await newerTree;
        expect(vi.mocked(saveHomeSnapshot).mock.calls.at(-1)?.[1]).toEqual(newTree.workspaces);
        expect(vi.mocked(saveHomeSnapshot).mock.calls.at(-1)?.[2]).toEqual([{ id: 'agent' }]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('merges inbound session.updated frames into one store write per 250 ms window', async () => {
        harness.connection.mode = 'hosted';
        harness.connection.machineId = 'machine-a';
        harness.grant = {
            machineId: 'machine-a', relayUrl: 'ws://relay.test',
            deviceKey: { publicKey: 'device-public', secretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            machineBoxPublicKey: 'bWFjaGluZS1ib3gta2V5LWJhc2U2NC0zMmJ5dGVzMjMyMQ',
        } as never;
        harness.eventListeners.length = 0;
        for (const id of Object.keys(harness.sessions)) delete harness.sessions[id];

        await syncReconnect();
        await vi.waitFor(() => expect(harness.eventListeners.length).toBeGreaterThan(0));

        for (let index = 0; index < 30; index += 1) {
            harness.sessions[`session-${index}`] = { id: `session-${index}` };
        }
        const applySessions = storage.getState().applySessions as unknown as ReturnType<typeof vi.fn>;
        applySessions.mockClear();

        vi.useFakeTimers();
        const emit = (sessionId: string, event: { type: string; session?: { id: string; taskTitle?: string } }) => {
            for (const listener of harness.eventListeners) listener(sessionId, event);
        };

        // Thirty sessions each publishing at once is the burst that used to cost
        // one store write and one render per frame.
        for (let index = 0; index < 30; index += 1) {
            const id = `session-${index}`;
            emit(id, { type: 'session.updated', session: { id, taskTitle: `task-${index}` } });
            if (index === 2) emit('session-0', { type: 'session.removed' });
            vi.advanceTimersByTime(1000 / 30);
        }
        vi.advanceTimersByTime(250);

        expect(applySessions.mock.calls.length).toBeLessThanOrEqual(5);
        expect(applySessions).toHaveBeenCalled();
        expect(storage.getState().sessions['session-0']).toBeUndefined();
        for (let index = 1; index < 30; index += 1) {
            expect(storage.getState().sessions[`session-${index}`]?.id).toBe(`session-${index}`);
        }
    });
});
