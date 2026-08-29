/**
 * The herdr session source: SessionSource implemented against the herdr socket.
 *
 * Herdr owns the PTYs and knows the agents; this file owns the translation to
 * muxr sessions and the push of contract events. The app also sees
 * agents it did not start -- anything herdr detects on the bus gets a session
 * row, which is the point of a multiplexer backend.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    AgentLifecycle,
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
import { ATTENTION_REASONS, realtimePluginPublicContext, relayControlUrl } from '@muxr/contract';
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
} from '../application/sessionSource.js';
import { HerdrClient } from './socketClient.js';
import { IdentityStore, normalizeAgentName, parseTaskTitle, taskTitleFor, type AgentIdentity } from './identity.js';
import { pluginInvalidationFrame, PluginCatalog, PluginRefreshGate, WriteReplayFence, Semaphore, rpcInputDigest, rpcReplayKey, runPluginProcess, type HerdrPlugin } from './pluginCatalog.js';
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
    identity?: IdentityStore;
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
}

/** herdr agent record (agent.list / snapshot.agents / agent.start result). */
interface AgentRecord {
    agent?: string;
    name?: string;
    agent_status?: string;
    pane_id: string;
    tab_id?: string;
    workspace_id?: string;
    cwd?: string;
    foreground_cwd?: string;
    launch_pending?: boolean;
    interactive_ready?: boolean;
    terminal_title?: string;
    terminal_title_stripped?: string;
}
export async function sendKeysToLiveAgent(
    client: Pick<HerdrClient, 'call'>,
    agentsByPane: ReadonlyMap<string, unknown>,
    record: Pick<AgentIdentity, 'paneId' | 'agentName'>,
    keys: string[],
): Promise<void> {
    if (!agentsByPane.has(record.paneId)) throw new Error(`${record.agentName} is not ready for keys.`);
    await client.call('agent.send_keys', { target: record.paneId, keys });
}

export async function promptHerdrAgent(
    client: Pick<HerdrClient, 'call'>,
    record: Pick<AgentIdentity, 'paneId' | 'agentName'>,
    text: string,
): Promise<void> {
    const receipt = await client.call<unknown>('agent.prompt', { target: record.paneId, text });
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
        || agent.pane_id !== record.paneId) {
        throw new Error(`${record.agentName} prompt was not queued by Herdr.`);
    }
}

function agentRouteError(code: 'agent-unavailable' | 'agent-route-ambiguous'): Error {
    const message = code === 'agent-route-ambiguous'
        ? 'That Agent Route is ambiguous. Refresh and select the agent again.'
        : 'That agent is no longer available. Refresh and try again.';
    return Object.assign(new Error(message), { code });
}

/** Close one pane only when Herdr can preserve its tab and workspace. */
export async function closeExactPane(
    client: Pick<HerdrClient, 'call'>,
    paneId: string,
    panes: ReadonlyMap<string, Pick<PaneRecord, 'tab_id'>>,
): Promise<void> {
    const tabId = panes.get(paneId)?.tab_id;
    if (tabId === undefined) {
        throw Object.assign(new Error('That pane is no longer available. Refresh and try again.'), { code: 'pane-unavailable' });
    }
    let paneCount = 0;
    for (const pane of panes.values()) {
        if (pane.tab_id === tabId) paneCount += 1;
    }
    if (paneCount <= 1) {
        throw Object.assign(new Error('Closing this pane would also close its tab. Use Close tab instead.'), { code: 'pane-close-would-widen' });
    }
    await client.call('pane.close', { pane_id: paneId });
}

/** Close one tab only when Herdr can preserve its workspace. */
export async function closeExactTab(
    client: Pick<HerdrClient, 'call'>,
    tabId: string,
    tabs: ReadonlyMap<string, Pick<TabRecord, 'workspace_id'>>,
): Promise<void> {
    const workspaceId = tabs.get(tabId)?.workspace_id;
    if (workspaceId === undefined) {
        throw Object.assign(new Error('That tab is no longer available. Refresh and try again.'), { code: 'tab-unavailable' });
    }
    let tabCount = 0;
    for (const tab of tabs.values()) {
        if (tab.workspace_id === workspaceId) tabCount += 1;
    }
    if (tabCount <= 1) {
        throw Object.assign(new Error('Closing this tab would also close its workspace. Use Close workspace instead.'), { code: 'tab-close-would-widen' });
    }
    await client.call('tab.close', { tab_id: tabId });
}

/** Close one workspace, refusing Herdr's implicit parent-worktree group widening. */
export async function closeExactWorkspace(
    client: Pick<HerdrClient, 'call'>,
    workspaceId: string,
    workspaces: ReadonlyMap<string, WorkspaceRecord>,
): Promise<void> {
    const workspace = workspaces.get(workspaceId);
    if (workspace === undefined) {
        throw Object.assign(new Error('That workspace is no longer available. Refresh and try again.'), { code: 'workspace-unavailable' });
    }
    const worktree = workspace.worktree;
    if (worktree?.is_linked_worktree === false && worktree.repo_key !== undefined) {
        let groupSize = 0;
        for (const candidate of workspaces.values()) {
            if (candidate.worktree?.repo_key === worktree.repo_key) groupSize += 1;
        }
        if (groupSize >= 2) {
            throw Object.assign(new Error('Closing this workspace would close its worktree group. Use the explicit Close worktree group action instead.'), {
                code: 'worktree-group-confirmation-required',
            });
        }
    }
    await client.call('workspace.close', { workspace_id: workspaceId });
}

