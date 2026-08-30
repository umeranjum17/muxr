/**
 * The herdr session source: SessionSource implemented against the herdr socket.
 *
 * Herdr owns the PTYs and knows the agents; this file owns the translation to
 * muxr sessions and the push of contract events. The app also sees
 * agents it did not start -- anything herdr detects on the bus gets a session
 * row, which is the point of a multiplexer backend.
 */

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type {
    AgentLifecycle,
    CloseResult,
    PluginsInvalidatedFrame,
    HerdrTreeWorkspace,
    LayoutSnapshot,
    PromptAttachment,
    RealtimePluginPublicContext,
    SessionEventBody,
    SessionInfo,
    SessionSnapshot,
    SessionStartResult,
    SessionStatus,
    VoiceProviderOption,
} from '@muxr/contract';
import { ATTENTION_REASONS, parseCloseResult, realtimePluginPublicContext, relayControlUrl } from '@muxr/contract';
import { AttachmentWatcher } from './attachmentWatcher.js';
import { AttachmentDownloadServer } from './attachmentDownloads.js';
import type { AgentWatchStores } from '../application/watchStores.js';
import type {
    SessionListOptions,
    SessionOpenOptions,
    SessionPromptOptions,
    SessionReadFileOptions,
    SessionShellOptions,
    SessionShellOutcome,
    SessionSource,
    SessionStartOptions,
    SessionStopOptions,
} from '../application/sessionSource.js';
import { HerdrClient } from './socketClient.js';
import {
    AgentRouteStore,
    herdrAgentSessionKey,
    parseHerdrAgentSession,
    type HerdrAgentSessionRef,
} from './agentRouteStore.js';
import { pluginInvalidationFrame, PluginCatalog, PluginRefreshGate, WriteReplayFence, Semaphore, rpcInputDigest, rpcReplayKey, runPluginProcess, type HerdrPlugin, type PluginBackendCallTarget } from './pluginCatalog.js';
import { PluginApprovals } from './pluginApprovals.js';
import { PluginStreamManager } from './pluginStreamManager.js';
import {
    RealtimeCodingCoordinator,
    type RealtimeCodingAgent,
    type RealtimePromptDiagnostic,
} from './realtimeCoordinator.js';
import type { HostedMachineKeys } from '../../machine/index.js';
import type { PeerBroker } from '../../peer/index.js';
import { MAX_RPC_CONCURRENCY, MAX_RPC_INPUT_BYTES, MAX_RPC_PER_DEVICE, MAX_RPC_PER_PLUGIN, type PluginContextRequest } from '@muxr/contract';
import { buildPluginPublicContext, type PublicContextSource } from '../application/pluginPublicContext.js';
import {
    collectKinds,
    collectPaneIds,
    neighborId,
    toHerdrRoot,
    toSnapshot,
    type HerdrLayoutNode,
} from '../domain/layout.js';
import { rollupLifecycle } from '../domain/lifecycle.js';
import { reportAgentOutcome } from '../application/reportAgentOutcome.js';
import { agentKindsFromManifests } from '../domain/agentKinds.js';

const PLUGIN_CALL_QUEUE_TIMEOUT_MS = 8_000;
const MAX_PLUGIN_INVOCATIONS_PER_SCOPE = 64;
const MAX_PLUGIN_INVOCATIONS_TOTAL = 1_024;

function publicAgentKind(kind: string | undefined): string | undefined {
    return kind === undefined || kind === 'shell' ? undefined : kind;
}

const moduleRoot = dirname(fileURLToPath(import.meta.url));
function bundledPluginsDirectory(start: string): string | undefined {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
        const candidate = join(dir, 'plugins');
        if (existsSync(candidate)) return realpathSync(candidate);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}
const BROWSER_RPC_PLUGINS_ROOT = bundledPluginsDirectory(moduleRoot);
const AGENT_CLOSE_CAPABILITY = 'agent.close';
const AGENT_CLOSE_CONTRIBUTION_ID = 'close';
const AGENT_CLOSE_METHOD = 'close';
function packagedWorkspaceHierarchyRoot(): string | undefined {
    if (BROWSER_RPC_PLUGINS_ROOT === undefined) return undefined;
    const candidate = join(BROWSER_RPC_PLUGINS_ROOT, 'workspace-hierarchy');
    return existsSync(candidate) ? realpathSync(candidate) : undefined;
}
const WORKSPACE_HIERARCHY_PLUGIN_ROOT = packagedWorkspaceHierarchyRoot();

const COMMAND_ALIASES: Record<string, string[]> = {
    qodercli: ['qodercli', 'qoder'],
    mastracode: ['mastracode', 'mastra'],
    agy: ['agy', 'antigravity'],
    'antigravity-cli': ['antigravity-cli', 'antigravity'],
    kilo: ['kilo', 'kilocode'],
};

function execFileExitCode(error: { code?: unknown } | null): number | null {
    if (error === null) return 0;
    if (typeof error.code === 'number') return error.code;
    return null;
}

function executableOnPath(command: string): boolean {
    const candidates = COMMAND_ALIASES[command] ?? [command];
    const home = homedir();
    const directories = new Set([
        ...(process.env.PATH ?? '').split(delimiter),
        join(home, '.local', 'bin'),
        join(home, '.local', 'share', 'mise', 'shims'),
        join(home, '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
    ]);
    for (const directory of directories) {
        if (directory === '') continue;
        for (const candidate of candidates) {
            try { accessSync(join(directory, candidate), constants.X_OK); return true; }
            catch { /* keep looking */ }
        }
    }
    return false;
}

function decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
}

export interface CreateHerdrSessionSourceOptions {
    socketPath?: string;
    dataDir: string;
    attention?: AgentWatchStores['attention'];
    lifecycle?: AgentWatchStores['lifecycle'];
    routes?: AgentRouteStore;
    /** Relay HTTP base for best-effort push notify (ws://... -> http://...). */
    relayUrl?: string;
    machineId?: string;
    attachmentsDir?: string;
    hostHttpPort?: number;
    /** Machine token (MUXR_RELAY_TOKEN); authorizes /v1/push/notify. */
    token?: string;
    /** Strict hosted keys for provider-neutral plugin stream channels. */
    hostedE2ee?: HostedMachineKeys;
    /** Issues one revocable capability only to an approved voice.session child. */
    peerBroker?: PeerBroker;
    /** Writes bounded semantic prompt outcomes to the owner-only host diagnostics journal. */
    onRealtimePromptDiagnostic?: (event: RealtimePromptDiagnostic) => void;
    /** Privacy-safe route-generation and readiness outcomes only. */
    onAgentReadinessDiagnostic?: (reason: 'starting' | 'ready' | 'not-promptable', promptable: boolean) => void;
}

export interface AgentRecord {
    agent?: string | null;
    name?: string | null;
    display_agent?: string | null;
    agent_session?: HerdrAgentSessionRef | null;
    agent_status?: string;
    pane_id: string;
    tab_id?: string;
    workspace_id?: string;
    cwd?: string | null;
    foreground_cwd?: string | null;
    launch_pending?: boolean;
    interactive_ready?: boolean;
    title?: string | null;
    terminal_title?: string | null;
    terminal_title_stripped?: string | null;
}

/** Partial events preserve readiness unless Herdr explicitly supplies a replacement value. */
export function mergeHerdrAgentEvent(
    current: AgentRecord | undefined,
    incoming: AgentRecord,
): AgentRecord {
    return { ...current, ...incoming };
}

interface CurrentSession {
    sessionId: string;
    paneId: string;
    pane: PaneRecord;
    agent?: AgentRecord;
}

export interface RouteTarget {
    sessionId: string;
    paneId: string;
}
export async function sendKeysToLiveAgent(
    client: Pick<HerdrClient, 'call'>,
    target: RouteTarget,
    keys: string[],
): Promise<void> {
    await client.call('agent.send_keys', { target: target.paneId, keys });
}

export async function promptHerdrAgent(
    client: Pick<HerdrClient, 'call'>,
    target: RouteTarget,
    text: string,
): Promise<void> {
    const receipt = await client.call<unknown>('agent.prompt', { target: target.paneId, text });
    const result = typeof receipt === 'object' && receipt !== null && !Array.isArray(receipt)
        ? receipt as Record<string, unknown>
        : undefined;
    const agent = typeof result?.agent === 'object' && result.agent !== null && !Array.isArray(result.agent)
        ? result.agent as Record<string, unknown>
        : undefined;
    if (result?.type !== 'agent_prompted'
        || typeof agent?.terminal_id !== 'string'
        || typeof agent.agent_status !== 'string'
        || typeof agent.workspace_id !== 'string'
        || typeof agent.tab_id !== 'string'
        || typeof agent.pane_id !== 'string'
        || typeof agent.focused !== 'boolean'
        || typeof agent.revision !== 'number'
        || !Number.isSafeInteger(agent.revision)
        || agent.revision < 0
        || agent.pane_id !== target.paneId) {
        throw new Error('Herdr did not queue the prompt.');
    }
}

function agentRouteError(code: 'agent-unavailable' | 'agent-not-ready' | 'agent-route-ambiguous'): Error {
    let message = 'That agent is no longer available. Refresh and try again.';
    if (code === 'agent-not-ready') message = 'Agent is not ready yet.';
    if (code === 'agent-route-ambiguous') {
        message = 'That Agent Route is ambiguous. Refresh and select the agent again.';
    }
    return Object.assign(new Error(message), { code });
}

/** Listed-agent gate. Omitted interactive_ready is ready when lifecycle is live. Starting stays closed. */
export function herdrAgentIsPromptable(
    agent: Pick<AgentRecord, 'interactive_ready' | 'launch_pending'>,
    lifecycle: AgentLifecycle,
): boolean {
    if (agent.launch_pending === true || agent.interactive_ready === false) return false;
    return lifecycle === 'idle' || lifecycle === 'working' || lifecycle === 'blocked' || lifecycle === 'done';
}

export async function promptPromptableHerdrAgent(
    client: Pick<HerdrClient, 'call'>,
    target: RouteTarget,
    promptable: boolean,
    text: string,
): Promise<void> {
    if (!promptable) throw agentRouteError('agent-not-ready');
    await promptHerdrAgent(client, target, text);
}

function herdrFailureCode(error: unknown): string | undefined {
    const message = error instanceof Error ? error.message : String(error);
    return /herdr: ([a-z0-9_]+):/i.exec(message)?.[1];
}

function unavailable(kind: 'pane' | 'tab' | 'workspace'): Error {
    return Object.assign(new Error(`That ${kind} is no longer available. Refresh and try again.`), {
        code: `${kind}-unavailable`,
    });
}

type LiveWorkspace = {
    workspace_id: string;
    tab_count?: number;
    worktree?: {
        repo_key?: string;
        repo_name?: string;
        is_linked_worktree?: boolean;
    };
};

function isParentWorktreeGroup(workspace: LiveWorkspace, workspaces: readonly LiveWorkspace[]): boolean {
    const worktree = workspace.worktree;
    if (worktree?.is_linked_worktree !== false || worktree.repo_key === undefined) return false;
    let size = 0;
    for (const candidate of workspaces) {
        if (candidate.worktree?.repo_key === worktree.repo_key) size += 1;
    }
    return size >= 2;
}

/** Close one pane only when live Herdr can preserve its tab and workspace. */
export async function closeExactPane(
    client: Pick<HerdrClient, 'call'>,
    paneId: string,
): Promise<void> {
    let pane: { tab_id?: string } | undefined;
    try {
        pane = (await client.call<{ pane?: { tab_id?: string } }>('pane.get', { pane_id: paneId })).pane;
    } catch (error) {
        if (herdrFailureCode(error) === 'pane_not_found') throw unavailable('pane');
        throw error;
    }
    if (pane?.tab_id === undefined) throw unavailable('pane');
    let paneCount = 0;
    try {
        paneCount = (await client.call<{ tab?: { pane_count?: number } }>('tab.get', { tab_id: pane.tab_id })).tab?.pane_count ?? 0;
    } catch (error) {
        if (herdrFailureCode(error) === 'tab_not_found') throw unavailable('pane');
        throw error;
    }
    if (paneCount <= 1) {
        throw Object.assign(new Error('Closing this pane would also close its tab. Use Close tab instead.'), {
            code: 'pane-close-would-widen',
        });
    }
    await client.call('pane.close', { pane_id: paneId });
}

/** Close one tab only when live Herdr can preserve its workspace. */
export async function closeExactTab(
    client: Pick<HerdrClient, 'call'>,
    tabId: string,
): Promise<void> {
    let tab: { workspace_id?: string } | undefined;
    try {
        tab = (await client.call<{ tab?: { workspace_id?: string } }>('tab.get', { tab_id: tabId })).tab;
    } catch (error) {
        if (herdrFailureCode(error) === 'tab_not_found') throw unavailable('tab');
        throw error;
    }
    if (tab?.workspace_id === undefined) throw unavailable('tab');
    let tabCount = 0;
    try {
        tabCount = (await client.call<{ workspace?: { tab_count?: number } }>('workspace.get', {
            workspace_id: tab.workspace_id,
        })).workspace?.tab_count ?? 0;
    } catch (error) {
        if (herdrFailureCode(error) === 'workspace_not_found') throw unavailable('tab');
        throw error;
    }
    if (tabCount <= 1) {
        throw Object.assign(new Error('Closing this tab would also close its workspace. Use Close workspace instead.'), {
            code: 'tab-close-would-widen',
        });
    }
    await client.call('tab.close', { tab_id: tabId });
}

