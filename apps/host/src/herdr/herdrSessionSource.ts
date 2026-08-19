/**
 * The herdr session source: SessionSource implemented against the herdr socket.
 *
 * Herdr owns the PTYs and knows the agents; this file owns the translation to
 * muxr sessions and the push of contract events. The app also sees
 * agents it did not start -- anything herdr detects on the bus gets a session
 * row, which is the point of a multiplexer backend.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    AgentLifecycle,
    PluginsInvalidatedFrame,
    HerdrTreeWorkspace,
    LayoutSnapshot,
    PromptAttachment,
    SessionEventBody,
    SessionInfo,
    SessionSnapshot,
    SessionStatus,
} from '@muxr/contract';
import { ATTENTION_REASONS, relayControlUrl } from '@muxr/contract';
import { AttachmentWatcher } from './attachmentWatcher.js';
import { AttachmentDownloadServer } from './attachmentDownloads.js';
import type { DomainStores } from '../domain/index.js';
import type {
    SessionListOptions,
    SessionOpenOptions,
    SessionPromptOptions,
    SessionReadFileOptions,
    SessionShellOptions,
    SessionShellOutcome,
    SessionSource,
    SessionStartOptions,
} from '../sessionSource.js';
import { HerdrClient } from './socketClient.js';
import { IdentityStore, newSessionId, type HerdrIdentity } from './identity.js';
import { explicitHerdName, isGeneratedName, isPlaceholderLabel, pickHerdName } from './herdNames.js';
import { pluginInvalidationFrame, PluginCatalog, PluginRefreshGate, WriteReplayFence, Semaphore, rpcInputDigest, rpcReplayKey, runPluginProcess, type HerdrPlugin } from './pluginCatalog.js';
import { PluginApprovals } from './pluginApprovals.js';
import { PluginStreamManager } from './pluginStreamManager.js';
import type { HostedMachineKeys } from '../hostedE2ee.js';
import { MAX_RPC_CONCURRENCY, MAX_RPC_INPUT_BYTES, MAX_RPC_PER_DEVICE, MAX_RPC_PER_PLUGIN, type PluginContextRequest } from '@muxr/contract';
import { buildPluginPublicContext, type PublicContextSource } from './pluginPublicContext.js';

const PLUGIN_CALL_QUEUE_TIMEOUT_MS = 8_000;
const MAX_PLUGIN_INVOCATIONS_PER_SCOPE = 64;
const MAX_PLUGIN_INVOCATIONS_TOTAL = 1_024;
const moduleRoot = dirname(fileURLToPath(import.meta.url));
const bundledPluginsRoot = [join(moduleRoot, 'plugins'), join(moduleRoot, '../../../../plugins')].find(existsSync);
const BROWSER_RPC_PLUGINS_ROOT = bundledPluginsRoot === undefined ? undefined : realpathSync(bundledPluginsRoot);

function decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
}

export interface CreateHerdrSessionSourceOptions {
    socketPath?: string;
    dataDir: string;
    attention?: DomainStores['attention'];
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
    terminal_title?: string;
    terminal_title_stripped?: string;
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
    worktree?: { repo_name?: string; repo_root?: string; checkout_path?: string };
}

interface TabRecord {
    tab_id: string;
    workspace_id?: string;
    label?: string;
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

/** The subset of herdr's layout tree this file reads. */
export type HerdrLayoutNode =
    | { type: 'pane'; pane_id?: string; cwd?: string }
    | { type: 'split'; direction: 'right' | 'down'; ratio: number; first: HerdrLayoutNode; second: HerdrLayoutNode };

export function toSnapshot(node: HerdrLayoutNode, identity: IdentityStore): LayoutSnapshot {
    if (node.type === 'split') {
        return {
            type: 'split',
            direction: node.direction,
            ratio: node.ratio,
            first: toSnapshot(node.first, identity),
            second: toSnapshot(node.second, identity),
        };
    }
    const kind = node.pane_id === undefined ? undefined : identity.byPane(node.pane_id)?.kind;
    return {
        type: 'pane',
        ...(node.cwd === undefined ? {} : { cwd: node.cwd }),
        ...(kind === undefined ? {} : { kind }),
    };
}