/** Close exactly the live pane or sole-pane tab selected by one stable Agent Route. */
export async function closeAgentRoute(
    client: Pick<HerdrClient, 'call'>,
    sessionId: string,
    identities: readonly Pick<AgentIdentity, 'sessionId' | 'paneId'>[],
    liveAgents: Pick<ReadonlyMap<string, unknown>, 'has'>,
    panes: ReadonlyMap<string, Pick<PaneRecord, 'tab_id'>>,
    tabs: ReadonlyMap<string, Pick<TabRecord, 'workspace_id'>>,
    afterClose: (record: Pick<AgentIdentity, 'sessionId' | 'paneId'>) => void,
): Promise<void> {
    let match: Pick<AgentIdentity, 'sessionId' | 'paneId'> | undefined;
    for (const identity of identities) {
        if (identity.sessionId !== sessionId) continue;
        if (match !== undefined) throw agentRouteError('agent-route-ambiguous');
        match = identity;
    }
    if (match === undefined || !liveAgents.has(match.paneId)) throw agentRouteError('agent-unavailable');
    const tabId = panes.get(match.paneId)?.tab_id;
    if (tabId === undefined) throw agentRouteError('agent-unavailable');
    let paneCount = 0;
    for (const pane of panes.values()) {
        if (pane.tab_id === tabId) paneCount += 1;
    }
    if (paneCount === 0) throw agentRouteError('agent-unavailable');
    try {
        if (paneCount > 1) await closeExactPane(client, match.paneId, panes);
        else await closeExactTab(client, tabId, tabs);
    } catch (error) {
        if (error !== null && typeof error === 'object' && 'code' in error
            && (error.code === 'pane-close-would-widen' || error.code === 'tab-close-would-widen')) throw error;
        throw agentRouteError('agent-unavailable');
    }
    afterClose(match);
}


interface PaneRecord {
    pane_id: string;
    tab_id?: string;
    workspace_id?: string;
    cwd?: string;
    foreground_cwd?: string;
    agent_status?: string;
    terminal_title?: string;
    terminal_title_stripped?: string;
    label?: string;
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

/** How long an app-started session survives before herdr must have detected its agent. */
const START_GRACE_MS = 90_000;
const DEFAULT_WATCH_MS = 30 * 60_000;
// ponytail: hard ceiling so a forgotten watch cannot hold a herdr connection
// open forever. Raise it if real turns routinely run longer than an hour.
const MAX_WATCH_MS = 60 * 60_000;

export async function createHerdrSessionSource(
    options: CreateHerdrSessionSourceOptions,
): Promise<SessionSource> {
    const socketPath = options.socketPath ?? join(homedir(), '.config', 'herdr', 'herdr.sock');
    const identity = options.identity ?? new IdentityStore(options.dataDir);
    await identity.load();
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
            const record = identity.byPane(paneId);
            if (record !== undefined) {
                emitState(record.sessionId);
            }
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
        const record = identity.get(sessionId);
        if (record === undefined) return undefined;
        const agent = agentsByPane.get(record.paneId);
        const pane = panesById.get(record.paneId);
        return agent?.foreground_cwd ?? pane?.foreground_cwd ?? pane?.cwd ?? record.cwd;
    }

    /** Agent-dropped artifacts in the pane's dump dir. Listed on demand through the attachments plugin. */
    const attachmentsDir = options.attachmentsDir ?? join(homedir(), '.muxr', 'attachments', 'pane');
    const attachments = new AttachmentWatcher(attachmentsDir, () => {
        // Bytes stay pull-only, but the phone must discard its cached count
        // when the directory changes or a newly written file stays at 0 until reconnect.
        const frame: PluginsInvalidatedFrame = { type: 'plugins.invalidated', reason: 'changed', pluginIds: [] };
        for (const listener of machineListeners) listener(frame);
    });
    attachments.start();

    /** One-time tickets + byte streaming for downloads too big for the ws link. */
    const attachmentDownloads = new AttachmentDownloadServer(attachmentsDir, options.hostHttpPort ?? 8793, attachments);
    attachmentDownloads.start();

    function lifecycleOf(paneId: string): AgentLifecycle {
        const sessionId = identity.byPane(paneId)?.sessionId;
        const canonical = sessionId === undefined ? undefined : options.lifecycle?.current(sessionId)?.state;
        if (!agentsByPane.has(paneId) && (canonical === 'starting' || canonical === 'failed')) return canonical;
        const raw = agentsByPane.get(paneId)?.agent_status ?? panesById.get(paneId)?.agent_status;
        if (raw === 'idle' || raw === 'working' || raw === 'blocked' || raw === 'done' || raw === 'failed') return raw;
        return canonical ?? 'unknown';
    }

    function transition(record: AgentIdentity, state: AgentLifecycle, reason: Parameters<NonNullable<CreateHerdrSessionSourceOptions['lifecycle']>['transition']>[3]): void {
        const event = options.lifecycle?.transition(
            record.sessionId,
            record.agentName,
            state,
            reason,
            record.taskTitle,
        );
        if (event !== undefined) publish(record.sessionId, { type: 'lifecycle.update', event });
    }

    function reportObserved(record: AgentIdentity, state: AgentLifecycle): void {
        if (options.lifecycle === undefined) return;
        const result = reportAgentOutcome(options.lifecycle, {
            sessionId: record.sessionId,
            agentName: record.agentName,
            state,
            ...(agentsByPane.get(record.paneId)?.agent_status === undefined
                ? {}
                : { liveAgentStatus: agentsByPane.get(record.paneId)!.agent_status }),
            ...(options.lifecycle.latestFor(record.sessionId)?.reasonCode === undefined
                ? {}
                : { previousReason: options.lifecycle.latestFor(record.sessionId)!.reasonCode }),
            taskTitle: record.taskTitle,
        });
        if (result.data !== undefined) publish(record.sessionId, { type: 'lifecycle.update', event: result.data });
    }

    function statusFor(sessionId: string): SessionStatus {
        const record = identity.get(sessionId);
        const agentStatus = record === undefined ? 'unknown' : lifecycleOf(record.paneId);

        return {
            sessionId,
            persisted: true,
            agentStatus,
            isStreaming: agentStatus === 'working',
            tokens: { ...EMPTY_TOKENS },
        };
    }

