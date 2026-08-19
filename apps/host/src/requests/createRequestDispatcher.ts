import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { MISSING_CWD_ERROR_PREFIX } from '@muxr/contract';
import type {
    ClientRequest,
    RequestMap,
    RequestResponse,
    RequestResult,
    RequestType,
} from '@muxr/contract';
import type { DomainStores } from '../domain/index.js';
import type { TerminalManager } from '../herdr/terminalManager.js';
import type { SessionSource } from '../sessionSource.js';
import { attachPreview, listPreviewServers } from './preview.js';
import { landWorktree } from './landWorktree.js';
import { listDir } from './listDir.js';
import { runMachineShell } from './runMachineShell.js';
import { runHerdrCli } from './runHerdrCli.js';

export interface RequestDispatcherOptions {
    source: SessionSource;
    domain: DomainStores;
    machineId: string;
    hostVersion: string;
    /** Where to join preview channels. Absent means preview is unavailable. */
    relayUrl?: string;
    terminals?: TerminalManager;
    token?: string;
    /** Browser grants can observe but cannot mutate terminal/machine state. */
    canMutateDevice?: (deviceId: string) => boolean;
}

type Handler<T extends RequestType> = (params: RequestMap[T]['params']) => Promise<RequestResult<T>>;

export function createRequestDispatcher(options: RequestDispatcherOptions): {
    dispatch(request: ClientRequest, authenticatedSenderId?: string): Promise<RequestResponse>;
} {
    const { source, domain, machineId, hostVersion } = options;

    const handlers: { [K in RequestType]: Handler<K> } = {
        'session.list': (params) =>
            source.list(params.cwd === undefined ? {} : { cwd: params.cwd }),
        'session.start': async (params) => {
            // Pi journals a new session under the requested cwd's slug and only
            // later refuses to run in a directory that never existed, leaving an
            // orphan session file behind. Settle the directory before starting.
            if (!existsSync(params.cwd)) {
                if (params.createCwd !== true) {
                    throw new Error(`${MISSING_CWD_ERROR_PREFIX}${params.cwd}`);
                }
                await mkdir(params.cwd, { recursive: true });
            }
            return source.start(params);
        },
        'session.open': (params) => source.open(params),
        'herdr.tree': async () => source.herdrTree(),
        'herdr.agentKinds': async () => ({ kinds: await source.agentKinds() }),
        'plugin.list': () => { throw new Error('authenticated device context required'); },
        'plugin.manifest': (params) => source.pluginManifest(params),
        'plugin.approve': () => { throw new Error('authenticated device context required'); },
        'plugin.invoke': () => { throw new Error('authenticated device context required'); },
        'plugin.call': () => { throw new Error('authenticated device context required'); },
        'plugin.stream': () => { throw new Error('authenticated device context required'); },
        'herdr.cli': async (params) => {
            const result = await runHerdrCli(params.args, params.timeoutMs);
            await source.refreshHerdr();
            await source.refreshPlugins?.();
            return result;
        },
        'herdr.layout': async (params) => ({ layout: await source.herdrLayout(params.tabId) }),
        'pane.split': (params) => source.paneSplit(params),
        'pane.read': (params) => source.paneRead(params),
        'agent.watch': (params) => source.agentWatch(params),
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
        'session.prompt': async (params) => {
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
            { machineId, online: true, hostVersion, lastSeenAt: new Date().toISOString() },
        ],
        'machine.shell': (params) => runMachineShell(params.command, params.cwd),
        'machine.listDir': (params) => listDir(params.path),
        'worktree.land': (params) => landWorktree(params.worktreePath, params.message, params.stash),
        'preview.list': (params) => {
            if (options.relayUrl === undefined) throw new Error('Hosted Preview is disabled until browser trust and pinning are complete.');
            return listPreviewServers(relayPort(options.relayUrl), params.cwd);
        },
        'preview.attach': (params) => {
            if (options.relayUrl === undefined) {
                throw new Error('preview: host has no relay url');
            }
            return attachPreview({
                relayUrl: options.relayUrl,
                machineId,
                channel: params.channel,
                port: params.port,
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

    return {
        async dispatch(request, authenticatedSenderId): Promise<RequestResponse> {
            const deviceId = authenticatedSenderId ?? 'local';
            const readOnly = options.canMutateDevice?.(deviceId) === false;
            const readOnlyRequests = new Set<RequestType>([
                'session.list', 'session.open', 'session.status',
                'herdr.tree', 'herdr.agentKinds', 'herdr.layout', 'pane.read', 'plugin.list', 'plugin.manifest',
                'attachment.fetch', 'attachment.read', 'unread.catalog',
                'attention.catalog', 'machines.list', 'terminal.attach',
            ]);
            // A read-only browser may still call read-mode plugin RPCs (Usage,
            // Files, Git history); write RPCs, invokes, and streams stay fenced.
            const readOnlyPluginRead = readOnly && request.type === 'plugin.call'
                && source.pluginRpcMode?.(request.params) === 'read';
            if (readOnly && !readOnlyRequests.has(request.type) && !readOnlyPluginRead) {
                return { type: 'result', requestId: request.requestId, ok: false, error: 'browser grant is read-only; use the native app for control' };
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
            const handler = handlers[request.type] as Handler<typeof request.type> | undefined;
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
        },
    };
}

/** The relay answers HTTP too, so without this it lists itself as a dev server. */
function relayPort(relayUrl: string | undefined): number | undefined {
    if (relayUrl === undefined) return undefined;
    try {
        const port = new URL(relayUrl).port;
        return port === '' ? undefined : Number(port);
    } catch {
        return undefined;
    }
}
