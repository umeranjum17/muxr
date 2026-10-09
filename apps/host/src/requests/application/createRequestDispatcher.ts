import { EngineRefused } from '@desklink/host';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type {
    ClientRequest,
    PeerClientRequest,
    PeerRequestType,
    PlanProviderAccounts,
    PreviewPresence,
    RequestMap,
    RequestResponse,
    RequestResult,
    RequestType,
} from '@trymuxr/contract';
import { machineHello, sanitizeRequestErrorMessage } from '@trymuxr/contract';
import type { AgentWatchStores, SessionSource, TerminalManager } from '../../agent/index.js';
import { changesBrowse, changesList, changesPatch, changesWorktrees } from '../../agent/index.js';
import { filesList, filesRead, filesRepos } from '../../files/index.js';
import { historyLog, historyShow } from '../../files/index.js';
import { presentAttachmentItems } from '../../attachments/index.js';
import {
    answerAgent,
    closeTerminal,
    focusAgent,
    listAgents,
    openAgent,
    promptAgent,
    readAgentSession,
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
import { landWorktree } from '../infrastructure/landWorktree.js';
import { listDir } from '../infrastructure/listDir.js';
import {
    PLAN_LABELS,
    acknowledgeAutoTerms,
    listPlans,
    withPlanAccounts,
    planAccountStatus,
    planLaunchEnv,
    planPaneAccount,
    planAccounts,
    cancelPlanSignIn,
    finishPlanSignIn,
    preparePlanSignIn,
    rememberPlanPane,
    rememberSignInTab,
    removePlanAccount,
    signInTab,
    forgetSignInTab,
    withPlanSignIn,
    renamePlanAccount,
    resolvePlanRecord,
    resolvePlanLaunch,
    loadPlanAccounts,
} from '../../plans/index.js';
import { repairHost } from '../infrastructure/repairHost.js';
import { runMachineShell } from '../infrastructure/runMachineShell.js';
import { deviceCapabilities, withPreview, type DevicePreviewTargets } from '../../desktop/index.js';
import type { DesktopSessions } from '../../desktop/index.js';
import { AgentCatalog } from './agentCatalog.js';

export interface RequestDispatcherOptions {
    agentCatalog?: AgentCatalog;
    source: SessionSource;
    domain: AgentWatchStores;
    machineId: string;
    machineName?: string;
    hostVersion: string;
    connectionMode?: string;
    pairedDeviceCount?: () => number;
    /** Distinguish local-only artifact preparation from hosted clients. */
    relayUrl?: string;
    terminals?: TerminalManager;
    /** Browser grants can observe but cannot mutate terminal/machine state. */
    canMutateDevice?: (deviceId: string) => boolean;
    peerRuntime?: PeerRuntime;
    getDeviceContext?: (deviceId: string) => PeerDeviceContext | undefined;
    /** The live-desktop owner. Absent means this host cannot show a desktop. */
    desktop?: DesktopSessions;
    /** Target routers for pane-owned devices (emulators, claimed simulators); absent means device targets are refused. */
    deviceTargets?: DevicePreviewTargets[];
    /** Announced device presence by pane, for stamping session lists. */
    devicePreviewForPane?: (paneId: string) => PreviewPresence | undefined;
    isDesktopConnectionActive?: (connectionId: string) => boolean;
}

type RequestContext = { deviceId: string; requestId: string; connectionId?: string };
type Handler<T extends RequestType> = (params: RequestMap[T]['params'], context: RequestContext) => Promise<RequestResult<T>>;
type NonPeerRequestType = Exclude<RequestType, PeerRequestType>;
const VIEW_ONLY_REQUESTS: ReadonlySet<RequestType> = new Set([
    'session.list', 'session.open', 'session.status',
    'herdr.tree', 'herdr.agentKinds', 'herdr.layout', 'pane.read', 'plugin.list', 'plugin.manifest',
    'applications.list',
    'artifact.list', 'artifact.fetch', 'artifact.read', 'unread.catalog',
    // The pre-rename spellings are the same read-only calls.
    'attachment.list', 'attachment.fetch', 'attachment.read',
    'attention.catalog', 'lifecycle.catalog', 'machines.list', 'machine.hello',
    'changes.list', 'changes.browse', 'changes.worktrees', 'changes.patch',
    'files.repos', 'files.list', 'files.read', 'history.log', 'history.show',
    'promptAttachments.list',
    'usage.report', 'usage.now',
    // Plan account names and emails are readable; changing them is a mutation.
    'plans.list', 'plans.agent',
    // Voice readiness is readable by every grant; changing a provider or its
    // key is a mutation and stays out of this set. The spoken report sentence
    // is derived without touching host state, so it stays readable too.
    'voice.status', 'voice.provider.list', 'voice.provider.describe', 'voice.report',
    'desktop.capabilities',
]);

export function viewOnlyRequestAllowed(request: ClientRequest): boolean {
    return VIEW_ONLY_REQUESTS.has(request.type);
}

function desktopOrThrow(options: RequestDispatcherOptions): DesktopSessions {
    if (options.desktop === undefined) throw new Error('This host has no desktop engine.');
    return options.desktop;
}

async function firstDeviceTarget<T>(
    options: RequestDispatcherOptions,
    attempt: (targets: DevicePreviewTargets) => Promise<T>,
): Promise<T> {
    let refusal: unknown;
    for (const targets of options.deviceTargets ?? []) {
        try {
            return await attempt(targets);
        } catch (error) {
            if ((error as { code?: unknown })?.code !== 'permission-denied') throw error;
            refusal = error;
        }
    }
    throw refusal ?? new EngineRefused('permission-denied', 'that session has no device to watch');
}

function deviceTargetFor(options: RequestDispatcherOptions, desktopId: string): DevicePreviewTargets | undefined {
    return options.deviceTargets?.find((targets) => targets.owns(desktopId));
}

function ok(requestId: string, data: unknown): RequestResponse {
    return { type: 'result', requestId, ok: true, data };
}

function fail(requestId: string, error: unknown, code?: string): RequestResponse {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
    return { type: 'result', requestId, ok: false, error: sanitizeRequestErrorMessage(raw), code: code ?? 'host-error' };
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
    close(): Promise<void>;
    refreshAgentCatalog(): void;
} {
    const { source, domain, machineId, hostVersion } = options;
    let planMoveInProgress = false;
    const agentCatalog = options.agentCatalog ?? new AgentCatalog(source);

    /** The session cwd is host-injected: a caller can never choose it. */
    const changesInput = async (sessionId: string, root?: string): Promise<{ sessionId: string; cwd: string; root?: string }> => {
        const sessions = await source.list();
        const cwd = sessions.find((session) => session.id === sessionId)?.cwd ?? '';
        if (cwd === '') throw new Error('No session directory for this session');
        return { sessionId, cwd, ...(root === undefined ? {} : { root }) };
    };

    const sessionCwds = (sessions: Awaited<ReturnType<SessionSource['list']>>): string[] =>
        sessions.map((session) => session.cwd ?? '').filter((cwd) => cwd !== '');

    /** Every repository open in some session; repository roots must be one of these, while a user-named folder passes selectedRoot's own checks. */
    const openRepoRoots = async (): Promise<string[]> => {
        const sessions = await source.list();
        return filesRepos(sessionCwds(sessions)).repos.map((repo) => repo.root);
    };

    /**
     * Like changesInput, but a session without a directory stays addressable:
     * files/history calls with an explicit open root (or none) answer from
     * the root or an empty state instead of throwing.
     */
    const filesInput = async (sessionId: string, root?: string): Promise<{ sessionId: string; cwd: string; root?: string }> => {
        const sessions = await source.list();
        const record = sessions.find((session) => session.id === sessionId);
        if (record === undefined) throw new Error('Unknown session');
        return { sessionId, cwd: record.cwd ?? '', ...(root === undefined ? {} : { root }) };
    };

    /** The accounts as last listed, which name the account on each agent in the tree. */
    let lastPlans: PlanProviderAccounts[] | undefined;

    /** An agent's route can change once it settles; its pane is what a plan account rides on. */
    const planPaneOf = async (sessionId: string): Promise<string> =>
        (await source.list()).find((session) => session.id === sessionId)?.paneId ?? sessionId;

    const rememberPane = async (paneId: string, accountId: string): Promise<void> => {
        const livePaneIds = (await source.list()).map((session) => session.paneId ?? session.id);
        rememberPlanPane(process.env, paneId, accountId, livePaneIds);
    };

    /** Close a sign-in tab muxr opened: its only pane, and the tab with it. */
    const closeSignInTab = async (accountId: string): Promise<string | undefined> => {
        const tab = signInTab(accountId);
        if (tab === undefined) return undefined;
        const session = (await source.list()).find((candidate) => candidate.paneId === tab || candidate.id === tab);
        if (session !== undefined) {
            let result = await source.stop(session.id, {});
            if (result.status === 'confirmationRequired' && result.scope === 'tab') {
                result = await source.stop(session.id, { confirmedScope: 'tab' });
            }
            if (result.status !== 'closed') {
                throw new Error("Couldn't close the sign-in tab. Try again.");
            }
        }
        forgetSignInTab(accountId, tab);
        return tab;
    };

    const handlers: { [K in NonPeerRequestType]: Handler<K> } = {
        'session.list': async (params) => {
            const listed = await listAgents(source, params.cwd === undefined ? {} : { cwd: params.cwd });
            if (!listed.ok) return useCaseData(listed);
            if (options.devicePreviewForPane !== undefined) return withPreview(listed.data, options.devicePreviewForPane);
            return useCaseData(listed);
        },
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
        // Files tree, previews, and git history are product code: the host
        // runs git, clients render. Same trust boundary as changes.* above.
        'files.repos': async () => {
            const sessions = await source.list();
            return filesRepos(sessionCwds(sessions));
        },
        'files.list': async (params) => filesList({
            ...(await filesInput(params.sessionId, params.root)),
            ...(params.path === undefined ? {} : { path: params.path }),
            allowedRoots: await openRepoRoots(),
        }),
        'files.read': async (params) => filesRead({
            ...(await filesInput(params.sessionId, params.root)),
            ...(params.path === undefined ? {} : { path: params.path }),
            allowedRoots: await openRepoRoots(),
        }),
        'history.log': async (params) => historyLog(await filesInput(params.sessionId)),
        'history.show': async (params) => historyShow({
            ...(await filesInput(params.sessionId)),
            ...(params.sha === undefined ? {} : { sha: params.sha }),
        }),
        // Prompt attachments are product code: the pill listing of the pane's
        // dump directory. Pane resolution comes from the session record, so a
        // client can never choose a dump directory; items open through the
        // artifact transports by content id.
        'promptAttachments.list': async (params) => {
            const listing = await source.artifactList(params);
            return presentAttachmentItems(listing.artifacts);
        },
        'session.start': async (params) => {
            const { peerMutation: _peerMutation, planAccount, planEnv: _planEnv, planUnset: _planUnset, signIn: _signIn, ...start } =
                params as typeof params & { planEnv?: unknown; planUnset?: unknown; signIn?: unknown };
            if (planAccount !== undefined && (start.kinds !== undefined || start.members !== undefined)) {
                throw Object.assign(
                    new Error('A squad cannot start on one plan account. Start its agents separately.'),
                    { code: 'plan-squad-unsupported' },
                );
            }
            const record = planAccount === undefined ? undefined : await resolvePlanLaunch(process.env, planAccount, start.kind);
            const launchEnv = record === undefined ? undefined : planLaunchEnv(process.env, record);
            const started = useCaseData(await startAgent({
                exists: existsSync,
                create: async (cwd) => { await mkdir(cwd, { recursive: true }); },
                start: (command) => source.start(command),
            }, {
                ...start,
                ...(launchEnv === undefined ? {} : { planEnv: launchEnv.set, planUnset: launchEnv.unset }),
            }));
            if (record !== undefined && 'info' in started) await rememberPane(started.info.paneId ?? started.info.id, record.id);
            return started;
        },
        'session.open': async (params) => useCaseData(await openAgent(source, params)),
        'herdr.tree': async () => withPlanAccounts(process.env, await source.herdrTree(), lastPlans),
        'applications.list': async () => source.applicationsList(),
        'applications.launch': async (params) => source.applicationsLaunch(params),
        'herdr.agentKinds': async (params) => agentCatalog.read(params.refresh),
        // Retired native UI runtime: keep replies safe for released apps.
        'plugin.list': async () => [],
        'plugin.manifest': async (params) => ({ schemaVersion: 1, pluginId: params.pluginId, contributions: [] }),
        'plugin.approve': async () => { throw new Error('plugins are no longer supported'); },
        'plugin.invoke': async () => { throw new Error('plugins are no longer supported'); },
        'plugin.call': async () => { throw new Error('plugins are no longer supported'); },
        'host.update': (params, context) => repairHost(params, context.deviceId),
        'desktop.capabilities': async (params) => {
            if (params.target !== undefined) {
                const sessionId = params.target.sessionId;
                await firstDeviceTarget(options, (targets) => targets.resolveTarget(sessionId));
                return deviceCapabilities();
            }
            if (options.desktop === undefined) {
                return { available: false, unavailableReason: 'This host has no desktop engine.', input: false, clipboard: false };
            }
            return options.desktop.capabilities();
        },
        'desktop.open': async (params, context) => {
            const connectionId = context.connectionId;
            const owner = connectionId === undefined ? undefined : {
                connectionId,
                deviceId: context.deviceId,
                isConnected: () => options.isDesktopConnectionActive?.(connectionId) === true,
            };
            if (params.target !== undefined) {
                const sessionId = params.target.sessionId;
                return firstDeviceTarget(options, (targets) => targets.openTarget(sessionId, {
                    permissions: params.permissions,
                    ...(params.maxFps === undefined ? {} : { maxFps: params.maxFps }),
                    ...(params.loopbackTcp === true ? { loopbackTcp: true } : {}),
                }, owner === undefined ? undefined : { deviceId: owner.deviceId }));
            }
            if (options.desktop === undefined) {
                throw new Error('This host has no desktop engine.');
            }
            return options.desktop.open({
                permissions: params.permissions,
                ...(params.maxWidth === undefined ? {} : { maxWidth: params.maxWidth }),
                ...(params.maxHeight === undefined ? {} : { maxHeight: params.maxHeight }),
                ...(params.bitrateKbps === undefined ? {} : { bitrateKbps: params.bitrateKbps }),
                ...(params.maxFps === undefined ? {} : { maxFps: params.maxFps }),
                ...(params.loopbackTcp === true ? { loopbackTcp: true } : {}),
                ...(params.awaitConsent === true ? { awaitConsent: true } : {}),
            }, owner);
        },
        'desktop.answer': async (params, context) => {
            const device = deviceTargetFor(options, params.desktopId);
            if (device !== undefined) {
                return device.answer(params.desktopId, params.sdp, context.connectionId, context.deviceId);
            }
            return desktopOrThrow(options).answer(params.desktopId, params.sdp, context.connectionId, context.deviceId);
        },
        'desktop.candidate': async (params, context) => {
            const device = deviceTargetFor(options, params.desktopId);
            if (device !== undefined) {
                return device.candidate(
                    params.desktopId,
                    params.candidate,
                    params.sdpMid ?? null,
                    params.sdpMLineIndex ?? null,
                    context.connectionId,
                    context.deviceId,
                );
            }
            return desktopOrThrow(options).candidate(
                params.desktopId,
                params.candidate,
                params.sdpMid ?? null,
                params.sdpMLineIndex ?? null,
                context.connectionId,
                context.deviceId,
            );
        },
        'desktop.poll': async (params, context) => {
            const device = deviceTargetFor(options, params.desktopId);
            if (device !== undefined) {
                return device.poll(params.desktopId, params.cursor, context.connectionId, context.deviceId);
            }
            return desktopOrThrow(options).poll(params.desktopId, params.cursor, context.connectionId, context.deviceId);
        },
        'desktop.close': async (params, context) => {
            const device = deviceTargetFor(options, params.desktopId);
            if (device !== undefined) {
                return device.close(params.desktopId, context.connectionId, context.deviceId);
            }
            return desktopOrThrow(options).close(params.desktopId, context.connectionId, context.deviceId);
        },
        'herdr.cli': async (params) => {
            const result = await source.herdrCli(params.args, params.timeoutMs);
            await source.refreshHerdr();
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
        'machine.hello': async () => machineHello(machineId, hostVersion),
        'machine.shell': (params) => runMachineShell(params.command, params.cwd),
        'machine.listDir': (params) => listDir(params.path),
        'usage.report': (params) => collectUsage({
            ...(params.provider === undefined ? {} : { provider: params.provider }),
            ...(params.refresh === undefined ? {} : { refresh: params.refresh }),
        }),
        'usage.now': (params) => usageNow(process.env, { ...(params.refresh === undefined ? {} : { refresh: params.refresh }) }),
        'plans.list': async () => {
            const listed = await listPlans(process.env);
            lastPlans = listed.providers;
            return listed;
        },
        'plans.acknowledgeAutoTerms': async () => acknowledgeAutoTerms(process.env),
        'plans.rename': (params) => withPlanSignIn(params.accountId, () => renamePlanAccount(process.env, params.accountId, params.name)),
        'plans.remove': (params) => withPlanSignIn(params.accountId, async () => {
            await closeSignInTab(params.accountId);
            const removed = await removePlanAccount(process.env, params.accountId);
            finishPlanSignIn(params.accountId);
            return removed;
        }),
        'plans.move': async (params) => {
            if (planMoveInProgress) {
                throw Object.assign(new Error('Another move is in progress.'), { code: 'plan-move-in-progress' });
            }
            planMoveInProgress = true;
            try {
                const selected = resolvePlanRecord(process.env, params.accountId);
                const record = await resolvePlanLaunch(process.env, params.accountId, selected.provider);
                if (record === undefined) throw new Error('Sign in to that account before moving.');
                if (source.movePlanAccount === undefined) {
                    throw Object.assign(
                        new Error('This host cannot move between plan accounts yet; update the host first.'),
                        { code: 'host-contract-mismatch' },
                    );
                }
                const launchEnv = planLaunchEnv(process.env, record);
                if (record.found) {
                    if (record.provider === 'claude') launchEnv.set.CLAUDE_CONFIG_DIR = record.folder;
                    else launchEnv.set.CODEX_HOME = record.folder;
                }
                try {
                    const moved = await source.movePlanAccount({
                        sessionId: params.sessionId,
                        provider: record.provider,
                        folder: record.folder,
                        launchEnv,
                        resumeArgs: (kind, ref) => planAccounts(process.env).resumeArgs(kind, ref),
                    });
                    await rememberPane(await planPaneOf(moved.sessionId), record.id);
                    return moved;
                } catch (error) {
                    const exposed = error as { code?: unknown; paneId?: unknown };
                    if (typeof exposed.paneId === 'string') {
                        await rememberPane(exposed.paneId, record.id);
                    }
                    if ((error as { code?: unknown }).code === 'plan-move-start-failed') {
                        const name = record.name.trim() === '' ? PLAN_LABELS[record.provider] : record.name;
                        throw Object.assign(new Error(`Couldn't start on ${name}. The original conversation is still running. Try again.`), {
                            code: 'plan-move-start-failed',
                        });
                    }
                    throw error;
                }
            } finally {
                planMoveInProgress = false;
            }
        },
        'plans.add': async (params) => {
            if (params.accountId !== undefined && resolvePlanRecord(process.env, params.accountId).provider !== params.provider) {
                throw Object.assign(new Error('That account belongs to another provider.'), { code: 'plan-kind-mismatch' });
            }
            const prepare = async (folder: string, provider: string) => {
                const folderVar = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
                const result = await source.herdrCli(['integration', 'install', provider], 15_000, { [folderVar]: folder });
                if (result.exitCode !== 0 || result.timedOut) throw new Error('Account hook preparation failed.');
            };
            const prepared = params.accountId === undefined ? await preparePlanSignIn(process.env, params.provider, undefined, prepare) : undefined;
            const accountId = params.accountId ?? prepared!.record.id;
            return withPlanSignIn(accountId, async () => {
                let attemptPrepared = prepared !== undefined;
                let pendingId = accountId;
                try {
                    await closeSignInTab(accountId);
                    const { record, launch } = prepared ?? await preparePlanSignIn(process.env, params.provider, accountId, prepare);
                    attemptPrepared = true;
                    pendingId = record.id;
                    await closeSignInTab(record.id);
                    const started = useCaseData(await startAgent({
                        exists: existsSync,
                        create: async (cwd) => { await mkdir(cwd, { recursive: true }); },
                        start: (command) => source.start(command),
                    }, { cwd: homedir(), ...launch }));
                    if (!('info' in started)) throw new Error(`Couldn't open ${PLAN_LABELS[record.provider]} sign-in. Try again.`);
                    rememberSignInTab(record.id, started.info.paneId ?? started.info.id);
                    return { accountId: record.id, sessionId: started.info.id };
                } catch (error) {
                    if (attemptPrepared) await cancelPlanSignIn(process.env, pendingId).catch(() => undefined);
                    throw error;
                }
            });
        },
        'plans.status': (params) => withPlanSignIn(params.accountId, async () => {
            const status = await planAccountStatus(process.env, params.accountId);
            if (status.account.signedIn) {
                await closeSignInTab(params.accountId);
                finishPlanSignIn(params.accountId);
            }
            const tab = signInTab(params.accountId);
            if (status.account.signedIn || status.failure !== undefined || tab === undefined) return status;
            const open = (await source.list()).some((session) => session.paneId === tab || session.id === tab);
            return open ? status : { ...status, failure: 'The sign-in tab was closed before you signed in.' };
        }),
        'plans.cancel': (params) => withPlanSignIn(params.accountId, async () => {
            const tab = await closeSignInTab(params.accountId);
            if (tab === undefined) return { removed: false };
            return cancelPlanSignIn(process.env, params.accountId);
        }),
        'plans.agent': async (params) => ({
            ...planPaneAccount(process.env, await planPaneOf(params.sessionId)),
            ...(source.canMovePlanAccount === undefined ? {} : { movable: await source.canMovePlanAccount(params.sessionId) }),
        }),
        'voice.status': () => voiceStatus(),
        'voice.provider.list': () => voiceProviderList(),
        'voice.provider.set': (params) => voiceProviderSet(params.providerId),
        'voice.provider.describe': (params) => voiceProviderDescribe(params.providerId),
        'voice.key.set': async (params) => { await voiceKeySet(params.key, params.provider); return null; },
        'voice.key.clear': async (params) => { await voiceKeyClear(params.provider); return null; },
        // The spoken sentence is derived from the outcome here, never by the caller.
        'voice.report': async (params) => voiceReport(params),
        'worktree.land': (params) => landWorktree(params.worktreePath, params.message, params.stash),
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
        if (isViewOnlyDevice && !viewOnlyRequestAllowed(request)) {
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
        refreshAgentCatalog: () => agentCatalog.refresh(),
        /** Lab-script teardown: the dispatcher owns no handles itself, so this
         *  cascades to the session source it dispatches against. Idempotent
         *  through the source's own dispose. */
        async close(): Promise<void> {
            await options.source.dispose();
        },
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