/** Close one workspace, refusing Herdr's implicit parent-worktree group widening. */
export async function closeExactWorkspace(
    client: Pick<HerdrClient, 'call'>,
    workspaceId: string,
): Promise<void> {
    let workspace: LiveWorkspace | undefined;
    try {
        workspace = (await client.call<{ workspace?: LiveWorkspace }>('workspace.get', {
            workspace_id: workspaceId,
        })).workspace;
    } catch (error) {
        if (herdrFailureCode(error) === 'workspace_not_found') throw unavailable('workspace');
        throw error;
    }
    if (workspace === undefined) throw unavailable('workspace');
    const workspaces = (await client.call<{ workspaces?: LiveWorkspace[] }>('workspace.list')).workspaces ?? [];
    if (isParentWorktreeGroup(workspace, workspaces)) {
        throw Object.assign(new Error('Closing this workspace would close its worktree group. Use the explicit Close worktree group action instead.'), {
            code: 'worktree-group-confirmation-required',
        });
    }
    await client.call('workspace.close', { workspace_id: workspaceId });
}

interface PaneRecord {
    pane_id: string;
    tab_id?: string;
    workspace_id?: string;
    cwd?: string | null;
    foreground_cwd?: string | null;
    agent_status?: string;
    terminal_title?: string | null;
    terminal_title_stripped?: string | null;
    label?: string | null;
    focused?: boolean;
    /** herdr display tokens; muxr stores lineage in `spawned_by`. */
    tokens?: Record<string, string>;
}

interface WorkspaceRecord {
    workspace_id: string;
    label?: string;
    focused?: boolean;
    worktree?: {
        repo_key?: string;
        repo_name?: string;
        repo_root?: string;
        checkout_path?: string;
        is_linked_worktree?: boolean;
    };
}

interface TabRecord {
    tab_id: string;
    workspace_id?: string;
    label?: string;
}

function mappedWorktree(
    worktree: WorkspaceRecord['worktree'],
    branch: string | undefined,
): { worktree?: { repo: string; branch?: string; path: string } } {
    if (worktree?.checkout_path === undefined) return {};
    return {
        worktree: {
            repo: worktree.repo_name ?? worktree.repo_root ?? 'repo',
            ...(branch === undefined ? {} : { branch }),
            path: worktree.checkout_path,
        },
    };
}

const EVENT_KINDS = [
    // pane.agent_status_changed is deliberately NOT here: it is a filtered
    // subscription (pane_id required) and one invalid kind rejects the whole
    // batch. Status transitions ride per-pane watches (watchPaneStatus).
    'pane.agent_detected',
    'pane.created',
    'pane.closed',
    'pane.moved',
    'pane.exited',
    'pane.updated',
    'workspace.created',
    'workspace.closed',
    'workspace.renamed',
    'workspace.updated',
    'tab.created',
    'tab.closed',
    'tab.renamed',
];

const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const SHELL_ROUTE_PREFIX = 'shell:';
const DEFAULT_WATCH_MS = 30 * 60_000;
// ponytail: hard ceiling so a forgotten watch cannot hold a herdr connection
// open forever. Raise it if real turns routinely run longer than an hour.
const MAX_WATCH_MS = 60 * 60_000;

export function resolveClosePaneId(options: {
    sessionId: string;
    currentAgentPaneIds?: readonly string[];
    rememberedPaneId?: string;
    paneExists: (paneId: string) => boolean;
    paneHasAgent: (paneId: string) => boolean;
}): string | undefined {
    const unownedPane = (paneId: string | undefined): string | undefined =>
        paneId !== undefined && options.paneExists(paneId) && !options.paneHasAgent(paneId)
            ? paneId
            : undefined;
    if (options.sessionId.startsWith(SHELL_ROUTE_PREFIX)) {
        return unownedPane(options.sessionId.slice(SHELL_ROUTE_PREFIX.length));
    }
    const currentAgentPaneIds = options.currentAgentPaneIds ?? [];
    if (currentAgentPaneIds.length > 1) throw agentRouteError('agent-route-ambiguous');
    const currentAgentPaneId = currentAgentPaneIds[0];
    if (currentAgentPaneId !== undefined && options.paneExists(currentAgentPaneId)) {
        return currentAgentPaneId;
    }
    return unownedPane(options.rememberedPaneId);
}

export function isRetryableCloseFailure(error: unknown): boolean {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PluginCallDeadlineError' || name === 'PluginCallQueueTimeoutError') return true;
    const message = error instanceof Error ? error.message : String(error);
    return /busy, retry|timed out|EACCES|ECONNREFUSED|ECONNRESET|ENOENT|ETIMEDOUT|server_not_running|connection closed|client closed|not running|EPIPE|connect E/i.test(message);
}

