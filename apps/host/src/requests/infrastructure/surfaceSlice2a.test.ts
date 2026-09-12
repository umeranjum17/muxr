/**
 * Slice 2A end-to-end contract flows (not a matrix).
 *
 * A local Browser offer opens bound to the exact live agent session, the
 * registry event fans out as a bounded host frame for live control devices
 * only, and a control device leases the offer by handle with the host-owned
 * port, provider and context -- after its own approvals check out. Forged
 * product params, stale or replaced offers, unapproved providers, revoked
 * approvals, direct-HTTPS and Code offers, and device-submitted host-local
 * offers all fail closed. The developer typed-port lease is untouched. The
 * broker resolves pane/cwd hints against the live tree and providers
 * generically, and its replies leak no ids or secrets.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    isSurfaceOfferHostFrame,
    type HerdrTreeWorkspace,
    type PluginSummary,
    type SurfaceCapability,
} from '@muxr/contract';
import { createRequestDispatcher } from '../application/createRequestDispatcher.js';
import { openSurfaceOffer } from '../application/openSurfaceOffer.js';
import { surfaceOfferFrame } from '../application/surfaceFanout.js';
import { createSurfaceOffers, type SurfaceOfferEvent } from './surfaceOffers.js';
import { SurfaceBroker } from './surfaceBroker.js';
import { createPreviewLeases } from './previewLeases.js';
import { createPreviewEndpoints } from './previewEndpoint.js';
import { PREVIEW_ADMISSION_COOKIE, startPreviewGateway } from './previewGateway.js';
import WebSocket, { WebSocketServer } from 'ws';
import { PluginApprovals, attachmentsInvalidationFrame, pluginCatalogChange, type SessionSource } from '../../agent/index.js';
import { isPluginsInvalidatedFrame } from '@muxr/contract';

const WORKTREE = join(mkdtempSync(join(tmpdir(), 'muxr-surface-')), 'repo');
/** The repository root, for the bundled plugin manifests. */
const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
// Broker context is resolved through canonical realpaths, so the tree
// roots used here must exist on disk exactly as a live herd reports them.
mkdirSync(WORKTREE, { recursive: true });
mkdirSync(join(WORKTREE, 'apps', 'web'), { recursive: true });

interface PaneSpec {
    paneId: string;
    sessionId?: string;
    cwd?: string;
}

function treeWith(panes: PaneSpec[]): { workspaces: HerdrTreeWorkspace[]; connected: boolean } {
    return {
        connected: true,
        workspaces: [{
            workspaceId: 'w1',
            label: 'repo',
            focused: true,
            agentStatus: 'idle',
            worktree: { repo: 'repo', path: WORKTREE },
            tabs: [{
                tabId: 'w1:t1',
                label: 'tab',
                focused: true,
                agentStatus: 'idle',
                panes: panes.map((pane) => ({
                    paneId: pane.paneId,
                    tabId: 'w1:t1',
                    agentStatus: 'idle' as const,
                    promptable: true,
                    focused: pane.paneId === 'w1:p1',
                    ...(pane.cwd === undefined ? {} : { cwd: pane.cwd }),
                    ...(pane.sessionId === undefined ? {} : { sessionId: pane.sessionId }),
                })),
            }],
        }],
    };
}

function summaries(
    browserApproved: boolean,
    browserIds: string[] = ['muxr.browser'],
    approvedFor: (pluginId: string) => boolean = (pluginId) => (pluginId === 'muxr.browser' ? browserApproved : true),
    manifestHashFor: (pluginId: string) => string = () => 'h1',
): PluginSummary[] {
    const entries: PluginSummary[] = browserIds.map((pluginId) => ({
        pluginId,
        name: pluginId,
        version: '0.1.0',
        source: { kind: 'local' },
        manifestHash: manifestHashFor(pluginId),
        approved: approvedFor(pluginId),
        capabilities: { 'surface.browser.open': 'describe' },
        hasBackend: true,
        herdrBackend: false,
        warnings: [],
    }));
    if (browserIds.length > 0) {
        entries.push({
            pluginId: 'muxr.code',
            name: 'muxr.code',
            version: '0.1.0',
            source: { kind: 'local' },
            manifestHash: manifestHashFor('muxr.code'),
            approved: approvedFor('muxr.code'),
            capabilities: { 'surface.code.open': 'files.read' },
            hasBackend: true,
            herdrBackend: false,
            warnings: [],
        });
    }
    return entries;
}

function fakeSource(options: { panes?: PaneSpec[]; approved?: boolean; plugins?: string[] } = {}): SessionSource {
    const panes = options.panes ?? [{ paneId: 'w1:p1', sessionId: 'route-1', cwd: WORKTREE }];
    const approved = options.approved ?? true;
    const plugins = options.plugins ?? ['muxr.browser'];
    return {
        async herdrTree() {
            return treeWith(panes);
        },
        async pluginList() {
            return summaries(approved, plugins);
        },
    } as unknown as SessionSource;
}

const claimantsFor = (ids: string[]) => async (capability: SurfaceCapability): Promise<string[]> => {
    if (capability === 'surface.browser.open') return [...ids];
    if (capability === 'surface.code.open') return ['muxr.code'];
    return [];
};

function dispatcherFor(
    source: SessionSource,
    offers: ReturnType<typeof createSurfaceOffers>,
    preview?: Pick<Parameters<typeof createRequestDispatcher>[0], 'previewEndpoints' | 'previewGateway'>,
) {
    const grants = new Set(['control-device']);
    return createRequestDispatcher({
        source,
        domain: {} as never,
        machineId: 'm1',
        hostVersion: '0.0.0',
        relayUrl: 'ws://relay.test',
        surfaceAuthority: (deviceId: string) => grants.has(deviceId),
        surfaceOffers: offers,
        ...preview,
    });
}

/** One raw HTTP exchange against the gateway under a public Host header. */
function fetchVia(port: number, host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
    return new Promise((resolvePromise, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port, method: init.method ?? 'GET', path, headers: { host, ...init.headers }, agent: false }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(init.body);
    });
}

const LOCAL_OFFER = {
    kind: 'browser-local',
    capability: 'surface.browser.open',
    name: 'app',
    port: 4317,
    label: 'App',
    context: WORKTREE,
    provider: 'muxr.browser',
} as const;

