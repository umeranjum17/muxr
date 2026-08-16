/**
 * Session state vocabulary. Produced by the machine host, rendered by clients.
 *
 * The vocabulary predates the herdr backend; the host fills every field it can
 * honestly and leaves the rest at defaults. Nothing here is reshaped per transport.
 */

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

/** herdr's raw agent lifecycle, so clients can render honest status chips. */
export type AgentLifecycle = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

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
    return status.agentStatus !== undefined ? status.agentStatus !== 'working' : !status.isStreaming;
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

export function attentionRank(reason: AttentionReason): number {
    return ATTENTION_REASONS.indexOf(reason);
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