export async function createHerdrSessionSource(
    options: CreateHerdrSessionSourceOptions,
): Promise<SessionSource> {
    const socketPath = options.socketPath ?? join(homedir(), '.config', 'herdr', 'herdr.sock');
    const routes = options.routes ?? new AgentRouteStore(options.dataDir);
    await routes.load();
    const catalog = new PluginCatalog();
    const pluginApprovals = new PluginApprovals(options.dataDir);
    await pluginApprovals.load();
    const pluginInvocations = new Map<string, Promise<void>>();
    let codingCoordinator: RealtimeCodingCoordinator | undefined;
    let pluginStreams: PluginStreamManager | undefined;
    if (options.relayUrl !== undefined && options.machineId !== undefined) {
        codingCoordinator = new RealtimeCodingCoordinator(join(options.dataDir, 'realtime-coding.sock'), {
            list: listRealtimeAgents,
            activity: async () => options.lifecycle?.catalog().events ?? [],
            start: startRealtimeAgent,
            sendKeys: sendSessionKeys,
            prompt: promptSession,
            read: readSessionOutput,
            status: async (sessionId) => statusFor(sessionId).agentStatus ?? 'unknown',
            watch: waitForAgent,
            focus: focusSession,
        }, options.onRealtimePromptDiagnostic);
        await codingCoordinator.start();
        pluginStreams = new PluginStreamManager({
            relayUrl: options.relayUrl,
            machineId: options.machineId,
            ...(options.token === undefined ? {} : { token: options.token }),
            ...(options.hostedE2ee === undefined ? {} : { hostedE2ee: options.hostedE2ee }),
            ...(options.peerBroker === undefined ? {} : { peerBroker: options.peerBroker }),
            codingCoordinator,
        });
    }
    /** Write-mode RPC replay fence: successful outcomes retained five minutes; rejections dropped; pending writes never evicted. */
    const writeReplayFence = new WriteReplayFence();
    /** Global cap plus admission caps so one plugin or device cannot fill its queue. */
    const pluginCallConcurrency = new Semaphore(MAX_RPC_CONCURRENCY);
    const activePluginCalls = new Map<string, number>();
    const activeDeviceCalls = new Map<string, number>();

    const listeners = new Set<(sessionId: string, event: SessionEventBody) => void>();
    const machineListeners = new Set<(frame: PluginsInvalidatedFrame) => void>();
    const agentsByPane = new Map<string, AgentRecord>();
    const panesById = new Map<string, PaneRecord>();
    /** Last pane authorized by an Agent Route. It survives a vanished agent
     * record while that pane remains live, so close can ask Herdr for truth. */
    const paneByAgentRoute = new Map<string, string>();
    const workspacesById = new Map<string, WorkspaceRecord>();
    const tabsById = new Map<string, TabRecord>();
    /** Local lifecycle epochs stop an older in-flight snapshot replacing a newer status event. */
    const lifecycleEpochByPane = new Map<string, number>();
    /** Last emitted signatures per session, so snapshots publish only real changes. */
    const lastStateSignature = new Map<string, string>();
    const lastInfoSignature = new Map<string, string>();
    /** pane_id -> close fn for its filtered status subscription. */
    const statusWatches = new Map<string, () => void>();

    /** Stamp a freshly spawned pane with who asked for it. Best effort. */
    const lastPromptableBySession = new Map<string, boolean>();
    async function tagSpawn(paneId: string, parentSessionId: string): Promise<void> {
        await client
            .call('pane.report_metadata', {
                pane_id: paneId,
                source: 'muxr',
                tokens: { spawned_by: parentSessionId },
            })
            .catch(() => {});
    }
    /** One in-flight agent.watch per session; re-arming replaces the old one. */
    const watches = new Map<string, ReturnType<typeof setTimeout>>();
    let pluginPollTimer: NodeJS.Timeout | undefined;
    let pluginDigests: Map<string, string> | undefined;
    let pluginEnabled = new Map<string, boolean>();

    const knownShells = new Set<string>();

    function agentSession(agent: AgentRecord | undefined): HerdrAgentSessionRef | undefined {
        return parseHerdrAgentSession(agent?.agent_session);
    }

    function namedAgent(agent: AgentRecord | undefined): agent is AgentRecord {
        return agentSession(agent) !== undefined && typeof agent?.name === 'string' && agent.name.length > 0
            && !/^pph?_/i.test(agent.name);
    }

    function shellRoute(paneId: string): string {
        return `${SHELL_ROUTE_PREFIX}${paneId}`;
    }

    function currentAgentRecordsFor(agentSessionRef: HerdrAgentSessionRef): AgentRecord[] {
        const expectedKey = herdrAgentSessionKey(agentSessionRef);
        return [...agentsByPane.values()].filter((agent) => {
            const ref = agentSession(agent);
            return ref !== undefined && herdrAgentSessionKey(ref) === expectedKey;
        });
    }

    function currentAgentRecordFor(agentSessionRef: HerdrAgentSessionRef): AgentRecord | undefined {
        const matches = currentAgentRecordsFor(agentSessionRef);
        return matches.length === 1 ? matches[0] : undefined;
    }

    function currentAgentFor(agentSessionRef: HerdrAgentSessionRef): AgentRecord | undefined {
        const match = currentAgentRecordFor(agentSessionRef);
        return namedAgent(match) ? match : undefined;
    }

    function closePaneId(sessionId: string): string | undefined {
        const expected = routes.get(sessionId);
        const currentPaneIds = expected === undefined
            ? []
            : currentAgentRecordsFor(expected).map((agent) => agent.pane_id);
        const rememberedPaneId = paneByAgentRoute.get(sessionId);
        return resolveClosePaneId({
            sessionId,
            currentAgentPaneIds: currentPaneIds,
            ...(rememberedPaneId === undefined ? {} : { rememberedPaneId }),
            paneExists: (paneId) => panesById.has(paneId),
            paneHasAgent: (paneId) => agentsByPane.has(paneId),
        });
    }

    function currentSessions(): CurrentSession[] {
        const sessions: CurrentSession[] = [];
        for (const binding of routes.all()) {
            const agent = currentAgentFor(binding.agentSession);
            const pane = agent === undefined ? undefined : panesById.get(agent.pane_id);
            if (agent !== undefined && pane !== undefined) {
                sessions.push({ sessionId: binding.route, paneId: pane.pane_id, pane, agent });
            }
        }
        for (const pane of panesById.values()) {
            if (!agentsByPane.has(pane.pane_id)) {
                sessions.push({ sessionId: shellRoute(pane.pane_id), paneId: pane.pane_id, pane });
            }
        }
        return sessions;
    }

    function currentSession(sessionId: string): CurrentSession | undefined {
        if (sessionId.startsWith(SHELL_ROUTE_PREFIX)) {
            const paneId = sessionId.slice(SHELL_ROUTE_PREFIX.length);
            const pane = panesById.get(paneId);
            return pane === undefined || agentsByPane.has(paneId)
                ? undefined
                : { sessionId, paneId, pane };
        }
        const expected = routes.get(sessionId);
        if (expected === undefined) return undefined;
        const agent = currentAgentFor(expected);
        const pane = agent === undefined ? undefined : panesById.get(agent.pane_id);
        return agent === undefined || pane === undefined
            ? undefined
            : { sessionId, paneId: pane.pane_id, pane, agent };
    }

    function currentSessionByPane(paneId: string): CurrentSession | undefined {
        return currentSessions().find((session) => session.paneId === paneId);
    }

    function agentPromptable(session: CurrentSession | undefined): boolean {
        if (session?.agent === undefined) return false;
        const ref = agentSession(session.agent);
        const bound = routes.get(session.sessionId);
        return ref !== undefined
            && bound !== undefined
            && herdrAgentSessionKey(ref) === herdrAgentSessionKey(bound)
            && herdrAgentIsPromptable(session.agent, lifecycleOf(session));
    }

    /** Herdr boundary adapter: Task Title comes only from current AgentInfo.title. */
    function taskTitleForSession(session: CurrentSession): string | undefined {
        return session.agent?.title ?? undefined;
    }

    function setLifecycle(paneId: string, agentStatus: string): void {
        const agent = agentsByPane.get(paneId);
        if (agent !== undefined) agentsByPane.set(paneId, { ...agent, agent_status: agentStatus });
        const pane = panesById.get(paneId);
        if (pane !== undefined) panesById.set(paneId, { ...pane, agent_status: agentStatus });
        lifecycleEpochByPane.set(paneId, (lifecycleEpochByPane.get(paneId) ?? 0) + 1);
    }

    function ensureStatusWatch(paneId: string): void {
        if (statusWatches.has(paneId)) return;
        const close = client.watchPaneStatus(paneId, (agentStatus) => {
            setLifecycle(paneId, agentStatus);
            const session = currentSessionByPane(paneId);
            if (session !== undefined) emitState(session.sessionId);
        });
        statusWatches.set(paneId, close);
    }
    const modifiedBySession = new Map<string, string>();
    let resnapshotTimer: NodeJS.Timeout | undefined;

    function publish(sessionId: string, event: SessionEventBody): void {
        modifiedBySession.set(sessionId, new Date().toISOString());
        for (const listener of listeners) listener(sessionId, event);
    }

    function cwdForSession(sessionId: string): string | undefined {
        const session = currentSession(sessionId);
        return session?.agent?.foreground_cwd
            ?? session?.pane.foreground_cwd
            ?? session?.agent?.cwd
            ?? session?.pane.cwd
            ?? undefined;
    }

    /** Agent-dropped artifacts in the pane's dump dir. Listed on demand through the attachments plugin. */
    const attachmentsDir = options.attachmentsDir ?? join(homedir(), '.muxr', 'attachments', 'pane');
    const attachments = new AttachmentWatcher(attachmentsDir, () => {
        const frame: PluginsInvalidatedFrame = { type: 'plugins.invalidated', reason: 'changed', pluginIds: [] };
        for (const listener of machineListeners) listener(frame);
    });
    attachments.start();

    /** One-time tickets + byte streaming for downloads too big for the ws link. */
    const attachmentDownloads = new AttachmentDownloadServer(attachmentsDir, options.hostHttpPort ?? 8793, attachments);
    attachmentDownloads.start();

    function lifecycleOf(session: CurrentSession): AgentLifecycle {
        const raw = session.agent?.agent_status ?? session.pane.agent_status;
        if (raw === 'idle' || raw === 'working' || raw === 'blocked' || raw === 'done' || raw === 'failed') return raw;
        const historical = options.lifecycle?.current(session.sessionId)?.state;
        return historical === 'starting' || historical === 'failed' ? historical : 'unknown';
    }

    function lifecycleForPane(paneId: string): AgentLifecycle {
        const session = currentSessionByPane(paneId);
        if (session !== undefined) return lifecycleOf(session);
        const raw = agentsByPane.get(paneId)?.agent_status ?? panesById.get(paneId)?.agent_status;
        return raw === 'idle' || raw === 'working' || raw === 'blocked' || raw === 'done' || raw === 'failed'
            ? raw
            : 'unknown';
    }

    function transition(session: CurrentSession, state: AgentLifecycle, reason: Parameters<NonNullable<CreateHerdrSessionSourceOptions['lifecycle']>['transition']>[3]): void {
        if (session.agent?.name === undefined || session.agent.name === null) return;
        const event = options.lifecycle?.transition(
            session.sessionId,
            session.agent.name,
            state,
            reason,
            taskTitleForSession(session),
            session.agent.agent ?? undefined,
        );
        if (event !== undefined) publish(session.sessionId, { type: 'lifecycle.update', event });
    }

    function reportObserved(session: CurrentSession, state: AgentLifecycle): void {
        if (options.lifecycle === undefined || session.agent?.name === undefined || session.agent.name === null) return;
        const taskTitle = taskTitleForSession(session);
        const result = reportAgentOutcome(options.lifecycle, {
            sessionId: session.sessionId,
            agentName: session.agent.name,
            state,
            ...(session.agent.agent_status === undefined ? {} : { liveAgentStatus: session.agent.agent_status }),
            ...(options.lifecycle.latestFor(session.sessionId)?.reasonCode === undefined
                ? {}
                : { previousReason: options.lifecycle.latestFor(session.sessionId)!.reasonCode }),
            ...(taskTitle === undefined ? {} : { taskTitle }),
            ...(session.agent.agent === undefined || session.agent.agent === null ? {} : { agentKind: session.agent.agent }),
        });
        if (result.data !== undefined) publish(session.sessionId, { type: 'lifecycle.update', event: result.data });
    }

    function statusFor(sessionId: string): SessionStatus {
        const session = currentSession(sessionId);
        const agentStatus = session === undefined ? 'unknown' : lifecycleOf(session);
        return {
            sessionId,
            persisted: true,
            agentStatus,
            promptable: agentPromptable(session),
            isStreaming: agentStatus === 'working',
            tokens: { ...EMPTY_TOKENS },
        };
    }

    function infoFor(session: CurrentSession): SessionInfo {
        const workspaceId = session.agent?.workspace_id ?? session.pane.workspace_id;
        const tabId = session.agent?.tab_id ?? session.pane.tab_id;
        const workspace = workspaceId === undefined ? undefined : workspacesById.get(workspaceId);
        const tabLabel = tabId === undefined ? undefined : tabsById.get(tabId)?.label;
        const worktree = workspace?.worktree;
        const taskTitle = taskTitleForSession(session);
        const agentKind = session.agent?.agent ?? undefined;
        const displayAgent = session.agent?.display_agent ?? undefined;
        const terminalTitle = session.agent?.terminal_title_stripped ?? session.pane.terminal_title_stripped ?? undefined;
        const spawnedBy = session.pane.tokens?.spawned_by;
        return {
            id: session.sessionId,
            cwd: cwdForSession(session.sessionId) ?? '',
            messageCount: 0,
            firstMessage: '',
            promptable: agentPromptable(session),
            agentStatus: lifecycleOf(session),
            ...(session.agent?.name === undefined || session.agent.name === null ? {} : { agentName: session.agent.name }),
            ...(taskTitle === undefined ? {} : { taskTitle }),
            ...(agentKind === undefined ? {} : { agentKind }),
            ...(displayAgent === undefined ? {} : { displayAgent }),
            paneId: session.paneId,
            ...(workspaceId === undefined ? {} : { workspaceId }),
            ...(workspace?.label === undefined ? {} : { workspaceLabel: workspace.label }),
            ...(tabId === undefined ? {} : { tabId }),
            ...(tabLabel === undefined ? {} : { tabLabel }),
            ...(spawnedBy === undefined ? {} : { spawnedBy }),
            ...(terminalTitle === undefined ? {} : { terminalTitle }),
            ...mappedWorktree(worktree, workspace?.label),
        };
    }

    /**
     * Best-effort push notify when a session parks waiting for its user.
     * Fire-and-forget: never awaited in the hot path, never throws.
     */
    let pushNotifyUrl: string | undefined;
    if (options.relayUrl !== undefined && options.machineId !== undefined) {
        try {
            pushNotifyUrl = relayControlUrl(options.relayUrl, '/v1/push/notify');
        } catch {}
    }

    function notifyAttention(sessionId: string, eventId: string, kind: 'blocked' | 'done' | 'failed'): void {
        if (pushNotifyUrl === undefined || options.machineId === undefined) return;
        const lifecycle = options.lifecycle?.current(sessionId);
        const body = JSON.stringify({
            machineId: options.machineId,
            sessionId,
            eventId,
            kind,
            ...(lifecycle === undefined ? {} : { reasonCode: lifecycle.reasonCode }),
            ...(lifecycle?.agentName === undefined ? {} : { agentName: lifecycle.agentName }),
            ...(lifecycle?.taskTitle === undefined ? {} : { taskTitle: lifecycle.taskTitle }),
        });
        void fetch(pushNotifyUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
            },
            body,
            signal: AbortSignal.timeout(3000),
        }).catch(() => {});
    }

    function applyAttention(sessionId: string, agentStatus: AgentLifecycle): void {
        const attention = options.attention;
        if (attention === undefined) return;
        let changed = false;
        switch (agentStatus) {
            case 'blocked':
                changed = attention.clear(sessionId, 'failed') || changed;
                if (attention.set(sessionId, 'waiting', 'Agent needs attention.')) {
                    changed = true;
                    const eventId = options.lifecycle?.current(sessionId)?.eventId;
                    if (eventId !== undefined) notifyAttention(sessionId, eventId, 'blocked');
                }
                break;
            case 'done':
                changed = attention.clear(sessionId, 'waiting', 'failed') || changed;
                if (attention.set(sessionId, 'done', 'Agent finished.')) {
                    changed = true;
                    const eventId = options.lifecycle?.current(sessionId)?.eventId;
                    if (eventId !== undefined) notifyAttention(sessionId, eventId, 'done');
                }
                break;
            case 'working':
            case 'idle':
                changed = attention.clear(sessionId, 'waiting', 'done', 'failed') || changed;
                break;
            case 'unknown':
                changed = attention.clear(sessionId, 'waiting', 'done') || changed;
                break;
            case 'failed':
                changed = attention.clear(sessionId, 'waiting', 'done') || changed;
                if (attention.set(sessionId, 'failed', 'Agent failed.')) {
                    changed = true;
                    const eventId = options.lifecycle?.current(sessionId)?.eventId;
                    if (eventId !== undefined) notifyAttention(sessionId, eventId, 'failed');
                }
                break;
            case 'starting':
                break;
        }
        if (changed) publish(sessionId, { type: 'attention.update', catalog: attention.catalog() });
    }

    function clearAttention(sessionId: string): void {
        const attention = options.attention;
        if (attention === undefined) return;
        if (attention.clear(sessionId, ...ATTENTION_REASONS)) {
            publish(sessionId, { type: 'attention.update', catalog: attention.catalog() });
        }
    }

    function removeRouteState(sessionId: string): void {
        const watch = watches.get(sessionId);
        if (watch !== undefined) clearTimeout(watch);
        watches.delete(sessionId);
        pluginStreams?.closeSession(sessionId);
        options.lifecycle?.remove(sessionId);
        clearAttention(sessionId);
        lastStateSignature.delete(sessionId);
        lastInfoSignature.delete(sessionId);
        lastPromptableBySession.delete(sessionId);
        publish(sessionId, { type: 'session.removed' });
    }

    function emitState(sessionId: string): void {
        const session = currentSession(sessionId);
        if (session === undefined) return;
        const agentStatus = lifecycleOf(session);
        if (session.agent !== undefined) {
            const promptable = agentPromptable(session);
            if (lastPromptableBySession.get(sessionId) !== promptable) {
                lastPromptableBySession.set(sessionId, promptable);
                options.onAgentReadinessDiagnostic?.(promptable ? 'ready' : 'starting', promptable);
            }
        }
        const stateSignature = `${agentStatus}|${String(agentPromptable(session))}`;
        if (lastStateSignature.get(sessionId) !== stateSignature) {
            lastStateSignature.set(sessionId, stateSignature);
            publish(sessionId, { type: 'status.update', status: statusFor(sessionId) });
            publish(sessionId, {
                type: 'activity.update',
                activity: {
                    sessionId,
                    phase: agentStatus === 'working' ? 'active' : 'idle',
                    label: agentStatus,
                    at: new Date().toISOString(),
                },
            });
        }
        const info = infoFor(session);
        const signature = JSON.stringify(info);
        if (lastInfoSignature.get(sessionId) !== signature) {
            lastInfoSignature.set(sessionId, signature);
            publish(sessionId, { type: 'session.updated', session: info });
        }
        if (session.agent !== undefined) {
            reportObserved(session, agentStatus);
            applyAttention(sessionId, agentStatus);
        }
    }

    /** Bind routes to current Herdr generations and remove every vanished generation first. */
    async function syncDiscovery(): Promise<void> {
        const liveRefs = [...agentsByPane.values()].flatMap((agent) => {
            const ref = agentSession(agent);
            return ref === undefined ? [] : [ref];
        });
        for (const binding of routes.reconcile(liveRefs)) removeRouteState(binding.route);

        const createdRoutes: string[] = [];
        for (const agent of agentsByPane.values()) {
            ensureStatusWatch(agent.pane_id);
            if (!namedAgent(agent)) continue;
            const ref = agentSession(agent)!;
            const bound = routes.bind(ref);
            paneByAgentRoute.set(bound.route, agent.pane_id);
            if (bound.created) createdRoutes.push(bound.route);
        }
        for (const [route, paneId] of paneByAgentRoute) {
            if (!panesById.has(paneId)) paneByAgentRoute.delete(route);
        }
        for (const [paneId, close] of statusWatches) {
            if (agentsByPane.has(paneId)) continue;
            close();
            statusWatches.delete(paneId);
            lifecycleEpochByPane.delete(paneId);
            if (!panesById.has(paneId)) attachments.dropPane(paneId);
        }
        await routes.flush();

        const currentShells = new Set(
            [...panesById.values()]
                .filter((pane) => !agentsByPane.has(pane.pane_id))
                .map((pane) => shellRoute(pane.pane_id)),
        );
        for (const route of knownShells) {
            if (!currentShells.has(route)) removeRouteState(route);
        }
        for (const route of currentShells) {
            if (knownShells.has(route)) continue;
            const session = currentSession(route);
            if (session !== undefined) publish(route, { type: 'session.created', session: infoFor(session) });
        }
        knownShells.clear();
        for (const route of currentShells) knownShells.add(route);

        for (const route of createdRoutes) {
            const session = currentSession(route);
            if (session === undefined) continue;
            publish(route, { type: 'session.created', session: infoFor(session) });
            emitState(route);
        }

        const liveSessionIds = new Set(currentSessions().map((session) => session.sessionId));
        const attention = options.attention;
        if (attention !== undefined) {
            for (const entry of attention.catalog().entries) {
                if (liveSessionIds.has(entry.sessionId)) continue;
                if (attention.clear(entry.sessionId)) {
                    publish(entry.sessionId, { type: 'attention.update', catalog: attention.catalog() });
                }
            }
        }
    }

    async function refreshSnapshot(): Promise<void> {
        const lifecycleEpochAtStart = new Map(lifecycleEpochByPane);
        const result = await client.call<{
            snapshot?: {
                agents?: AgentRecord[];
                panes?: PaneRecord[];
                workspaces?: WorkspaceRecord[];
                tabs?: TabRecord[];
            };
        }>('session.snapshot');
        const nextAgents = new Map<string, AgentRecord>();
        const nextPanes = new Map<string, PaneRecord>();
        for (const incoming of result.snapshot?.agents ?? []) {
            const changedWhileReading = lifecycleEpochByPane.get(incoming.pane_id) !== lifecycleEpochAtStart.get(incoming.pane_id);
            const currentStatus = agentsByPane.get(incoming.pane_id)?.agent_status;
            nextAgents.set(incoming.pane_id, changedWhileReading && currentStatus !== undefined
                ? { ...incoming, agent_status: currentStatus }
                : incoming);
        }
        for (const incoming of result.snapshot?.panes ?? []) {
            const changedWhileReading = lifecycleEpochByPane.get(incoming.pane_id) !== lifecycleEpochAtStart.get(incoming.pane_id);
            const currentStatus = panesById.get(incoming.pane_id)?.agent_status;
            nextPanes.set(incoming.pane_id, changedWhileReading && currentStatus !== undefined
                ? { ...incoming, agent_status: currentStatus }
                : incoming);
        }
        agentsByPane.clear();
        panesById.clear();
        workspacesById.clear();
        tabsById.clear();
        for (const [paneId, agent] of nextAgents) agentsByPane.set(paneId, agent);
        for (const [paneId, pane] of nextPanes) panesById.set(paneId, pane);
        for (const workspace of result.snapshot?.workspaces ?? []) {
            workspacesById.set(workspace.workspace_id, workspace);
        }
        for (const tab of result.snapshot?.tabs ?? []) tabsById.set(tab.tab_id, tab);
        await syncDiscovery();
    }

    function scheduleResnapshot(): void {
        if (resnapshotTimer !== undefined) return;
        resnapshotTimer = setTimeout(() => {
            resnapshotTimer = undefined;
            void refreshSnapshot().then(emitAllStates).catch(() => {});
        }, 500);
    }

    function emitAllStates(): void {
        for (const session of currentSessions()) emitState(session.sessionId);
    }

    const client = new HerdrClient(socketPath, () => {
        void client.subscribeEvents(EVENT_KINDS).catch(() => {});
        void refreshSnapshot().then(emitAllStates).catch(() => {});
    });

    async function waitForPublishedAgent(paneId: string, timeoutMs: number): Promise<CurrentSession> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await refreshSnapshot();
            const session = currentSessionByPane(paneId);
            if (session?.agent !== undefined) return session;
            await sleep(200);
        }
        throw new Error('Herdr did not publish the current Agent Name and session.');
    }

    async function waitForInteractiveAgent(paneId: string, timeoutMs: number): Promise<void> {
        const result = await client.call<{ agent?: AgentRecord }>(
            'agent.wait',
            { target: paneId, until: ['idle', 'working', 'blocked', 'done'], timeout_ms: timeoutMs },
            timeoutMs + 10_000,
        );
        if (result.agent?.interactive_ready !== true || result.agent.launch_pending === true) {
            throw new Error('herdr agent did not become interactive');
        }
    }

    client.onEvent((event) => {
        // Wire kinds arrive dot-style per the subscription schema; tolerate snake_case too.
        const kind = event.type.replace(/_/g, '.');
        const pane = (event.pane ?? event.agent) as AgentRecord | PaneRecord | undefined;
        if (pane !== undefined && typeof pane.pane_id === 'string') {
            const currentPaneStatus = panesById.get(pane.pane_id)?.agent_status;
            panesById.set(pane.pane_id, {
                ...panesById.get(pane.pane_id),
                ...pane,
                ...(currentPaneStatus === undefined ? {} : { agent_status: currentPaneStatus }),
            });
            if ('agent' in pane || 'name' in pane || 'agent_session' in pane) {
                const current = agentsByPane.get(pane.pane_id);
                const merged = mergeHerdrAgentEvent(current, pane as AgentRecord);
                agentsByPane.set(pane.pane_id, {
                    ...merged,
                    pane_id: pane.pane_id,
                    ...(current?.agent_status === undefined ? {} : { agent_status: current.agent_status }),
                });
            }
        }
        switch (kind) {
            case 'pane.updated': {
                const paneId = typeof event.pane_id === 'string' ? event.pane_id : pane?.pane_id;
                scheduleResnapshot();
                const session = paneId === undefined ? undefined : currentSessionByPane(paneId);
                if (session !== undefined) emitState(session.sessionId);
                return;
            }
            case 'pane.agent.status.changed':
            case 'pane.agent.detected': {
                const paneId = typeof event.pane_id === 'string' ? event.pane_id : pane?.pane_id;
                const agentStatus = typeof event.agent_status === 'string' ? event.agent_status : pane?.agent_status;
                if (paneId !== undefined && agentStatus !== undefined) setLifecycle(paneId, agentStatus);
                const session = paneId === undefined ? undefined : currentSessionByPane(paneId);
                if (session !== undefined) emitState(session.sessionId);
                scheduleResnapshot();
                return;
            }
            case 'pane.moved': {
                const previous = typeof event.previous_pane_id === 'string' ? event.previous_pane_id : undefined;
                if (previous !== undefined) {
                    statusWatches.get(previous)?.();
                    statusWatches.delete(previous);
                    lifecycleEpochByPane.delete(previous);
                }
                scheduleResnapshot();
                return;
            }
            case 'workspace.created':
            case 'workspace.closed':
            case 'workspace.renamed':
            case 'workspace.updated': {
                const workspace = event.workspace as WorkspaceRecord | undefined;
                if (workspace !== undefined && typeof workspace.workspace_id === 'string') {
                    workspacesById.set(workspace.workspace_id, {
                        ...workspacesById.get(workspace.workspace_id),
                        ...workspace,
                    });
                }
                scheduleResnapshot();
                return;
            }
            case 'tab.created':
            case 'tab.closed':
            case 'tab.renamed':
            case 'pane.created':
            case 'pane.closed':
            case 'pane.exited':
                scheduleResnapshot();
                return;
            default:
                return;
        }
    });

    // A dead herdr must not take the host down with it: the phone needs this
    // process alive to see connected:false instead of a healthy-looking ghost.
    // start() already retried with backoff and left the reconnect loop armed;
    // onReconnect resubscribes and resnapshots when herdr comes back.
    try {
        await client.start();
        await client.subscribeEvents(EVENT_KINDS);
        await refreshSnapshot();
        emitAllStates();
    } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    }

    function agentUnavailable(): Error {
        return agentRouteError('agent-unavailable');
    }

    async function resolvePane(sessionId: string): Promise<CurrentSession> {
        try { await refreshSnapshot(); } catch { throw agentUnavailable(); }
        const session = currentSession(sessionId);
        if (session === undefined) throw agentUnavailable();
        return session;
    }

    function forgetClosedSession(sessionId: string, paneId?: string): void {
        const resolvedPaneId = paneId ?? closePaneId(sessionId);
        if (resolvedPaneId !== undefined) {
            statusWatches.get(resolvedPaneId)?.();
            statusWatches.delete(resolvedPaneId);
            lifecycleEpochByPane.delete(resolvedPaneId);
            attachments.dropPane(resolvedPaneId);
        }
        if (sessionId.startsWith(SHELL_ROUTE_PREFIX)) knownShells.delete(sessionId);
        else {
            paneByAgentRoute.delete(sessionId);
            routes.remove(sessionId);
        }
        removeRouteState(sessionId);
    }

    function snapshotFor(session: CurrentSession, accepted = false): SessionSnapshot {
        let acceptance: SessionSnapshot['acceptance'];
        if (accepted) {
            acceptance = { outcome: 'accepted', state: lifecycleOf(session) };
            const agentName = session.agent?.name;
            if (agentName !== undefined && agentName !== null) acceptance.agentName = agentName;
        }
        return {
            info: infoFor(session),
            status: statusFor(session.sessionId),
            page: { messages: [], hasMore: false },
            ...(acceptance === undefined ? {} : { acceptance }),
        };
    }

    async function startSession(startOptions: SessionStartOptions & { kind?: string; label?: string }): Promise<SessionStartResult> {
        const squad: Array<{ kind: string }> | undefined =
            startOptions.members ?? startOptions.kinds?.map((kind) => ({ kind }));
        if (squad !== undefined && squad.length > 1) {
            let first: SessionStartResult | undefined;
            const started: CurrentSession[] = [];
            for (const member of squad.slice(0, 4)) {
                const snapshot = await startSession({
                    cwd: startOptions.cwd,
                    kind: member.kind,
                    ...(startOptions.taskTitle === undefined ? {} : { taskTitle: startOptions.taskTitle }),
                });
                if (!('info' in snapshot)) {
                    for (const session of started.reverse()) {
                        transition(session, 'failed', 'squad-rolled-back');
                        await client.call('pane.close', { pane_id: session.paneId }).catch(() => undefined);
                        removeRouteState(session.sessionId);
                        routes.remove(session.sessionId);
                    }
                    await routes.flush();
                    return snapshot;
                }
                const session = currentSession(snapshot.info.id);
                if (session !== undefined) started.push(session);
                first = first ?? snapshot;
            }
            if (first === undefined) throw new Error('herdr: squad start produced nothing');
            return first;
        }

        const kind = startOptions.kind ?? 'pi';
        const requestedLabel = startOptions.label?.trim() || startOptions.taskTitle?.trim();
        const earlyFailure = (): SessionStartResult => ({
            acceptance: {
                outcome: 'failed',
                state: 'failed',
                code: 'start-launch-failed',
                message: 'Agent could not start.',
            },
        });

        let cwd = startOptions.cwd;
        let workspaceId: string | undefined;
        try {
            if (startOptions.worktree !== undefined) {
                const created = await client.call<{
                    workspace?: { workspace_id?: string; worktree?: { checkout_path?: string } };
                }>(
                    'worktree.create',
                    {
                        cwd,
                        focus: false,
                        ...(startOptions.worktree.branch === undefined ? {} : { branch: startOptions.worktree.branch }),
                        ...(startOptions.worktree.base === undefined ? {} : { base: startOptions.worktree.base }),
                    },
                );
                workspaceId = created.workspace?.workspace_id;
                const checkout = created.workspace?.worktree?.checkout_path;
                if (checkout !== undefined) cwd = checkout;
            }

            if (workspaceId === undefined) {
                const workspaces = await client.call<{ workspaces?: { workspace_id: string; label?: string }[] }>(
                    'workspace.list',
                );
                const existing = (workspaces.workspaces ?? []).find((workspace) => workspace.label === cwd);
                if (existing !== undefined) {
                    workspaceId = existing.workspace_id;
                } else {
                    const created = await client.call<{ workspace?: { workspace_id: string } }>('workspace.create', {
                        cwd,
                        label: cwd,
                        focus: false,
                    });
                    workspaceId = created.workspace?.workspace_id;
                }
            }
        } catch {
            return earlyFailure();
        }
        if (workspaceId === undefined) return earlyFailure();

        let tab: { tab?: { tab_id: string }; root_pane?: { pane_id: string } };
        try {
            tab = await client.call('tab.create', {
                workspace_id: workspaceId,
                cwd,
                ...(requestedLabel === undefined ? {} : { label: requestedLabel }),
                focus: false,
            });
        } catch {
            return earlyFailure();
        }
        const paneId = tab.root_pane?.pane_id;
        if (paneId === undefined || tab.tab?.tab_id === undefined) return earlyFailure();

        if (kind === 'shell') {
            await refreshSnapshot();
            const shell = currentSession(shellRoute(paneId));
            if (shell === undefined) return earlyFailure();
            emitState(shell.sessionId);
            return snapshotFor(shell, true);
        }

        try {
            const launchName = `pp_${randomBytes(8).toString('hex')}`;
            await client.call('agent.start', { name: launchName, kind, pane_id: paneId, timeout_ms: 60_000 }, 70_000);
            const session = await waitForPublishedAgent(paneId, 5_000);
            const expectedRef = agentSession(session.agent)!;
            transition(session, 'starting', 'start-requested');
            emitState(session.sessionId);
            void waitForInteractiveAgent(paneId, 60_000)
                .then(async () => {
                    await refreshSnapshot();
                    const current = currentSession(session.sessionId);
                    const currentRef = agentSession(current?.agent);
                    if (current === undefined || currentRef === undefined
                        || herdrAgentSessionKey(currentRef) !== herdrAgentSessionKey(expectedRef)) return;
                    emitState(current.sessionId);
                })
                .catch(() => {
                    const current = currentSession(session.sessionId);
                    if (current !== undefined) {
                        transition(current, 'failed', 'start-launch-failed');
                        emitState(current.sessionId);
                    }
                });
            return snapshotFor(session, true);
        } catch {
            await client.call('pane.close', { pane_id: paneId }).catch(() => undefined);
            return earlyFailure();
        }
    }

    function realtimeAgentFor(session: CurrentSession): RealtimeCodingAgent {
        const changedAt = Date.parse(options.lifecycle?.latestFor(session.sessionId)?.at ?? '');
        const taskTitle = taskTitleForSession(session);
        const displayAgent = session.agent?.display_agent ?? undefined;
        return {
            sessionId: session.sessionId,
            cwd: cwdForSession(session.sessionId) ?? '',
            ...(session.agent?.name === undefined || session.agent.name === null ? {} : { agentName: session.agent.name }),
            ...(taskTitle === undefined ? {} : { taskTitle }),
            ...(session.agent?.agent === undefined || session.agent.agent === null ? {} : { agentKind: session.agent.agent }),
            ...(displayAgent === undefined ? {} : { displayAgent }),
            agentStatus: lifecycleOf(session),
            promptable: agentPromptable(session),
            ...(Number.isFinite(changedAt) ? { changedAt } : {}),
        };
    }

    async function listRealtimeAgents(): Promise<RealtimeCodingAgent[]> {
        await refreshSnapshot();
        return currentSessions().filter((session) => session.agent !== undefined).map(realtimeAgentFor);
    }

    async function startRealtimeAgent(input: {
        cwd: string;
        taskTitle: string;
        kind: string;
    }): Promise<{ accepted: boolean; agent?: RealtimeCodingAgent }> {
        const result = await startSession({
            cwd: input.cwd,
            taskTitle: input.taskTitle,
            label: input.taskTitle,
            kind: input.kind,
        });
        if (!('info' in result)) return { accepted: false };
        const session = currentSession(result.info.id);
        return session?.agent === undefined
            ? { accepted: false }
            : { accepted: true, agent: realtimeAgentFor(session) };
    }

    async function promptSession(sessionId: string, text: string): Promise<void> {
        const session = await resolvePane(sessionId);
        const promptable = agentPromptable(session);
        if (!promptable) options.onAgentReadinessDiagnostic?.('not-promptable', false);
        await promptPromptableHerdrAgent(client, session, promptable, text);
    }

    async function sendSessionKeys(sessionId: string, keys: string[]): Promise<void> {
        const session = await resolvePane(sessionId);
        if (session.agent === undefined) throw agentUnavailable();
        await sendKeysToLiveAgent(client, session, keys);
    }


    async function readSessionOutput(sessionId: string): Promise<{ text: string; truncated: boolean }> {
        const record = await resolvePane(sessionId);
        const result = await client.call<{ read?: { text?: string; truncated?: boolean } }>('pane.read', {
            pane_id: record.paneId,
            source: 'recent',
            lines: 80,
            format: 'text',
            strip_ansi: true,
        });
        return { text: result.read?.text ?? '', truncated: result.read?.truncated === true };
    }

    async function waitForAgent(sessionId: string, timeoutMs: number): Promise<{ status: string; detail: string; timedOut?: boolean }> {
        const record = await resolvePane(sessionId);
        try {
            const result = await client.call<{ agent?: { agent_status?: string } }>(
                'agent.wait',
                { target: record.paneId, until: ['idle', 'done', 'blocked', 'failed'], timeout_ms: timeoutMs },
                timeoutMs + 10_000,
            );
            const status = result.agent?.agent_status ?? 'settled';
            return { status, detail: `${record.agent?.name ?? 'Agent'} is ${status}` };
        } catch (error) {
            const timedOut = (error instanceof Error ? error.message : String(error)).includes('timed out');
            return {
                status: timedOut ? 'unknown' : 'error',
                detail: timedOut ? 'Watch timed out' : 'Watch ended before completion',
                ...(timedOut ? { timedOut: true } : {}),
            };
        }
    }

    async function focusSession(sessionId: string): Promise<void> {
        const record = await resolvePane(sessionId);
        await client.call('pane.focus', { pane_id: record.paneId });
    }

    const pluginRefreshGate = new PluginRefreshGate(async () => {
            const result = await client.call<{ plugins?: HerdrPlugin[] }>('plugin.list');
            const plugins = result.plugins ?? [];
            const nextDigests = await catalog.refresh(plugins);
            const nextEnabled = new Map(plugins.map((plugin) => [plugin.plugin_id, plugin.enabled]));
            const previousDigests = pluginDigests;
            const previousEnabled = pluginEnabled;
            pluginDigests = nextDigests;
            pluginEnabled = nextEnabled;
            if (previousDigests === undefined) return; // first snapshot establishes the baseline
            const frame = pluginInvalidationFrame(
                { digests: previousDigests, enabled: previousEnabled },
                { digests: nextDigests, enabled: nextEnabled },
            );
            if (frame === undefined) return;
            // A changed/disabled manifest must not leave an old provider process live.
            pluginStreams?.closeAll();
            for (const listener of machineListeners) listener(frame);
        });

    /** Polls coalesce; freshness-critical callers get one trailing authoritative read. */
    function reconcilePlugins(forceFresh = false): Promise<void> {
        return forceFresh ? pluginRefreshGate.forceFresh() : pluginRefreshGate.poll();
    }

    async function refreshPlugins(): Promise<void> {
        await reconcilePlugins(true);
    }

    function voiceProviderOptions(): VoiceProviderOption[] {
        return catalog.capabilityPlugins('voice.session').map(({ pluginId, name, enabled, source, hasBackend }) => ({
            id: pluginId,
            name,
            selected: enabled,
            source,
            hasBackend,
        }));
    }

    async function selectVoiceProviderNow(providerId: string): Promise<VoiceProviderOption[]> {
        await refreshPlugins();
        const providers = catalog.capabilityPlugins('voice.session');
        const target = providers.find((candidate) => candidate.pluginId === providerId);
        if (target === undefined) throw new Error('realtime voice provider is not installed on this machine; update muxr first');
        const previouslyEnabled = providers.filter(({ enabled }) => enabled);
        const disabled: typeof previouslyEnabled = [];
        let enabledTarget = false;
        try {
            for (const current of previouslyEnabled) {
                if (current.pluginId === target.pluginId) continue;
                await client.call('plugin.disable', { plugin_id: current.pluginId });
                disabled.push(current);
            }
            if (!target.enabled) {
                await client.call('plugin.enable', { plugin_id: target.pluginId });
                enabledTarget = true;
            }
            await refreshPlugins();
            const latest = catalog.capabilityPlugins('voice.session');
            let converged = false;
            if (!latest.some((candidate) => candidate.pluginId === target.pluginId && candidate.enabled)) {
                await client.call('plugin.enable', { plugin_id: target.pluginId });
                enabledTarget = true;
                converged = true;
            }
            for (const current of latest) {
                if (!current.enabled || current.pluginId === target.pluginId) continue;
                await client.call('plugin.disable', { plugin_id: current.pluginId });
                converged = true;
            }
            if (converged) await refreshPlugins();
            return voiceProviderOptions();
        } catch (error) {
            if (enabledTarget) await client.call('plugin.disable', { plugin_id: target.pluginId }).catch(() => undefined);
            for (const current of disabled.reverse()) {
                await client.call('plugin.enable', { plugin_id: current.pluginId }).catch(() => undefined);
            }
            await refreshPlugins().catch(() => undefined);
            throw error;
        }
    }

    let voiceSwitch: Promise<void> = Promise.resolve();
    function selectVoiceProvider(providerId: string): Promise<VoiceProviderOption[]> {
        const run = voiceSwitch.then(() => selectVoiceProviderNow(providerId));
        voiceSwitch = run.then(() => undefined, () => undefined);
        return run;
    }

    void reconcilePlugins().catch(() => undefined);
    pluginPollTimer = setInterval(() => {
        if (machineListeners.size > 0) void reconcilePlugins().catch(() => undefined);
    }, 2_000);
    pluginPollTimer.unref();

    function pluginPublicContext(requests: readonly PluginContextRequest[] | undefined, preferredSessionId?: string): string | undefined {
        if (requests === undefined || requests.length === 0) return undefined;
        const source: PublicContextSource = {
            sessions: currentSessions().map((session) => {
                const info = infoFor(session);
                const workspace = info.workspaceId === undefined ? undefined : workspacesById.get(info.workspaceId);
                const tab = info.tabId === undefined ? undefined : tabsById.get(info.tabId);
                const cwd = info.cwd;
                const base = cwd.replace(/\/+$/, '').split('/').pop();
                return {
                    sessionId: session.sessionId,
                    label: session.pane.label ?? tab?.label ?? base,
                    ...(info.agentName === undefined ? {} : { agentName: info.agentName }),
                    ...(info.taskTitle === undefined ? {} : { taskTitle: info.taskTitle }),
                    cwd,
                    workspaceLabel: workspace?.label,
                    tabLabel: tab?.label,
                    ...(info.agentKind === undefined ? {} : { agentKind: info.agentKind }),
                    ...(info.displayAgent === undefined ? {} : { displayAgent: info.displayAgent }),
                    agentStatus: info.agentStatus,
                    promptable: info.promptable,
                    activeAt: modifiedBySession.get(session.sessionId),
                };
            }),
            attention: options.attention?.catalog().entries ?? [],
            workspaces: [...workspacesById.values()].map((workspace) => {
                const panes = [...panesById.values()].filter((pane) => pane.workspace_id === workspace.workspace_id);
                const tabIds = [...new Set(panes.map((pane) => pane.tab_id).filter((tabId): tabId is string => tabId !== undefined))];
                const tabs = tabIds.map((tabId) => {
                    const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
                    return {
                        label: tabsById.get(tabId)?.label,
                        focused: tabPanes.some((pane) => pane.focused === true),
                        agentStatus: rollupLifecycle(tabPanes.map((pane) => lifecycleForPane(pane.pane_id))),
                        sessions: tabPanes.map((pane) => {
                            const session = currentSessionByPane(pane.pane_id);
                            const info = session === undefined ? undefined : infoFor(session);
                            return {
                                ...(session === undefined ? {} : { sessionId: session.sessionId }),
                                label: pane.label ?? undefined,
                                ...(info?.agentName === undefined ? {} : { agentName: info.agentName }),
                                ...(info?.taskTitle === undefined ? {} : { taskTitle: info.taskTitle }),
                                ...(info?.agentKind === undefined ? {} : { agentKind: info.agentKind }),
                                ...(info?.displayAgent === undefined ? {} : { displayAgent: info.displayAgent }),
                                agentStatus: lifecycleForPane(pane.pane_id),
                                promptable: info?.promptable === true,
                            };
                        }),
                    };
                });
                return {
                    label: workspace.label,
                    focused: workspace.focused === true,
                    agentStatus: rollupLifecycle(tabs.map((tab) => tab.agentStatus)),
                    tabs,
                };
            }),
        };
        return JSON.stringify(buildPluginPublicContext(requests, source, preferredSessionId));
    }

    /** Prepare host-owned context, then run the exported bounded process path. */
    function runPluginCall(
        pluginId: string,
        target: { pluginRoot: string; entry: string; method: string; context?: PluginContextRequest[] },
        serializedInput: string,
        signal: AbortSignal,
        preferredSessionId?: string,
        trustedHerdrSocketPath?: string,
    ): Promise<unknown> {
        const stateDir = join(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'), 'plugin-state', pluginId);
        try { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); } catch { /* a plugin that needs it will fail loudly */ }
        const publicContext = pluginPublicContext(target.context, preferredSessionId);
        return runPluginProcess({
            pluginId,
            method: target.method,
            script: join(target.pluginRoot, target.entry),
            serializedInput,
            stateDir,
            ...(publicContext === undefined ? {} : { publicContext }),
            ...(trustedHerdrSocketPath === undefined ? {} : { trustedHerdrSocketPath }),
            signal,
        });
    }

    function publicPluginCallTarget(
        pluginId: string,
        manifestHash: string,
        contributionId: string,
    ): PluginBackendCallTarget {
        return {
            pluginId,
            manifestHash,
            contributionId,
            ...catalog.callTarget(pluginId, manifestHash, contributionId),
        };
    }

    function serializePluginCallInput(input: unknown): string {
        const serialized = JSON.stringify(input);
        if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_RPC_INPUT_BYTES) {
            throw new Error('plugin call input is too large');
        }
        return serialized;
    }

    async function guardedPluginCall(options: {
        deviceId: string;
        idempotencyKey?: string;
        target: PluginBackendCallTarget;
        targetAtExecution: () => PluginBackendCallTarget;
        input: unknown;
        inputAtExecution?: () => Promise<unknown>;
        preferredSessionId?: string;
        trustedHerdrSocketPath?: string;
        requireApproval: boolean;
    }): Promise<unknown> {
        const { deviceId, target } = options;
        if (options.requireApproval && !pluginApprovals.has(deviceId, target.pluginId)) {
            throw new Error('plugin is not approved for this device');
        }
        serializePluginCallInput(options.input);
        const inputDigest = rpcInputDigest(options.input);
        const run = async () => {
            const pluginActive = activePluginCalls.get(target.pluginId) ?? 0;
            const deviceActive = activeDeviceCalls.get(deviceId) ?? 0;
            if (pluginActive >= MAX_RPC_PER_PLUGIN || deviceActive >= MAX_RPC_PER_DEVICE) {
                throw new Error(`plugin ${target.pluginId} is busy, retry`);
            }
            activePluginCalls.set(target.pluginId, pluginActive + 1);
            activeDeviceCalls.set(deviceId, deviceActive + 1);
            try {
                return await pluginCallConcurrency.run(async () => {
                    const execute = async (signal: AbortSignal): Promise<unknown> => {
                        const input = options.inputAtExecution === undefined
                            ? options.input
                            : await options.inputAtExecution();
                        const serializedInput = serializePluginCallInput(input);
                        const currentTarget = options.targetAtExecution();
                        return runPluginCall(
                            target.pluginId,
                            currentTarget,
                            serializedInput,
                            signal,
                            options.preferredSessionId,
                            options.trustedHerdrSocketPath,
                        );
                    };
                    if (options.requireApproval) {
                        return pluginApprovals.whileApproved(deviceId, target.pluginId, execute);
                    }
                    // Kernel capabilities are not user-disableable plugin UI,
                    // but still enter the same bounded process path.
                    return execute(new AbortController().signal);
                }, PLUGIN_CALL_QUEUE_TIMEOUT_MS);
            } finally {
                decrement(activePluginCalls, target.pluginId);
                decrement(activeDeviceCalls, deviceId);
            }
        };
        if (target.mode !== 'write') return run();
        const idempotencyKey = options.idempotencyKey;
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 64) {
            throw new Error('write plugin call requires an idempotency key');
        }
        const key = rpcReplayKey(
            deviceId,
            target.pluginId,
            target.manifestHash,
            target.contributionId,
            idempotencyKey,
        );
        return writeReplayFence.run(`${deviceId}\0${target.pluginId}`, key, inputDigest, run);
    }

    function hostContractMismatch(message: string): Error {
        return Object.assign(new Error(message), { code: 'host-contract-mismatch' });
    }

    function trustedCloseTarget(manifestHash?: string): PluginBackendCallTarget {
        if (WORKSPACE_HIERARCHY_PLUGIN_ROOT === undefined) {
            throw hostContractMismatch('Agent close plugin RPC is missing.');
        }
        let target: PluginBackendCallTarget;
        try {
            target = catalog.trustedCapabilityCallTarget({
                pluginRoot: WORKSPACE_HIERARCHY_PLUGIN_ROOT,
                capability: AGENT_CLOSE_CAPABILITY,
                mode: 'write',
                ...(manifestHash === undefined ? {} : { manifestHash }),
            });
        } catch {
            throw hostContractMismatch('Agent close plugin RPC is unavailable or changed.');
        }
        if (target.contributionId !== AGENT_CLOSE_CONTRIBUTION_ID || target.method !== AGENT_CLOSE_METHOD
            || target.pluginId !== `muxr.${basename(WORKSPACE_HIERARCHY_PLUGIN_ROOT)}`
            || !existsSync(join(target.pluginRoot, target.entry))) {
            throw hostContractMismatch('Agent close plugin RPC has an invalid contract.');
        }
        return target;
    }

    async function invokeHerdrAction({ sessionId, pluginId, actionId }: { sessionId: string; pluginId: string; actionId: string }): Promise<void> {
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pluginId) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(actionId)) {
            throw new Error('plugin invoke rejected invalid identifier');
        }
        const plugins = await client.call<{ plugins?: { plugin_id: string; enabled: boolean; actions?: { id: string }[] }[] }>('plugin.list', { plugin_id: pluginId });
        const installed = (plugins.plugins ?? []).find((plugin) => plugin.plugin_id === pluginId && plugin.enabled);
        if (!installed?.actions?.some((action) => action.id === actionId)) throw new Error(`plugin action unavailable: ${pluginId}.${actionId}`);
        const record = await resolvePane(sessionId);
        const workspaceId = record.agent?.workspace_id ?? record.pane.workspace_id;
        const tabId = record.agent?.tab_id ?? record.pane.tab_id;
        if (workspaceId === undefined || tabId === undefined) throw agentUnavailable();
        await client.call('plugin.action.invoke', {
            plugin_id: pluginId,
            action_id: actionId,
            context: {
                workspace_id: workspaceId,
                tab_id: tabId,
                focused_pane_id: record.paneId,
                focused_pane_cwd: infoFor(record).cwd,
                invocation_source: 'muxr',
            },
        });
    }

    return {
        async refreshHerdr(): Promise<void> {
            await refreshSnapshot();
            emitAllStates();
        },

        async refreshPlugins(): Promise<void> {
            await reconcilePlugins(true);
        },

        async pluginList(deviceId) {
            await refreshPlugins();
            return catalog.list((pluginId) => pluginApprovals.has(deviceId, pluginId));
        },

        async pluginManifest({ pluginId, manifestHash }) {
            await refreshPlugins();
            return catalog.manifest(pluginId, manifestHash);
        },

        async pluginApprove({ deviceId, pluginId, manifestHash, approved }) {
            await refreshPlugins();
            if (approved) catalog.manifest(pluginId, manifestHash);
            await pluginApprovals.set(deviceId, pluginId, approved);
        },

        async voiceProviderList() {
            await refreshPlugins();
            return voiceProviderOptions();
        },

        async voiceProviderSelect(provider) {
            return selectVoiceProvider(provider);
        },

        async pluginInvoke({ deviceId, pluginId, manifestHash, contributionId, sessionId, idempotencyKey }) {
            await refreshPlugins();
            if (!pluginApprovals.has(deviceId, pluginId)) throw new Error('plugin is not approved for this device');
            const scope = `${deviceId}\0${pluginId}`;
            const key = `${scope}\0${manifestHash}\0${contributionId}\0${sessionId}\0${idempotencyKey}`;
            const existing = pluginInvocations.get(key);
            if (existing !== undefined) return existing;
            const scopeSize = [...pluginInvocations.keys()].filter((candidate) => candidate.startsWith(`${scope}\0`)).length;
            if (scopeSize >= MAX_PLUGIN_INVOCATIONS_PER_SCOPE || pluginInvocations.size >= MAX_PLUGIN_INVOCATIONS_TOTAL) {
                throw new Error(`plugin ${pluginId} is busy, retry`);
            }
            const pluginActionId = catalog.action(pluginId, manifestHash, contributionId);
            const pluginActive = activePluginCalls.get(pluginId) ?? 0;
            const deviceActive = activeDeviceCalls.get(deviceId) ?? 0;
            if (pluginActive >= MAX_RPC_PER_PLUGIN || deviceActive >= MAX_RPC_PER_DEVICE) throw new Error(`plugin ${pluginId} is busy, retry`);
            activePluginCalls.set(pluginId, pluginActive + 1);
            activeDeviceCalls.set(deviceId, deviceActive + 1);
            const invocation = pluginCallConcurrency.run(
                () => pluginApprovals.whileApproved(deviceId, pluginId, async () => {
                    if (catalog.action(pluginId, manifestHash, contributionId) !== pluginActionId) throw new Error('plugin action changed before invocation');
                    await invokeHerdrAction({ sessionId, pluginId, actionId: pluginActionId });
                }),
                PLUGIN_CALL_QUEUE_TIMEOUT_MS,
            ).finally(() => {
                decrement(activePluginCalls, pluginId);
                decrement(activeDeviceCalls, deviceId);
            });
            pluginInvocations.set(key, invocation);
            void invocation.then(
                () => {
                    const timer = setTimeout(() => {
                        if (pluginInvocations.get(key) === invocation) pluginInvocations.delete(key);
                    }, 5 * 60_000);
                    timer.unref();
                },
                () => { if (pluginInvocations.get(key) === invocation) pluginInvocations.delete(key); },
            );
            return invocation;
        },

        async pluginStream({ deviceId, pluginId, manifestHash, contributionId, channel, sessionId }): Promise<null> {
            await refreshPlugins();
            if (!pluginApprovals.has(deviceId, pluginId)) throw new Error('plugin is not approved for this device');
            if (pluginStreams === undefined) throw new Error('plugin stream transport is unavailable');
            if (typeof channel !== 'string' || !/^rs_[A-Za-z0-9_-]{8,80}$/.test(channel)) throw new Error('invalid plugin stream channel');
            const target = catalog.streamTarget(pluginId, manifestHash, contributionId);
            if (sessionId !== undefined) await resolvePane(sessionId);
            const stateDir = join(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'), 'plugin-state', pluginId);
            const approval = await pluginApprovals.track(deviceId, pluginId, () => pluginStreams.detach(channel, 'plugin revoked'));
            try {
                await refreshPlugins();
                const record = sessionId === undefined ? undefined : await resolvePane(sessionId);
                const latestTarget = catalog.streamTarget(pluginId, manifestHash, contributionId);
                if (latestTarget.pluginRoot !== target.pluginRoot || latestTarget.entry !== target.entry) throw agentUnavailable();
                const voiceSession = catalog.streamClaimsCapability(pluginId, manifestHash, contributionId, 'voice.session');
                let publicContext: RealtimePluginPublicContext | undefined;
                if (voiceSession) {
                    publicContext = realtimePluginPublicContext(
                        currentSessions()
                            .filter((session) => session.agent !== undefined)
                            .map((session) => {
                                const info = infoFor(session);
                                return {
                                    sessionId: session.sessionId,
                                    ...(info.agentName === undefined ? {} : { agentName: info.agentName }),
                                    ...(info.taskTitle === undefined ? {} : { taskTitle: info.taskTitle }),
                                    ...(info.agentKind === undefined ? {} : { agentKind: info.agentKind }),
                                    ...(info.displayAgent === undefined ? {} : { displayAgent: info.displayAgent }),
                                    agentStatus: info.agentStatus,
                                    promptable: info.promptable,
                                };
                            }),
                    );
                }
                await pluginStreams.attach({
                    target: {
                        pluginId,
                        pluginRoot: target.pluginRoot,
                        entry: target.entry,
                        ...(voiceSession ? { peerBroker: true, codingCoordinator: true } : {}),
                    },
                    channel,
                    stateDir,
                    ...(record === undefined ? {} : {
                        sessionId: record.sessionId,
                        paneId: record.paneId,
                        cwd: cwdForSession(record.sessionId) ?? '',
                    }),
                    ...(publicContext === undefined ? {} : { publicContext }),
                    deviceId,
                    signal: approval.signal,
                    onClosed: approval.release,
                });
                return null;
            } catch (error) {
                approval.release();
                throw error;
            }
        },

        pluginRpcMode({ pluginId, manifestHash, contributionId }: { pluginId: string; manifestHash: string; contributionId: string }): 'read' | 'write' | undefined {
            // Browser access is package-owned and fail-closed: third-party code
            // cannot make itself browser-callable by self-declaring read mode.
            try {
                const call = catalog.callTarget(pluginId, manifestHash, contributionId);
                return BROWSER_RPC_PLUGINS_ROOT !== undefined && dirname(call.pluginRoot) === BROWSER_RPC_PLUGINS_ROOT && call.modeDeclared && call.mode === 'read' ? 'read' : undefined;
            } catch { return undefined; }
        },

        async pluginCall({ deviceId, pluginId, manifestHash, contributionId, input, idempotencyKey }): Promise<unknown> {
            // Force one authoritative catalog read before entering the bounded
            // process queue. The active hash is checked again at dequeue.
            await refreshPlugins();
            if (!pluginApprovals.has(deviceId, pluginId)) throw new Error('plugin is not approved for this device');
            const target = publicPluginCallTarget(pluginId, manifestHash, contributionId);
            let payload: unknown = input ?? null;
            let requestedSessionId: string | undefined;
            if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
                const { paneId: _paneId, cwd: _cwd, ...trustedPayload } = payload as Record<string, unknown>;
                payload = trustedPayload;
                if (typeof trustedPayload.sessionId === 'string') {
                    requestedSessionId = trustedPayload.sessionId;
                    const record = await resolvePane(trustedPayload.sessionId);
                    payload = { ...trustedPayload, paneId: record.paneId, cwd: cwdForSession(trustedPayload.sessionId) ?? '' };
                }
            }
            const inputAtExecution = requestedSessionId === undefined
                ? undefined
                : async (): Promise<unknown> => {
                    const record = await resolvePane(requestedSessionId);
                    return {
                        ...(payload as Record<string, unknown>),
                        paneId: record.paneId,
                        cwd: cwdForSession(requestedSessionId) ?? '',
                    };
                };
            return guardedPluginCall({
                deviceId,
                target,
                targetAtExecution: () => publicPluginCallTarget(pluginId, manifestHash, contributionId),
                input: payload,
                ...(inputAtExecution === undefined ? {} : { inputAtExecution }),
                ...(requestedSessionId === undefined ? {} : { preferredSessionId: requestedSessionId }),
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                requireApproval: true,
            });
        },



        async list(listOptions?: SessionListOptions): Promise<SessionInfo[]> {
            await refreshSnapshot().then(
                () => {
                    client.connected = true;
                },
                () => {
                    client.connected = false;
                },
            );
            let sessions = currentSessions();
            if (listOptions?.cwd !== undefined) {
                sessions = sessions.filter((session) => cwdForSession(session.sessionId) === listOptions.cwd);
            }
            return sessions
                .sort((left, right) =>
                    (modifiedBySession.get(right.sessionId) ?? '').localeCompare(modifiedBySession.get(left.sessionId) ?? '')
                )
                .map(infoFor);
        },

        start: startSession,
        async open(openOptions: SessionOpenOptions): Promise<SessionSnapshot> {
            const record = await resolvePane(openOptions.sessionId);
            // herdr clears `done` when the tab is focused; focusing from a phone
            // would yank the desk's focus, so opening the session is the "seen"
            // signal here instead.
            if (openOptions.acknowledgeAttention !== false) clearAttention(openOptions.sessionId);
            return snapshotFor(record);
        },

        async herdrLayout(tabId: string): Promise<{
            tabId: string;
            zoomed: boolean;
            area: { x: number; y: number; width: number; height: number };
            panes: { paneId: string; focused: boolean; rect: { x: number; y: number; width: number; height: number } }[];
        }> {
            // pane.layout resolves a tab through any of its panes.
            const anyPane = [...panesById.values()].find((pane) => pane.tab_id === tabId);
            if (anyPane === undefined) throw new Error(`herdr: unknown tab ${tabId}`);
            const result = await client.call<{
                layout?: {
                    tab_id?: string;
                    zoomed?: boolean;
                    area?: { x: number; y: number; width: number; height: number };
                    panes?: { pane_id: string; focused?: boolean; rect: { x: number; y: number; width: number; height: number } }[];
                };
            }>('pane.layout', { pane_id: anyPane.pane_id });
            const layout = result.layout;
            if (layout === undefined) throw new Error('herdr: pane.layout returned nothing');
            return {
                tabId,
                zoomed: layout.zoomed === true,
                area: layout.area ?? { x: 0, y: 0, width: 0, height: 0 },
                panes: (layout.panes ?? []).map((pane) => ({
                    paneId: pane.pane_id,
                    focused: pane.focused === true,
                    rect: pane.rect,
                })),
            };
        },

        async agentKinds(): Promise<string[]> {
            const result = await client.call<{ manifests?: Array<{ agent?: string }> }>('server.agent_manifests', {});
            // Herdr's endpoint lists screen-detection manifests, not every
            // launchable integration. OMP and MastraCode report state through
            // hooks, so include them before probing the host PATH.
            return agentKindsFromManifests(result.manifests ?? []);
        },

        async installedAgentKinds(kinds: readonly string[]): Promise<string[]> {
            return kinds.filter(executableOnPath);
        },

        async herdrTree(): Promise<{ workspaces: HerdrTreeWorkspace[]; connected: boolean }> {
            const workspaces: HerdrTreeWorkspace[] = [];
            for (const workspace of workspacesById.values()) {
                const panes = [...panesById.values()].filter((pane) => pane.workspace_id === workspace.workspace_id);
                const tabIds = [...new Set(panes.map((pane) => pane.tab_id).filter((tabId): tabId is string => tabId !== undefined))];
                const tabs = tabIds.map((tabId) => {
                    const tabLabel = tabsById.get(tabId)?.label;
                    const tabPanes = panes.filter((pane) => pane.tab_id === tabId);
                    const treePanes = tabPanes.map((pane) => {
                        const session = currentSessionByPane(pane.pane_id);
                        const taskTitle = session === undefined ? undefined : taskTitleForSession(session);
                        const agentKind = session?.agent?.agent ?? undefined;
                        const cwd = pane.foreground_cwd ?? pane.cwd ?? undefined;
                        return {
                            paneId: pane.pane_id,
                            tabId,
                            ...(pane.label === undefined || pane.label === null ? {} : { label: pane.label }),
                            ...(cwd === undefined ? {} : { cwd }),
                            ...(agentKind === undefined ? {} : { agentKind }),
                            ...(session?.agent?.name === undefined || session.agent.name === null
                                ? {}
                                : { agentName: session.agent.name }),
                            ...(session?.agent?.display_agent === undefined || session.agent.display_agent === null
                                ? {}
                                : { displayAgent: session.agent.display_agent }),
                            ...(taskTitle === undefined ? {} : { taskTitle }),
                            agentStatus: lifecycleForPane(pane.pane_id),
                            promptable: agentPromptable(session),
                            ...(pane.terminal_title_stripped === undefined || pane.terminal_title_stripped === null
                                ? {}
                                : { terminalTitle: pane.terminal_title_stripped }),
                            focused: pane.focused === true,
                            ...(session === undefined ? {} : { sessionId: session.sessionId }),
                        };
                    });
                    return {
                        tabId,
                        ...(tabLabel === undefined ? {} : { label: tabLabel }),
                        focused: tabPanes.some((pane) => pane.focused === true),
                        agentStatus: rollupLifecycle(treePanes.map((pane) => pane.agentStatus)),
                        panes: treePanes,
                    };
                });
                const worktree = workspace.worktree;
                workspaces.push({
                    workspaceId: workspace.workspace_id,
                    ...(workspace.label === undefined ? {} : { label: workspace.label }),
                    focused: workspace.focused === true,
                    agentStatus: rollupLifecycle(tabs.map((tab) => tab.agentStatus)),
                    ...mappedWorktree(worktree, workspace.label),
                    tabs,
                });
            }
            return { workspaces, connected: client.connected };
        },

        async paneSplit(splitOptions: {
            sessionId: string;
            direction: 'right' | 'down';
            kind?: string;
        }): Promise<{ paneId: string; sessionId?: string }> {
            const record = await resolvePane(splitOptions.sessionId);
            const result = await client.call<{ pane?: { pane_id?: string } }>('pane.split', {
                direction: splitOptions.direction,
                target_pane_id: record.paneId,
                focus: false,
            });
            const newPaneId = result.pane?.pane_id;
            if (newPaneId === undefined) throw new Error('herdr: pane.split returned no pane');
            if (splitOptions.kind === undefined) {
                await refreshSnapshot();
                return { paneId: newPaneId, sessionId: shellRoute(newPaneId) };
            }
            await tagSpawn(newPaneId, splitOptions.sessionId);
            const launchName = `pp_${randomBytes(8).toString('hex')}`;
            await client.call('agent.start', {
                name: launchName,
                kind: splitOptions.kind,
                pane_id: newPaneId,
                timeout_ms: 30_000,
            }, 40_000);
            try {
                const found = await waitForPublishedAgent(newPaneId, 30_000);
                return { paneId: newPaneId, sessionId: found.sessionId };
            } catch {
                return { paneId: newPaneId };
            }
        },

        async paneRead(readOptions: {
            sessionId: string;
            lines?: number;
            source?: 'visible' | 'recent' | 'recent_unwrapped';
            ansi?: boolean;
        }): Promise<{ text: string; truncated: boolean }> {
            const record = await resolvePane(readOptions.sessionId);
            // herdr nests the payload under `read`, unlike pane.split's `pane`.
            const result = await client.call<{ read?: { text?: string; truncated?: boolean } }>('pane.read', {
                pane_id: record.paneId,
                source: readOptions.source ?? 'recent',
                ...(readOptions.lines === undefined ? {} : { lines: readOptions.lines }),
                format: readOptions.ansi === true ? 'ansi' : 'text',
                strip_ansi: readOptions.ansi !== true,
            });
            return { text: result.read?.text ?? '', truncated: result.read?.truncated === true };
        },

        async agentWatch(watchOptions: {
            sessionId: string;
            until?: ('idle' | 'done' | 'blocked' | 'unknown')[];
            timeoutMs?: number;
        }): Promise<{ watching: boolean }> {
            const record = await resolvePane(watchOptions.sessionId);
            if (record.agent === undefined) throw agentUnavailable();
            const watchedRef = agentSession(record.agent)!;
            const timeoutMs = Math.min(watchOptions.timeoutMs ?? DEFAULT_WATCH_MS, MAX_WATCH_MS);
            const until = watchOptions.until ?? ['idle', 'done', 'blocked'];
            clearTimeout(watches.get(watchOptions.sessionId));
            const guard = setTimeout(() => watches.delete(watchOptions.sessionId), timeoutMs + 5_000);
            watches.set(watchOptions.sessionId, guard);

            void client
                .call<{ agent?: { agent_status?: string } }>(
                    'agent.wait',
                    { target: record.paneId, until, timeout_ms: timeoutMs },
                    timeoutMs + 10_000,
                )
                .then(async (result) => {
                    await refreshSnapshot();
                    const watched = currentSession(watchOptions.sessionId);
                    const currentRef = agentSession(watched?.agent);
                    if (watched?.agent?.name === undefined || currentRef === undefined
                        || herdrAgentSessionKey(currentRef) !== herdrAgentSessionKey(watchedRef)) return;
                    const status = result.agent?.agent_status ?? 'settled';
                    publish(watchOptions.sessionId, {
                        type: 'watch.settled',
                        status,
                        detail: `${watched.agent.name} is ${status}`,
                    });
                })
                .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    publish(watchOptions.sessionId, {
                        type: 'watch.settled',
                        status: 'unknown',
                        detail: message.includes('timed out') ? 'Watch timed out' : 'Watch ended before completion',
                        timedOut: message.includes('timed out'),
                    });
                })
                .finally(() => {
                    clearTimeout(watches.get(watchOptions.sessionId));
                    watches.delete(watchOptions.sessionId);
                });
            return { watching: true };
        },

        async agentWait(waitOptions: {
            sessionId: string;
            until?: ('idle' | 'done' | 'blocked' | 'unknown')[];
            timeoutMs?: number;
        }) {
            const record = await resolvePane(waitOptions.sessionId);
            const timeoutMs = Math.min(waitOptions.timeoutMs ?? DEFAULT_WATCH_MS, MAX_WATCH_MS);
            try {
                const result = await client.call<{ agent?: { agent_status?: string } }>(
                    'agent.wait',
                    { target: record.paneId, until: waitOptions.until ?? ['idle', 'done', 'blocked'], timeout_ms: timeoutMs },
                    timeoutMs + 10_000,
                );
                const status = result.agent?.agent_status ?? 'settled';
                return { status, detail: `Agent is ${status}` };
            } catch (error) {
                const timedOut = (error instanceof Error ? error.message : String(error)).includes('timed out');
                if (timedOut) return { status: 'unknown', detail: 'Watch timed out', timedOut: true };
                return { status: 'unknown', detail: 'Watch ended before completion' };
            }
        },

        async layoutExport(sessionId: string): Promise<{ snapshot: LayoutSnapshot }> {

            const record = await resolvePane(sessionId);
            const pane = await client.call<{ pane?: { tab_id?: string } }>('pane.get', {
                pane_id: record.paneId,
            });
            const tabId = pane.pane?.tab_id;
            if (tabId === undefined) throw new Error('herdr: pane has no tab');
            const exported = await client.call<{ layout?: { root?: HerdrLayoutNode } }>('layout.export', {
                tab_id: tabId,
            });
            const root = exported.layout?.root;
            if (root === undefined) throw new Error('herdr: layout.export returned no root');
            return { snapshot: toSnapshot(root, (paneId) => currentSessionByPane(paneId)?.agent?.agent ?? undefined) };
        },

        async layoutApply(applyOptions: {
            sessionId: string;
            snapshot: LayoutSnapshot;
            label?: string;
        }): Promise<{ tabId: string; started: number }> {
            const record = await resolvePane(applyOptions.sessionId);
            const pane = await client.call<{ pane?: { workspace_id?: string } }>('pane.get', {
                pane_id: record.paneId,
            });
            const applied = await client.call<{ layout?: { tab_id?: string; root?: HerdrLayoutNode } }>(
                'layout.apply',
                {
                    root: toHerdrRoot(applyOptions.snapshot),
                    ...(pane.pane?.workspace_id === undefined ? {} : { workspace_id: pane.pane.workspace_id }),
                    ...(applyOptions.label === undefined ? {} : { tab_label: applyOptions.label }),
                    focus: false,
                },
            );
            const tabId = applied.layout?.tab_id;
            const appliedRoot = applied.layout?.root;
            if (tabId === undefined || appliedRoot === undefined) {
                throw new Error('herdr: layout.apply returned no tab');
            }

            // apply preserves tree shape, so the two walks line up position for
            // position -- that is how a recorded kind finds its new pane.
            const kinds = collectKinds(applyOptions.snapshot);
            const newPanes = collectPaneIds(appliedRoot);
            let started = 0;
            for (let index = 0; index < Math.min(kinds.length, newPanes.length); index += 1) {
                const kind = kinds[index];
                const paneId = newPanes[index];
                if (kind === undefined || paneId === undefined) continue;
                const name = `pph_${kind}_${paneId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 32);
                // Fire and forget: agent.start blocks on detection, and one agent
                // failing to come up must not lose the rest of the layout.
                void client
                    .call('agent.start', { name, kind, pane_id: paneId, timeout_ms: 30_000 }, 45_000)
                    .catch(() => {});
                started += 1;
            }
            return { tabId, started };
        },

        async paneFocus(sessionId: string): Promise<void> {
            await focusSession(sessionId);
        },

        async focusNeighbor(sessionId: string, direction: 'left' | 'right' | 'up' | 'down'): Promise<void> {
            const record = await resolvePane(sessionId);
            await client.call('pane.focus_direction', { pane_id: record.paneId, direction });
        },

        async focusTabNeighbor(sessionId: string, direction: 'next' | 'prev'): Promise<void> {
            const record = await resolvePane(sessionId);
            const workspaceId = record.agent?.workspace_id ?? record.pane.workspace_id;
            const currentTabId = record.agent?.tab_id ?? record.pane.tab_id;
            if (workspaceId === undefined || currentTabId === undefined) return;
            const result = await client.call<{ tabs?: { tab_id?: string }[] }>('tab.list', {
                workspace_id: workspaceId,
            });
            const tabs = (result.tabs ?? [])
                .map((tab) => tab.tab_id)
                .filter((tabId): tabId is string => tabId !== undefined);
            const next = neighborId(tabs, currentTabId, direction);
            if (next === undefined) return; // one tab, or the tab is gone: no-op
            await client.call('tab.focus', { tab_id: next });
        },

        async focusWorkspaceNeighbor(sessionId: string, direction: 'next' | 'prev'): Promise<void> {
            const record = await resolvePane(sessionId);
            const workspaceId = record.agent?.workspace_id ?? record.pane.workspace_id;
            if (workspaceId === undefined) return;
            const result = await client.call<{ workspaces?: { workspace_id?: string }[] }>('workspace.list');
            const workspaces = (result.workspaces ?? [])
                .map((workspace) => workspace.workspace_id)
                .filter((id): id is string => id !== undefined);
            const next = neighborId(workspaces, workspaceId, direction);
            if (next === undefined) return; // one workspace, or it is gone: no-op
            await client.call('workspace.focus', { workspace_id: next });
        },

        async closeTab(sessionId: string, tabId: string): Promise<void> {
            await resolvePane(sessionId);
            await closeExactTab(client, tabId);
        },

        async closePane(sessionId: string): Promise<void> {
            const record = await resolvePane(sessionId);
            await closeExactPane(client, record.paneId);
        },

        async closeWorkspace(workspaceId: string): Promise<void> {
            try { await refreshSnapshot(); } catch {
                throw Object.assign(new Error('That workspace is no longer available. Refresh and try again.'), { code: 'workspace-unavailable' });
            }
            await closeExactWorkspace(client, workspaceId);
        },

        async createTab(sessionId: string, options: { kind?: string; label?: string }): Promise<void> {
            const record = await resolvePane(sessionId);
            const workspaceId = record.agent?.workspace_id ?? record.pane.workspace_id;
            const cwd = cwdForSession(sessionId);
            if (workspaceId === undefined || cwd === undefined) throw new Error('herdr: session has no workspace');
            const requestedLabel = options.label?.trim();
            const tab = await client.call<{ tab?: { tab_id: string }; root_pane?: { pane_id: string } }>(
                'tab.create',
                { workspace_id: workspaceId, cwd, ...(requestedLabel === undefined ? {} : { label: requestedLabel }), focus: false },
            );
            const paneId = tab.root_pane?.pane_id;
            if (paneId === undefined || tab.tab?.tab_id === undefined) throw new Error('herdr: tab.create returned no root pane');
            if (options.kind === undefined) {
                await refreshSnapshot();
                emitState(shellRoute(paneId));
                return;
            }
            const launchName = `pp_${randomBytes(8).toString('hex')}`;
            void client
                .call('agent.start', { name: launchName, kind: options.kind, pane_id: paneId, timeout_ms: 60_000 })
                .then(() => refreshSnapshot())
                .then(emitAllStates)
                .catch(() => undefined);
        },

        sendKeys: sendSessionKeys,

        async paneZoom(zoomOptions: {
            sessionId: string;
            mode?: 'toggle' | 'on' | 'off';
        }): Promise<{ changed: boolean; zoomed: boolean; reason?: string }> {
            const record = await resolvePane(zoomOptions.sessionId);
            const result = await client.call<{
                zoom?: { changed?: boolean; zoomed?: boolean; reason?: string };
            }>('pane.zoom', {
                pane_id: record.paneId,
                mode: zoomOptions.mode ?? 'toggle',
            });
            return {
                changed: result.zoom?.changed === true,
                zoomed: result.zoom?.zoomed === true,
                ...(result.zoom?.reason === undefined ? {} : { reason: result.zoom.reason }),
            };
        },

        async stop(sessionId: string, options: SessionStopOptions): Promise<CloseResult> {
            try {
                await refreshSnapshot();
            } catch {
                return { status: 'retryable', message: 'Herdr is temporarily unavailable. Try again.' };
            }
            const paneId = closePaneId(sessionId);
            if (paneId === undefined) {
                forgetClosedSession(sessionId);
                await routes.flush();
                return { status: 'closed', alreadyGone: true };
            }
            try {
                await refreshPlugins();
            } catch {
                return { status: 'retryable', message: 'Herdr is temporarily unavailable. Try again.' };
            }
            const target = trustedCloseTarget();
            const input = {
                paneId,
                ...(options.confirmedScope === undefined ? {} : { confirmedScope: options.confirmedScope }),
            };
            let raw: unknown;
            try {
                raw = await guardedPluginCall({
                    deviceId: options.deviceId,
                    idempotencyKey: rpcInputDigest({ operation: 'session.stop', requestId: options.idempotencyKey }),
                    target,
                    targetAtExecution: () => trustedCloseTarget(target.manifestHash),
                    input,
                    trustedHerdrSocketPath: socketPath,
                    requireApproval: false,
                });
            } catch (error) {
                if ((error as { code?: unknown }).code === 'host-contract-mismatch') throw error;
                if (isRetryableCloseFailure(error)) {
                    return { status: 'retryable', message: 'Herdr is temporarily unavailable. Try again.' };
                }
                throw hostContractMismatch('Agent close plugin RPC failed.');
            }
            const parsed = parseCloseResult(raw);
            if (!parsed.ok) {
                throw hostContractMismatch('Agent close plugin RPC returned an invalid result.');
            }
            if (parsed.value.status === 'closed') {
                forgetClosedSession(sessionId, paneId);
                await routes.flush();
            }
            return parsed.value;
        },

        async abort(sessionId: string): Promise<void> {
            const record = await resolvePane(sessionId);
            await client
                .call('agent.send_keys', { target: record.paneId, keys: ['escape'] })
                .catch(() => client.call('pane.send_keys', { pane_id: record.paneId, keys: ['escape'] }))
                .catch(() => {});
        },

        async reload(): Promise<void> {
            await refreshSnapshot();
        },

        async prompt(promptOptions: SessionPromptOptions): Promise<void> {
            await promptSession(promptOptions.sessionId, promptOptions.text);
        },


        async status(sessionId: string): Promise<SessionStatus> {
            await resolvePane(sessionId);
            return statusFor(sessionId);
        },



        async shell(shellOptions: SessionShellOptions): Promise<SessionShellOutcome | null> {
            const record = await resolvePane(shellOptions.sessionId);
            const cwd = cwdForSession(record.sessionId);
            if (cwd === undefined) throw agentUnavailable();
            return await new Promise((resolve) => {
                execFile(
                    '/bin/sh',
                    ['-c', shellOptions.command],
                    { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
                    (error, stdout, stderr) => {
                        const output = `${stdout}${stderr}`;
                        const exitCode = execFileExitCode(error);
                        if (shellOptions.quiet === true) {
                            resolve({ output, exitCode, isError: error !== null });
                            return;
                        }
                        publish(record.sessionId, { type: 'shell.start', command: shellOptions.command });
                        if (output.length > 0) publish(record.sessionId, { type: 'shell.chunk', chunk: output });
                        publish(record.sessionId, {
                            type: 'shell.end',
                            output,
                            exitCode,
                            isError: error !== null,
                        });
                        resolve(null);
                    },
                );
            });
        },

        async readFile(readOptions: SessionReadFileOptions): Promise<{ content: string }> {
            // ponytail: no sandboxing beyond the cap. The host runs as the user; the
            // app can already drive a full shell through the terminal channel.
            const handle = await open(readOptions.path, 'r');
            try {
                const bytes = Buffer.alloc(512 * 1024 + 1);
                const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
                return { content: bytes.subarray(0, bytesRead).toString('utf8').slice(0, 512 * 1024) };
            } finally {
                await handle.close();
            }
        },








        async saveAttachments(saveOptions: {
            sessionId: string;
            attachments: PromptAttachment[];
            folder?: string;
        }): Promise<{ savedPaths: string[] }> {
            const record = await resolvePane(saveOptions.sessionId);
            // Moshi's pattern: the file lands on the host, the agent gets a path.
            // Per-session folder keeps concurrent herds from stepping on names.
            // Both name and folder are client-supplied -- sanitize both, and
            // reject dot components: '..' must never climb out of the data dir.
            const folder = (saveOptions.folder ?? new Date().toISOString().replace(/[:.]/g, '-')).replace(
                /[^A-Za-z0-9_-]/g,
                '_',
            );
            const dir = join(options.dataDir, 'attachments', record.sessionId, folder);
            await mkdir(dir, { recursive: true });
            const savedPaths: string[] = [];
            for (const attachment of saveOptions.attachments) {
                const safeName = attachment.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment';
                const target = join(dir, safeName);
                await writeFile(target, Buffer.from(attachment.data, 'base64'));
                savedPaths.push(target);
            }
            return { savedPaths };
        },

        async attachmentFetch({ sessionId, attachmentId }: { sessionId: string; attachmentId: string }) {
            const record = currentSession(sessionId);
            if (record === undefined) return null;
            const found = await attachments.fetch(record.paneId, attachmentId);
            if (found?.data === undefined) return null;
            return { name: found.name, mimeType: found.mimeType, data: found.data };
        },

        async attachmentPrepare({ sessionId, attachmentId }: { sessionId: string; attachmentId: string }) {
            const record = currentSession(sessionId);
            if (record === undefined) return null;
            return attachmentDownloads.prepare(record.paneId, attachmentId);
        },

        async attachmentRead({ sessionId, attachmentId, offset, length }: { sessionId: string; attachmentId: string; offset: number; length: number }) {
            const record = currentSession(sessionId);
            if (record === undefined) return null;
            return attachments.read(record.paneId, attachmentId, offset, length);
        },




        resendCumulativeState(): void {
            // Invalidation frames are edge-triggered. If the machine→relay link
            // dropped one while clients stayed connected, host reconnect must
            // force a full mobile catalog reconciliation.
            const pluginFrame: PluginsInvalidatedFrame = { type: 'plugins.invalidated', reason: 'changed', pluginIds: [] };
            for (const listener of machineListeners) listener(pluginFrame);
            void attachments.resendAll(currentSessions().map((session) => session.paneId));
        },

        subscribe(listener: (sessionId: string, event: SessionEventBody) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        subscribeMachine(listener: (frame: PluginsInvalidatedFrame) => void): () => void {
            machineListeners.add(listener);
            return () => machineListeners.delete(listener);
        },

        async dispose(): Promise<void> {
            if (resnapshotTimer !== undefined) clearTimeout(resnapshotTimer);
            if (pluginPollTimer !== undefined) clearInterval(pluginPollTimer);
            pluginStreams?.closeAll();
            await codingCoordinator?.close();
            attachments.dispose();
            attachmentDownloads.dispose();
            for (const close of statusWatches.values()) close();
            statusWatches.clear();
            client.close();
            await routes.flush();
        },
    };
}
