import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type {
    ClientRequest,
    PeerClientRequest,
    PeerRequestType,
    PluginManifestV1,
    RequestMap,
    RequestResponse,
    RequestResult,
    RequestType,
} from '@muxr/contract';
import { isPublishableSurfaceSession } from '@muxr/contract';
import type { AgentWatchStores, SessionSource, TerminalManager } from '../../agent/index.js';
import {
    answerAgent,
    closeTerminal,
    focusAgent,
    listAgents,
    openAgent,
    openTerminal,
    promptAgent,
    readAgentSession,
    runPluginAction,
    startAgent,
    stopAgent,
    watchAgentLifecycle,
} from '../../agent/index.js';
import type { PeerDeviceContext, PeerRuntime } from '../../peer/index.js';
import { grantMayAdministerPeers, hostPlatformLabel, listMachines, observerGrantIsViewOnly } from '../../machine/index.js';
import { attachPreview, probePreviewPort } from '../infrastructure/preview.js';
import { createPreviewLeases, providerIdentity, type PreviewLeaseRegistry } from '../infrastructure/previewLeases.js';
import { createSurfaceOffers, type SurfaceOfferRegistry } from '../infrastructure/surfaceOffers.js';
import { landWorktree } from '../infrastructure/landWorktree.js';
import { listDir } from '../infrastructure/listDir.js';
import { repairHost } from '../infrastructure/repairHost.js';
import { runMachineShell } from '../infrastructure/runMachineShell.js';
import { runHerdrCli } from '../infrastructure/runHerdrCli.js';
import { openPreview, probePreview } from './openPreview.js';

export interface RequestDispatcherOptions {
    source: SessionSource;
    domain: AgentWatchStores;
    machineId: string;
    machineName?: string;
    hostVersion: string;
    /** Where to join preview channels. Absent means preview is unavailable. */
    relayUrl?: string;
    /** Hosted E2EE never permits clear preview payloads from older clients. */
    requirePreviewEncryption?: boolean;
    terminals?: TerminalManager;
    token?: string;
    /** Browser grants can observe but cannot mutate terminal/machine state. */
    canMutateDevice?: (deviceId: string) => boolean;
    /**
     * Whether a device holds an explicitly live, unexpired, control-authority
     * grant right now. Surfaces need that stronger answer than the request gate
     * does: a grant that was removed leaves no authority entry behind, and an
     * absent entry must never read as permission. Hosted mode supplies it; an
     * unhosted local host has no grant table and falls back to the request gate.
     */
    surfaceAuthority?: (deviceId: string) => boolean;
    /** Endpoint leases for preview surfaces. One is created when absent. */
    previewLeases?: PreviewLeaseRegistry;
    /**
     * Provider-neutral Surface offers. One is created when absent; the local
     * broker and the device surface requests share it, so a product lease
     * always resolves its endpoint from host-owned offer state.
     */
    surfaceOffers?: SurfaceOfferRegistry;
    peerRuntime?: PeerRuntime;
    getDeviceContext?: (deviceId: string) => PeerDeviceContext | undefined;
}

/** `peerAdmitted`: reached through the authenticated peer runtime's receipt executor, never from a request field. */
type RequestContext = { deviceId: string; requestId: string; peerAdmitted: boolean };
type Handler<T extends RequestType> = (params: RequestMap[T]['params'], context: RequestContext) => Promise<RequestResult<T>>;
type NonPeerRequestType = Exclude<RequestType, PeerRequestType>;
type PluginExecutionRequest = Extract<ClientRequest, {
    type: 'plugin.approve' | 'plugin.invoke' | 'plugin.call' | 'plugin.stream';
}>;

const VIEW_ONLY_REQUESTS: ReadonlySet<RequestType> = new Set([
    'session.list', 'session.open', 'session.status',
    'herdr.tree', 'herdr.agentKinds', 'herdr.layout', 'pane.read', 'plugin.list', 'plugin.manifest',
    'attachment.fetch', 'attachment.read', 'unread.catalog',
    'attention.catalog', 'lifecycle.catalog', 'machines.list', 'terminal.attach',
]);

function isPluginExecutionRequest(request: ClientRequest): request is PluginExecutionRequest {
    switch (request.type) {
        case 'plugin.approve':
        case 'plugin.invoke':
        case 'plugin.call':
        case 'plugin.stream':
            return true;
        default:
            return false;
    }
}

