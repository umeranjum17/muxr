/**
 * Session state vocabulary. Produced by the machine host, rendered by clients.
 *
 * The vocabulary predates the herdr backend; the host fills every field it can
 * honestly and leaves the rest at defaults. Nothing here is reshaped per transport.
 */

import { fail, ok, type Outcome } from '../../shared/outcome.js';

export interface SessionRef {
    id: string;
    cwd: string;
}

export interface SessionModel {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
}

export interface SessionInfo extends SessionRef {
    path: string;
    name?: string;
    created: string;
    modified: string;
    messageCount: number;
    firstMessage: string;
    parentSessionPath?: string;
    /** herdr agent kind for sessions backed by a live agent (pi, claude, ...). */
    agentKind?: string;
    /** Human-facing name. Never used as a routing key. */
    displayName?: string;
    /** Concise dynamic description of the current work. */
    taskTitle?: string;
    /** herdr pane id backing this session, when live. */
    paneId?: string;
    /** Latest OSC title from the pane -- the "what it is doing" breadcrumb. */
    terminalTitle?: string;
    /** Worktree provenance when the session lives in a herdr-managed checkout. */
    worktree?: { repo: string; branch?: string; path: string };
    /** herdr topology: which workspace/tab this session's pane lives in. */
    workspaceId?: string;
    workspaceLabel?: string;
    tabId?: string;
    /** herdr's tab label ('1', 'pi', 'review'...) — the grouping level below a workspace. */
    tabLabel?: string;
    /**
     * Session id of the agent that spawned this one, when known.
     *
     * herdr has no parent/child concept, so this rides in a herdr pane metadata
     * token (`spawned_by`). That keeps lineage in herdr rather than in a private
     * muxr map: it survives host restarts and shows up at the desk too.
     */
    spawnedBy?: string;
}

/** One file in a session's working-tree change set (git-derived, agent-agnostic). */
export interface SessionChangeFile {
    /** Repo-relative path (renames use the new path). */
    path: string;
    /** Basename for display. */
    name: string;
    added: number;
    removed: number;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
    /** True when the file has staged content (git porcelain v2 X column not '.'). */
    staged?: boolean;
    /**
     * The run's captured patch for this file, computed by the host at settle
     * (committed part + uncommitted part, vs the run's start commit). Present
     * only for diffable text files within size bounds; clients show exactly
     * this run's diff from it and never a later commit.
     */
    patch?: string;
}

/**
 * One artifact dropped into the pane's attachment dump dir
 * (~/.muxr/attachments/pane/<HERDR_PANE_ID>/). Agent-agnostic by
 * convention: anything can copy a file there; the host watches and forwards.
 */
export interface SessionAttachment {
    /** sha256 hex of the file content; the merge key. Stable for identical content. */
    id: string;
    /** File name inside the pane's dump dir. */
    name: string;
    mimeType: string;
    size: number;
    /** mtime ms, for ordering. */
    at: number;
    /**
     * base64 data, inlined by the host for images up to 1 MiB. Sent only on the
     * first emit of this id per host run; later cumulative lists carry the
     * entry metadata-only. Clients merge by id and keep already-received data.
     */
    data?: string;
}

/** Attribution for bounded cumulative attachment lists. */
export interface SessionAttachmentAttribution {
    total: number;
    truncated: boolean;
    schemaVersion?: 1;
}

/** Attribution for bounded cumulative changed-file lists. */
export interface SessionChangeAttribution {
    total: number;
    truncated: boolean;
    schemaVersion?: 1;
}

/** One pane in the herdr tree, with its agent (when it has one). */
export interface HerdrTreePane {
    paneId: string;
    tabId: string;
    label?: string;
    cwd?: string;
    agentKind?: string;
    agentName?: string;
    /** Human-facing name. Never used as a routing key. */
    displayName?: string;
    /** Concise dynamic description of the current work. */
    taskTitle?: string;
    agentStatus: AgentLifecycle;
    terminalTitle?: string;
    focused: boolean;
    /** muxr session id when this pane hosts a known agent. */
    sessionId?: string;
}

export interface HerdrTreeTab {
    tabId: string;
    label?: string;
    focused: boolean;
    agentStatus: AgentLifecycle;
    panes: HerdrTreePane[];
}

export interface HerdrTreeWorkspace {
    workspaceId: string;
    label?: string;
    focused: boolean;
    agentStatus: AgentLifecycle;
    worktree?: { repo: string; branch?: string; path: string };
    tabs: HerdrTreeTab[];
}

export interface SessionTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

export interface SessionContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

export interface SessionWarning {
    kind: string;
    message: string;
}

/** Canonical user-facing lifecycle. `idle` remains for older herdr providers. */
export const AGENT_LIFECYCLES = ['starting', 'idle', 'working', 'blocked', 'done', 'failed', 'unknown'] as const;
export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];

export function parseAgentLifecycle(value: unknown): Outcome<AgentLifecycle> {
    if (typeof value !== 'string' || !(AGENT_LIFECYCLES as readonly string[]).includes(value)) {
        return fail('invalid agent status');
    }
    return ok(value as AgentLifecycle);
}

export function agentIsWorking(state: AgentLifecycle): boolean {
    return state === 'working';
}

/**
 * Canonical user-facing Agent Name. Wire records still call this displayName
 * for protocol compatibility; it never authorizes routing.
 */
export function normalizeAgentName(value: string | undefined): string {
    const name = value?.normalize('NFKC').replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return name === undefined || name === '' || /^pph?_/i.test(name) ? 'Agent' : name;
}

