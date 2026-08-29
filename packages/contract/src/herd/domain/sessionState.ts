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

/** One-to-one Herdr AgentInfo projection used by mobile and realtime tools. */
export interface AgentInfo {
    agentName?: string;
    taskTitle?: string;
    agentKind?: string;
    displayAgent?: string;
    agentStatus: AgentLifecycle;
    promptable: boolean;
}

export interface SessionModel {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
}

export interface SessionInfo extends SessionRef, AgentInfo {
    path?: string;
    created?: string;
    modified?: string;
    messageCount: number;
    firstMessage: string;
    parentSessionPath?: string;
    paneId?: string;
    terminalTitle?: string;
    worktree?: { repo: string; branch?: string; path: string };
    workspaceId?: string;
    workspaceLabel?: string;
    tabId?: string;
    tabLabel?: string;
    /** Agent Route of the spawning Agent, stored in current Herdr pane metadata. */
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

/** One current Herdr pane and its Agent, when that Agent has a publishable generation. */
export interface HerdrTreePane extends AgentInfo {
    paneId: string;
    tabId: string;
    label?: string;
    cwd?: string;
    terminalTitle?: string;
    focused: boolean;
    /** Agent Route, or an explicit ephemeral Shell route for a bare pane. */
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

export const LIFECYCLE_NOTIFICATION_LEVELS = ['off', 'important', 'all'] as const;
export type LifecycleNotificationLevel = (typeof LIFECYCLE_NOTIFICATION_LEVELS)[number];

export function parseLifecycleNotificationLevel(value: unknown): LifecycleNotificationLevel | undefined {
    return typeof value === 'string' && (LIFECYCLE_NOTIFICATION_LEVELS as readonly string[]).includes(value)
        ? value as LifecycleNotificationLevel
        : undefined;
}

/** One admission policy shared by device-local and relay-owned lifecycle alerts. */
export function lifecycleNotificationAllowed(level: LifecycleNotificationLevel, state: AgentLifecycle): boolean {
    if (level === 'off') return false;
    return state === 'blocked' || state === 'failed' || (level === 'all' && state === 'done');
}

export function parseAgentLifecycle(value: unknown): Outcome<AgentLifecycle> {
    if (typeof value !== 'string' || !(AGENT_LIFECYCLES as readonly string[]).includes(value)) {
        return fail('invalid agent status');
    }
    return ok(value as AgentLifecycle);
}

export function agentIsWorking(state: AgentLifecycle): boolean {
    return state === 'working';
}

/** Validate a current Herdr Agent Name without changing its presentation value. */
export function parseAgentName(value: unknown): Outcome<string> {
    if (typeof value !== 'string' || value.length === 0 || value.length > 80
        || /[\0-\x1F\x7F]/.test(value) || /^pph?_/i.test(value)) {
        return fail('invalid Agent Name');
    }
    return ok(value);
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

export const CLOSE_SCOPES = ['tab', 'workspace', 'worktreeGroup'] as const;
export type CloseScope = (typeof CLOSE_SCOPES)[number];

export type CloseResult =
    | { status: 'closed'; alreadyGone?: true }
    | { status: 'confirmationRequired'; scope: CloseScope; label: string; message: string }
    | { status: 'retryable'; message: string };

export function parseCloseScope(value: unknown): Outcome<CloseScope> {
    if (value === 'tab' || value === 'workspace' || value === 'worktreeGroup') return ok(value);
    return fail('invalid close scope');
}

export function parseCloseResult(value: unknown): Outcome<CloseResult> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('invalid close result');
    const record = value as Record<string, unknown>;
    if (record.status === 'closed') {
        if (record.alreadyGone === true) return ok({ status: 'closed', alreadyGone: true });
        if (record.alreadyGone !== undefined) return fail('invalid close result');
        return ok({ status: 'closed' });
    }
    if (record.status === 'retryable') {
        if (typeof record.message !== 'string') return fail('invalid close result');
        const message = record.message.trim();
        if (message === '' || message.length > 320) return fail('invalid close result');
        return ok({ status: 'retryable', message });
    }
    if (record.status === 'confirmationRequired') {
        const scope = parseCloseScope(record.scope);
        if (!scope.ok || typeof record.label !== 'string' || typeof record.message !== 'string') {
            return fail('invalid close result');
        }
        const label = record.label.trim();
        const message = record.message.trim();
        if (label === '' || label.length > 160 || message === '' || message.length > 320) {
            return fail('invalid close result');
        }
        return ok({
            status: 'confirmationRequired',
            scope: scope.value,
            label,
            message,
        });
    }
    return fail('invalid close result');
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
    return event.agentName;
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
    agentName: string;
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
    /** Current Herdr generation can accept an agent.prompt call. */
    promptable: boolean;
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
