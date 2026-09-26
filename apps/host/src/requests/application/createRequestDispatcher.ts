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
import type { AgentWatchStores, SessionSource, TerminalManager } from '../../agent/index.js';
import { changesBrowse, changesList, changesPatch, changesWorktrees } from '../../agent/index.js';
import {
    answerAgent,
    closeTerminal,
    focusAgent,
    listAgents,
    openAgent,
    promptAgent,
    readAgentSession,
    runPluginAction,
    startAgent,
    stopAgent,
    watchAgentLifecycle,
} from '../../agent/index.js';
import type { PeerDeviceContext, PeerRuntime } from '../../peer/index.js';
import { grantMayAdministerPeers, hostPlatformLabel, listMachines, observerGrantIsViewOnly } from '../../machine/index.js';
import { collectUsage, usageNow } from '../../usage/index.js';
import {
    voiceKeyClear,
    voiceKeySet,
    voiceProviderDescribe,
    voiceProviderList,
    voiceProviderSet,
    voiceReport,
    voiceStatus,
} from '../../voice/index.js';
import { attachPreview as attachPreviewTransport } from '../infrastructure/preview.js';
import { landWorktree } from '../infrastructure/landWorktree.js';
import { listDir } from '../infrastructure/listDir.js';
import { repairHost } from '../infrastructure/repairHost.js';
import { runMachineShell } from '../infrastructure/runMachineShell.js';
import { runHerdrCli } from '../infrastructure/runHerdrCli.js';
import { attachPreviewTunnel } from './attachPreviewTunnel.js';
import type { DesktopSessions } from '../../desktop/index.js';

export interface RequestDispatcherOptions {
    source: SessionSource;
    domain: AgentWatchStores;
    machineId: string;
    machineName?: string;
    hostVersion: string;
    connectionMode?: string;
    pairedDeviceCount?: () => number;
    /** Where to join preview channels. Absent means preview is unavailable. */
    relayUrl?: string;
    /** Hosted E2EE never permits clear preview payloads from older clients. */
    requirePreviewEncryption?: boolean;
    terminals?: TerminalManager;
    token?: string;
    /** Browser grants can observe but cannot mutate terminal/machine state. */
    canMutateDevice?: (deviceId: string) => boolean;
    peerRuntime?: PeerRuntime;
    getDeviceContext?: (deviceId: string) => PeerDeviceContext | undefined;
    /** The live-desktop owner. Absent means this host cannot show a desktop. */
    desktop?: DesktopSessions;
    isDesktopConnectionActive?: (connectionId: string) => boolean;
}

type RequestContext = { deviceId: string; requestId: string; connectionId?: string };
type Handler<T extends RequestType> = (params: RequestMap[T]['params'], context: RequestContext) => Promise<RequestResult<T>>;
type NonPeerRequestType = Exclude<RequestType, PeerRequestType>;
type PluginExecutionRequest = Extract<ClientRequest, {
    type: 'plugin.approve' | 'plugin.invoke' | 'plugin.call' | 'plugin.stream';
}>;

const VIEW_ONLY_REQUESTS: ReadonlySet<RequestType> = new Set([
    'session.list', 'session.open', 'session.status',
    'herdr.tree', 'herdr.agentKinds', 'herdr.layout', 'pane.read', 'plugin.list', 'plugin.manifest',
    'applications.list',
    'artifact.list', 'artifact.fetch', 'artifact.read', 'unread.catalog',
    // The pre-rename spellings are the same read-only calls.
    'attachment.list', 'attachment.fetch', 'attachment.read',
    'attention.catalog', 'lifecycle.catalog', 'machines.list',
    'changes.list', 'changes.browse', 'changes.worktrees', 'changes.patch',
    'usage.report', 'usage.now',
    // Voice readiness is readable by every grant; changing a provider or its
    // key is a mutation and stays out of this set. The spoken report sentence
    // is derived without touching host state, so it stays readable too.
    'voice.status', 'voice.provider.list', 'voice.provider.describe', 'voice.report',
    'desktop.capabilities',
]);

export function viewOnlyRequestAllowed(request: ClientRequest, source: SessionSource): boolean {
    return VIEW_ONLY_REQUESTS.has(request.type)
        || (request.type === 'plugin.call' && source.pluginRpcMode?.(request.params) === 'read');
}