/** Panes restore as plain shells; agents are started afterwards by pane id. */
export function toHerdrRoot(node: LayoutSnapshot): HerdrLayoutNode {
    if (node.type === 'split') {
        return {
            type: 'split',
            direction: node.direction,
            ratio: node.ratio,
            first: toHerdrRoot(node.first),
            second: toHerdrRoot(node.second),
        };
    }
    return { type: 'pane', ...(node.cwd === undefined ? {} : { cwd: node.cwd }) };
}

export function collectKinds(node: LayoutSnapshot, out: (string | undefined)[] = []): (string | undefined)[] {
    if (node.type === 'split') {
        collectKinds(node.first, out);
        collectKinds(node.second, out);
    } else {
        out.push(node.kind);
    }
    return out;
}

export function collectPaneIds(node: HerdrLayoutNode, out: (string | undefined)[] = []): (string | undefined)[] {
    if (node.type === 'split') {
        collectPaneIds(node.first, out);
        collectPaneIds(node.second, out);
    } else {
        out.push(node.pane_id);
    }
    return out;
}

/**
 * The entry `step` away from `currentId` in `list`, wrapping at both ends.
 * Pure so tab/workspace adjacency (next/prev + wrap-around) is unit-tested
 * without a herdr server. Undefined when the list has <2 entries (nothing to
 * switch to) or the current id is absent (stale); callers no-op silently.
 */