function ok(requestId: string, data: unknown): RequestResponse {
    return { type: 'result', requestId, ok: true, data };
}

function fail(requestId: string, error: unknown, code?: string): RequestResponse {
    if (error instanceof Error) return { type: 'result', requestId, ok: false, error: error.message, ...(code === undefined ? {} : { code }) };
    if (typeof error === 'string') return { type: 'result', requestId, ok: false, error, ...(code === undefined ? {} : { code }) };
    return { type: 'result', requestId, ok: false, error: String(error), ...(code === undefined ? {} : { code }) };
}

function fromCaught(requestId: string, error: unknown): RequestResponse {
    const code = (error as { code?: unknown }).code;
    return fail(requestId, error, typeof code === 'string' ? code : undefined);
}

type UseCaseResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

function useCaseData<T>(result: UseCaseResult<T>): T {
    if (result.ok) return result.data;
    const error = new Error(result.error) as Error & { code?: string };
    if (result.code !== undefined) error.code = result.code;
    throw error;
}

function fromUseCase(requestId: string, result: UseCaseResult<unknown>): RequestResponse {
    if (result.ok) return ok(requestId, result.data);
    return fail(requestId, result.error, result.code);
}

export function createRequestDispatcher(options: RequestDispatcherOptions): {
    dispatch(request: ClientRequest, authenticatedSenderId?: string): Promise<RequestResponse>;
} {
    const { source, domain, machineId, hostVersion } = options;

    // A device that has lost control authority can hold no surface. This
    // predicate expires its leases and closes the listeners they hold, so it
    // has to answer for a grant that is gone -- not merely for one recorded as
    // view-only.
    const deviceMayMutate = (deviceId: string): boolean => !observerGrantIsViewOnly(
        options.getDeviceContext?.(deviceId)?.kind,
        options.canMutateDevice?.(deviceId) !== false,
    );
    const deviceMayHoldSurface = (deviceId: string): boolean => {
        if (options.surfaceAuthority !== undefined) return options.surfaceAuthority(deviceId) === true;
        return deviceMayMutate(deviceId);
    };
    /**
     * Digest of the enabled-and-approved plugin catalog a lease was issued
     * under. Approval is part of standing: it throws on a failed read on
     * purpose, and a revoked approval changes the digest so revalidation
     * closes the tunnels it no longer covers. A catalog this host cannot
     * read is not an empty catalog, and a lease must not be issued -- or
     * kept -- under one.
     */
    /**
     * Authority revisions: monotonic tokens moved by the owners of the
     * state a lease stands on. The catalog token moves on every approval
     * write through this dispatcher, on every plugins-invalidated frame
     * from the herd, and whenever a catalog read observes a digest
     * change. A session token moves on every session event the herd
     * publishes for it (removal, replacement, status), on a tree
     * connectivity flip, and whenever a liveness read observes a change.
     * The registry captures the composite before its asynchronous reads
     * and compares it synchronously before use, so a change the reads
     * could not see still denies.
     */
    let catalogRevision = 0;
    /**
     * Monotonic provider generations, independent of anything observed by
     * a read: a `plugins.invalidated` frame naming plugins advances each
     * named provider's generation synchronously, so a relevant
     * invalidation landing during an in-flight admission moves the token
     * before the dial, while an unrelated provider's invalidation leaves
     * a Browser token untouched. An empty frame is informational by
     * contract (reconnect reconciliation, an unnameable change): it
     * refreshes cache bookkeeping only and never moves authority or ends a
     * holder -- an actual provider change surfaces through the exact
     * provider identity on the next catalog read.
     */
    const providerGenerations = new Map<string, number>();
    const sessionRevisions = new Map<string, number>();
    let treeConnected: boolean | undefined;
    const bumpCatalog = (): void => {
        catalogRevision += 1;
    };
    const bumpSession = (sessionId: string): void => {
        sessionRevisions.set(sessionId, (sessionRevisions.get(sessionId) ?? 0) + 1);
    };
    const bumpAllSessions = (): void => {
        for (const sessionId of [...sessionRevisions.keys()]) bumpSession(sessionId);
    };
    const lastDigest = new Map<string, string>();
    const lastLive = new Map<string, boolean>();
    // Subscriptions live as long as the dispatcher does, like the lease
    // registry they feed.
    try {
        source.subscribe((sessionId, event) => {
            if (event.type === 'session.removed' || event.type === 'session.created'
                || event.type === 'session.updated' || event.type === 'status.update') {
                bumpSession(sessionId);
            }
        });
    } catch {
        /* a source without a stream still reconciles on read */
    }
    // A provider whose catalog identity changed: its generation moves and
    // its current holders end, synchronously.
    const providerChanged = (pluginId: string): void => {
        providerGenerations.set(pluginId, (providerGenerations.get(pluginId) ?? 0) + 1);
        previewLeases.invalidateProvider(pluginId);
    };
    try {
        // Authoritative path from the catalog diff owner: the complete
        // changed set, delivered before the bounded wire frame -- so a
        // change too large for the wire to name still fences every
        // affected provider.
        source.onPluginCatalogChange?.((changed) => {
            bumpCatalog();
            for (const pluginId of changed) providerChanged(pluginId);
        });
    } catch {
        /* a source without the hook still fences through named wire frames */
    }
    try {
        // Wire frames: a named list is exhaustive by contract and fences
        // the same way; the empty frame is informational (reconnect,
        // attachments fallback) and refreshes cache bookkeeping only.
        source.subscribeMachine?.((frame) => {
            bumpCatalog();
            const named = Array.isArray(frame.pluginIds) ? frame.pluginIds : [];
            for (const pluginId of named) providerChanged(pluginId);
        });
    } catch {
        /* same */
    }
    const pluginSnapshot = async (deviceId: string): Promise<string> => {
        const listed = await source.pluginList(deviceId);
        const digest = listed
            .filter((plugin) => plugin.approved)
            .map((plugin) => `${plugin.pluginId}:${plugin.manifestHash}`)
            .sort()
            .join('|');
        // A first observation establishes the baseline; only a change
        // from an earlier observation is a reconciliation the token
        // records.
        const previous = lastDigest.get(deviceId);
        lastDigest.set(deviceId, digest);
        if (previous !== undefined && previous !== digest) bumpCatalog();
        return digest;
    };
    /** Same rule the registry applies: the exact provider's identity for product leases, the whole digest otherwise. */
    const providerStillApproved = (lease: { provider?: string; snapshot: string }, current: string): boolean => {
        if (lease.provider === undefined) return current === lease.snapshot;
        const identity = providerIdentity(current, lease.provider);
        return identity !== undefined && identity === providerIdentity(lease.snapshot, lease.provider);
    };
    const surfaceOffers = options.surfaceOffers ?? createSurfaceOffers();
    const previewLeases = options.previewLeases ?? createPreviewLeases({
        machineId,
        authorized: deviceMayHoldSurface,
        snapshot: (lease) => pluginSnapshot(lease.deviceId),
        // A product lease stands only while its exact offer generation is
        // still the current live record, in the exact live session it was
        // issued for. Replace, close, expiry, and a session that moved on
        // each answer undefined here and end the lease on the next check.
        offerCurrent: (handle) => {
            try {
                const record = surfaceOffers.resolve(handle);
                return { revision: record.revision, sessionId: record.sessionId };
            } catch {
                return undefined;
            }
        },
        // The stored offer record cannot prove its own session is live:
        // termination and replacement never rewrite it, and a cached
        // disconnected tree still lists its panes. The herd is read live
        // instead, and only a connected tree with a pane holding a
        // publishable agent session under this exact id -- confirmed
        // through an independent live status read that reconciles the
        // session against current herd state rather than the cached
        // tree -- keeps the lease standing. A disconnected tree is fail
        // closed: cached state authorizes nothing, existing holders end,
        // and a fresh attach reconciles once the herd is readable again.
        sessionLive: async (sessionId) => {
            const observed = (live: boolean): boolean => {
                const previous = lastLive.get(sessionId);
                lastLive.set(sessionId, live);
                if (previous !== undefined && previous !== live) bumpSession(sessionId);
                return live;
            };
            try {
                const tree = await source.herdrTree();
                const connected = tree.connected === true;
                const previouslyConnected = treeConnected;
                treeConnected = connected;
                if (previouslyConnected !== undefined && previouslyConnected !== connected) bumpAllSessions();
                if (!connected) return observed(false);
                const present = tree.workspaces.some((workspace) =>
                    workspace.tabs.some((tab) =>
                        tab.panes.some((pane) =>
                            pane.sessionId === sessionId
                            && isPublishableSurfaceSession(pane.sessionId),
                        ),
                    ),
                );
                if (!present) return observed(false);
                if (typeof source.status !== 'function') return observed(true);
                try {
                    await source.status(sessionId);
                } catch {
                    return observed(false);
                }
                return observed(true);
            } catch {
                return observed(false);
            }
        },
        // The approval store's own fence leads the token: it moves before
        // any approval persistence starts and is undefined while a
        // mutation is in flight, so a check that starts or completes
        // across a revocation is denied before any dial or extension.
        authorityRevision: (lease) => {
            // Fenced per (device, provider); a lease without a provider
            // keeps the device-wide fence.
            const approvals = typeof source.pluginApprovalRevision === 'function'
                ? source.pluginApprovalRevision(lease.deviceId, lease.provider)
                : 0;
            if (approvals === undefined) return undefined;
            // Catalog component: the exact provider's last observed identity
            // for product leases -- an unrelated plugin's change does not
            // move it -- and the whole-catalog revision for providerless
            // ones. Before any observation the lease's own snapshot is the
            // baseline.
            const catalog = lease.provider === undefined
                ? `${catalogRevision}`
                : `${providerIdentity(lastDigest.get(lease.deviceId) ?? lease.snapshot, lease.provider) ?? 'absent'}/${providerGenerations.get(lease.provider) ?? 0}`;
            return `${approvals}:${catalog}:${lease.offerSession === undefined ? '' : sessionRevisions.get(lease.offerSession) ?? 0}`;
        },
        // A renewed lease renews its offer alongside it, re-emitted
        // unchanged: a live surface never watches its offer expire.
        onRenew: (lease) => {
            if (lease.offerHandle !== undefined) surfaceOffers.renew(lease.offerHandle);
        },
    });

    // Event-driven: the approval store announces every mutation start with
    // its exact device and plugin, and the registry ends the current
    // holders standing on that approval in the same event turn -- while
    // any catalog or session read is still pending, before persistence,
    // and independently of the sweep.
    try {
        source.onPluginApprovalMutation?.((deviceId, pluginId) => {
            previewLeases.invalidateAuthority(deviceId, pluginId);
        });
    } catch {
        /* a source without the hook still fences through the token */
    }

    const handlers: { [K in NonPeerRequestType]: Handler<K> } = {
        'session.list': async (params) => useCaseData(
            await listAgents(source, params.cwd === undefined ? {} : { cwd: params.cwd }),
        ),
        'session.start': async (params) => {
            const { peerMutation: _peerMutation, ...start } = params;
            return useCaseData(await startAgent({
                exists: existsSync,
                create: async (cwd) => { await mkdir(cwd, { recursive: true }); },
                start: (command) => source.start(command),
            }, start));
        },
        'session.open': async (params) => useCaseData(await openAgent(source, params)),
        'herdr.tree': async () => source.herdrTree(),
        'herdr.agentKinds': async () => {
            const kinds = await source.agentKinds();
            return { kinds, installed: await source.installedAgentKinds(kinds) };
        },
        'plugin.list': () => { throw new Error('authenticated device context required'); },
        'plugin.manifest': async (params) => useCaseData(
            await runPluginAction(source, { action: 'manifest', ...params }),
        ) as PluginManifestV1,
        'plugin.approve': () => { throw new Error('authenticated device context required'); },
        'plugin.invoke': () => { throw new Error('authenticated device context required'); },
        'plugin.call': () => { throw new Error('authenticated device context required'); },
        'plugin.stream': () => { throw new Error('authenticated device context required'); },
        'host.update': (params, context) => repairHost(params, context.deviceId),
        'herdr.cli': async (params) => {
            const result = await runHerdrCli(params.args, params.timeoutMs);
            await source.refreshHerdr();
            await source.refreshPlugins?.();
            return result;
        },
        'herdr.layout': async (params) => ({ layout: await source.herdrLayout(params.tabId) }),
        'pane.split': (params) => source.paneSplit(params),
        'pane.read': async (params) => useCaseData(await readAgentSession(source, {
            view: 'pane',
            sessionId: params.sessionId,
            ...(params.lines === undefined ? {} : { lines: params.lines }),
            ...(params.source === undefined ? {} : { source: params.source }),
            ...(params.ansi === undefined ? {} : { ansi: params.ansi }),
        })) as { text: string; truncated: boolean },
        'agent.watch': async ({ peerMutation: _peerMutation, ...params }) =>
            useCaseData(await watchAgentLifecycle(source, params)) as { watching: boolean },
        'layout.export': (params) => source.layoutExport(params.sessionId),
        'layout.apply': (params) => source.layoutApply(params),
        'pane.focus': async (params) => useCaseData(await focusAgent(source, { target: 'pane', sessionId: params.sessionId })),
        'pane.focusNeighbor': async (params) => useCaseData(await focusAgent(source, {
            target: 'pane-neighbor', sessionId: params.sessionId, direction: params.direction,
        })),
        'tab.focusNeighbor': async (params) => useCaseData(await focusAgent(source, {
            target: 'tab-neighbor', sessionId: params.sessionId, direction: params.direction,
        })),
        'workspace.focusNeighbor': async (params) => useCaseData(await focusAgent(source, {
            target: 'workspace-neighbor', sessionId: params.sessionId, direction: params.direction,
        })),
        'tab.create': async (params) => {
            await source.createTab(params.sessionId, { ...(params.kind === undefined ? {} : { kind: params.kind }), ...(params.label === undefined ? {} : { label: params.label }) });
            return null;
        },
        'tab.close': async (params) => {
            await source.closeTab(params.sessionId, params.tabId);
            return null;
        },
        'pane.close': async (params) => {
            await source.closePane(params.sessionId);
            return null;
        },
        'workspace.close': async (params) => {
            await source.closeWorkspace(params.workspaceId);
            return null;
        },
        'session.answer': async (params) => useCaseData(await answerAgent(source, params)),
        'pane.zoom': (params) => source.paneZoom(params),
        'session.stop': async (params, context) => useCaseData(await stopAgent(
            { sessions: source }, {
                sessionId: params.sessionId,
                action: 'stop',
                deviceId: context.deviceId,
                idempotencyKey: context.requestId,
                ...(params.confirmedScope === undefined ? {} : { confirmedScope: params.confirmedScope }),
            },
        )),
        'session.abort': async (params) => useCaseData(await stopAgent(
            { sessions: source }, { sessionId: params.sessionId, action: 'abort' },
        )),
        'session.reload': async (params) => useCaseData(await stopAgent(
            { sessions: source }, { sessionId: params.sessionId, action: 'reload' },
        )),
        'session.prompt': async ({ peerMutation, promptId, promptNotValidAfter, ...params }, context) => {
            const run = async (): Promise<null> => {
                const result = await promptAgent(source, params);
                if (result.ok) return result.data;
                const error = new Error(result.error) as Error & { code?: string; promptDispatched?: true };
                if (result.code !== undefined) error.code = result.code;
                if (result.dispatched === true) error.promptDispatched = true;
                throw error;
            };
            // Admitted peers carry their own durable receipt (peerMutation,
            // executed by the peer runtime before this handler). Trust the
            // dispatch context, never the field: an ordinary device offering
            // peer metadata is refused. Every other client must identify the
            // submission so a resend after a lost answer runs at most once.
            if (context.peerAdmitted) return run();
            if (peerMutation !== undefined) {
                const error = new Error('peer mutation metadata is not accepted from this device') as Error & { code: string };
                error.code = 'prompt-invalid';
                throw error;
            }
            if (promptId === undefined && promptNotValidAfter === undefined) {
                const error = new Error('session.prompt requires promptId and promptNotValidAfter on this host; update the app') as Error & { code: string };
                error.code = 'prompt-id-required';
                throw error;
            }
            return domain.prompts.once(context.deviceId, { promptId, notValidAfter: promptNotValidAfter, input: params }, run);
        },
        'session.status': async (params) => useCaseData(
            await readAgentSession(source, { view: 'status', sessionId: params.sessionId }),
        ) as Awaited<ReturnType<SessionSource['status']>>,
        'session.shell': (params) => source.shell(params),
        'session.readFile': async (params) => useCaseData(
            await readAgentSession(source, { view: 'file', sessionId: params.sessionId, path: params.path }),
        ) as { content: string },
        'session.saveAttachments': (params) => source.saveAttachments(params),
        'attachment.fetch': (params) => source.attachmentFetch(params),
        'attachment.prepare': (params) => {
            if (options.relayUrl === undefined) throw new Error('attachment.prepare is local-only; hosted clients use encrypted attachment.read chunks');
            return source.attachmentPrepare(params);
        },
        'attachment.read': (params) => source.attachmentRead(params),
        'unread.catalog': async () => domain.unread.catalog(),
        'unread.acknowledge': async (params) => domain.unread.acknowledge(params.sessionId, params.throughSeq),
        'attention.catalog': async () => domain.attention.catalog(),
        'lifecycle.catalog': async () => domain.lifecycle.catalog(),
        'machines.list': async () => listMachines({
            machineId,
            ...(options.machineName === undefined ? {} : { machineName: options.machineName }),
            hostVersion,
            platform: hostPlatformLabel(),
        }).data,
        'machine.shell': (params) => runMachineShell(params.command, params.cwd),
        'machine.listDir': (params) => listDir(params.path),
        'worktree.land': (params) => landWorktree(params.worktreePath, params.message, params.stash),
        'preview.probe': async (params) => {
            const result = await probePreview(probePreviewPort, params);
            return result.data;
        },
        'preview.lease': async (params, context) => {
            // Product leases resolve their endpoint from a current local
            // Browser offer. The phone names the offer handle and nothing
            // else: a product port, provider or context submitted by the
            // caller is refused rather than trusted. Developer leases keep
            // their exact typed-port behavior.
            if (params.access === 'product') {
                if (typeof params.offer !== 'string' || params.offer === '') {
                    throw new Error('preview: a surface needs its current local offer; open it again');
                }
                if (params.port !== undefined || params.provider !== undefined || params.context !== undefined) {
                    throw new Error('preview: a surface names its offer, not its port or provider');
                }
                let record;
                try {
                    record = surfaceOffers.resolve(params.offer);
                } catch {
                    throw new Error('preview: that surface is no longer open; open it again');
                }
                if (record.offer.kind !== 'browser-local') {
                    throw new Error('preview: that surface kind never creates a tunnel lease');
                }
                // The receiving device's own approvals decide, read live now:
                // a provider it never approved -- or one it has since
                // revoked -- names no endpoint for this device. A provider
                // stored by the phone is never trusted; the caller names an
                // offer handle and this table names everything else.
                let summaries;
                try {
                    summaries = await source.pluginList(context.deviceId);
                } catch {
                    throw new Error('preview: this host cannot read its plugin catalog');
                }
                const approvedSnapshot = summaries
                    .filter((plugin) => plugin.approved)
                    .map((plugin) => `${plugin.pluginId}:${plugin.manifestHash}`)
                    .sort()
                    .join('|');
                const approvedClaimants = summaries
                    .filter((plugin) => plugin.approved
                        && plugin.capabilities?.[record.offer.capability] !== undefined)
                    .map((plugin) => plugin.pluginId);
                if (!approvedClaimants.includes(record.offer.provider)) {
                    throw new Error('preview: that surface provider is not approved on this device');
                }
                // Approval for this exact provider is being written (queued
                // or in flight): nothing is issued on state that is about
                // to change.
                if (typeof source.pluginApprovalRevision === 'function'
                    && source.pluginApprovalRevision(context.deviceId, record.offer.provider) === undefined) {
                    throw new Error('preview: that surface provider\'s approval is changing; try again');
                }
                // The catalog read above awaited: a replace or close in that
                // window must not still issue a lease. Resolve again and
                // require the exact same generation.
                let current: typeof record;
                try {
                    current = surfaceOffers.resolve(params.offer);
                } catch {
                    throw new Error('preview: that surface is no longer open; open it again');
                }
                if (current.handle !== record.handle || current.revision !== record.revision) {
                    throw new Error('preview: that surface is no longer open; open it again');
                }
                const lease = previewLeases.issue({
                    deviceId: context.deviceId,
                    kind: params.kind,
                    access: params.access,
                    port: record.offer.port,
                    provider: record.offer.provider,
                    context: record.offer.context,
                    snapshot: approvedSnapshot,
                    offerHandle: record.handle,
                    offerRevision: record.revision,
                    ...(record.sessionId === undefined ? {} : { offerSession: record.sessionId }),
                });
                return { lease: lease.id, expiresAt: lease.expiresAt, kind: lease.kind };
            }
            if (params.offer !== undefined) {
                throw new Error('preview: a developer surface names its port, not an offer');
            }
            if (params.port === undefined) throw new Error('preview: that is not a port on this machine');
            const lease = previewLeases.issue({
                deviceId: context.deviceId,
                kind: params.kind,
                access: params.access,
                port: params.port,
                ...(params.provider === undefined ? {} : { provider: params.provider }),
                ...(params.context === undefined ? {} : { context: params.context }),
                snapshot: await pluginSnapshot(context.deviceId),
            });
            // The endpoint and the snapshot stay on the host: the device gets an
            // opaque id and an expiry, and nothing it could reuse elsewhere.
            return { lease: lease.id, expiresAt: lease.expiresAt, kind: lease.kind };
        },
        'preview.release': async (params, context) => {
            previewLeases.release(params.lease, context.deviceId);
            return null;
        },
        'preview.renew': async (params, context) => {
            // Authenticated liveness from the holding device: the call
            // itself, over the encrypted control plane, proves presence.
            // The registry re-resolves the exact offer generation and
            // re-reads approval before extending anything, and renews the
            // bound offer alongside the lease.
            const lease = await previewLeases.renew(params.lease, context.deviceId);
            return { expiresAt: lease.expiresAt };
        },
        'preview.attach': async (params, context) => {
            // Legacy path: the caller names a port (takeover streams and the
            // typed dev-server preview). The lease path below never does.
            if (params.lease === undefined) {
                return useCaseData(await openPreview({
                    ...(options.relayUrl === undefined ? {} : { relayUrl: options.relayUrl }),
                    machineId,
                    ...(options.token === undefined ? {} : { token: options.token }),
                    ...(options.requirePreviewEncryption === undefined ? {} : { requireEncryption: options.requirePreviewEncryption }),
                    attach: attachPreview,
                }, { channel: params.channel, port: params.port as number, ...(params.key === undefined ? {} : { key: params.key }), ...(params.mode === undefined ? {} : { mode: params.mode }) }));
            }
            if (params.port !== undefined || params.mode !== undefined) {
                throw new Error('preview: a surface names its lease, not a port');
            }
            if (options.relayUrl === undefined) throw new Error('preview: host has no relay url');
            if (options.requirePreviewEncryption === true && params.key === undefined) {
                throw new Error('preview: update the app to use encrypted preview');
            }
            if (params.key === undefined) throw new Error('preview: a leased surface requires an encrypted tunnel');
            // Ownership before the await: the claim supersedes any tunnel
            // already on the lease, and a lease released, expired or
            // re-claimed while the relay dial ran loses below.
            const claim = previewLeases.claim(params.lease, context.deviceId);
            // A catalog that changed under the lease, or one this host cannot
            // read at all, is the same answer: do not open the tunnel.
            const snapshot = await pluginSnapshot(context.deviceId).catch(() => undefined);
            if (snapshot === undefined || !providerStillApproved(claim, snapshot)) {
                throw new Error('preview: the plugin snapshot changed; open the surface again');
            }
            const owner = { close: (): void => {}, dead: false };
            const handle = (): void => owner.close();
            const teardown = await attachPreview({
                relayUrl: options.relayUrl,
                machineId,
                channel: params.channel,
                port: claim.port,
                ...(params.key === undefined ? {} : { key: params.key }),
                ...(options.token === undefined ? {} : { token: options.token }),
                // Re-read before every new upstream dial: a revoked device or
                // a lease that lost standing opens no further connections.
                authorize: () => previewLeases.stands(claim.id, context.deviceId),
                onChannelClose: () => {
                    owner.dead = true;
                    previewLeases.releaseHeld(claim.id, handle);
                },
            });
            owner.close = teardown;
            // The relay dial gave revocation a window: recheck live standing
            // after it, before handing anything over.
            if (!(await previewLeases.standsLive(claim.id, context.deviceId)) || !previewLeases.settle(claim, handle)) {
                teardown();
                throw new Error('preview: that surface is no longer open; open it again');
            }
            if (owner.dead) {
                owner.close();
                throw new Error('preview: the tunnel closed before it was ready');
            }
            return null;
        },
        'terminal.attach': async (params) => useCaseData(await openTerminal(options.terminals, params)),
        'terminal.detach': async (params) => {
            await closeTerminal(options.terminals, params);
            return null;
        },
    };

    async function dispatchCore(request: ClientRequest, authenticatedSenderId?: string, peerAdmitted = false): Promise<RequestResponse> {
        const deviceId = authenticatedSenderId ?? 'local';
        const isViewOnlyDevice = observerGrantIsViewOnly(
            options.getDeviceContext?.(deviceId)?.kind,
            options.canMutateDevice?.(deviceId) !== false,
        );
        const viewOnlyPluginRead = isViewOnlyDevice && request.type === 'plugin.call'
            && source.pluginRpcMode?.(request.params) === 'read';
        if (isViewOnlyDevice && !VIEW_ONLY_REQUESTS.has(request.type) && !viewOnlyPluginRead) {
            return fail(request.requestId, 'this device grant is view-only; pair a control browser or use the native app');
        }
        if (isViewOnlyDevice && request.type === 'terminal.attach') {
            request = { ...request, params: { ...request.params, mode: 'observe' } } as ClientRequest;
        }
        if (isViewOnlyDevice && request.type === 'session.open') {
            try {
                const result = await openAgent(source, { ...request.params, acknowledgeAttention: false });
                return fromUseCase(request.requestId, result);
            } catch (error) {
                return fromCaught(request.requestId, error);
            }
        }
        if (request.type === 'plugin.list') {
            try {
                return fromUseCase(request.requestId, await runPluginAction(source, { action: 'list', deviceId }));
            } catch (error) {
                return fromCaught(request.requestId, error);
            }
        }
        if (isPluginExecutionRequest(request)) {
            try {
                if (request.type === 'plugin.approve') {
                    // The approval store is the owner: its per-provider
                    // fence and mutation hook fire inside this call.
                    return fromUseCase(request.requestId, await runPluginAction(source, { action: 'approve', deviceId, ...request.params }));
                }
                if (request.type === 'plugin.invoke') {
                    return fromUseCase(request.requestId, await runPluginAction(source, { action: 'invoke', deviceId, ...request.params }));
                }
                if (request.type === 'plugin.stream') {
                    return fromUseCase(request.requestId, await runPluginAction(source, { action: 'stream', deviceId, ...request.params }));
                }
                return fromUseCase(request.requestId, await runPluginAction(source, { action: 'call', deviceId, ...request.params }));
            } catch (error) {
                return fromCaught(request.requestId, error);
            }
        }
        if (request.type === 'terminal.detach' && authenticatedSenderId !== undefined) {
            try {
                await closeTerminal(options.terminals, { channel: request.params.channel, deviceId: authenticatedSenderId });
                return ok(request.requestId, null);
            } catch (error) {
                return fromCaught(request.requestId, error);
            }
        }
        const handler = handlers[request.type as NonPeerRequestType] as Handler<typeof request.type> | undefined;
        if (handler === undefined) {
            return fail(
                request.requestId,
                `host/APK contract mismatch: host has no handler for request type '${String(request.type)}'`,
                'host-contract-mismatch',
            );
        }
        try {
            const data = await handler(request.params, { deviceId, requestId: request.requestId, peerAdmitted });
            return ok(request.requestId, data);
        } catch (error: unknown) {
            return fromCaught(request.requestId, error);
        }
    }

    async function dispatchPeerWatch(request: Extract<ClientRequest, { type: 'agent.watch' }>): Promise<RequestResponse> {
        const { peerMutation: _peerMutation, ...params } = request.params;
        const result = await watchAgentLifecycle(source, { ...params, correlatedWait: true });
        return fromUseCase(request.requestId, result);
    }

    return {
        async dispatch(request, authenticatedSenderId): Promise<RequestResponse> {
            const deviceId = authenticatedSenderId ?? 'local';
            const context = options.getDeviceContext?.(deviceId);
            if (request.type.startsWith('peer.')) {
                if (options.peerRuntime === undefined) {
                    return fail(request.requestId, 'peer runtime is unavailable on this host', 'host-contract-mismatch');
                }
                if (!grantMayAdministerPeers(context?.kind, options.canMutateDevice?.(deviceId) !== false)) {
                    if (context?.kind === 'peer') {
                        return fail(request.requestId, 'peer grants cannot administer peer relationships', 'peer-forbidden');
                    }
                    return fail(request.requestId, 'this device grant is view-only; pair a control browser or use the native app');
                }
                try {
                    return ok(request.requestId, await options.peerRuntime.handle(request as PeerClientRequest, deviceId));
                } catch (error) {
                    return fromCaught(request.requestId, error);
                }
            }
            if (context?.kind === 'peer') {
                if (options.peerRuntime === undefined || authenticatedSenderId === undefined) {
                    return fail(request.requestId, 'peer runtime is unavailable on this host', 'peer-forbidden');
                }
                return options.peerRuntime.dispatchIncoming(
                    request,
                    authenticatedSenderId,
                    context,
                    () => {
                        if (request.type === 'agent.watch') return dispatchPeerWatch(request);
                        return dispatchCore(request, authenticatedSenderId, true);
                    },
                );
            }
            return dispatchCore(request, authenticatedSenderId);
        },
    };
}
