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
import { landWorktree } from '../infrastructure/landWorktree.js';
import { listDir } from '../infrastructure/listDir.js';
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
    peerRuntime?: PeerRuntime;
    getDeviceContext?: (deviceId: string) => PeerDeviceContext | undefined;
}

type Handler<T extends RequestType> = (params: RequestMap[T]['params']) => Promise<RequestResult<T>>;
type NonPeerRequestType = Exclude<RequestType, PeerRequestType>;
type PluginExecutionRequest = Extract<ClientRequest, {
    type: 'plugin.approve' | 'plugin.invoke' | 'plugin.call' | 'plugin.stream';
}>;

const VIEW_ONLY_REQUESTS: ReadonlySet<RequestType> = new Set([
    'session.list', 'session.open', 'session.status',
    'herdr.tree', 'herdr.agentKinds', 'herdr.layout', 'pane.read', 'plugin.list', 'plugin.manifest', 'voice.provider.list',
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
        'voice.provider.list': () => source.voiceProviderList(),
        'voice.provider.select': (params) => source.voiceProviderSelect(params.providerId),
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
        'session.stop': async (params) => useCaseData(await stopAgent(
            { sessions: source, detachSession: (sessionId) => options.terminals?.detachSession(sessionId) },
            { sessionId: params.sessionId, action: 'stop' },
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
        'preview.attach': async (params) => useCaseData(await openPreview({
            ...(options.relayUrl === undefined ? {} : { relayUrl: options.relayUrl }),
            machineId,
            ...(options.token === undefined ? {} : { token: options.token }),
            ...(options.requirePreviewEncryption === undefined ? {} : { requireEncryption: options.requirePreviewEncryption }),
            attach: attachPreview,
        }, params)),
        'terminal.attach': async (params) => useCaseData(await openTerminal(options.terminals, params)),
        'terminal.detach': async (params) => {
            await closeTerminal(options.terminals, params);
            return null;
        },
    };

    async function dispatchCore(request: ClientRequest, authenticatedSenderId?: string): Promise<RequestResponse> {
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
            const data = await handler(request.params);
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
                        return dispatchCore(request, authenticatedSenderId);
                    },
                );
            }
            return dispatchCore(request, authenticatedSenderId);
        },
    };
}
