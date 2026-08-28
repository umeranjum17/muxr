import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { MISSING_CWD_ERROR_PREFIX } from '@muxr/contract';
import type {
    ClientRequest,
    PeerClientRequest,
    PeerRequestType,
    RequestMap,
    RequestResponse,
    RequestResult,
    RequestType,
} from '@muxr/contract';
import type { AgentWatchStores, SessionSource, TerminalManager } from '../../agent/index.js';
import type { PeerDeviceContext, PeerRuntime } from '../../peer/index.js';
import { grantMayAdministerPeers, hostPlatformLabel, observerGrantIsViewOnly } from '../../machine/index.js';
import { attachPreview, probePreviewPort } from '../infrastructure/preview.js';
import { landWorktree } from '../infrastructure/landWorktree.js';
import { listDir } from '../infrastructure/listDir.js';
import { runMachineShell } from '../infrastructure/runMachineShell.js';
import { runHerdrCli } from '../infrastructure/runHerdrCli.js';

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

export function createRequestDispatcher(options: RequestDispatcherOptions): {
    dispatch(request: ClientRequest, authenticatedSenderId?: string): Promise<RequestResponse>;
} {
    const { source, domain, machineId, hostVersion } = options;

    const handlers: { [K in NonPeerRequestType]: Handler<K> } = {
        'session.list': (params) =>
            source.list(params.cwd === undefined ? {} : { cwd: params.cwd }),
        'session.start': async (params) => {
            const { peerMutation: _peerMutation, ...start } = params;
            // Pi journals a new session under the requested cwd's slug and only
            // later refuses to run in a directory that never existed, leaving an
            // orphan session file behind. Settle the directory before starting.
            if (!existsSync(start.cwd)) {
                if (start.createCwd !== true) {
                    throw new Error(`${MISSING_CWD_ERROR_PREFIX}${start.cwd}`);
                }
                await mkdir(start.cwd, { recursive: true });
            }
            return source.start(start);
        },
        'session.open': (params) => source.open(params),
        'herdr.tree': async () => source.herdrTree(),
        'herdr.agentKinds': async () => {
            const kinds = await source.agentKinds();
            return { kinds, installed: await source.installedAgentKinds(kinds) };
        },
        'plugin.list': () => { throw new Error('authenticated device context required'); },
        'plugin.manifest': (params) => source.pluginManifest(params),
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
        'pane.read': (params) => source.paneRead(params),
        'agent.watch': ({ peerMutation: _peerMutation, ...params }) => source.agentWatch(params),
        'layout.export': (params) => source.layoutExport(params.sessionId),
        'layout.apply': (params) => source.layoutApply(params),
        'pane.focus': async (params) => {
            await source.paneFocus(params.sessionId);
            return null;
        },
        'pane.focusNeighbor': async (params) => {
            await source.focusNeighbor(params.sessionId, params.direction);
            return null;
        },
        'tab.focusNeighbor': async (params) => {
            await source.focusTabNeighbor(params.sessionId, params.direction);
            return null;
        },
        'workspace.focusNeighbor': async (params) => {
            await source.focusWorkspaceNeighbor(params.sessionId, params.direction);
            return null;
        },
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
        'session.answer': async (params) => {
            // The agent's y/n prompt is answered by typing the literal key.
            await source.sendKeys(params.sessionId, [params.answer]);
            return null;
        },
        'pane.zoom': (params) => source.paneZoom(params),
        'session.stop': async (params) => {
            options.terminals?.detachSession(params.sessionId);
            await source.stop(params.sessionId);
            return null;
        },
        'session.abort': async (params) => {
            await source.abort(params.sessionId);
            return null;
        },
        'session.reload': async (params) => {
            await source.reload(params.sessionId);
            return null;
        },
        'session.prompt': async ({ peerMutation: _peerMutation, ...params }) => {
            await source.prompt(params);
            return null;
        },
        'session.status': (params) => source.status(params.sessionId),
        'session.shell': (params) => source.shell(params),
        'session.readFile': (params) => source.readFile(params),
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
        'machines.list': async () => [
            {
                machineId,
                ...(options.machineName?.trim() ? { name: options.machineName.trim() } : {}),
                online: true,
                hostVersion,
                platform: hostPlatformLabel(),
                lastSeenAt: new Date().toISOString(),
            },
        ],
        'machine.shell': (params) => runMachineShell(params.command, params.cwd),
        'machine.listDir': (params) => listDir(params.path),
        'worktree.land': (params) => landWorktree(params.worktreePath, params.message, params.stash),
        'preview.probe': async (params) => ({ contentType: await probePreviewPort(params.port) }),
        'preview.attach': (params) => {
            if (options.relayUrl === undefined) {
                throw new Error('preview: host has no relay url');
            }
            if (options.requirePreviewEncryption === true && params.key === undefined) {
                throw new Error('preview: update the app to use encrypted preview');
            }
            return attachPreview({
                relayUrl: options.relayUrl,
                machineId,
                channel: params.channel,
                port: params.port,
                ...(params.key === undefined ? {} : { key: params.key }),
                ...(options.token === undefined ? {} : { token: options.token }),
            });
        },
        'terminal.attach': (params) => {
            if (options.terminals === undefined) throw new Error('terminal: not available on this host');
            return options.terminals.attach(params);
        },
        'terminal.detach': async (params) => {
            options.terminals?.detach(params.channel);
            return null;
        },
    };

    async function dispatchCore(request: ClientRequest, authenticatedSenderId?: string): Promise<RequestResponse> {
            const deviceId = authenticatedSenderId ?? 'local';
            const isViewOnlyDevice = observerGrantIsViewOnly(
                options.getDeviceContext?.(deviceId)?.kind,
                options.canMutateDevice?.(deviceId) !== false,
            );
            const readOnlyRequests = new Set<RequestType>([
                'session.list', 'session.open', 'session.status',
                'herdr.tree', 'herdr.agentKinds', 'herdr.layout', 'pane.read', 'plugin.list', 'plugin.manifest', 'voice.provider.list',
                'attachment.fetch', 'attachment.read', 'unread.catalog',
                'attention.catalog', 'lifecycle.catalog', 'machines.list', 'terminal.attach',
            ]);
            const viewOnlyPluginRead = isViewOnlyDevice && request.type === 'plugin.call'
                && source.pluginRpcMode?.(request.params) === 'read';
            if (isViewOnlyDevice && !readOnlyRequests.has(request.type) && !viewOnlyPluginRead) {
                return fail(request.requestId, 'this device grant is view-only; pair a control browser or use the native app');
            }
            if (isViewOnlyDevice && request.type === 'terminal.attach') {
                request = { ...request, params: { ...request.params, mode: 'observe' } } as ClientRequest;
            }
            if (isViewOnlyDevice && request.type === 'session.open') {
                try { return ok(request.requestId, await source.open({ ...request.params, acknowledgeAttention: false })); }
                catch (error) { return fromCaught(request.requestId, error); }
            }
            if (request.type === 'plugin.list') {
                try { return ok(request.requestId, await source.pluginList(deviceId)); }
                catch (error) { return fromCaught(request.requestId, error); }
            }
            if (request.type === 'plugin.approve' || request.type === 'plugin.invoke' || request.type === 'plugin.call' || request.type === 'plugin.stream') {
                try {
                    if (request.type === 'plugin.approve') {
                        await source.pluginApprove({ ...request.params, deviceId });
                        return ok(request.requestId, null);
                    }
                    if (request.type === 'plugin.invoke') {
                        await source.pluginInvoke({ ...request.params, deviceId });
                        return ok(request.requestId, null);
                    }
                    if (request.type === 'plugin.stream') {
                        return ok(request.requestId, await source.pluginStream({ ...request.params, deviceId }));
                    }
                    return ok(request.requestId, await source.pluginCall({ ...request.params, deviceId }));
                } catch (error) {
                    return fromCaught(request.requestId, error);
                }
            }
            if (request.type === 'terminal.detach' && authenticatedSenderId !== undefined) {
                try {
                    options.terminals?.detach(request.params.channel, authenticatedSenderId);
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
        const settlement = await source.agentWait(params);
        return ok(request.requestId, { watching: true, settlement });
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
