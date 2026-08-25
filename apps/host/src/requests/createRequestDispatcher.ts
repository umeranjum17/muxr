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
import type { DomainStores } from '../domain/index.js';
import type { TerminalManager } from '../herdr/terminalManager.js';
import type { SessionSource } from '../sessionSource.js';
import type { PeerDeviceContext, PeerRuntime } from '../peer/runtime.js';
import { attachPreview, probePreviewPort } from './preview.js';
import { landWorktree } from './landWorktree.js';
import { listDir } from './listDir.js';
import { runMachineShell } from './runMachineShell.js';
import { runHerdrCli } from './runHerdrCli.js';

export interface RequestDispatcherOptions {
    source: SessionSource;
    domain: DomainStores;
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
        'machines.list': async () => [
            {
                machineId,
                ...(options.machineName?.trim() ? { name: options.machineName.trim() } : {}),
                online: true,
                hostVersion,
                platform: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform,
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
            const readOnly = options.getDeviceContext?.(deviceId)?.kind !== 'peer'
                && options.canMutateDevice?.(deviceId) === false;
            const readOnlyRequests = new Set<RequestType>([
                'session.list', 'session.open', 'session.status',
                'herdr.tree', 'herdr.agentKinds', 'herdr.layout', 'pane.read', 'plugin.list', 'plugin.manifest', 'voice.provider.list',
                'attachment.fetch', 'attachment.read', 'unread.catalog',
                'attention.catalog', 'machines.list', 'terminal.attach',
            ]);
            // A read-only browser may still call read-mode plugin RPCs (Usage,
            // Files, Git history); write RPCs, invokes, and streams stay fenced.
            const readOnlyPluginRead = readOnly && request.type === 'plugin.call'
                && source.pluginRpcMode?.(request.params) === 'read';
            if (readOnly && !readOnlyRequests.has(request.type) && !readOnlyPluginRead) {
                return { type: 'result', requestId: request.requestId, ok: false, error: 'this device grant is view-only; pair a control browser or use the native app' };
            }
            if (readOnly && request.type === 'terminal.attach') {
                request = { ...request, params: { ...request.params, mode: 'observe' } } as ClientRequest;
            }
            if (readOnly && request.type === 'session.open') {
                try { return { type: 'result', requestId: request.requestId, ok: true, data: await source.open({ ...request.params, acknowledgeAttention: false }) }; }
                catch (error) { return { type: 'result', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
            }
            if (request.type === 'plugin.list') {
                try { return { type: 'result', requestId: request.requestId, ok: true, data: await source.pluginList(deviceId) }; }
                catch (error) { return { type: 'result', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
            }
            if (request.type === 'plugin.approve' || request.type === 'plugin.invoke' || request.type === 'plugin.call' || request.type === 'plugin.stream') {
                try {
                    if (request.type === 'plugin.approve') await source.pluginApprove({ ...request.params, deviceId });
                    else if (request.type === 'plugin.invoke') await source.pluginInvoke({ ...request.params, deviceId });
                    else if (request.type === 'plugin.stream') return { type: 'result', requestId: request.requestId, ok: true, data: await source.pluginStream({ ...request.params, deviceId }) };
                    else return { type: 'result', requestId: request.requestId, ok: true, data: await source.pluginCall({ ...request.params, deviceId }) };
                    return { type: 'result', requestId: request.requestId, ok: true, data: null };
                } catch (error) { return { type: 'result', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
            }
            if (request.type === 'terminal.detach' && authenticatedSenderId !== undefined) {
                try {
                    options.terminals?.detach(request.params.channel, authenticatedSenderId);
                    return { type: 'result', requestId: request.requestId, ok: true, data: null };
                } catch (error) {
                    return {
                        type: 'result',
                        requestId: request.requestId,
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            }
            // A client built against a newer contract can ask for a type this host
            // does not know (e.g. a newer APK request against an older host
            // release). Indexing the object yields undefined and the old code turned
            // that into `handler is not a function` -- a message that says nothing
            // actionable. Answer with a stable, parseable mismatch result instead.
            const handler = handlers[request.type as NonPeerRequestType] as Handler<typeof request.type> | undefined;
            if (handler === undefined) {
                return {
                    type: 'result',
                    requestId: request.requestId,
                    ok: false,
                    code: 'host-contract-mismatch',
                    error: `host/APK contract mismatch: host has no handler for request type '${String(request.type)}'`,
                };
            }
        try {
            const data = await handler(request.params);
            return { type: 'result', requestId: request.requestId, ok: true, data };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            // Structured rejection codes (deprecated-field, ...) ride the
            // result so a legacy client can tell the difference between
            // "this param is gone" and a plain runtime failure.
            const withCode = error as { code?: unknown };
            const code = typeof withCode.code === 'string' ? withCode.code : undefined;
            return { type: 'result', requestId: request.requestId, ok: false, error: message, ...(code === undefined ? {} : { code }) };
        }
    }

    async function dispatchPeerWatch(request: Extract<ClientRequest, { type: 'agent.watch' }>): Promise<RequestResponse> {
        const { peerMutation: _peerMutation, ...params } = request.params;
        const settlement = await source.agentWait(params);
        return { type: 'result', requestId: request.requestId, ok: true, data: { watching: true, settlement } };
    }

    return {
        async dispatch(request, authenticatedSenderId): Promise<RequestResponse> {
            const deviceId = authenticatedSenderId ?? 'local';
            const context = options.getDeviceContext?.(deviceId);
            if (request.type.startsWith('peer.')) {
                if (options.peerRuntime === undefined) {
                    return { type: 'result', requestId: request.requestId, ok: false, code: 'host-contract-mismatch', error: 'peer runtime is unavailable on this host' };
                }
                if (context?.kind === 'peer') {
                    return { type: 'result', requestId: request.requestId, ok: false, code: 'peer-forbidden', error: 'peer grants cannot administer peer relationships' };
                }
                if (options.canMutateDevice?.(deviceId) === false) {
                    return { type: 'result', requestId: request.requestId, ok: false, error: 'this device grant is view-only; pair a control browser or use the native app' };
                }
                try {
                    const data = await options.peerRuntime.handle(request as PeerClientRequest, deviceId);
                    return { type: 'result', requestId: request.requestId, ok: true, data };
                } catch (error) {
                    const code = (error as { code?: unknown }).code;
                    return {
                        type: 'result', requestId: request.requestId, ok: false,
                        error: error instanceof Error ? error.message : String(error),
                        ...(typeof code === 'string' ? { code } : {}),
                    };
                }
            }
            if (context?.kind === 'peer') {
                if (options.peerRuntime === undefined || authenticatedSenderId === undefined) {
                    return { type: 'result', requestId: request.requestId, ok: false, code: 'peer-forbidden', error: 'peer runtime is unavailable on this host' };
                }
                return options.peerRuntime.dispatchIncoming(
                    request,
                    authenticatedSenderId,
                    context,
                    () => request.type === 'agent.watch'
                        ? dispatchPeerWatch(request)
                        : dispatchCore(request, authenticatedSenderId),
                );
            }
            return dispatchCore(request, authenticatedSenderId);
        },
    };
}