describe('slice 2A surface contract', () => {
    it('leases a session-bound Browser offer by handle with host-owned endpoint state', async () => {
        const source = fakeSource();
        const offers = createSurfaceOffers();
        const events: SurfaceOfferEvent[] = [];
        offers.onEvent = (event) => events.push(event);
        const { dispatch } = dispatcherFor(source, offers);

        const record = await openSurfaceOffer(
            {
                offers,
                snapshot: async () => 'muxr.browser:h1',
                claimants: claimantsFor(['muxr.browser']),
            },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        expect(record.offer.kind).toBe('browser-local');
        expect(record.sessionId).toBe('route-1');
        expect(events.map((event) => event.operation)).toEqual(['open']);

        const leased = await dispatch({
            type: 'preview.lease',
            requestId: 'lease-1',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
        expect(leased.ok).toBe(true);

        // The lease resolves the endpoint from the offer table, so quoting a
        // forged port, provider or context alongside the handle buys nothing.
        for (const forged of [
            { kind: 'browser', access: 'product', offer: record.handle, port: 9999 },
            { kind: 'browser', access: 'product', offer: record.handle, provider: 'evil.browser' },
            { kind: 'browser', access: 'product', offer: record.handle, context: '/elsewhere' },
            { kind: 'browser', access: 'product', port: 4317, provider: 'muxr.browser', context: WORKTREE },
        ]) {
            const refused = await dispatch({
                type: 'preview.lease',
                requestId: `forged-${JSON.stringify(forged).length}`,
                params: forged,
            } as never, 'control-device');
            expect(refused.ok).toBe(false);
        }

        // A replaced offer (same name and session, new target) kills the old handle.
        const updated = await openSurfaceOffer(
            {
                offers,
                snapshot: async () => 'muxr.browser:h1',
                claimants: claimantsFor(['muxr.browser']),
            },
            { offer: { ...LOCAL_OFFER, port: 4321 }, context: WORKTREE, sessionId: 'route-1' },
        );
        expect(updated.revision).toBe(record.revision + 1);
        expect(events.map((event) => event.operation)).toEqual(['open', 'update']);
        expect(await dispatch({
            type: 'preview.lease',
            requestId: 'stale',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device')).toMatchObject({ ok: false });

        // Closing the name kills the replacement handle too.
        offers.close('app', WORKTREE, 'route-1');
        expect(events.map((event) => event.operation)).toEqual(['open', 'update', 'close']);
        expect(await dispatch({
            type: 'preview.lease',
            requestId: 'closed',
            params: { kind: 'browser', access: 'product', offer: updated.handle },
        } as never, 'control-device')).toMatchObject({ ok: false });
    });

    it('leases only what the receiving device approved, and revocation changes standing', async () => {
        let approved = true;
        const source = fakeSource();
        const baseList = source.pluginList.bind(source);
        source.pluginList = (async () => {
            const listed = await baseList('control-device');
            return listed.map((plugin) => ({ ...plugin, approved: plugin.pluginId === 'muxr.browser' ? approved : plugin.approved }));
        }) as SessionSource['pluginList'];
        const offers = createSurfaceOffers();
        const { dispatch } = dispatcherFor(source, offers);
        const record = await openSurfaceOffer(
            {
                offers,
                snapshot: async () => 'muxr.browser:h1',
                claimants: claimantsFor(['muxr.browser']),
            },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );

        const granted = await dispatch({
            type: 'preview.lease',
            requestId: 'approved',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
        expect(granted.ok).toBe(true);

        // The device revokes the provider. No new lease names it anymore, and
        // the held tunnel no longer stands under its snapshot: attaching
        // reports the changed snapshot instead of opening the tunnel.
        approved = false;
        expect(await dispatch({
            type: 'preview.lease',
            requestId: 'revoked',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device')).toMatchObject({ ok: false });
        const attach = await dispatch({
            type: 'preview.attach',
            requestId: 'revoked-attach',
            params: { channel: 'c1', lease: granted.data!.lease, key: 'k' },
        } as never, 'control-device') as { ok: boolean; error?: string };
        expect(attach.ok).toBe(false);
        expect(String(attach.error)).toMatch(/snapshot changed/);
    });

    it('renews a held product lease and its offer from an authenticated holder', async () => {
        const source = fakeSource();
        const offers = createSurfaceOffers();
        const events: SurfaceOfferEvent[] = [];
        offers.onEvent = (event) => events.push(event);
        const { dispatch } = dispatcherFor(source, offers);
        const record = await openSurfaceOffer(
            {
                offers,
                snapshot: async () => 'muxr.browser:h1',
                claimants: claimantsFor(['muxr.browser']),
            },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const granted = await dispatch({
            type: 'preview.lease',
            requestId: 'renew-lease',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string; expiresAt: number } };
        expect(granted.ok).toBe(true);

        // Authenticated renewal from the holding device reports the live
        // expiry and re-emits the exact offer; the phone adopts the later
        // expiry instead of sweeping the selected surface.
        const renewed = await dispatch({
            type: 'preview.renew',
            requestId: 'renew-1',
            params: { lease: granted.data!.lease },
        } as never, 'control-device') as { ok: boolean; data?: { expiresAt: number } };
        expect(renewed.ok).toBe(true);
        expect(typeof renewed.data?.expiresAt).toBe('number');
        expect(events.map((event) => event.operation)).toEqual(['open']);

        // Another device cannot renew this lease, and closing the offer ends
        // renewal with it.
        expect(await dispatch({
            type: 'preview.renew',
            requestId: 'renew-foreign',
            params: { lease: granted.data!.lease },
        } as never, 'peer-device')).toMatchObject({ ok: false });
        offers.close('app', WORKTREE, 'route-1');
        expect(await dispatch({
            type: 'preview.renew',
            requestId: 'renew-closed',
            params: { lease: granted.data!.lease },
        } as never, 'control-device')).toMatchObject({ ok: false });
    });

    it('requires a connected, reconciled herd session on every renew', async () => {
        // The stored offer record still names route-1 in both cases: only
        // the live herd read can tell a terminated session, or a cached
        // disconnected tree, from a live one. Disconnect denies without
        // granting anything from cache.
        const source = fakeSource();
        const offers = createSurfaceOffers();
        const { dispatch } = dispatcherFor(source, offers);
        const record = await openSurfaceOffer(
            {
                offers,
                snapshot: async () => 'muxr.browser:h1',
                claimants: claimantsFor(['muxr.browser']),
            },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const granted = await dispatch({
            type: 'preview.lease',
            requestId: 'renew-lease',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
        expect(granted.ok).toBe(true);
        const renew = () => dispatch({
            type: 'preview.renew',
            requestId: 'renew-x',
            params: { lease: granted.data!.lease },
        } as never, 'control-device') as Promise<{ ok: boolean }>;
        expect((await renew()).ok).toBe(true);

        // A disconnected tree is fail closed: the pane is still listed but
        // cached state authorizes nothing, so renewal is denied and the
        // lease ends. Reconnecting does not revive it; a fresh attach
        // reconciles instead.
        const baseTree = source.herdrTree.bind(source);
        source.herdrTree = (async () => {
            const tree = await baseTree();
            return { ...tree, connected: false };
        }) as SessionSource['herdrTree'];
        expect((await renew()).ok).toBe(false);
        source.herdrTree = baseTree as SessionSource['herdrTree'];
        expect((await renew()).ok).toBe(false);

        // Connected, the tree still lists the pane, but the session no
        // longer reconciles against live herd state: a fresh lease's
        // renewal refuses.
        const again = await dispatch({
            type: 'preview.lease',
            requestId: 'renew-lease-2',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
        expect(again.ok).toBe(true);
        source.status = (async () => {
            throw new Error('unknown session');
        }) as SessionSource['status'];
        expect((await dispatch({
            type: 'preview.renew',
            requestId: 'renew-y',
            params: { lease: again.data!.lease },
        } as never, 'control-device') as { ok: boolean }).ok).toBe(false);
    });

    it('denies standing and renewal that overlap a real approval revocation, with zero dial', async () => {
        // The composed probe that dialed once before: a standing check
        // starts while the real approval store is revoking (its
        // persistence still awaiting), reads the catalog, and would dial.
        // The store's own fence moves synchronously at the start of the
        // mutation and stays in flux until it settles: a check that starts
        // during it is denied outright, and one that captured its token
        // before the revocation started is denied afterwards -- zero dial,
        // no extension, the holder ended once the catalog reads false.
        const dataDir = mkdtempSync(join(tmpdir(), 'muxr-approvals-'));
        const approvals = new PluginApprovals(dataDir);
        await approvals.load();
        let listGate: (() => void) | undefined;
        const base = fakeSource();
        const source = {
            ...base,
            async pluginList(deviceId: string) {
                if (listGate === undefined) {
                    await new Promise<void>((resolve) => {
                        listGate = resolve;
                    });
                }
                return summaries(true, ['muxr.browser'], (pluginId) => approvals.has(deviceId, pluginId));
            },
            async pluginApprove({ deviceId, pluginId, approved }: { deviceId: string; pluginId: string; approved: boolean }) {
                await approvals.set(deviceId, pluginId, approved);
            },
            pluginApprovalRevision: (deviceId: string) => approvals.revision(deviceId),
        } as unknown as SessionSource;
        const offers = createSurfaceOffers();
        const grants = new Set(['control-device']);
        const leases = createPreviewLeases({
            machineId: 'm1',
            authorized: (deviceId) => grants.has(deviceId),
            snapshot: async (lease) => {
                const listed = await source.pluginList(lease.deviceId);
                return listed.filter((plugin) => plugin.approved).map((plugin) => `${plugin.pluginId}:${plugin.manifestHash}`).sort().join('|');
            },
            offerCurrent: (handle) => {
                const record = offers.resolve(handle);
                return { revision: record.offer.revision, sessionId: record.sessionId };
            },
            // The store's fence, exactly as the dispatcher composes it.
            authorityRevision: (lease) => {
                const fence = approvals.revision(lease.deviceId);
                return fence === undefined ? undefined : `${fence}`;
            },
            snapshotMs: 0,
        });
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            relayUrl: 'ws://relay.test',
            surfaceAuthority: (deviceId: string) => grants.has(deviceId),
            surfaceOffers: offers,
            previewLeases: leases,
        });
        listGate = () => {};
        const record = await openSurfaceOffer(
            { offers, snapshot: async () => 'muxr.browser:h1|muxr.code:h1', claimants: claimantsFor(['muxr.browser']) },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const granted = await dispatch({
            type: 'preview.lease',
            requestId: 'fence-lease',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
        expect(granted.ok).toBe(true);
        let closed = 0;
        leases.hold(granted.data!.lease, () => { closed += 1; });
        expect(await leases.standsLive(granted.data!.lease, 'control-device')).toBe(true);

        // Standing captured before the revocation, catalog read hanging;
        // the revocation starts (fence moves) and completes while the read
        // is pending; the read then answers the pre-revocation catalog.
        listGate = undefined;
        const pending = leases.standsLive(granted.data!.lease, 'control-device');
        await new Promise((resolve) => setTimeout(resolve, 10));
        const revoking = dispatch({
            type: 'plugin.approve',
            requestId: 'revoke',
            params: { pluginId: 'muxr.browser', manifestHash: 'h1', approved: false },
        } as never, 'control-device');
        // Fence in flux: a check starting now is denied without any read.
        expect(approvals.revision('control-device')).toBeUndefined();
        const during = leases.standsLive(granted.data!.lease, 'control-device');
        listGate!();
        await revoking;
        expect(await pending).toBe(false);
        expect(await during).toBe(false);
        expect(closed).toBe(1);
        expect(() => leases.resolve(granted.data!.lease, 'control-device')).toThrow(/unknown or has expired/);
        expect(approvals.revision('control-device')).toBe(2);

        // Established stream under a revocation whose persistence never
        // completes: approval is already false in memory, the fence stays
        // in flux. Revalidation closes the exact current holder on its
        // first round, standing denies, renew denies -- forwarding stops
        // without waiting for persistence. Ten rounds close it once.
        await approvals.set('control-device', 'muxr.browser', true);
        const again = await dispatch({
            type: 'preview.lease',
            requestId: 'fence-lease-2',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
        expect(again.ok).toBe(true);
        let streamClosed = 0;
        const claim = leases.claim(again.data!.lease, 'control-device');
        expect(leases.settle(claim, () => { streamClosed += 1; })).toBe(true);
        expect(await leases.standsLive(again.data!.lease, 'control-device')).toBe(true);
        let persistGate: (() => void) | undefined;
        (approvals as unknown as { persist: () => Promise<void> }).persist = () => new Promise<void>((resolve) => {
            persistGate = resolve;
        });
        const stuck = approvals.set('control-device', 'muxr.browser', false);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(approvals.has('control-device', 'muxr.browser')).toBe(false);
        expect(approvals.revision('control-device')).toBeUndefined();
        for (let round = 0; round < 10; round += 1) await leases.revalidate();
        expect(streamClosed).toBe(1);
        expect(await leases.standsLive(again.data!.lease, 'control-device')).toBe(false);
        await expect(leases.renew(again.data!.lease, 'control-device')).rejects.toThrow(/no longer open|unknown or has expired/);
        expect(leases.size()).toBe(0);
        persistGate!();
        await stuck;
    });

    it('ends the Browser holder in the mutation-start callback while a catalog read is pending, never an unrelated one', async () => {
        // Astra's production reproduction: a revalidation is awaiting a
        // paused catalog read when the Browser provider is revoked. The
        // approval store announces the mutation synchronously at its
        // start; the dispatcher routes it to the registry, which ends the
        // exact current holder in the same event turn -- before the read
        // resolves, before persistence, before any private byte. An
        // unrelated plugin's mutation ends nothing; a successor issued
        // afterwards is untouched by later unrelated mutations.
        const approvals = new PluginApprovals(mkdtempSync(join(tmpdir(), 'muxr-approvals-')));
        await approvals.load();
        const manifestHashes = new Map<string, string>();
        let listGate: (() => void) | undefined;
        const base = fakeSource();
        const source = {
            ...base,
            async pluginList(deviceId: string) {
                if (listGate === undefined) {
                    await new Promise<void>((resolve) => {
                        listGate = resolve;
                    });
                }
                return summaries(true, ['muxr.browser'], (pluginId) => approvals.has(deviceId, pluginId), (pluginId) => manifestHashes.get(pluginId) ?? 'h1');
            },
            async pluginApprove({ deviceId, pluginId, approved }: { deviceId: string; pluginId: string; approved: boolean }) {
                await approvals.set(deviceId, pluginId, approved);
            },
            pluginApprovalRevision: (deviceId: string, pluginId?: string) => approvals.revision(deviceId, pluginId),
            onPluginApprovalMutation: (listener: (deviceId: string, pluginId: string) => void) => approvals.onMutation(listener),
        } as unknown as SessionSource;
        const offers = createSurfaceOffers();
        const grants = new Set(['control-device']);
        const leases = createPreviewLeases({
            machineId: 'm1',
            authorized: (deviceId) => grants.has(deviceId),
            snapshot: async (lease) => {
                const listed = await source.pluginList(lease.deviceId);
                return listed.filter((plugin) => plugin.approved).map((plugin) => `${plugin.pluginId}:${plugin.manifestHash}`).sort().join('|');
            },
            offerCurrent: (handle) => {
                const record = offers.resolve(handle);
                return { revision: record.offer.revision, sessionId: record.sessionId };
            },
            authorityRevision: (lease) => {
                const fence = approvals.revision(lease.deviceId, lease.provider);
                return fence === undefined ? undefined : `${fence}`;
            },
            snapshotMs: 0,
        });
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            relayUrl: 'ws://relay.test',
            surfaceAuthority: (deviceId: string) => grants.has(deviceId),
            surfaceOffers: offers,
            previewLeases: leases,
        });
        listGate = () => {};
        const record = await openSurfaceOffer(
            { offers, snapshot: async () => 'muxr.browser:h1|muxr.code:h1', claimants: claimantsFor(['muxr.browser']) },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const lease = async () => {
            const granted = await dispatch({
                type: 'preview.lease',
                requestId: 'hook-lease',
                params: { kind: 'browser', access: 'product', offer: record.handle },
            } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
            expect(granted.ok).toBe(true);
            return granted.data!.lease;
        };
        const first = await lease();
        let closed = 0;
        expect(leases.settle(leases.claim(first, 'control-device'), () => { closed += 1; })).toBe(true);
        expect(await leases.standsLive(first, 'control-device')).toBe(true);

        // Catalog read paused with a revalidation awaiting it.
        listGate = undefined;
        const revalidating = leases.revalidate();
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Unrelated plugin mutation: the Browser holder stands.
        const unrelated = dispatch({
            type: 'plugin.approve',
            requestId: 'revoke-code',
            params: { pluginId: 'muxr.code', manifestHash: 'h1', approved: false },
        } as never, 'control-device');
        expect(closed).toBe(0);
        expect(approvals.revision('control-device', 'muxr.browser')).toBe(0);
        // Browser provider revoked: ended in the same event turn, with the
        // catalog read still paused and persistence not yet started.
        const revoking = dispatch({
            type: 'plugin.approve',
            requestId: 'revoke-browser',
            params: { pluginId: 'muxr.browser', manifestHash: 'h1', approved: false },
        } as never, 'control-device');
        expect(closed).toBe(1);
        expect(() => leases.resolve(first, 'control-device')).toThrow(/unknown or has expired/);
        listGate!();
        await Promise.all([unrelated, revoking, revalidating]);
        expect(closed).toBe(1);

        // Successor after re-approval: later unrelated mutations never
        // touch it, and the fence is per (device, provider).
        await approvals.set('control-device', 'muxr.browser', true);
        const successor = await lease();
        let successorClosed = 0;
        expect(leases.settle(leases.claim(successor, 'control-device'), () => { successorClosed += 1; })).toBe(true);
        await dispatch({
            type: 'plugin.approve',
            requestId: 'toggle-code',
            params: { pluginId: 'muxr.code', manifestHash: 'h1', approved: true },
        } as never, 'control-device');
        await leases.revalidate();
        expect(successorClosed).toBe(0);
        expect(await leases.standsLive(successor, 'control-device')).toBe(true);

        // Astra's follow-up: with Code actually revoked in the catalog the
        // Browser holder still stands through revalidation, standing, and
        // renew -- the lease compares the exact provider's identity, not
        // the whole approved digest. A redundant re-approve of Browser is
        // not a mutation and ends nothing.
        await dispatch({
            type: 'plugin.approve',
            requestId: 'revoke-code-again',
            params: { pluginId: 'muxr.code', manifestHash: 'h1', approved: false },
        } as never, 'control-device');
        for (let round = 0; round < 3; round += 1) await leases.revalidate();
        expect(successorClosed).toBe(0);
        expect(await leases.standsLive(successor, 'control-device')).toBe(true);
        await dispatch({
            type: 'plugin.approve',
            requestId: 'approve-browser-again',
            params: { pluginId: 'muxr.browser', manifestHash: 'h1', approved: true },
        } as never, 'control-device');
        expect(successorClosed).toBe(0);
        expect((await dispatch({
            type: 'preview.renew',
            requestId: 'renew-successor',
            params: { lease: successor },
        } as never, 'control-device') as { ok: boolean }).ok).toBe(true);

        // A second device holds its own Browser lease: a revocation for
        // the first device closes only the first device's holder.
        grants.add('other-device');
        const otherGranted = await dispatch({
            type: 'preview.lease',
            requestId: 'other-lease',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'other-device') as { ok: boolean; data?: { lease: string } };
        expect(otherGranted.ok).toBe(true);
        let otherClosed = 0;
        expect(leases.settle(leases.claim(otherGranted.data!.lease, 'other-device'), () => { otherClosed += 1; })).toBe(true);
        await dispatch({
            type: 'plugin.approve',
            requestId: 'revoke-browser-first',
            params: { pluginId: 'muxr.browser', manifestHash: 'h1', approved: false },
        } as never, 'control-device');
        expect(successorClosed).toBe(1);
        expect(otherClosed).toBe(0);
        await leases.revalidate();
        expect(otherClosed).toBe(0);
        expect(await leases.standsLive(otherGranted.data!.lease, 'other-device')).toBe(true);

        // The Browser provider's manifest changes: the other device's
        // holder ends on the next revalidation; an unrelated manifest
        // change (Code) does not.
        manifestHashes.set('muxr.code', 'h2');
        await leases.revalidate();
        expect(otherClosed).toBe(0);
        manifestHashes.set('muxr.browser', 'h2');
        await leases.revalidate();
        expect(otherClosed).toBe(1);
    });

    it('orders approval writes per provider: a queued revoke behind a pending enable wins and fences leases', async () => {
        // Astra's probe: Browser enable queued behind another plugin's
        // pending persistence, then Browser revoke while the stored value
        // is still false. The revoke is pending authority, not a stale
        // no-op: the fence reads in flux from enqueue, no lease is issued
        // meanwhile, the enable applies first, the revoke fires its
        // mutation-start invalidation and commits last -- final false.
        const approvals = new PluginApprovals(mkdtempSync(join(tmpdir(), 'muxr-approvals-')));
        await approvals.load();
        await approvals.set('control-device', 'muxr.browser', false);
        const mutations: string[] = [];
        approvals.onMutation((deviceId, pluginId) => mutations.push(`${deviceId}:${pluginId}`));
        const base = fakeSource();
        const source = {
            ...base,
            async pluginList(deviceId: string) {
                return summaries(true, ['muxr.browser'], (pluginId) => approvals.has(deviceId, pluginId));
            },
            async pluginApprove({ deviceId, pluginId, approved }: { deviceId: string; pluginId: string; approved: boolean }) {
                await approvals.set(deviceId, pluginId, approved);
            },
            pluginApprovalRevision: (deviceId: string, pluginId?: string) => approvals.revision(deviceId, pluginId),
            onPluginApprovalMutation: (listener: (deviceId: string, pluginId: string) => void) => approvals.onMutation(listener),
        } as unknown as SessionSource;
        const offers = createSurfaceOffers();
        const { dispatch } = dispatcherFor(source, offers);
        const record = await openSurfaceOffer(
            { offers, snapshot: async () => 'muxr.browser:h1|muxr.code:h1', claimants: claimantsFor(['muxr.browser']) },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const lease = () => dispatch({
            type: 'preview.lease',
            requestId: 'queued-lease',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as Promise<{ ok: boolean; error?: string }>;

        // Another plugin's persistence is paused: the global write queue
        // holds every later persist behind it.
        let persistGate: (() => void) | undefined;
        const realPersist = (approvals as unknown as { persist: () => Promise<void> }).persist.bind(approvals);
        (approvals as unknown as { persist: () => Promise<void> }).persist = () => new Promise<void>((resolve) => {
            persistGate = resolve;
        });
        const unrelated = approvals.set('control-device', 'muxr.code', false);
        await new Promise((resolve) => setTimeout(resolve, 10));
        (approvals as unknown as { persist: () => Promise<void> }).persist = realPersist;
        const enable = approvals.set('control-device', 'muxr.browser', true);
        const revoke = approvals.set('control-device', 'muxr.browser', false);
        // Pending authority: no lease is issued while the pair is in flux.
        expect(approvals.revision('control-device', 'muxr.browser')).toBeUndefined();
        expect((await lease()).ok).toBe(false);
        persistGate!();
        await Promise.all([unrelated, enable, revoke]);
        expect(approvals.has('control-device', 'muxr.browser')).toBe(false);
        expect(mutations).toEqual(['control-device:muxr.code', 'control-device:muxr.browser', 'control-device:muxr.browser']);
        expect(approvals.revision('control-device', 'muxr.browser')).toBe(6);
        const refused = await lease();
        expect(refused.ok).toBe(false);
        expect(refused.error).toMatch(/not approved/);
    });

    it('moves the Browser token on relevant or full catalog invalidation during a paused admission, never on an unrelated one', async () => {
        // Astra's probe: admission read the old manifest, a relevant
        // plugins.invalidated frame lands while the session read is
        // paused, then the read resolves. The provider generation is part
        // of the token, advanced synchronously by the frame -- zero dial,
        // and the old holder ends at the invalidation hook. An unrelated
        // provider's frame, the attachments watcher's own named frame,
        // and the empty informational frame leave the Browser token and
        // holder untouched.
        let machineListener: ((frame: { type: string; reason: string; pluginIds: string[] }) => void) | undefined;
        let sessionGate: (() => void) | undefined;
        const base = fakeSource();
        const source = {
            ...base,
            subscribeMachine: (listener: typeof machineListener) => {
                machineListener = listener;
                return () => {};
            },
            status: async () => {
                if (sessionGate !== undefined) return { state: 'idle' };
                await new Promise<void>((resolve) => {
                    sessionGate = resolve;
                });
                return { state: 'idle' };
            },
        } as unknown as SessionSource;
        const offers = createSurfaceOffers();
        const grants = new Set(['control-device']);
        const leases = createPreviewLeases({
            machineId: 'm1',
            authorized: (deviceId) => grants.has(deviceId),
            snapshot: async () => 'muxr.browser:h1|muxr.code:h1',
            offerCurrent: (handle) => {
                const record = offers.resolve(handle);
                return { revision: record.offer.revision, sessionId: record.sessionId };
            },
            sessionLive: async (sessionId) => {
                await source.status(sessionId);
                return true;
            },
            snapshotMs: 0,
        });
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            relayUrl: 'ws://relay.test',
            surfaceAuthority: (deviceId: string) => grants.has(deviceId),
            surfaceOffers: offers,
            previewLeases: leases,
        });
        expect(machineListener).toBeDefined();
        sessionGate = () => {};
        const record = await openSurfaceOffer(
            { offers, snapshot: async () => 'muxr.browser:h1|muxr.code:h1', claimants: claimantsFor(['muxr.browser']) },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const lease = async () => {
            const granted = await dispatch({
                type: 'preview.lease',
                requestId: 'gen-lease',
                params: { kind: 'browser', access: 'product', offer: record.handle },
            } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
            expect(granted.ok).toBe(true);
            return granted.data!.lease;
        };
        const first = await lease();
        let closed = 0;
        expect(leases.settle(leases.claim(first, 'control-device'), () => { closed += 1; })).toBe(true);

        // Unrelated provider invalidation during a paused admission: token
        // unchanged, holder untouched, standing true once the read lands.
        sessionGate = undefined;
        const pending = leases.standsLive(first, 'control-device');
        await new Promise((resolve) => setTimeout(resolve, 10));
        machineListener!({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['muxr.code'] });
        expect(closed).toBe(0);
        sessionGate!();
        expect(await pending).toBe(true);
        expect(closed).toBe(0);

        // Relevant invalidation during a paused admission: the holder ends
        // at the hook, synchronously, and the admission answers false.
        sessionGate = undefined;
        const relevant = leases.standsLive(first, 'control-device');
        await new Promise((resolve) => setTimeout(resolve, 10));
        machineListener!({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['muxr.browser'] });
        expect(closed).toBe(1);
        sessionGate!();
        expect(await relevant).toBe(false);

        // The attachments watcher's own frame (an agent dropped a file) and
        // the empty informational reconnect frame: neither moves authority
        // nor ends a Browser holder; standing stays true.
        const second = await lease();
        let secondClosed = 0;
        expect(leases.settle(leases.claim(second, 'control-device'), () => { secondClosed += 1; })).toBe(true);
        sessionGate = undefined;
        const informational = leases.standsLive(second, 'control-device');
        await new Promise((resolve) => setTimeout(resolve, 10));
        // The exact frame the host's attachment watcher publishes, from the
        // bundled plugin manifest.
        const attachmentsFrame = attachmentsInvalidationFrame(join(WORKTREE_ROOT, 'plugins'))!;
        expect(attachmentsFrame.pluginIds).toEqual(['muxr.attachments']);
        expect(isPluginsInvalidatedFrame(attachmentsFrame)).toBe(true);
        machineListener!(attachmentsFrame);
        machineListener!({ type: 'plugins.invalidated', reason: 'changed', pluginIds: [] });
        expect(secondClosed).toBe(0);
        sessionGate!();
        expect(await informational).toBe(true);
        await leases.revalidate();
        expect(secondClosed).toBe(0);
        expect(await leases.standsLive(second, 'control-device')).toBe(true);

        // The composed token on the dispatcher's own registry: a renew
        // awaiting its paused session read is denied by a relevant or
        // full invalidation that lands meanwhile, and untouched by an
        // unrelated one.
        let tokenListener: typeof machineListener;
        let tokenGate: (() => void) | undefined;
        const tokenSource = {
            ...base,
            subscribeMachine: (listener: typeof machineListener) => {
                tokenListener = listener;
                return () => {};
            },
            status: async () => {
                if (tokenGate !== undefined) return { state: 'idle' };
                await new Promise<void>((resolve) => {
                    tokenGate = resolve;
                });
                return { state: 'idle' };
            },
        } as unknown as SessionSource;
        const tokenOffers = createSurfaceOffers();
        const owned = dispatcherFor(tokenSource, tokenOffers);
        const tokenRecord = await openSurfaceOffer(
            { offers: tokenOffers, snapshot: async () => 'muxr.browser:h1|muxr.code:h1', claimants: claimantsFor(['muxr.browser']) },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        tokenGate = () => {};
        const tokenLease = await owned.dispatch({
            type: 'preview.lease',
            requestId: 'token-lease',
            params: { kind: 'browser', access: 'product', offer: tokenRecord.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
        expect(tokenLease.ok).toBe(true);
        const renew = () => owned.dispatch({
            type: 'preview.renew',
            requestId: 'token-renew',
            params: { lease: tokenLease.data!.lease },
        } as never, 'control-device') as Promise<{ ok: boolean }>;
        tokenGate = undefined;
        const unrelatedRenew = renew();
        await new Promise((resolve) => setTimeout(resolve, 10));
        tokenListener!({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['muxr.code'] });
        tokenGate!();
        expect((await unrelatedRenew).ok).toBe(true);
        tokenGate = undefined;
        const informationalRenew = renew();
        await new Promise((resolve) => setTimeout(resolve, 10));
        tokenListener!(attachmentsInvalidationFrame(join(WORKTREE_ROOT, 'plugins'))!);
        tokenListener!({ type: 'plugins.invalidated', reason: 'changed', pluginIds: [] });
        tokenGate!();
        expect((await informationalRenew).ok).toBe(true);
        tokenGate = undefined;
        const relevantRenew = renew();
        await new Promise((resolve) => setTimeout(resolve, 10));
        tokenListener!({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['muxr.browser'] });
        tokenGate!();
        expect((await relevantRenew).ok).toBe(false);
    });

    it('fences a bulk catalog change (33 entries including the Browser provider) that the wire frame cannot name', async () => {
        // Astra's probe: admission read the old manifest and is paused on
        // its session read; 33 plugins change at once, the Browser
        // provider among them. The bounded wire frame must omit ids
        // (informational), so authority is fed by the catalog diff owner
        // directly with the complete changed set, before that frame goes
        // out: the established holder ends immediately, the paused
        // admission answers false -- zero dial. The same bulk change
        // without the Browser provider leaves it untouched.
        let catalogListener: ((changed: readonly string[]) => void) | undefined;
        let machineListener: ((frame: { type: string; reason: string; pluginIds: string[] }) => void) | undefined;
        let sessionGate: (() => void) | undefined;
        const base = fakeSource();
        const source = {
            ...base,
            onPluginCatalogChange: (listener: typeof catalogListener) => {
                catalogListener = listener;
                return () => {};
            },
            subscribeMachine: (listener: typeof machineListener) => {
                machineListener = listener;
                return () => {};
            },
            status: async () => {
                if (sessionGate !== undefined) return { state: 'idle' };
                await new Promise<void>((resolve) => {
                    sessionGate = resolve;
                });
                return { state: 'idle' };
            },
        } as unknown as SessionSource;
        const offers = createSurfaceOffers();
        const grants = new Set(['control-device']);
        const leases = createPreviewLeases({
            machineId: 'm1',
            authorized: (deviceId) => grants.has(deviceId),
            snapshot: async () => 'muxr.browser:h1|muxr.code:h1',
            offerCurrent: (handle) => {
                const record = offers.resolve(handle);
                return { revision: record.offer.revision, sessionId: record.sessionId };
            },
            sessionLive: async (sessionId) => {
                await source.status(sessionId);
                return true;
            },
            snapshotMs: 0,
        });
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            relayUrl: 'ws://relay.test',
            surfaceAuthority: (deviceId: string) => grants.has(deviceId),
            surfaceOffers: offers,
            previewLeases: leases,
        });
        expect(catalogListener).toBeDefined();
        sessionGate = () => {};
        const record = await openSurfaceOffer(
            { offers, snapshot: async () => 'muxr.browser:h1|muxr.code:h1', claimants: claimantsFor(['muxr.browser']) },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const lease = async () => {
            const granted = await dispatch({
                type: 'preview.lease',
                requestId: 'bulk-lease',
                params: { kind: 'browser', access: 'product', offer: record.handle },
            } as never, 'control-device') as { ok: boolean; data?: { lease: string } };
            expect(granted.ok).toBe(true);
            return granted.data!.lease;
        };
        // The actual catalog diff owner's output for 33 changed entries:
        // the complete set for authority, an empty informational wire frame.
        const bulk = (withBrowser: boolean) => {
            const before = new Map<string, string>();
            const after = new Map<string, string>();
            for (let index = 0; index < 32; index += 1) {
                before.set(`vendor.plugin-${index}`, 'a');
                after.set(`vendor.plugin-${index}`, 'b');
            }
            if (withBrowser) {
                before.set('muxr.browser', 'h1');
                after.set('muxr.browser', 'h2');
            } else {
                before.set('vendor.plugin-32', 'a');
                after.set('vendor.plugin-32', 'b');
            }
            const change = pluginCatalogChange(
                { digests: before, enabled: new Map() },
                { digests: after, enabled: new Map() },
            )!;
            expect(change.changed).toHaveLength(33);
            expect(change.frame.pluginIds).toEqual([]);
            return change;
        };
        const publish = (change: { changed: readonly string[]; frame: { type: string; reason: string; pluginIds: string[] } }) => {
            catalogListener!(change.changed);
            machineListener!(change.frame);
        };

        const first = await lease();
        let closed = 0;
        expect(leases.settle(leases.claim(first, 'control-device'), () => { closed += 1; })).toBe(true);
        // Bulk change without the Browser provider: untouched.
        sessionGate = undefined;
        const unrelated = leases.standsLive(first, 'control-device');
        await new Promise((resolve) => setTimeout(resolve, 10));
        publish(bulk(false));
        expect(closed).toBe(0);
        sessionGate!();
        expect(await unrelated).toBe(true);
        // Bulk change including the Browser provider during the paused
        // admission: holder ended at the authoritative hook, zero dial.
        sessionGate = undefined;
        const relevant = leases.standsLive(first, 'control-device');
        await new Promise((resolve) => setTimeout(resolve, 10));
        publish(bulk(true));
        expect(closed).toBe(1);
        expect(() => leases.resolve(first, 'control-device')).toThrow(/unknown or has expired/);
        sessionGate!();
        expect(await relevant).toBe(false);
    });

    it('denies a renew awaiting across a herd session event or an approval write', async () => {
        // The dispatcher owns the authority tokens: a session event the
        // herd publishes for the lease's session, or an approval write
        // through plugin.approve, moves the token while a renew is still
        // awaiting its status read -- and the renew is denied without
        // extension, however the reads answered.
        let listener: ((sessionId: string, event: { type: string }) => void) | undefined;
        let statusGate: (() => void) | undefined;
        const base = fakeSource();
        const source = {
            ...base,
            subscribe: (next: typeof listener) => {
                listener = next;
                return () => {};
            },
            status: async () => {
                if (statusGate !== undefined) return { state: 'idle' };
                await new Promise<void>((resolve) => {
                    statusGate = resolve;
                });
                return { state: 'idle' };
            },
        } as unknown as SessionSource;
        const offers = createSurfaceOffers();
        const { dispatch } = dispatcherFor(source, offers);
        const record = await openSurfaceOffer(
            { offers, snapshot: async () => 'muxr.browser:h1', claimants: claimantsFor(['muxr.browser']) },
            { offer: { ...LOCAL_OFFER }, context: WORKTREE, sessionId: 'route-1' },
        );
        const granted = await dispatch({
            type: 'preview.lease',
            requestId: 'token-lease',
            params: { kind: 'browser', access: 'product', offer: record.handle },
        } as never, 'control-device') as { ok: boolean; data?: { lease: string; expiresAt: number } };
        expect(granted.ok).toBe(true);
        const renew = () => dispatch({
            type: 'preview.renew',
            requestId: 'token-renew',
            params: { lease: granted.data!.lease },
        } as never, 'control-device') as Promise<{ ok: boolean; data?: { expiresAt: number } }>;
        const pending = renew();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(listener).toBeDefined();
        listener!('route-1', { type: 'session.updated' });
        statusGate!();
        expect((await pending).ok).toBe(false);
        // Nothing ended: the next renew reads the owner's state fresh.
        expect((await renew()).ok).toBe(true);
    });

    it('never leases direct HTTPS or Code offers, and keeps the developer port path exact', async () => {
        const source = fakeSource();
        const offers = createSurfaceOffers();
        const { dispatch } = dispatcherFor(source, offers);

        const direct = await openSurfaceOffer(
            { offers, claimants: claimantsFor(['muxr.browser']) },
            {
                offer: { kind: 'browser-direct', capability: 'surface.browser.open', name: 'docs', url: 'https://example.com/guide', provider: 'muxr.browser' },
                context: 'device',
            },
        );
        const code = await openSurfaceOffer(
            { offers, claimants: claimantsFor(['muxr.browser']) },
            {
                offer: { kind: 'code-review', capability: 'surface.code.open', name: 'review', path: 'src/index.ts', line: 10, provider: 'muxr.code' },
                context: WORKTREE,
            },
        );
        expect(code.offer).toMatchObject({ mode: 'review', provider: 'muxr.code' });
        expect(direct.offer).toMatchObject({ provider: 'muxr.browser' });
        for (const handle of [direct.handle, code.handle]) {
            expect(await dispatch({
                type: 'preview.lease',
                requestId: `never-${handle.slice(0, 8)}`,
                params: { kind: 'browser', access: 'product', offer: handle },
            } as never, 'control-device')).toMatchObject({ ok: false });
        }

        // Direct and Code offers need a host-installed claimant behind them.
        await expect(openSurfaceOffer(
            { offers, claimants: claimantsFor([]) },
            {
                offer: { kind: 'browser-direct', capability: 'surface.browser.open', name: 'docs', url: 'https://example.com/', provider: 'muxr.browser' },
                context: 'device',
            },
        )).rejects.toThrow(/not enabled on this computer/);

        // There is no client surface path anymore: the required activation
        // is broker into a host-originated frame, so a phone that speaks
        // these types gets the contract-mismatch answer instead of injecting
        // offers into other controlling devices.
        for (const type of ['surface.offer', 'surface.list', 'surface.close']) {
            const answered = await dispatch({
                type,
                requestId: `gone-${type}`,
                params: {},
            } as never, 'control-device');
            expect(answered).toMatchObject({ ok: false, code: 'host-contract-mismatch' });
        }

        // Developer leases still take the operator-typed port, unchanged.
        const developer = await dispatch({
            type: 'preview.lease',
            requestId: 'dev',
            params: { kind: 'browser', access: 'developer', port: 4321 },
        } as never, 'control-device') as { ok: boolean };
        expect(developer.ok).toBe(true);
    });

    it('fans registry events out as bounded frames', () => {
        const offers = createSurfaceOffers();
        const frames: unknown[] = [];
        offers.onEvent = (event) => {
            const frame = surfaceOfferFrame(event);
            if (frame !== undefined) frames.push(frame);
        };
        const sessionless = offers.open(
            { kind: 'browser-direct', capability: 'surface.browser.open', name: 'docs', url: 'https://example.com/', provider: 'muxr.browser' },
            'device',
        );
        expect(sessionless.sessionId).toBeUndefined();
        const record = offers.open({ ...LOCAL_OFFER }, WORKTREE, 'route-1');
        offers.refresh(record.handle);
        offers.close('app', WORKTREE, 'route-1');
        // Sessionless records emit nothing; the rest round-trip the guard.
        expect(frames).toHaveLength(3);
        for (const frame of frames) expect(isSurfaceOfferHostFrame(frame)).toBe(true);
        expect(frames.map((frame) => (frame as { operation: string }).operation)).toEqual(['open', 'reload', 'close']);
        expect(frames[0]).toMatchObject({ handle: record.handle, sessionId: 'route-1', revision: 1 });
        expect(frames[0]).toMatchObject({ offer: { provider: 'muxr.browser', capability: 'surface.browser.open' } });
        expect(frames[2]).not.toHaveProperty('offer');
        expect(JSON.stringify(frames)).not.toMatch(/pane-|pp_|device|token|secret/i);
    });

    it('resolves broker context to the exact live session and providers generically, leaking no ids', async () => {
        const source = fakeSource();
        const broker = new SurfaceBroker({ dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')), source });
        const hints = { paneId: 'w1:p1', cwd: WORKTREE };

        const https = await broker.invoke({ method: 'browser.open', target: 'https://example.com/guide' }, hints) as {
            outcome: string;
            surface: Record<string, unknown>;
        };
        expect(https.outcome).toBe('accepted');
        expect(https.surface).toMatchObject({ name: 'browser', kind: 'browser-direct' });
        // The resolved provider stays on the host: a reply names the surface, never a plugin id.
        expect(https.surface).not.toHaveProperty('provider');
        expect(broker.registry.current('browser', WORKTREE, 'route-1')?.offer.provider).toBe('muxr.browser');
        expect(broker.registry.current('browser', WORKTREE, 'route-1')?.sessionId).toBe('route-1');

        const blank = await broker.invoke({ method: 'browser.open', target: 'about:blank', name: 'home' }, hints) as {
            outcome: string;
            surface: Record<string, unknown>;
        };
        expect(blank.outcome).toBe('accepted');

        const local = await broker.invoke({ method: 'browser.open', target: 'http://localhost:4317/app' }, hints) as {
            outcome: string;
            surface: Record<string, unknown>;
        };
        expect(local.outcome).toBe('accepted');
        expect(local.surface).toMatchObject({ path: '/app', context: WORKTREE, title: 'Local app /app' });
        // The port the operator typed resolves on the host and never comes back in a reply.
        expect(JSON.stringify(local.surface)).not.toMatch(/4317|muxr\.browser/);
        expect(broker.registry.current('browser', WORKTREE, 'route-1')?.offer).toMatchObject({ port: 4317, provider: 'muxr.browser' });

        // Reload re-emits the same revision as accepted, never visible: no
        // device acknowledgement exists yet.
        const reload = await broker.invoke({ method: 'browser.reload', name: 'browser' }, hints) as {
            outcome: string;
            surface: Record<string, unknown>;
        };
        expect(reload.outcome).toBe('accepted');
        expect(reload.surface).toMatchObject({ revision: local.surface.revision });

        const capabilities = await broker.invoke({ method: 'capabilities' }, hints) as {
            capabilities: { capability: string; available: boolean; ambiguous: boolean }[];
        };
        expect(capabilities.capabilities).toContainEqual({
            capability: 'surface.browser.open',
            available: true,
            ambiguous: false,
        });

        // Explicit claimant wins; stale pane, shell sessions and unknown
        // or ambiguous providers fail; traversal outside the worktree fails.
        await expect(broker.invoke({ method: 'browser.open', target: 'http://localhost:4317/app', provider: 'nope.browser' }, hints))
            .rejects.toThrow(/not enabled/);
        await expect(broker.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w9:p9' }))
            .rejects.toThrow(/no longer open/);
        await expect(broker.invoke({ method: 'code.open', target: '../outside.ts' }, hints))
            .rejects.toThrow(/outside/);
        await expect(broker.invoke({ method: 'browser.open', target: 'http://example.com/plain' }, hints))
            .rejects.toThrow(/HTTPS/);
        await expect(broker.invoke({ method: 'browser.open', target: 'https://user:pass@example.com/' }, hints))
            .rejects.toThrow(/credentials/);

        const shellBroker = new SurfaceBroker({
            dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')),
            source: fakeSource({ panes: [{ paneId: 'w1:p9', sessionId: 'shell:w1:p9', cwd: WORKTREE }] }),
        });
        await expect(shellBroker.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p9' }))
            .rejects.toThrow(/no live agent session/);

        const crowdedSource = fakeSource({ plugins: ['muxr.browser', 'a.browser', 'b.browser'] });
        const crowded = new SurfaceBroker({
            dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')),
            source: crowdedSource,
        });
        // Same cwd on two live panes is ambiguous and must fail.
        const twinSource = fakeSource({
            panes: [
                { paneId: 'w1:p1', sessionId: 'route-1', cwd: WORKTREE },
                { paneId: 'w1:p2', sessionId: 'route-2', cwd: WORKTREE },
            ],
        });
        const twins = new SurfaceBroker({
            dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')),
            source: twinSource,
        });
        await expect(twins.invoke({ method: 'browser.open', target: 'https://example.com/' }, { cwd: WORKTREE }))
            .rejects.toThrow(/more than one agent session/);
        // ...while the exact pane still resolves.
        const exact = await twins.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p2', cwd: WORKTREE }) as {
            outcome: string;
        };
        expect(exact.outcome).toBe('accepted');
        expect(twins.registry.current('browser', WORKTREE, 'route-2')?.sessionId).toBe('route-2');

        // A cwd hint naming a *different* live pane is a genuine conflict --
        // a moved or stale terminal must fail rather than open elsewhere.
        const movedSource = fakeSource({
            panes: [
                { paneId: 'w1:p1', sessionId: 'route-1', cwd: WORKTREE },
                { paneId: 'w1:p2', sessionId: 'route-2', cwd: '/elsewhere-live' },
            ],
        });
        const moved = new SurfaceBroker({
            dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')),
            source: movedSource,
        });
        await expect(moved.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p1', cwd: '/elsewhere-live' }))
            .rejects.toThrow(/moved/);
        // A cwd hint naming no live pane at all is still a conflict: a
        // stale or moved terminal fails rather than opening in the pane's
        // new repository. Compatibility launchers normalize context at
        // their own trusted boundary -- the Tools launch passes the
        // original live agent pane and runs with its cwd -- and never ask
        // the broker to retarget a hint.
        await expect(moved.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p1', cwd: '/plugin/root' }))
            .rejects.toThrow(/moved/);
        // An agreeing hint still opens exactly where the live pane stands.
        const actioned = await moved.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p1', cwd: WORKTREE }) as {
            outcome: string;
        };
        expect(actioned.outcome).toBe('accepted');
        expect(moved.registry.current('browser', WORKTREE, 'route-1')?.sessionId).toBe('route-1');

        // A real subdirectory of the session root keeps the pane's
        // context: an agent that `cd`s into a package and runs from there
        // is in the right terminal, not a moved one. The bound context
        // stays the session root, never the subdirectory.
        const subdir = join(WORKTREE, 'apps', 'web');
        const descended = await moved.invoke({ method: 'browser.open', target: 'https://example.com/', name: 'web' }, { paneId: 'w1:p1', cwd: subdir }) as {
            outcome: string;
        };
        expect(descended.outcome).toBe('accepted');
        expect(moved.registry.current('web', WORKTREE, 'route-1')?.sessionId).toBe('route-1');

        // Separator safety: a sibling prefix is not a descendant.
        const sibling = `${WORKTREE}-other`;
        await expect(moved.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p1', cwd: sibling }))
            .rejects.toThrow(/moved/);

        // Symlink escape: a link inside the root pointing outside resolves
        // outside and fails; a link to an inside directory resolves inside
        // and keeps the pane context.
        const outside = mkdtempSync(join(tmpdir(), 'muxr-surface-outside-'));
        const escapeLink = join(WORKTREE, 'escape');
        try { symlinkSync(outside, escapeLink); } catch { /* already linked */ }
        await expect(moved.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p1', cwd: escapeLink }))
            .rejects.toThrow(/moved/);
        const innerLink = join(WORKTREE, 'web-link');
        try { symlinkSync(subdir, innerLink); } catch { /* already linked */ }
        const linked = await moved.invoke({ method: 'browser.open', target: 'https://example.com/', name: 'linked' }, { paneId: 'w1:p1', cwd: innerLink }) as {
            outcome: string;
        };
        expect(linked.outcome).toBe('accepted');
        expect(moved.registry.current('linked', WORKTREE, 'route-1')?.sessionId).toBe('route-1');

        // A pane that has moved outside its worktree is rejected outright:
        // the pane directory is never a second trust root, and the offer
        // is never bound to the old repository on its strength.
        const straySource = fakeSource({
            panes: [{ paneId: 'w1:p1', sessionId: 'route-1', cwd: outside }],
        });
        const stray = new SurfaceBroker({
            dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')),
            source: straySource,
        });
        try {
            await expect(stray.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p1', cwd: outside }))
                .rejects.toThrow(/moved/);
            await expect(stray.invoke({ method: 'browser.open', target: 'https://example.com/' }, { paneId: 'w1:p1' }))
                .rejects.toThrow(/moved/);
        } finally {
            await stray.close();
        }

        // Relative Code targets resolve against the validated invocation
        // directory, not the bare root: a monorepo subdir invocation of
        // `file.ts` reviews `apps/web/file.ts`, never `file.ts`.
        const coded = await moved.invoke({ method: 'code.open', target: 'file.ts', name: 'sub' }, { paneId: 'w1:p1', cwd: subdir }) as {
            outcome: string;
            surface: Record<string, unknown>;
        };
        expect(coded.outcome).toBe('accepted');
        expect(coded.surface).toMatchObject({ path: join('apps', 'web', 'file.ts') });
        // An escaping symlink target fails even though its lexical path
        // reads as inside.
        const escapeFile = join('escape', 'file.ts');
        await expect(moved.invoke({ method: 'code.open', target: escapeFile, name: 'esc' }, { paneId: 'w1:p1', cwd: WORKTREE }))
            .rejects.toThrow(/outside the current worktree/);

        await expect(crowded.invoke({ method: 'browser.open', target: 'http://localhost:4317/app' }, hints))
            .rejects.toThrow(/choose one explicitly/);
        // An explicit valid claimant is stored on the offer, not discarded:
        // the mobile admits only while this exact provider stays approved.
        const chosen = await crowded.invoke(
            { method: 'browser.open', target: 'http://localhost:4317/app', provider: 'a.browser' },
            hints,
        ) as { outcome: string; surface: Record<string, unknown> };
        expect(chosen.outcome).toBe('accepted');
        expect(chosen.surface).not.toHaveProperty('provider');
        expect(crowded.registry.current('browser', WORKTREE, 'route-1')?.offer).toMatchObject({ provider: 'a.browser' });
        const crowdedCapabilities = await crowded.invoke({ method: 'capabilities' }, hints) as {
            capabilities: { capability: string; available: boolean; ambiguous: boolean }[];
        };
        expect(crowdedCapabilities.capabilities).toContainEqual({
            capability: 'surface.browser.open',
            available: true,
            ambiguous: true,
        });

        const bare = new SurfaceBroker({
            dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')),
            source: fakeSource({ plugins: [] }),
        });
        await expect(bare.invoke({ method: 'browser.open', target: 'https://example.com/' }, hints))
            .rejects.toThrow(/no surface provider is installed/);

        // Whatever the broker returns names the logical surface only.
        const listed = await broker.invoke({ method: 'surface.list' }, hints) as {
            surfaces: unknown[];
        };
        expect(listed.surfaces.length).toBeGreaterThan(0);
        // Cwd-only hints resolve when they identify exactly one live session.
        const cwdOnly = await broker.invoke({ method: 'surface.list' }, { cwd: WORKTREE }) as {
            surfaces: unknown[];
        };
        expect(cwdOnly.surfaces.length).toBeGreaterThan(0);
        const serialized = JSON.stringify({ https, blank, local, reload, listed });
        expect(serialized).not.toMatch(/sfo_|pvl_|pane-|session|device|admission|token|secret/i);
        await broker.close();
        await crowded.close();
        await twins.close();
        await moved.close();
        await shellBroker.close();
        await bare.close();
    });

    it('preserves code open versus code diff as an explicit destination', async () => {
        const source = fakeSource();
        const broker = new SurfaceBroker({ dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')), source });
        try {
            const hints = { paneId: 'w1:p1', cwd: WORKTREE };
            const opened = await broker.invoke({ method: 'code.open', target: 'src/index.ts:10:2' }, hints) as {
                outcome: string;
                surface: Record<string, unknown>;
            };
            expect(opened.outcome).toBe('accepted');
            // The numeric revision stays numeric; no revision string collides
            // with it, and the destination travels explicitly beside the mode.
            expect(opened.surface).toMatchObject({
                kind: 'code-review',
                path: 'src/index.ts',
                line: 10,
                column: 2,
                destination: 'file',
                mode: 'review',
                title: 'index.ts:10',
            });
            expect(typeof opened.surface.revision).toBe('number');
            expect(broker.registry.current('code', WORKTREE, 'route-1')?.offer).toMatchObject({ destination: 'file' });

            const diffed = await broker.invoke({ method: 'code.diff', target: 'src/index.ts' }, hints) as {
                outcome: string;
                surface: Record<string, unknown>;
            };
            expect(diffed.outcome).toBe('accepted');
            expect(diffed.surface).toMatchObject({ kind: 'code-review', destination: 'diff', mode: 'review', title: 'index.ts' });
            expect(broker.registry.current('code', WORKTREE, 'route-1')?.offer).toMatchObject({ destination: 'diff' });

            const serialized = JSON.stringify({ opened, diffed });
            expect(serialized).not.toMatch(/sfo_|pvl_|pane-|pp_|device|admission|token|secret/i);
        } finally {
            await broker.close();
        }
    });

    it('opens a root delta on targetless code diff while browser update still requires an offer', async () => {
        const source = fakeSource();
        const broker = new SurfaceBroker({ dataDir: mkdtempSync(join(tmpdir(), 'muxr-broker-')), source });
        try {
            const hints = { paneId: 'w1:p1', cwd: WORKTREE };
            // Fresh session, no open offer: accepted as a root delta, not refused.
            const first = await broker.invoke({ method: 'code.diff' }, hints) as {
                outcome: string;
                surface: Record<string, unknown>;
            };
            expect(first.outcome).toBe('accepted');
            expect(first.surface).toMatchObject({
                kind: 'code-review',
                name: 'code',
                path: '.',
                destination: 'diff',
                mode: 'review',
                title: 'Worktree root',
            });
            expect(first.surface).not.toHaveProperty('provider');
            expect(typeof first.surface.revision).toBe('number');
            // Repeating replaces the named offer with a newer revision.
            const second = await broker.invoke({ method: 'code.diff', name: 'code-root' }, hints) as {
                outcome: string;
                surface: Record<string, unknown>;
            };
            expect(second.outcome).toBe('accepted');
            expect(second.surface).toMatchObject({ name: 'code-root', path: '.', destination: 'diff' });
            // From a package directory inside the worktree, targetless diff
            // is still the worktree's Changes -- never the package path --
            // while an explicit relative target resolves from that
            // directory.
            const fromPackage = { paneId: 'w1:p1', cwd: join(WORKTREE, 'apps', 'web') };
            const rooted = await broker.invoke({ method: 'code.diff' }, fromPackage) as { surface: Record<string, unknown> };
            expect(rooted.surface).toMatchObject({ path: '.', destination: 'diff', title: 'Worktree root' });
            const explicit = await broker.invoke({ method: 'code.diff', target: '.' }, fromPackage) as { surface: Record<string, unknown> };
            expect(explicit.surface).toMatchObject({ path: join('apps', 'web'), destination: 'diff' });
            const serialized = JSON.stringify({ first, second });
            expect(serialized).not.toMatch(/sfo_|pvl_|pane-|pp_|device|admission|token|secret/i);

            // `browser update` without a target keeps refresh semantics.
            await expect(broker.invoke({ method: 'browser.update', name: 'missing' }, hints))
                .rejects.toThrow(/no open surface by that name/);
        } finally {
            await broker.close();
        }
    });

    it('gives reload orders monotonic commands while renewals keep theirs', () => {
        let now = 1_000_000;
        const offers = createSurfaceOffers({ now: () => now });
        const seen: Array<{ operation: string; command: number }> = [];
        offers.onEvent = (event) => seen.push({ operation: event.operation, command: event.record.command });
        const opened = offers.open({ ...LOCAL_OFFER }, WORKTREE, 'route-1');
        const openCommand = opened.command;
        const reloaded = offers.refresh(opened.handle);
        expect(reloaded.command).toBeGreaterThan(openCommand);
        // Renewal extends and re-emits without a new command: the phone
        // adopts the later expiry and never mistakes it for an order.
        // (Capture numbers: every call below mutates the same record.)
        const reloadCommand = reloaded.command;
        const reloadExpiry = reloaded.expiresAt;
        now += 1_000;
        const renewed = offers.renew(opened.handle);
        expect(renewed?.command).toBe(reloadCommand);
        expect(renewed?.expiresAt).toBeGreaterThan(reloadExpiry);
        offers.close('app', WORKTREE, 'route-1');
        const commands = seen.map((entry) => entry.command);
        expect(seen.map((entry) => entry.operation)).toEqual(['open', 'reload', 'reload', 'close']);
        expect([...commands].sort((a, b) => a - b)).toEqual(commands);
        expect(new Set(commands).size).toBe(commands.length - 1);
    });

    it('delivers a real app over the HTTPS gateway: unadmitted refused with zero dials, bootstrap admits, page, asset, cookie and WebSocket flow, release closes the socket', async () => {
        // A real dev-server stub: a page that installs a session cookie
        // scoped to its own host, an asset that reads it back, a redirect
        // to its own authority, and an echo WebSocket on the same listener.
        const upstreamRequests: string[] = [];
        const app = createHttpServer((request, response) => {
            upstreamRequests.push(`${request.method} ${request.url}`);
            if (request.url === '/app') {
                response.writeHead(200, {
                    'content-type': 'text/html',
                    'set-cookie': ['sid=s3cr3t; Path=/; Domain=localhost; HttpOnly', 'theme=dark; Path=/'],
                });
                response.end('<script src="/app.js"></script>');
                return;
            }
            if (request.url === '/app.js') {
                response.writeHead(200, { 'content-type': 'text/javascript' });
                response.end(`// cookie=${request.headers.cookie ?? ''}; proto=${request.headers['x-forwarded-proto']}; fhost=${request.headers['x-forwarded-host']}`);
                return;
            }
            if (request.url === '/login') {
                response.writeHead(302, { location: `http://127.0.0.1:${appPort}/app?next=1` });
                response.end();
                return;
            }
            response.writeHead(404);
            response.end();
        });
        const socketServer = new WebSocketServer({ server: app, path: '/hmr' });
        socketServer.on('connection', (socket, request) => {
            socket.send(`hello ${request.headers.cookie ?? ''}`);
            socket.on('message', (data) => socket.send(`echo ${String(data)}`));
        });
        await new Promise<void>((resolvePromise) => app.listen(0, '127.0.0.1', resolvePromise));
        const appPort = (app.address() as { port: number }).port;

        const endpoints = createPreviewEndpoints({ publicPort: 443, allocator: { hostnameFor: (endpoint) => `${endpoint.id}.preview.test` } });
        const gateway = await startPreviewGateway({ endpoints });
        const source = fakeSource();
        const offers = createSurfaceOffers();
        const { dispatch } = dispatcherFor(source, offers, { previewEndpoints: endpoints, previewGateway: gateway });
        try {
            const record = await openSurfaceOffer(
                { offers, snapshot: async () => 'muxr.browser:h1', claimants: claimantsFor(['muxr.browser']) },
                { offer: { ...LOCAL_OFFER, port: appPort, path: '/app' }, context: WORKTREE, sessionId: 'route-1' },
            );
            const leased = await dispatch({ type: 'preview.lease', requestId: 'l', params: { kind: 'browser', access: 'product', offer: record.handle } } as never, 'control-device') as { ok: boolean; data: { lease: string } };
            expect(leased.ok).toBe(true);
            const booted = await dispatch({ type: 'preview.bootstrap', requestId: 'b', params: { lease: leased.data.lease } } as never, 'control-device') as {
                ok: boolean; data: { origin: string; generation: number; path: string; bootstrap: { path: string; body: string; expiresAt: number } };
            };
            expect(booted.ok).toBe(true);
            const host = new URL(booted.data.origin).host;
            expect(host).toMatch(/\.preview\.test$/);
            expect(booted.data.path).toBe('/app');

            // Unpaired: right host, no cookie -- and a forged cookie -- reach nothing upstream.
            expect((await fetchVia(gateway.port, host, '/app')).status).toBe(403);
            expect((await fetchVia(gateway.port, host, '/app', { headers: { cookie: `${PREVIEW_ADMISSION_COOKIE}=${'x'.repeat(43)}` } })).status).toBe(403);
            expect((await fetchVia(gateway.port, 'other.preview.test', '/app')).status).toBe(403);
            expect(upstreamRequests).toEqual([]);

            // One-use bootstrap admits with a host-only Secure HttpOnly cookie and lands on the app path.
            // The body is posted verbatim, exactly as a native WebView does.
            expect(booted.data.bootstrap.body).toMatch(/^bootstrap=[A-Za-z0-9_-]{43}$/);
            const admitted = await fetchVia(gateway.port, host, booted.data.bootstrap.path, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: booted.data.bootstrap.body,
            });
            expect(admitted.status).toBe(303);
            expect(admitted.headers.location).toBe('/app');
            const setCookie = (admitted.headers['set-cookie'] ?? [])[0] as string;
            expect(setCookie).toMatch(new RegExp(`^${PREVIEW_ADMISSION_COOKIE}=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=None; Partitioned; Path=/$`));
            const cookie = setCookie.split(';')[0] as string;
            const replay = await fetchVia(gateway.port, host, booted.data.bootstrap.path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: booted.data.bootstrap.body });
            expect(replay.status).toBe(403);

            // Page: the app's cookies pass through with only the upstream Domain dropped.
            const page = await fetchVia(gateway.port, host, '/app', { headers: { cookie } });
            expect(page.status).toBe(200);
            expect(page.body).toContain('/app.js');
            expect(page.headers['set-cookie']).toEqual(['sid=s3cr3t; Path=/; HttpOnly', 'theme=dark; Path=/']);
            // Asset: the app session cookie reaches upstream, the gateway cookie does not, and forwarding facts are set.
            const asset = await fetchVia(gateway.port, host, '/app.js', { headers: { cookie: `${cookie}; sid=s3cr3t; theme=dark` } });
            expect(asset.body).toBe(`// cookie=sid=s3cr3t; theme=dark; proto=https; fhost=${host}`);
            // Redirect to the upstream's own authority maps back to the public origin, query intact.
            const redirect = await fetchVia(gateway.port, host, '/login', { headers: { cookie } });
            expect(redirect.status).toBe(302);
            expect(redirect.headers.location).toBe(`${booted.data.origin}/app?next=1`);

            // WebSocket: admitted upgrade becomes a raw duplex; an unadmitted one is refused before any dial.
            const refused = new WebSocket(`ws://127.0.0.1:${gateway.port}/hmr`, { headers: { host } });
            await new Promise<void>((resolvePromise) => refused.once('error', () => resolvePromise()));
            const upgrades = upstreamRequests.length;
            const live = new WebSocket(`ws://127.0.0.1:${gateway.port}/hmr`, { headers: { host, cookie: `${cookie}; sid=s3cr3t` } });
            const messages: string[] = [];
            const closed = new Promise<void>((resolvePromise) => live.once('close', () => resolvePromise()));
            await new Promise<void>((resolvePromise, reject) => {
                live.once('error', reject);
                live.on('message', (data) => {
                    messages.push(String(data));
                    if (messages.length === 1) live.send('ping');
                    if (messages.length === 2) resolvePromise();
                });
            });
            expect(messages).toEqual(['hello sid=s3cr3t', 'echo ping']);
            expect(upstreamRequests.length).toBe(upgrades);

            // Release ends the lease: the gateway closes the live socket and admits nothing more.
            await dispatch({ type: 'preview.release', requestId: 'r', params: { lease: leased.data.lease } } as never, 'control-device');
            await closed;
            expect((await fetchVia(gateway.port, host, '/app', { headers: { cookie } })).status).toBe(403);
        } finally {
            gateway.close();
            endpoints.dispose();
            socketServer.close();
            app.close();
        }
    });
});