    function infoFor(record: AgentIdentity): SessionInfo {
        const pane = panesById.get(record.paneId);
        const agent = agentsByPane.get(record.paneId);
        const name = normalizeAgentName(agent?.name);
        const agentKind = publicAgentKind(record.kind ?? agent?.agent);
        const terminalTitle = agent?.terminal_title_stripped ?? pane?.terminal_title_stripped;
        const workspace = workspacesById.get(record.workspaceId);
        const worktree = workspace?.worktree;
        const tabLabel = tabsById.get(record.tabId)?.label;
        const taskTitle = record.taskTitle;
        const safeTerminalTitle = parseTaskTitle(terminalTitle, agentKind, name);
        const spawnedBy = pane?.tokens?.spawned_by;
        return {
            id: record.sessionId,
            cwd: agent?.foreground_cwd ?? pane?.foreground_cwd ?? pane?.cwd ?? record.cwd,
            path: record.paneId,
            name,
            displayName: name,
            ...(taskTitle === undefined ? {} : { taskTitle }),
            created: record.createdAt,
            modified: modifiedBySession.get(record.sessionId) ?? record.createdAt,
            messageCount: 0,
            firstMessage: '',
            ...(agentKind === undefined ? {} : { agentKind }),
            paneId: record.paneId,
            workspaceId: record.workspaceId,
            ...(workspace?.label === undefined ? {} : { workspaceLabel: workspace.label }),
            tabId: record.tabId,
            ...(tabLabel === undefined ? {} : { tabLabel }),
            ...(spawnedBy === undefined ? {} : { spawnedBy }),
            ...(safeTerminalTitle === undefined ? {} : { terminalTitle: safeTerminalTitle }),
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
            displayName: lifecycle?.displayName ?? 'Agent',
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

    function applyAttention(sessionId: string, agentStatus: AgentLifecycle, label: string | undefined): void {
        const attention = options.attention;
        if (attention === undefined) return;
        const name = label ?? 'Agent';
        let changed = false;
        switch (agentStatus) {
            case 'blocked':
                // A live lifecycle disproves a recorded start failure.
                changed = attention.clear(sessionId, 'failed') || changed;
                // Push only on the transition INTO waiting, not on every publish.
                if (attention.set(sessionId, 'waiting', `${name} needs attention.`)) {
                    changed = true;
                    const eventId = options.lifecycle?.current(sessionId)?.eventId;
                    if (eventId !== undefined) notifyAttention(sessionId, eventId, 'blocked');
                }
                break;
            case 'done':
                changed = attention.clear(sessionId, 'waiting', 'failed') || changed;
                if (attention.set(sessionId, 'done', `${name} finished.`)) {
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
                // unknown is exactly what a failed start looks like; clearing
                // 'failed' here would erase the failure it reports.
                changed = attention.clear(sessionId, 'waiting', 'done') || changed;
                break;
            case 'failed': {
                changed = attention.clear(sessionId, 'waiting', 'done') || changed;
                const runtime = options.lifecycle?.current(sessionId)?.reasonCode === 'agent-runtime-failed';
                const detail = runtime ? `${name} failed.` : `${name} could not start.`;
                if (attention.set(sessionId, 'failed', detail)) {
                    changed = true;
                    const eventId = options.lifecycle?.current(sessionId)?.eventId;
                    if (eventId !== undefined) notifyAttention(sessionId, eventId, 'failed');
                }
                break;
            }
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

    function emitState(sessionId: string): void {
        const record = identity.get(sessionId);
        if (record === undefined) return;
        const agentStatus = lifecycleOf(record.paneId);
        const stateSignature = agentStatus;
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
        // Terminal title / worktree / pane changes ride their own event so list
        // rows and preview cards can refresh without a status churn. Herdr's
        // animated leading spinner is decoration, not a semantic title change.
        const info = infoFor(record);
        const stableTitle = (info.terminalTitle ?? '').replace(/^[◐◑◒◓]\s*/, '');
        const signature = `${stableTitle}|${info.taskTitle ?? ''}|${info.worktree?.path ?? ''}|${info.paneId ?? ''}|${info.name ?? ''}`;
        if (lastInfoSignature.get(sessionId) !== signature) {
            lastInfoSignature.set(sessionId, signature);
            publish(sessionId, { type: 'session.updated', session: info });
        }
        reportObserved(record, agentStatus);
        applyAttention(sessionId, agentStatus, record.agentName);
    }

    function singlePaneTabLabel(tabId: string | undefined): string | undefined {
        if (tabId === undefined) return undefined;
        const tabPaneCount = [...panesById.values()].filter((pane) => pane.tab_id === tabId).length;
        if (tabPaneCount > 1) return undefined;
        return tabsById.get(tabId)?.label;
    }

    function applyLiveIdentity(live: Parameters<IdentityStore['observe']>[0]): AgentIdentity {
        const result = identity.observe(live);
        if (result.displaced !== undefined) {
            options.lifecycle?.remove(result.displaced.sessionId);
            clearAttention(result.displaced.sessionId);
            publish(result.displaced.sessionId, { type: 'session.removed' });
        }
        if (result.previousPaneId !== undefined && result.previousPaneId !== result.identity.paneId) {
            statusWatches.get(result.previousPaneId)?.();
            statusWatches.delete(result.previousPaneId);
            lifecycleEpochByPane.delete(result.previousPaneId);
            attachments.dropPane(result.previousPaneId);
        }
        if (result.created) publish(result.identity.sessionId, { type: 'session.created', session: infoFor(result.identity) });
        return result.identity;
    }

    /** Reconcile identity with what herdr currently reports. */
    async function syncDiscovery(): Promise<void> {
        for (const agent of agentsByPane.values()) {
            if (agent.pane_id === undefined) continue;
            ensureStatusWatch(agent.pane_id);
            const pane = panesById.get(agent.pane_id);
            applyLiveIdentity({
                paneId: agent.pane_id,
                workspaceId: agent.workspace_id ?? pane?.workspace_id,
                tabId: agent.tab_id ?? pane?.tab_id,
                cwd: agent.foreground_cwd ?? pane?.foreground_cwd ?? agent.cwd ?? pane?.cwd,
                agentName: agent.name,
                kind: agent.agent,
                paneLabel: pane?.label,
                tabLabel: singlePaneTabLabel(agent.tab_id ?? pane?.tab_id),
                terminalTitle: agent.terminal_title_stripped ?? pane?.terminal_title_stripped,
            });
        }
        // Shell panes (no agent in them) get sessions too: the phone should be
        // able to open and type into ANY pane, and a split-out shell is dead
        // weight otherwise. A shell session lives exactly as long as its pane.
        for (const pane of panesById.values()) {
            if (agentsByPane.has(pane.pane_id)) continue;
            applyLiveIdentity({
                paneId: pane.pane_id,
                workspaceId: pane.workspace_id,
                tabId: pane.tab_id,
                agentName: undefined,
                cwd: pane.foreground_cwd ?? pane.cwd,
                paneLabel: pane.label,
                tabLabel: singlePaneTabLabel(pane.tab_id),
                terminalTitle: pane.terminal_title_stripped,
            });
        }
        // A session dies with its PANE, not with its agent. An agent that exits
        // leaves a working shell behind, which stays openable until the pane
        // itself closes in herdr (resnapshots drop closed panes from panesById).
        for (const record of identity.all()) {
            if (agentsByPane.has(record.paneId)) continue;
            if (panesById.has(record.paneId)) continue;
            const starting =
                record.ours && Date.now() - Date.parse(record.createdAt) < START_GRACE_MS;
            if (starting) continue;
            statusWatches.get(record.paneId)?.();
            statusWatches.delete(record.paneId);
            lifecycleEpochByPane.delete(record.paneId);
            lastStateSignature.delete(record.sessionId);
            lastInfoSignature.delete(record.sessionId);
            attachments.dropPane(record.paneId);
            identity.remove(record.sessionId);
            options.lifecycle?.remove(record.sessionId);
            clearAttention(record.sessionId);
            // session.error left the row in the list as a corpse that opened a
            // blank terminal. The event stream is the only way the phone ever
            // learns a session is gone.
            publish(record.sessionId, { type: 'session.removed' });
        }
        // Attention outlives its session on disk (herdr restarts, panes close while
        // the host is down), which leaves an inbox badge pointing at nothing.
        const attention = options.attention;
        if (attention !== undefined) {
            for (const entry of attention.catalog().entries) {
                if (identity.get(entry.sessionId) !== undefined) continue;
                if (attention.clear(entry.sessionId)) {
                    publish(entry.sessionId, { type: 'attention.update', catalog: attention.catalog() });
                }
            }
        }
        await identity.flush();
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
        for (const record of identity.all()) emitState(record.sessionId);
    }

    const client = new HerdrClient(socketPath, () => {
        void client.subscribeEvents(EVENT_KINDS).catch(() => {});
        void refreshSnapshot().then(emitAllStates).catch(() => {});
    });

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
            if ('agent' in pane || 'name' in pane) {
                const currentAgentStatus = agentsByPane.get(pane.pane_id)?.agent_status;
                agentsByPane.set(pane.pane_id, {
                    ...agentsByPane.get(pane.pane_id),
                    ...(pane as AgentRecord),
                    ...(currentAgentStatus === undefined ? {} : { agent_status: currentAgentStatus }),
                });
            }
        }
        switch (kind) {
            case 'pane.updated': {
                // Some herdr versions require a filtered subscription for this;
                // if it does arrive, reconcile labels rather than only repainting.
                const paneId = typeof event.pane_id === 'string' ? event.pane_id : pane?.pane_id;
                const record = paneId === undefined ? undefined : identity.byPane(paneId);
                scheduleResnapshot();
                if (record !== undefined) emitState(record.sessionId);
                return;
            }
            case 'pane.agent.status.changed':
            case 'pane.agent.detected': {
                const paneId = typeof event.pane_id === 'string' ? event.pane_id : pane?.pane_id;
                const agentStatus = typeof event.agent_status === 'string' ? event.agent_status : pane?.agent_status;
                if (paneId !== undefined && agentStatus !== undefined) setLifecycle(paneId, agentStatus);
                const record = paneId === undefined ? undefined : identity.byPane(paneId);
                if (record !== undefined) {
                    scheduleResnapshot();
                    emitState(record.sessionId);
                    return;
                }
                scheduleResnapshot();
                return;
            }
            case 'pane.moved': {
                const previous = typeof event.previous_pane_id === 'string' ? event.previous_pane_id : undefined;
                const nextId = pane?.pane_id;
                if (previous !== undefined && nextId !== undefined && identity.byPane(previous) !== undefined) {
                    const observedKind = pane !== undefined && 'agent' in pane ? pane.agent : undefined;
                    applyLiveIdentity({
                        paneId: nextId,
                        previousPaneId: previous,
                        workspaceId: pane?.workspace_id,
                        tabId: pane?.tab_id,
                        cwd: pane?.foreground_cwd ?? pane?.cwd,
                        kind: observedKind,
                    });
                    void identity.flush().catch(() => scheduleResnapshot());
                    statusWatches.get(previous)?.();
                    statusWatches.delete(previous);
                    ensureStatusWatch(nextId);
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
    } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    }

    function agentUnavailable(): Error {
        return agentRouteError('agent-unavailable');
    }

    async function resolvePane(sessionId: string): Promise<AgentIdentity> {
        try { await refreshSnapshot(); } catch { throw agentUnavailable(); }
        const record = identity.get(sessionId);
        if (record === undefined || !panesById.has(record.paneId)) throw agentUnavailable();
        return record;
    }

    function snapshotFor(record: AgentIdentity, accepted = false): SessionSnapshot {
        return {
            info: infoFor(record),
            status: statusFor(record.sessionId),
            page: { messages: [], hasMore: false },
            ...(accepted ? { acceptance: { outcome: 'accepted' as const, state: lifecycleOf(record.paneId), displayName: record.agentName } } : {}),
        };
    }

    async function startSession(startOptions: SessionStartOptions & { kind?: string; label?: string }): Promise<SessionStartResult> {
        // Squad mode: one tab per kind. workspace-per-cwd dedup lands them
        // all in the same workspace; the first session answers the request,
        // the rest land through discovery events. Wire displayName is ignored:
        // plugins/pane-titler owns Herdr Agent Names.
        const squad: Array<{ kind: string; displayName?: string }> | undefined =
            startOptions.members ?? startOptions.kinds?.map((kind) => ({ kind }));
        if (squad !== undefined && squad.length > 1) {
            let first: SessionStartResult | undefined;
            const started: AgentIdentity[] = [];
            for (const member of squad.slice(0, 4)) {
                const snapshot = await startSession({
                    cwd: startOptions.cwd,
                    kind: member.kind,
                    ...(startOptions.taskTitle === undefined ? {} : { taskTitle: startOptions.taskTitle }),
                });
                if (!('info' in snapshot)) {
                    for (const record of started.reverse()) {
                        transition(record, 'failed', 'squad-rolled-back');
                        pluginStreams?.closeSession(record.sessionId);
                        await client.call('pane.close', { pane_id: record.paneId }).catch(() => undefined);
                        statusWatches.get(record.paneId)?.();
                        statusWatches.delete(record.paneId);
                        identity.remove(record.sessionId);
                        clearAttention(record.sessionId);
                        publish(record.sessionId, { type: 'session.removed' });
                    }
                    return snapshot;
                }
                const record = identity.get(snapshot.info.id);
                if (record !== undefined) started.push(record);
                first = first ?? snapshot;
            }
            if (first === undefined) throw new Error('herdr: squad start produced nothing');
            return first;
        }

        const kind = startOptions.kind ?? 'pi';
        const requestedLabel = startOptions.label?.trim();
        const sessionId = identity.allocateRoute();
        const agentName = 'Agent';
        const taskTitle = taskTitleFor(startOptions.taskTitle ?? requestedLabel, kind, agentName);
        const starting = options.lifecycle?.transition(sessionId, agentName, 'starting', 'start-requested', taskTitle);
        if (starting !== undefined) publish(sessionId, { type: 'lifecycle.update', event: starting });
        const earlyFailure = (): SessionStartResult => {
            const event = options.lifecycle?.transition(sessionId, agentName, 'failed', 'start-launch-failed', taskTitle);
            if (event !== undefined) {
                publish(sessionId, { type: 'lifecycle.update', event });
                notifyAttention(sessionId, event.eventId, 'failed');
            }
            return {
                acceptance: {
                    outcome: 'failed', state: 'failed', displayName: agentName,
                    code: 'start-launch-failed', message: 'Agent could not start.',
                },
            };
        };

        // Worktree sessions: herdr forks the checkout and groups it under the project.
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
            // Result shape (verified live): { type:'worktree_created', workspace: {
            //   workspace_id, worktree: { checkout_path } }, tab: { tab_id } }
            workspaceId = created.workspace?.workspace_id;
            const checkout = created.workspace?.worktree?.checkout_path;
            if (checkout !== undefined) cwd = checkout;
        }

        if (workspaceId === undefined) {
            // One workspace per project directory: phone and desk see the same herd.
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
                ...(requestedLabel === undefined || requestedLabel === '' ? {} : { label: requestedLabel }),
                focus: false,
            });
        } catch {
            return earlyFailure();
        }
        const paneId = tab.root_pane?.pane_id;
        const tabId = tab.tab?.tab_id;
        if (paneId === undefined || tabId === undefined) return earlyFailure();

        const record = identity.adopt({
            sessionId,
            paneId,
            workspaceId,
            tabId,
            cwd,
            kind: publicAgentKind(kind),
            taskTitle,
            ours: true,
        });
        try {
            await identity.flush();
        } catch {
            identity.remove(record.sessionId);
            await client.call('pane.close', { pane_id: paneId }).catch(() => undefined);
            return earlyFailure();
        }
        transition(record, 'starting', 'start-requested');

        // tab.create already left the pane at an interactive shell, which IS the
        // session when no agent is wanted. 'shell' is not a herdr kind, so
        // starting one would just fail.
        if (kind === 'shell') {
            publish(record.sessionId, { type: 'session.created', session: infoFor(record) });
            transition(record, 'working', 'agent-working');
            emitState(record.sessionId);
            return snapshotFor(record, true);
        }

        // agent.start acknowledges launch admission before the process becomes
        // interactive. Publish session.created only after Herdr confirms the
        // stable Agent Route can accept prompts.
        void client
            .call('agent.start', { name: record.sessionId, kind, pane_id: paneId, timeout_ms: 60_000 }, 70_000)
            .then(() => waitForInteractiveAgent(paneId, 60_000))
            .then(() => {
                const current = identity.get(record.sessionId);
                if (current === undefined) return;
                setLifecycle(current.paneId, 'working');
                publish(current.sessionId, { type: 'session.created', session: infoFor(current) });
                emitState(current.sessionId);
            })
            .catch((error: unknown) => {
                const current = identity.get(record.sessionId);
                if (current !== undefined) transition(current, 'failed', error instanceof Error && /timed?\s*out/i.test(error.message) ? 'start-timeout' : 'start-launch-failed');
                const friendly = current?.agentName ?? agentName;
                publish(record.sessionId, { type: 'session.error', message: `${friendly} could not start.` });
                const attention = options.attention;
                if (attention !== undefined && attention.set(record.sessionId, 'failed', `${friendly} could not start.`)) {
                    const eventId = options.lifecycle?.current(record.sessionId)?.eventId;
                    if (eventId !== undefined) notifyAttention(record.sessionId, eventId, 'failed');
                    publish(record.sessionId, { type: 'attention.update', catalog: attention.catalog() });
                }
            });

        return snapshotFor(record, true);
    }

    function realtimeAgentFor(record: AgentIdentity): RealtimeCodingAgent {
        const info = infoFor(record);
        const changedAt = Date.parse(options.lifecycle?.latestFor(record.sessionId)?.at ?? record.createdAt);
        return {
            sessionId: record.sessionId,
            cwd: info.cwd,
            displayName: record.agentName,
            taskTitle: record.taskTitle,
            kind: record.kind ?? 'agent',
            status: statusFor(record.sessionId).agentStatus ?? 'unknown',
            ...(Number.isFinite(changedAt) ? { changedAt } : {}),
        };
    }

    async function listRealtimeAgents(): Promise<RealtimeCodingAgent[]> {
        await refreshSnapshot();
        return identity.all().map(realtimeAgentFor);
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
        const record = identity.get(result.info.id);
        return record === undefined
            ? { accepted: false }
            : { accepted: true, agent: realtimeAgentFor(record) };
    }

    async function promptSession(sessionId: string, text: string): Promise<void> {
        const record = await resolvePane(sessionId);
        if (!agentsByPane.has(record.paneId)) {
            throw new Error(`${record.agentName} is not ready for prompts.`);
        }
        await promptHerdrAgent(client, record, text);
    }
    async function sendSessionKeys(sessionId: string, keys: string[]): Promise<void> {
        const record = await resolvePane(sessionId);
        await sendKeysToLiveAgent(client, agentsByPane, record, keys);
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
            return { status, detail: `${record.agentName} is ${status}` };
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
            sessions: identity.all().map((record) => {
                const pane = panesById.get(record.paneId);
                const agent = agentsByPane.get(record.paneId);
                const workspace = workspacesById.get(record.workspaceId);
                const tab = tabsById.get(record.tabId);
                const cwd = cwdForSession(record.sessionId) ?? record.cwd;
                const base = cwd.replace(/\/+$/, '').split('/').pop();
                return {
                    sessionId: record.sessionId,
                    label: record.taskTitle ?? agent?.name ?? pane?.terminal_title_stripped ?? tab?.label ?? base,
                    displayName: record.agentName,
                    taskTitle: record.taskTitle,
                    cwd,
                    workspaceLabel: workspace?.label,
                    tabLabel: tab?.label,
                    agentKind: publicAgentKind(record.kind ?? agent?.agent),
                    agentStatus: lifecycleOf(record.paneId),
                    activeAt: modifiedBySession.get(record.sessionId) ?? record.createdAt,
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
                        agentStatus: rollupLifecycle(tabPanes.map((pane) => lifecycleOf(pane.pane_id))),
                        sessions: tabPanes.map((pane) => {
                            const agent = agentsByPane.get(pane.pane_id);
                            const session = identity.byPane(pane.pane_id);
                            const agentKind = publicAgentKind(agent?.agent ?? session?.kind);
                            return {
                                ...(session === undefined ? {} : { sessionId: session.sessionId }),
                                label: pane.label ?? agent?.name ?? pane.terminal_title_stripped ?? session?.taskTitle,
                                displayName: session?.agentName,
                                taskTitle: session?.taskTitle ?? taskTitleFor(undefined, agentKind),
                                agentKind,
                                agentStatus: lifecycleOf(pane.pane_id),
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
            signal,
        });
    }

    async function invokeHerdrAction({ sessionId, pluginId, actionId }: { sessionId: string; pluginId: string; actionId: string }): Promise<void> {
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pluginId) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(actionId)) {
            throw new Error('plugin invoke rejected invalid identifier');
        }
        const plugins = await client.call<{ plugins?: { plugin_id: string; enabled: boolean; actions?: { id: string }[] }[] }>('plugin.list', { plugin_id: pluginId });
        const installed = (plugins.plugins ?? []).find((plugin) => plugin.plugin_id === pluginId && plugin.enabled);
        if (!installed?.actions?.some((action) => action.id === actionId)) throw new Error(`plugin action unavailable: ${pluginId}.${actionId}`);
        const record = await resolvePane(sessionId);
        await client.call('plugin.action.invoke', {
            plugin_id: pluginId,
            action_id: actionId,
            context: {
                workspace_id: record.workspaceId,
                tab_id: record.tabId,
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
                    publicContext = realtimePluginPublicContext(identity.all().map((session) => {
                        const info = infoFor(session);
                        const agentKind = publicAgentKind(session.kind);
                        return {
                            sessionId: session.sessionId,
                            displayName: session.agentName,
                            ...(info.taskTitle === undefined ? {} : { taskTitle: info.taskTitle }),
                            ...(agentKind === undefined ? {} : { agentKind }),
                        };
                    }));
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
                        cwd: cwdForSession(record.sessionId) ?? record.cwd,
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
            const call = catalog.call(pluginId, manifestHash, contributionId);
            let payload: unknown = input ?? null;
            let requestedSessionId: string | undefined;
            if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
                const { paneId: _paneId, cwd: _cwd, ...trustedPayload } = payload as Record<string, unknown>;
                payload = trustedPayload;
                if (typeof trustedPayload.sessionId === 'string') {
                    requestedSessionId = trustedPayload.sessionId;
                    const record = await resolvePane(trustedPayload.sessionId);
                    payload = { ...trustedPayload, paneId: record.paneId, cwd: cwdForSession(trustedPayload.sessionId) ?? record.cwd };
                }
            }
            const serializedInput = JSON.stringify(payload);
            if (Buffer.byteLength(serializedInput, 'utf8') > MAX_RPC_INPUT_BYTES) throw new Error('plugin call input is too large');
            const inputDigest = rpcInputDigest(payload);
            // Admission happens before the global queue, so one plugin/device
            // cannot reserve every future slot while other plugins are healthy.
            const run = async () => {
                const pluginActive = activePluginCalls.get(pluginId) ?? 0;
                const deviceActive = activeDeviceCalls.get(deviceId) ?? 0;
                if (pluginActive >= MAX_RPC_PER_PLUGIN || deviceActive >= MAX_RPC_PER_DEVICE) {
                    throw new Error(`plugin ${pluginId} is busy, retry`);
                }
                activePluginCalls.set(pluginId, pluginActive + 1);
                activeDeviceCalls.set(deviceId, deviceActive + 1);
                try {
                    return await pluginCallConcurrency.run(async () => pluginApprovals.whileApproved(deviceId, pluginId, async (signal) => {
                        let currentInput = serializedInput;
                        if (requestedSessionId !== undefined && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
                            const record = await resolvePane(requestedSessionId);
                            currentInput = JSON.stringify({
                                ...(payload as Record<string, unknown>),
                                paneId: record.paneId,
                                cwd: cwdForSession(requestedSessionId) ?? record.cwd,
                            });
                            if (Buffer.byteLength(currentInput, 'utf8') > MAX_RPC_INPUT_BYTES) throw new Error('plugin call input is too large');
                        }
                        const target = catalog.callTarget(pluginId, manifestHash, contributionId);
                        return runPluginCall(pluginId, target, currentInput, signal, requestedSessionId);
                    }), PLUGIN_CALL_QUEUE_TIMEOUT_MS);
                } finally {
                    decrement(activePluginCalls, pluginId);
                    decrement(activeDeviceCalls, deviceId);
                }
            };
            if (call.mode === 'write') {
                if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 64) throw new Error('write plugin call requires an idempotency key');
                const key = rpcReplayKey(deviceId, pluginId, manifestHash, contributionId, idempotencyKey);
                return writeReplayFence.run(`${deviceId}\0${pluginId}`, key, inputDigest, run);
            }
            return run();
        },



        async list(listOptions?: SessionListOptions): Promise<SessionInfo[]> {
            // A failed refresh must mark herdr down; serving the on-disk map
            // as if it were fresh is what makes the ghost convincing. A
            // successful snapshot is positive proof herdr is reachable again.
            await refreshSnapshot().then(
                () => {
                    client.connected = true;
                },
                () => {
                    client.connected = false;
                },
            );
            let records = identity.all();
            if (listOptions?.cwd !== undefined) {
                records = records.filter((record) => record.cwd === listOptions.cwd);
            }
            return records.map(infoFor).sort((a, b) => b.modified.localeCompare(a.modified));
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
            // Cached maps are event-fresh; a snapshot call here would work too but
            // the Spaces screen polls, so keep this free.
            const workspaces: HerdrTreeWorkspace[] = [];
            for (const workspace of workspacesById.values()) {
                const panes = [...panesById.values()].filter((p) => p.workspace_id === workspace.workspace_id);
                const tabIds = [...new Set(panes.map((p) => p.tab_id).filter((t): t is string => t !== undefined))];
                const tabs = tabIds.map((tabId) => {
                    const tabLabel = tabsById.get(tabId)?.label;
                    const tabPanes = panes.filter((p) => p.tab_id === tabId);
                    const treePanes = tabPanes.map((pane) => {
                        const agent = agentsByPane.get(pane.pane_id);
                        const session = identity.byPane(pane.pane_id);
                        const agentKind = publicAgentKind(agent?.agent ?? session?.kind);
                        const taskTitle = session?.taskTitle ?? taskTitleFor(undefined, agentKind);
                        const agentName = normalizeAgentName(agent?.name);
                        return {
                            paneId: pane.pane_id,
                            tabId,
                            ...(pane.label === undefined ? {} : { label: pane.label }),
                            ...(pane.foreground_cwd === undefined && pane.cwd === undefined
                                ? {}
                                : { cwd: pane.foreground_cwd ?? pane.cwd }),
                            ...(agentKind === undefined ? {} : { agentKind }),
                            ...(agentName === 'Agent' ? {} : { displayName: agentName }),
                            ...(taskTitle === undefined ? {} : { taskTitle }),
                            agentStatus: lifecycleOf(pane.pane_id),
                            ...(pane.terminal_title_stripped === undefined
                                ? {}
                                : { terminalTitle: pane.terminal_title_stripped }),
                            focused: pane.focused === true,
                            ...(session === undefined ? {} : { sessionId: session.sessionId }),
                        };
                    });
                    return {
                        tabId,
                        ...(tabLabel === undefined ? {} : { label: tabLabel }),
                        focused: tabPanes.some((p) => p.focused === true),
                        agentStatus: rollupLifecycle(treePanes.map((p) => p.agentStatus)),
                        panes: treePanes,
                    };
                });
                const worktree = workspace.worktree;
                workspaces.push({
                    workspaceId: workspace.workspace_id,
                    ...(workspace.label === undefined ? {} : { label: workspace.label }),
                    focused: workspace.focused === true,
                    agentStatus: rollupLifecycle(tabs.map((t) => t.agentStatus)),
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
            if (splitOptions.kind === undefined) return { paneId: newPaneId };
            // Record lineage in herdr itself so the app can show who spawned
            // whom. herdr has no parent/child field; a metadata token is its
            // sanctioned place for this and survives a host restart.
            await tagSpawn(newPaneId, splitOptions.sessionId);
            // Agent start blocks until detection; the name makes the session
            // recognisable on the other side.
            const name = `pph_${splitOptions.kind}_${newPaneId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 32);
            void client
                .call('agent.start', {
                    name,
                    kind: splitOptions.kind,
                    pane_id: newPaneId,
                    timeout_ms: 30_000,
                }, 40_000)
                .catch(() => {});
            // Give discovery a beat so the caller can navigate to a live session.
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const found = identity.byPane(newPaneId);
                if (found !== undefined) return { paneId: newPaneId, sessionId: found.sessionId };
                await new Promise((resolve) => setTimeout(resolve, 400));
            }
            return { paneId: newPaneId };
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
            const timeoutMs = Math.min(watchOptions.timeoutMs ?? DEFAULT_WATCH_MS, MAX_WATCH_MS);
            const until = watchOptions.until ?? ['idle', 'done', 'blocked'];
            const existing = watches.get(watchOptions.sessionId);
            if (existing !== undefined) clearTimeout(existing);
            // Only one watch per session: re-arming replaces rather than stacking
            // duplicate notifications for the same agent.
            const guard = setTimeout(() => watches.delete(watchOptions.sessionId), timeoutMs + 5_000);
            watches.set(watchOptions.sessionId, guard);

            // Deliberately not awaited: herdr blocks until the agent settles,
            // which is far longer than the caller's request timeout.
            void client
                .call<{ agent?: { agent_status?: string } }>(
                    'agent.wait',
                    { target: record.paneId, until, timeout_ms: timeoutMs },
                    timeoutMs + 10_000,
                )
                .then((result) => {
                    const status = result.agent?.agent_status ?? 'settled';
                    const watched = identity.get(watchOptions.sessionId);
                    const label = watched?.agentName ?? 'Agent';
                    publish(watchOptions.sessionId, {
                        type: 'watch.settled',
                        status,
                        detail: `${label} is ${status}`,
                    });
                })
                .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    publish(watchOptions.sessionId, {
                        type: 'watch.settled',
                        status: 'unknown',
                        detail: message.includes('timed out') ? 'Watch timed out' : `Watch ended: ${message}`,
                        timedOut: message.includes('timed out'),
                    });
                })
                .finally(() => {
                    clearTimeout(guard);
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
            return { snapshot: toSnapshot(root, (paneId) => identity.byPane(paneId)?.kind) };
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

        // Cached pane records are fresher than the identity map (pane.moved
        // updates paneId but not the workspace/tab on the identity record);
        // identity fields are the fallback for sessions herdr has not re-reported.
        async focusTabNeighbor(sessionId: string, direction: 'next' | 'prev'): Promise<void> {
            const record = await resolvePane(sessionId);
            const pane = panesById.get(record.paneId);
            const workspaceId = pane?.workspace_id ?? record.workspaceId;
            const currentTabId = pane?.tab_id ?? record.tabId;
            if (workspaceId === '' || currentTabId === '') return;
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
            const pane = panesById.get(record.paneId);
            const workspaceId = pane?.workspace_id ?? record.workspaceId;
            if (workspaceId === '') return;
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
            await closeExactTab(client, tabId, tabsById);
        },

        async closePane(sessionId: string): Promise<void> {
            const record = await resolvePane(sessionId);
            await closeExactPane(client, record.paneId, panesById);
        },

        async closeWorkspace(workspaceId: string): Promise<void> {
            try { await refreshSnapshot(); } catch {
                throw Object.assign(new Error('That workspace is no longer available. Refresh and try again.'), { code: 'workspace-unavailable' });
            }
            await closeExactWorkspace(client, workspaceId, workspacesById);
        },

        async createTab(sessionId: string, options: { kind?: string; label?: string }): Promise<void> {
            const record = await resolvePane(sessionId);
            const pane = panesById.get(record.paneId);
            const workspaceId = pane?.workspace_id ?? record.workspaceId;
            if (workspaceId === '') throw new Error('herdr: session has no workspace');
            const cwd = pane?.foreground_cwd ?? pane?.cwd ?? record.cwd;
            const requestedLabel = options.label?.trim();
            const createdSessionId = identity.allocateRoute();
            const tab = await client.call<{ tab?: { tab_id: string }; root_pane?: { pane_id: string } }>(
                'tab.create',
                { workspace_id: workspaceId, cwd, ...(requestedLabel === undefined ? {} : { label: requestedLabel }), focus: false },
            );
            const paneId = tab.root_pane?.pane_id;
            const tabId = tab.tab?.tab_id;
            if (paneId === undefined || tabId === undefined) throw new Error('herdr: tab.create returned no root pane');

            const created = identity.adopt({
                sessionId: createdSessionId,
                paneId,
                workspaceId,
                tabId,
                cwd,
                kind: publicAgentKind(options.kind),
                taskTitle: requestedLabel,
                ours: true,
            });
            if (options.kind === undefined) {
                publish(created.sessionId, { type: 'session.created', session: infoFor(created) });
                return;
            }
            void client
                .call('agent.start', { name: created.sessionId, kind: options.kind, pane_id: paneId, timeout_ms: 60_000 })
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

        async stop(sessionId: string): Promise<void> {
            try { await refreshSnapshot(); } catch { throw agentUnavailable(); }
            await closeAgentRoute(client, sessionId, identity.all(), agentsByPane, panesById, tabsById, (record) => {
                pluginStreams?.closeSession(record.sessionId);
                statusWatches.get(record.paneId)?.();
                statusWatches.delete(record.paneId);
                lifecycleEpochByPane.delete(record.paneId);
                lastStateSignature.delete(record.sessionId);
                lastInfoSignature.delete(record.sessionId);
                attachments.dropPane(record.paneId);
                identity.remove(record.sessionId);
                options.lifecycle?.remove(record.sessionId);
                clearAttention(record.sessionId);
                publish(record.sessionId, { type: 'session.removed' });
            });
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
            return await new Promise((resolve) => {
                execFile(
                    '/bin/sh',
                    ['-c', shellOptions.command],
                    { cwd: record.cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
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
            const record = identity.get(sessionId);
            if (record === undefined) return null;
            const found = await attachments.fetch(record.paneId, attachmentId);
            if (found?.data === undefined) return null;
            return { name: found.name, mimeType: found.mimeType, data: found.data };
        },

        async attachmentPrepare({ sessionId, attachmentId }: { sessionId: string; attachmentId: string }) {
            const record = identity.get(sessionId);
            if (record === undefined) return null;
            return attachmentDownloads.prepare(record.paneId, attachmentId);
        },

        async attachmentRead({ sessionId, attachmentId, offset, length }: { sessionId: string; attachmentId: string; offset: number; length: number }) {
            const record = identity.get(sessionId);
            if (record === undefined) return null;
            return attachments.read(record.paneId, attachmentId, offset, length);
        },




        resendCumulativeState(): void {
            // Invalidation frames are edge-triggered. If the machine→relay link
            // dropped one while clients stayed connected, host reconnect must
            // force a full mobile catalog reconciliation.
            const pluginFrame: PluginsInvalidatedFrame = { type: 'plugins.invalidated', reason: 'changed', pluginIds: [] };
            for (const listener of machineListeners) listener(pluginFrame);
            void attachments.resendAll(identity.all().map((record) => record.paneId));
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
            await identity.flush();
        },
    };
}