export function parseAgentName(value: unknown): Outcome<string> {
    if (typeof value !== 'string') return fail('invalid Agent Name');
    return ok(normalizeAgentName(value));
}

/**
 * Agent Route that may cross a plugin/stream process boundary.
 * Host-internal routes can be richer; this is the public subset.
 */
const PUBLIC_AGENT_ROUTE = /^[A-Za-z0-9._:-]{1,80}$/;

export function parsePublicAgentRoute(value: unknown): Outcome<string> {
    if (typeof value !== 'string') return fail('invalid agent route');
    const route = value.replace(/[\0-\x1F\x7F]/g, '').trim();
    if (!PUBLIC_AGENT_ROUTE.test(route)) return fail('invalid agent route');
    return ok(route);
}

const PROVIDER_KIND = /^[a-z][a-z0-9_-]{0,31}$/;

export function parseProviderKind(value: unknown): Outcome<string> {
    if (typeof value !== 'string') return fail('invalid provider kind');
    const kind = value.trim().toLowerCase();
    if (!PROVIDER_KIND.test(kind)) return fail('invalid provider kind');
    return ok(kind);
}

/** The only key that authorizes prompt, watch, or focus. */
export function agentRoute(agent: { id: string }): string {
    return agent.id;
}

/** Lifecycle Event's routing key. Agent Name and Task Title on the same record never authorize. */
export function lifecycleEventRoute(event: LifecycleEvent): string {
    return event.sessionId;
}

export function lifecycleEventAgentName(event: LifecycleEvent): string {
    return event.displayName;
}

export type LifecycleReasonCode =
    | 'start-requested'
    | 'start-launch-failed'
    | 'start-timeout'
    | 'squad-rolled-back'
    | 'agent-working'
    | 'agent-blocked'
    | 'agent-done'
    | 'agent-runtime-failed'
    | 'agent-unavailable'
    | 'state-reconciled';

/** Privacy-safe host-owned transition record. */
export interface LifecycleEvent {
    eventId: string;
    /** Stable transport key. Clients must not render it. */
    sessionId: string;
    displayName: string;
    /** Bounded privacy-safe work context captured with the transition. */
    taskTitle?: string;
    state: AgentLifecycle;
    reasonCode: LifecycleReasonCode;
    /** @deprecated Read reasonCode. Kept for older clients during rollout. */
    reason?: LifecycleReasonCode;
    at: string;
}

export interface LifecycleCatalog {
    revision: number;
    events: LifecycleEvent[];
}

export interface SessionUsageWindow {
    label: string;
    usedPercent: number;
    resetAt?: string;
}

export interface SessionUsageLimits {
    capturedAt: string;
    windows: SessionUsageWindow[];
}

export interface SessionStatus {
    sessionId: string;
    persisted?: boolean;
    /** Live agent lifecycle from herdr. */
    agentStatus?: AgentLifecycle;
    /** agentStatus === 'working'. Kept for clients that render a busy state. */
    isStreaming: boolean;
    tokens: SessionTokens;
    /**
     * Total spend in USD, or undefined when the provider publishes no pricing.
     * Undefined means UNKNOWN -- render it as such. Never coerce to 0.
     */
    cost?: number;
    contextUsage?: SessionContextUsage;
    usageLimits?: SessionUsageLimits;
    warnings?: SessionWarning[];
}

/** True when nothing is running. herdr's lifecycle is the authority. */
export function isSessionIdle(status: SessionStatus): boolean {
    if (status.agentStatus !== undefined) return !agentIsWorking(status.agentStatus);
    return !status.isStreaming;
}

export interface SessionActivity {
    sessionId: string;
    phase: 'active' | 'idle' | 'error';
    label: string;
    detail?: string;
    at: string;
}

/**
 * Why a session needs its user, most urgent first. The index is the priority:
 * a session publishes only its lowest-index reason, so one row is one session
 * and the badge count is a session count rather than an event count.
 */
export const ATTENTION_REASONS = ['waiting', 'blocked', 'failed', 'done'] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** 'done' rows are noise after ten minutes: the work is finished, the row isn't. */
export const ATTENTION_DONE_TTL_MS = 10 * 60_000;
/** Nothing except a parked question survives past six hours. */
export const ATTENTION_HARD_CAP_MS = 6 * 60 * 60_000;

export function attentionRank(reason: AttentionReason): number {
    return ATTENTION_REASONS.indexOf(reason);
}

export function attentionOutranks(candidate: AttentionReason, incumbent: AttentionReason): boolean {
    return attentionRank(candidate) < attentionRank(incumbent);
}

/** Waiting is a parked question and never decays. Other reasons age out. */
export function attentionReasonStillHolds(reason: AttentionReason, ageMs: number): boolean {
    if (reason === 'waiting') return true;
    if (ageMs > ATTENTION_HARD_CAP_MS) return false;
    if (reason === 'done' && ageMs > ATTENTION_DONE_TTL_MS) return false;
    return true;
}

/**
 * A session waiting on its user. This is state, not an event log: an entry
 * exists exactly while the condition holds and disappears when it resolves.
 * Nothing here is dismissed by hand -- a row that cannot clear itself is a bug
 * in whatever set it, not a row that needs an X.
 */
export interface AttentionEntry {
    sessionId: string;
    reason: AttentionReason;
    /** One line for the row: the question, the blocker, the error. */
    detail: string;
    at: string;
}

export interface AttentionCatalog {
    revision: number;
    entries: AttentionEntry[];
}

export interface SessionShellOutcome {
    output: string;
    exitCode: number | null;
    isError: boolean;
}