function desktopOrThrow(options: RequestDispatcherOptions): DesktopSessions {
    if (options.desktop === undefined) throw new Error('This host has no desktop engine.');
    return options.desktop;
}

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
    dispatch(request: ClientRequest, authenticatedSenderId?: string, connectionId?: string): Promise<RequestResponse>;
} {
    const { source, domain, machineId, hostVersion } = options;

    /** The session cwd is host-injected: a caller can never choose it. */
    const changesInput = async (sessionId: string, root?: string): Promise<{ sessionId: string; cwd: string; root?: string }> => {
        const sessions = await source.list();
        const cwd = sessions.find((session) => session.id === sessionId)?.cwd ?? '';
        if (cwd === '') throw new Error('No session directory for this session');
        return { sessionId, cwd, ...(root === undefined ? {} : { root }) };
    };

    const handlers: { [K in NonPeerRequestType]: Handler<K> } = {
        'session.list': async (params) => useCaseData(
            await listAgents(source, params.cwd === undefined ? {} : { cwd: params.cwd }),
        ),
        'changes.list': async (params) => changesList(await changesInput(params.sessionId, params.root)),
        'changes.browse': async (params) => changesBrowse({
            ...(await changesInput(params.sessionId, params.root)),
            ...(params.scope === undefined ? {} : { scope: params.scope }),
            ...(params.page === undefined ? {} : { page: params.page }),
        }),
        'changes.worktrees': async (params) => changesWorktrees(await changesInput(params.sessionId)),
        'changes.patch': async (params) => changesPatch({
            ...(await changesInput(params.sessionId, params.root)),
            path: params.path,
            ...(params.scope === undefined ? {} : { scope: params.scope }),
            ...(params.kind === undefined ? {} : { kind: params.kind }),
            ...(params.head === undefined ? {} : { head: params.head }),
            ...(params.base === undefined ? {} : { base: params.base }),
        }),
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
        'applications.list': async () => source.applicationsList(),
        'applications.launch': async (params) => source.applicationsLaunch(params),
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
        'desktop.capabilities': async () => {
            if (options.desktop === undefined) {
                return { available: false, unavailableReason: 'This host has no desktop engine.', input: false, clipboard: false };
            }
            return options.desktop.capabilities();
        },
        'desktop.open': async (params, context) => {
            if (options.desktop === undefined) {
                throw new Error('This host has no desktop engine.');
            }
            const connectionId = context.connectionId;
            return options.desktop.open({
                permissions: params.permissions,
                ...(params.maxWidth === undefined ? {} : { maxWidth: params.maxWidth }),
                ...(params.maxHeight === undefined ? {} : { maxHeight: params.maxHeight }),
                ...(params.bitrateKbps === undefined ? {} : { bitrateKbps: params.bitrateKbps }),
                ...(params.maxFps === undefined ? {} : { maxFps: params.maxFps }),
                ...(params.loopbackTcp === true ? { loopbackTcp: true } : {}),
                ...(params.awaitConsent === true ? { awaitConsent: true } : {}),
            }, connectionId === undefined ? undefined : {
                connectionId,
                deviceId: context.deviceId,
                isConnected: () => options.isDesktopConnectionActive?.(connectionId) === true,
            });
        },
        'desktop.answer': async (params, context) => desktopOrThrow(options).answer(params.desktopId, params.sdp, context.connectionId, context.deviceId),
        'desktop.candidate': async (params, context) => desktopOrThrow(options).candidate(
            params.desktopId,
            params.candidate,
            params.sdpMid ?? null,
            params.sdpMLineIndex ?? null,
            context.connectionId,
            context.deviceId,
        ),
        'desktop.poll': async (params, context) => desktopOrThrow(options).poll(params.desktopId, params.cursor, context.connectionId, context.deviceId),
        'desktop.close': async (params, context) => desktopOrThrow(options).close(params.desktopId, context.connectionId, context.deviceId),
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
            return await source.createTab(params.sessionId, { ...(params.kind === undefined ? {} : { kind: params.kind }), ...(params.label === undefined ? {} : { label: params.label }) });
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
        'herdr.rename': async (params) => {
            await source.rename(params.target, params.id, params.name);
            return null;
        },
        'session.answer': async (params) => useCaseData(await answerAgent(source, params)),
        'pane.zoom': (params) => source.paneZoom(params),
        'session.stop': async (params) => useCaseData(await stopAgent(
            { sessions: source }, {
                sessionId: params.sessionId,
                action: 'stop',
                ...(params.confirmedScope === undefined ? {} : { confirmedScope: params.confirmedScope }),
            },
        )),
        'session.abort': async (params) => useCaseData(await stopAgent(
            { sessions: source }, { sessionId: params.sessionId, action: 'abort' },
        )),
        'session.reload': async (params) => useCaseData(await stopAgent(
            { sessions: source }, { sessionId: params.sessionId, action: 'reload' },
        )),
        'session.prompt': async ({ peerMutation: _peerMutation, ...params }) =>
            useCaseData(await promptAgent(source, params)),
        'session.status': async (params) => useCaseData(
            await readAgentSession(source, { view: 'status', sessionId: params.sessionId }),
        ) as Awaited<ReturnType<SessionSource['status']>>,
        'session.shell': (params) => source.shell(params),
        'session.readFile': async (params) => useCaseData(
            await readAgentSession(source, { view: 'file', sessionId: params.sessionId, path: params.path }),
        ) as { content: string },
        'session.saveAttachments': (params) => source.saveAttachments(params),
        'artifact.list': (params) => source.artifactList(params),
        'artifact.fetch': (params) => source.artifactFetch(params),
        'artifact.prepare': (params) => {
            if (options.relayUrl === undefined) throw new Error('artifact.prepare is local-only; hosted clients use encrypted artifact.read chunks');
            return source.artifactPrepare(params);
        },
        'artifact.read': (params) => source.artifactRead(params),
        // Deprecated wire compatibility: an app built before the artifact rename
        // asks for attachment.* with an attachmentId and reads an `attachments`
        // listing. Answer it from the same code with the old shapes.
        'attachment.list': async (params) => {
            const listing = await source.artifactList(params);
            return { attachments: listing.artifacts, total: listing.total, truncated: listing.truncated };
        },
        'attachment.fetch': (params) => source.artifactFetch({ sessionId: params.sessionId, artifactId: params.attachmentId }),
        'attachment.prepare': (params) => {
            if (options.relayUrl === undefined) throw new Error('artifact.prepare is local-only; hosted clients use encrypted artifact.read chunks');
            return source.artifactPrepare({ sessionId: params.sessionId, artifactId: params.attachmentId });
        },
        'attachment.read': (params) => source.artifactRead({
            sessionId: params.sessionId,
            artifactId: params.attachmentId,
            offset: params.offset,
            length: params.length,
        }),
        'unread.catalog': async () => domain.unread.catalog(),
        'unread.acknowledge': async (params) => domain.unread.acknowledge(params.sessionId, params.throughSeq),
        'attention.catalog': async () => domain.attention.catalog(),
        'lifecycle.catalog': async () => domain.lifecycle.catalog(),
        'machines.list': async () => listMachines({
            machineId,
            ...(options.machineName === undefined ? {} : { machineName: options.machineName }),
            hostVersion,
            platform: hostPlatformLabel(),
            ...(options.connectionMode === undefined ? {} : { connectionMode: options.connectionMode }),
            ...(options.pairedDeviceCount === undefined ? {} : { pairedDeviceCount: options.pairedDeviceCount() }),
        }).data,
        'machine.shell': (params) => runMachineShell(params.command, params.cwd),
        'machine.listDir': (params) => listDir(params.path),
        'usage.report': (params) => collectUsage({
            report: true,
            ...(params.provider === undefined ? {} : { provider: params.provider }),
            ...(params.refresh === undefined ? {} : { refresh: params.refresh }),
        }),
        'usage.now': (params) => usageNow(process.env, { ...(params.refresh === undefined ? {} : { refresh: params.refresh }) }),
        'voice.status': () => voiceStatus(),
        'voice.provider.list': () => voiceProviderList(),
        'voice.provider.set': (params) => voiceProviderSet(params.providerId),
        'voice.provider.describe': (params) => voiceProviderDescribe(params.providerId),
        'voice.key.set': async (params) => { await voiceKeySet(params.key, params.provider); return null; },
        'voice.key.clear': async (params) => { await voiceKeyClear(params.provider); return null; },
        // The spoken sentence is derived from the outcome here, never by the caller.
        'voice.report': async (params) => voiceReport(params),
        'worktree.land': (params) => landWorktree(params.worktreePath, params.message, params.stash),
        'preview.attach': async (params) => useCaseData(await attachPreviewTunnel({
            ...(options.relayUrl === undefined ? {} : { relayUrl: options.relayUrl }),
            machineId,
            ...(options.token === undefined ? {} : { token: options.token }),
            ...(options.requirePreviewEncryption === undefined ? {} : { requireEncryption: options.requirePreviewEncryption }),
            attach: attachPreviewTransport,
        }, params)),
        'terminal.attach': async () => { throw new Error('terminal attach requires a link stream'); },
        'terminal.detach': async (params) => {
            await closeTerminal(options.terminals, params);
            return null;
        },
        // A device registers its push address over the link only; the relay
        // transport has no device identity a push store could trust.
        'push.subscribe': async () => { throw new Error('push registration needs the link transport'); },
        'push.unsubscribe': async () => { throw new Error('push registration needs the link transport'); },
        'push.vapid': async () => { throw new Error('push registration needs the link transport'); },
    };

    async function dispatchCore(request: ClientRequest, authenticatedSenderId?: string, connectionId?: string): Promise<RequestResponse> {
        const deviceId = authenticatedSenderId ?? 'local';
        const isViewOnlyDevice = observerGrantIsViewOnly(
            options.getDeviceContext?.(deviceId)?.kind,
            options.canMutateDevice?.(deviceId) !== false,
        );
        if (isViewOnlyDevice && !viewOnlyRequestAllowed(request, source)) {
            return fail(request.requestId, 'this device grant is view-only; pair a control browser or use the native app');
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
            const data = await handler(request.params, { deviceId, requestId: request.requestId, ...(connectionId === undefined ? {} : { connectionId }) });
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
        async dispatch(request, authenticatedSenderId, connectionId): Promise<RequestResponse> {
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
                        return dispatchCore(request, authenticatedSenderId, connectionId);
                    },
                );
            }
            return dispatchCore(request, authenticatedSenderId, connectionId);
        },
    };
}