export function neighborId<T extends string>(
    list: readonly T[],
    currentId: string,
    direction: 'next' | 'prev',
): T | undefined {
    if (list.length < 2) return undefined;
    const index = list.indexOf(currentId as T);
    if (index === -1) return undefined;
    const step = direction === 'next' ? 1 : -1;
    return list[(index + step + list.length) % list.length];
}
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
    const pluginStreams = options.relayUrl === undefined || options.machineId === undefined
        ? undefined
        : new PluginStreamManager({
            relayUrl: options.relayUrl,
            machineId: options.machineId,
            ...(options.token === undefined ? {} : { token: options.token }),
            ...(options.hostedE2ee === undefined ? {} : { hostedE2ee: options.hostedE2ee }),
        });
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
    /** Ignore the old pane label until a requested rename appears in a snapshot. */
    const pendingPaneLabels = new Map<string, string>();

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
        // Listed on demand through the attachments plugin RPC. Pushing the
        // catalog onto the phone froze the JS thread on large files.
    });
    attachments.start();

    /** One-time tickets + byte streaming for downloads too big for the ws link. */
    const attachmentDownloads = new AttachmentDownloadServer(attachmentsDir, options.hostHttpPort ?? 8793, attachments);
    attachmentDownloads.start();

    function lifecycleOf(paneId: string): AgentLifecycle {
        const raw = agentsByPane.get(paneId)?.agent_status ?? panesById.get(paneId)?.agent_status;
        return raw === 'idle' || raw === 'working' || raw === 'blocked' || raw === 'done' ? raw : 'unknown';
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

    function infoFor(record: HerdrIdentity): SessionInfo {
        const pane = panesById.get(record.paneId);
        const agent = agentsByPane.get(record.paneId);
        const name = record.label ?? agent?.name;
        const agentKind = record.kind ?? agent?.agent;
        const terminalTitle = agent?.terminal_title_stripped ?? pane?.terminal_title_stripped;
        const workspace = workspacesById.get(record.workspaceId);
        const worktree = workspace?.worktree;
        const tabLabel = tabsById.get(record.tabId)?.label;
        const spawnedBy = pane?.tokens?.spawned_by;
        return {
            id: record.sessionId,
            cwd: agent?.foreground_cwd ?? pane?.foreground_cwd ?? pane?.cwd ?? record.cwd,
            path: record.paneId,
            ...(name === undefined ? {} : { name }),
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
            ...(terminalTitle === undefined || terminalTitle === '' ? {} : { terminalTitle }),
            ...(worktree?.checkout_path === undefined
                ? {}
                : {
                      worktree: {
                          repo: worktree.repo_name ?? worktree.repo_root ?? 'repo',
                          ...(workspace?.label === undefined ? {} : { branch: workspace.label }),
                          path: worktree.checkout_path,
                      },
                  }),
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

    function notifyBlocked(sessionId: string, detail: string): void {
        if (pushNotifyUrl === undefined || options.machineId === undefined) return;
        const body = JSON.stringify({ machineId: options.machineId, sessionId, kind: 'blocked', detail });
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

    function applyAttention(sessionId: string, agentStatus: AgentLifecycle, kind: string | undefined): void {
        const attention = options.attention;
        if (attention === undefined) return;
        const label = kind ?? 'agent';
        let changed = false;
        switch (agentStatus) {
            case 'blocked':
                // Push only on the transition INTO waiting, not on every publish.
                if (attention.set(sessionId, 'waiting', `${label} needs an answer`)) {
                    changed = true;
                    notifyBlocked(sessionId, `${label} needs an answer`);
                }
                break;
            case 'done':
                changed = attention.clear(sessionId, 'waiting') || changed;
                changed = attention.set(sessionId, 'done', `${label} finished`) || changed;
                break;
            case 'working':
            case 'idle':
            case 'unknown':
                changed = attention.clear(sessionId, 'waiting', 'done') || changed;
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
        const signature = `${stableTitle}|${info.worktree?.path ?? ''}|${info.paneId ?? ''}|${info.name ?? ''}`;
        if (lastInfoSignature.get(sessionId) !== signature) {
            lastInfoSignature.set(sessionId, signature);
            publish(sessionId, { type: 'session.updated', session: info });
        }
        applyAttention(sessionId, agentStatus, record.kind);
    }

    /**
     * A name for a pane nobody named, unique against every name in play --
     * ours, the desk's pane labels, and herdr's own agent names -- so "send it
     * to Otter" can only mean one pane. Pushed back into herdr so the desk and
     * the phone call it the same thing.
     */
    function freeHerdName(): string {
        // ponytail: two starts racing can pick the same name; the pane picker
        // then asks which one. Reserve in-flight names if that ever bites.
        return pickHerdName(
            [
                ...identity.all().map((record) => record.label),
                ...[...panesById.values()].map((pane) => pane.label),
                ...[...agentsByPane.values()].map((agent) => (isGeneratedName(agent.name) ? undefined : agent.name)),
            ].filter((name): name is string => typeof name === 'string' && name.trim() !== ''),
        );
    }

    function renamePane(paneId: string, label: string): void {
        pendingPaneLabels.set(paneId, label);
        void client.call('pane.rename', { pane_id: paneId, label }).catch(() => {
            if (pendingPaneLabels.get(paneId) === label) pendingPaneLabels.delete(paneId);
        });
    }

    function assignHerdName(paneId: string): string {
        const name = freeHerdName();
        renamePane(paneId, name);
        return name;
    }

    /** Reconcile identity with what herdr currently reports. */
    function syncDiscovery(): void {
        for (const agent of agentsByPane.values()) {
            if (agent.pane_id === undefined) continue;
            ensureStatusWatch(agent.pane_id);
            const known = identity.byPane(agent.pane_id);
            const paneLabel = panesById.get(agent.pane_id)?.label?.trim() || undefined;
            const pendingPaneLabel = pendingPaneLabels.get(agent.pane_id);
            if (paneLabel === pendingPaneLabel) pendingPaneLabels.delete(agent.pane_id);
            const agentLabel = isGeneratedName(agent.name) ? undefined : agent.name?.trim();
            // A tab label names the tab, not every pane inside a split. Reusing
            // it across siblings would make voice targeting ambiguous.
            const tabPaneCount = [...panesById.values()].filter((pane) => pane.tab_id === agent.tab_id).length;
            const rawTabLabel = tabPaneCount <= 1 ? tabsById.get(agent.tab_id ?? '')?.label : undefined;
            const tabLabel = isPlaceholderLabel(rawTabLabel) ? undefined : rawTabLabel?.trim();
            if (known !== undefined) {
                // A later explicit rename beats an automatic animal. Otherwise
                // the stored explicit name remains authoritative.
                const paneRenamed = pendingPaneLabel === undefined && paneLabel !== known.label && !isPlaceholderLabel(paneLabel) ? paneLabel : undefined;
                const agentRenamed = agent.name !== known.agentName ? agentLabel : undefined;
                const tabRenamed = known.autoLabel === true && tabLabel !== known.label ? tabLabel : undefined;
                const renamed = paneRenamed ?? agentRenamed ?? tabRenamed;
                if (renamed !== undefined && paneRenamed === undefined) renamePane(agent.pane_id, renamed);
                const given = renamed ?? known.label ?? paneLabel ?? agentLabel ?? tabLabel;
                const label = given ?? assignHerdName(agent.pane_id);
                const autoLabel = renamed === undefined && given === undefined ? true : renamed === undefined ? known.autoLabel : false;
                if (
                    label !== known.label
                    || autoLabel !== known.autoLabel
                    || (agent.name !== undefined && known.agentName !== agent.name)
                    || (agent.agent !== undefined && known.kind !== agent.agent)
                ) {
                    identity.put({
                        ...known,
                        label,
                        ...(autoLabel === undefined ? {} : { autoLabel }),
                        ...(agent.name === undefined ? {} : { agentName: agent.name }),
                        ...(agent.agent === undefined ? {} : { kind: agent.agent }),
                    });
                }
                continue;
            }
            // An agent herdr found that we did not start: the desk's herd shows up on the phone.
            const sessionId = newSessionId();
            const given = explicitHerdName({
                ...(paneLabel === undefined ? {} : { paneLabel }),
                ...(agent.name === undefined ? {} : { agentName: agent.name }),
                ...(rawTabLabel === undefined ? {} : { tabLabel: rawTabLabel }),
            });
            identity.put({
                sessionId,
                paneId: agent.pane_id,
                workspaceId: agent.workspace_id ?? '',
                tabId: agent.tab_id ?? '',
                label: given ?? assignHerdName(agent.pane_id),
                autoLabel: given === undefined,
                ...(agent.name === undefined ? {} : { agentName: agent.name }),
                ...(agent.agent === undefined ? {} : { kind: agent.agent }),
                cwd: agent.foreground_cwd ?? agent.cwd ?? '/',
                createdAt: new Date().toISOString(),
                ours: false,
            });
            const record = identity.get(sessionId);
            if (record !== undefined) {
                publish(sessionId, { type: 'session.created', session: infoFor(record) });
            }
        }
        // Shell panes (no agent in them) get sessions too: the phone should be
        // able to open and type into ANY pane, and a split-out shell is dead
        // weight otherwise. A shell session lives exactly as long as its pane.
        for (const pane of panesById.values()) {
            if (agentsByPane.has(pane.pane_id)) continue;
            const known = identity.byPane(pane.pane_id);
            if (known !== undefined) {
                const paneLabel = pane.label?.trim() || undefined;
                const pending = pendingPaneLabels.get(pane.pane_id);
                if (paneLabel === pending) pendingPaneLabels.delete(pane.pane_id);
                if (pending === undefined && paneLabel !== undefined && paneLabel !== known.label && !isPlaceholderLabel(paneLabel)) {
                    identity.put({ ...known, label: paneLabel, autoLabel: false });
                }
                continue;
            }
            const sessionId = newSessionId();
            const tabPaneCount = [...panesById.values()].filter((candidate) => candidate.tab_id === pane.tab_id).length;
            const rawTabLabel = tabPaneCount <= 1 ? tabsById.get(pane.tab_id ?? '')?.label : undefined;
            const given = explicitHerdName({
                ...(pane.label === undefined ? {} : { paneLabel: pane.label }),
                ...(rawTabLabel === undefined ? {} : { tabLabel: rawTabLabel }),
            });
            identity.put({
                sessionId,
                paneId: pane.pane_id,
                workspaceId: pane.workspace_id ?? '',
                tabId: pane.tab_id ?? '',
                cwd: pane.foreground_cwd ?? pane.cwd ?? '/',
                label: given ?? assignHerdName(pane.pane_id),
                autoLabel: given === undefined,
                createdAt: new Date().toISOString(),
                ours: false,
            });
            const record = identity.get(sessionId);
            if (record !== undefined) {
                publish(sessionId, { type: 'session.created', session: infoFor(record) });
            }
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
            pendingPaneLabels.delete(record.paneId);
            lastStateSignature.delete(record.sessionId);
            lastInfoSignature.delete(record.sessionId);
            attachments.dropPane(record.paneId);
            identity.remove(record.sessionId);
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
        syncDiscovery();
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
                const record = previous === undefined ? undefined : identity.byPane(previous);
                if (record !== undefined && nextId !== undefined) {
                    identity.put({ ...record, paneId: nextId });
                    if (previous !== undefined) {
                        statusWatches.get(previous)?.();
                        statusWatches.delete(previous);
                    }
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

    async function resolvePane(sessionId: string): Promise<HerdrIdentity> {
        const record = identity.get(sessionId);
        if (record === undefined) throw new Error(`unknown session: ${sessionId}`);
        return record;
    }

    function snapshotFor(record: HerdrIdentity): SessionSnapshot {
        return {
            info: infoFor(record),
            status: statusFor(record.sessionId),
            page: { messages: [], hasMore: false },
        };
    }

    async function startSession(startOptions: SessionStartOptions & { kind?: string; label?: string }): Promise<SessionSnapshot> {
        // Squad mode: one tab per kind. workspace-per-cwd dedup lands them
        // all in the same workspace; the first session answers the request,
        // the rest land through discovery events.
        if (startOptions.kinds !== undefined && startOptions.kinds.length > 1) {
            let first: SessionSnapshot | undefined;
            for (const squadKind of startOptions.kinds.slice(0, 4)) {
                const snapshot = await startSession({
                    cwd: startOptions.cwd,
                    kind: squadKind,
                });
                first = first ?? snapshot;
            }
            if (first === undefined) throw new Error('herdr: squad start produced nothing');
            return first;
        }

        const kind = startOptions.kind ?? 'pi';
        const sessionId = newSessionId();
        // Named before the tab exists: the tab carries the name on the desk, and
        // a herd of panes all called "pi" is one nobody can point at.
        const requestedLabel = startOptions.label?.trim();
        const label = requestedLabel || freeHerdName();

        // Worktree sessions: herdr forks the checkout and groups it under the project.
        let cwd = startOptions.cwd;
        let workspaceId: string | undefined;
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
        if (workspaceId === undefined) throw new Error('herdr: could not resolve a workspace');

        const tab = await client.call<{ tab?: { tab_id: string }; root_pane?: { pane_id: string } }>(
            'tab.create',
            {
                workspace_id: workspaceId,
                cwd,
                label,
                focus: false,
            },
        );
        const paneId = tab.root_pane?.pane_id;
        const tabId = tab.tab?.tab_id;
        if (paneId === undefined || tabId === undefined) throw new Error('herdr: tab.create returned no root pane');
        renamePane(paneId, label);

        identity.put({
            sessionId,
            paneId,
            workspaceId,
            tabId,
            cwd,
            kind,
            label,
            autoLabel: requestedLabel === undefined || requestedLabel === '',
            createdAt: new Date().toISOString(),
            ours: true,
        });
        const record = identity.get(sessionId);
        if (record === undefined) throw new Error('herdr: identity write failed');

        // tab.create already left the pane at an interactive shell, which IS the
        // session when no agent is wanted. 'shell' is not a herdr kind, so
        // starting one would just fail.
        if (kind === 'shell') {
            publish(sessionId, { type: 'session.created', session: infoFor(record) });
            emitState(sessionId);
            return snapshotFor(record);
        }

        // agent.start blocks until detection (up to 30s+); the client times out at
        // 20s. Answer now, land the detection as events.
        void client
            .call('agent.start', { name: sessionId, kind, pane_id: paneId, timeout_ms: 60_000 })
            .then(() => {
                const current = identity.get(sessionId);
                if (current === undefined) return;
                identity.put({ ...current, agentName: sessionId });
                publish(sessionId, { type: 'session.created', session: infoFor(current) });
                emitState(sessionId);
            })
            .catch((error: unknown) => {
                publish(sessionId, {
                    type: 'session.error',
                    message: error instanceof Error ? error.message : String(error),
                });
            });

        return snapshotFor(record);
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
                    label: record.label ?? agent?.name ?? pane?.terminal_title_stripped ?? tab?.label ?? base,
                    cwd,
                    workspaceLabel: workspace?.label,
                    tabLabel: tab?.label,
                    agentKind: record.kind ?? agent?.agent,
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
                        agentStatus: tabPanes.reduce<AgentLifecycle>((best, pane) => {
                            const status = lifecycleOf(pane.pane_id);
                            const rank = (value: AgentLifecycle) => value === 'blocked' ? 4 : value === 'working' ? 3 : value === 'done' ? 2 : value === 'idle' ? 1 : 0;
                            return rank(status) > rank(best) ? status : best;
                        }, 'unknown'),
                        sessions: tabPanes.map((pane) => {
                            const agent = agentsByPane.get(pane.pane_id);
                            const session = identity.byPane(pane.pane_id);
                            return {
                                ...(session === undefined ? {} : { sessionId: session.sessionId }),
                                label: pane.label ?? agent?.name ?? pane.terminal_title_stripped ?? session?.label,
                                agentKind: agent?.agent ?? session?.kind,
                                agentStatus: lifecycleOf(pane.pane_id),
                            };
                        }),
                    };
                });
                return {
                    label: workspace.label,
                    focused: workspace.focused === true,
                    agentStatus: tabs.reduce<AgentLifecycle>((best, tab) => {
                        const rank = (value: AgentLifecycle) => value === 'blocked' ? 4 : value === 'working' ? 3 : value === 'done' ? 2 : value === 'idle' ? 1 : 0;
                        return rank(tab.agentStatus) > rank(best) ? tab.agentStatus : best;
                    }, 'unknown'),
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
            const record = sessionId === undefined ? undefined : identity.get(sessionId);
            if (sessionId !== undefined && record === undefined) throw new Error(`unknown session: ${sessionId}`);
            const stateDir = join(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'), 'plugin-state', pluginId);
            const approval = await pluginApprovals.track(deviceId, pluginId, () => pluginStreams.detach(channel, 'plugin revoked'));
            try {
                await pluginStreams.attach({
                    target: { pluginId, pluginRoot: target.pluginRoot, entry: target.entry },
                    channel,
                    stateDir,
                    ...(record === undefined ? {} : {
                        sessionId: record.sessionId,
                        paneId: record.paneId,
                        cwd: cwdForSession(record.sessionId) ?? record.cwd,
                    }),
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
                    const record = identity.get(trustedPayload.sessionId);
                    if (record !== undefined) {
                        payload = { ...trustedPayload, paneId: record.paneId, cwd: cwdForSession(trustedPayload.sessionId) ?? record.cwd };
                    }
                }
            }
            const serializedInput = JSON.stringify(payload);
            if (Buffer.byteLength(serializedInput, 'utf8') > MAX_RPC_INPUT_BYTES) throw new Error('plugin call input is too large');
            const inputDigest = rpcInputDigest(payload);
            // Admission happens before the global queue, so one plugin/device
            // cannot reserve every future slot while other plugins are healthy.
            const run = async () => {
                const queuedAt = Date.now();
                let startedAt: number | undefined;
                let outcome = 'error';
                const pluginActive = activePluginCalls.get(pluginId) ?? 0;
                const deviceActive = activeDeviceCalls.get(deviceId) ?? 0;
                if (pluginActive >= MAX_RPC_PER_PLUGIN || deviceActive >= MAX_RPC_PER_DEVICE) {
                    outcome = pluginActive >= MAX_RPC_PER_PLUGIN ? 'plugin-busy' : 'device-busy';
                    console.log(`[plugin-rpc] plugin=${pluginId} method=${call.method} mode=${call.mode} queue=0ms run=0ms outcome=${outcome}`);
                    throw new Error(`plugin ${pluginId} is busy, retry`);
                }
                activePluginCalls.set(pluginId, pluginActive + 1);
                activeDeviceCalls.set(deviceId, deviceActive + 1);
                try {
                    return await pluginCallConcurrency.run(async () => {
                        startedAt = Date.now();
                        try {
                            const result = await pluginApprovals.whileApproved(deviceId, pluginId, async (signal) => {
                                const target = catalog.callTarget(pluginId, manifestHash, contributionId);
                                return runPluginCall(pluginId, target, serializedInput, signal, requestedSessionId);
                            });
                            outcome = 'ok';
                            return result;
                        } catch (error) {
                            outcome = error instanceof Error && error.name === 'PluginCallDeadlineError'
                                ? 'deadline'
                                : error instanceof Error && error.name === 'PluginCallQueueTimeoutError'
                                  ? 'queue-timeout'
                                  : error instanceof Error && error.name === 'AbortError'
                                    ? 'revoked'
                                    : 'error';
                            throw error;
                        }
                    }, PLUGIN_CALL_QUEUE_TIMEOUT_MS);
                } finally {
                    decrement(activePluginCalls, pluginId);
                    decrement(activeDeviceCalls, deviceId);
                    const endedAt = Date.now();
                    const queueMs = startedAt === undefined ? 0 : startedAt - queuedAt;
                    const runMs = startedAt === undefined ? 0 : endedAt - startedAt;
                    console.log(`[plugin-rpc] plugin=${pluginId} method=${call.method} mode=${call.mode} queue=${queueMs}ms run=${runMs}ms outcome=${outcome}`);
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
            return [...new Set((result.manifests ?? [])
                .map((manifest) => manifest.agent?.trim())
                .filter((agent): agent is string => agent !== undefined && /^[a-z][a-z0-9_-]{0,31}$/.test(agent)))]
                .slice(0, 64);
        },

        async herdrTree(): Promise<{ workspaces: HerdrTreeWorkspace[]; connected: boolean }> {
            // Cached maps are event-fresh; a snapshot call here would work too but
            // the Spaces screen polls, so keep this free.
            const lifecycleOfPane = (paneId: string): AgentLifecycle => lifecycleOf(paneId);
            const rank = (status: AgentLifecycle): number =>
                status === 'blocked' ? 4 : status === 'working' ? 3 : status === 'done' ? 2 : status === 'idle' ? 1 : 0;
            const rollup = (statuses: AgentLifecycle[]): AgentLifecycle =>
                statuses.reduce<AgentLifecycle>((best, s) => (rank(s) > rank(best) ? s : best), 'unknown');

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
                        return {
                            paneId: pane.pane_id,
                            tabId,
                            ...(pane.label === undefined ? {} : { label: pane.label }),
                            ...(pane.foreground_cwd === undefined && pane.cwd === undefined
                                ? {}
                                : { cwd: pane.foreground_cwd ?? pane.cwd }),
                            ...(agent?.agent === undefined ? {} : { agentKind: agent.agent }),
                            ...(agent?.name === undefined ? {} : { agentName: agent.name }),
                            agentStatus: lifecycleOfPane(pane.pane_id),
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
                        agentStatus: rollup(treePanes.map((p) => p.agentStatus)),
                        panes: treePanes,
                    };
                });
                const worktree = workspace.worktree;
                workspaces.push({
                    workspaceId: workspace.workspace_id,
                    ...(workspace.label === undefined ? {} : { label: workspace.label }),
                    focused: workspace.focused === true,
                    agentStatus: rollup(tabs.map((t) => t.agentStatus)),
                    ...(worktree?.checkout_path === undefined
                        ? {}
                        : {
                              worktree: {
                                  repo: worktree.repo_name ?? worktree.repo_root ?? 'repo',
                                  ...(workspace.label === undefined ? {} : { branch: workspace.label }),
                                  path: worktree.checkout_path,
                              },
                          }),
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
                })
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
                    const label = identity.get(watchOptions.sessionId)?.kind ?? 'agent';
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
            return { snapshot: toSnapshot(root, identity) };
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
            const record = await resolvePane(sessionId);
            await client.call('pane.focus', { pane_id: record.paneId });
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
            await client.call('tab.close', { tab_id: tabId });
        },

        async closePane(sessionId: string): Promise<void> {
            const record = await resolvePane(sessionId);
            await client.call('pane.close', { pane_id: record.paneId });
        },

        async closeWorkspace(workspaceId: string): Promise<void> {
            await client.call('workspace.close', { workspace_id: workspaceId });
        },

        async createTab(sessionId: string, options: { kind?: string; label?: string }): Promise<void> {
            const record = await resolvePane(sessionId);
            const pane = panesById.get(record.paneId);
            const workspaceId = pane?.workspace_id ?? record.workspaceId;
            if (workspaceId === '') throw new Error('herdr: session has no workspace');
            const cwd = pane?.foreground_cwd ?? pane?.cwd ?? record.cwd;
            const requestedLabel = options.label?.trim();
            const label = requestedLabel || freeHerdName();
            const tab = await client.call<{ tab?: { tab_id: string }; root_pane?: { pane_id: string } }>(
                'tab.create',
                {
                    workspace_id: workspaceId,
                    cwd,
                    label,
                    focus: false,
                },
            );
            const paneId = tab.root_pane?.pane_id;
            const tabId = tab.tab?.tab_id;
            if (paneId === undefined || tabId === undefined) throw new Error('herdr: tab.create returned no root pane');
            renamePane(paneId, label);

            // Record the shell too, so a later explicitly named agent can beat
            // this tab's automatic fallback instead of inheriting it forever.
            const newId = newSessionId();
            identity.put({
                sessionId: newId,
                paneId,
                workspaceId,
                tabId,
                cwd,
                kind: options.kind ?? 'shell',
                label,
                autoLabel: requestedLabel === undefined || requestedLabel === '',
                createdAt: new Date().toISOString(),
                ours: true,
            });
            if (options.kind === undefined) {
                const shell = identity.get(newId);
                if (shell !== undefined) publish(newId, { type: 'session.created', session: infoFor(shell) });
                return;
            }

            // Same pattern as session.start: start the agent and let detection
            // land as normal session events.
            void client
                .call('agent.start', { name: newId, kind: options.kind, pane_id: paneId, timeout_ms: 60_000 })
                .catch(() => undefined);
        },

        async sendKeys(sessionId: string, keys: string[]): Promise<void> {
            const record = await resolvePane(sessionId);
            await client.call('agent.send_keys', { target: record.paneId, keys });
        },

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
            pluginStreams?.closeSession(sessionId);
            const record = await resolvePane(sessionId);
            await client.call('pane.close', { pane_id: record.paneId }).catch(() => {});
            // Close the pane's status watch BEFORE removing the identity record --
            // the syncDiscovery cleanup only walks live records, so a watch
            // orphaned here leaks a socket (and its reconnect loop) forever.
            statusWatches.get(record.paneId)?.();
            statusWatches.delete(record.paneId);
            identity.remove(sessionId);
            clearAttention(sessionId);
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
            const record = await resolvePane(promptOptions.sessionId);
            try {
                await client.call('agent.prompt', { target: record.paneId, text: promptOptions.text });
            } catch {
                // No live agent in the pane (yet): type into the shell instead.
                await client.call('pane.send_input', {
                    pane_id: record.paneId,
                    text: promptOptions.text,
                    keys: ['enter'],
                });
            }
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
                        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
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
            console.log('[attachment-download] re-sending active attachment lists to clients');
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
            attachments.dispose();
            attachmentDownloads.dispose();
            for (const close of statusWatches.values()) close();
            statusWatches.clear();
            client.close();
        },
    };
}
