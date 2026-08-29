/**
 * Session backend surface consumed by the request dispatcher.
 *
 * Pi-facing methods mirror `RequestMap` in `@muxr/contract`. Domain stores
 * (unread, attention) stay separate — the dispatcher wires them.
 */

import type {
    PluginManifestV1,
    PluginSummary,
    HerdrTreeWorkspace,
    LayoutSnapshot,
    PromptAttachment,
    SessionEventBody,
    CloseResult,
    CloseScope,
    SessionInfo,
    SessionSnapshot,
    SessionStartResult,
    SessionStatus,
    StreamingBehavior,
    PluginsInvalidatedFrame,
    VoiceProviderOption,
    WatchSettlement,
} from '@muxr/contract';

export interface SessionListOptions {
    cwd?: string;
    includeSubsessions?: boolean;
}

export interface SessionStartOptions {
    cwd: string;
    parentSessionId?: string;
    createCwd?: boolean;
    /** herdr agent kind: pi, claude, codex, opencode, gemini, grok, ... */
    kind?: string;
    label?: string;
    taskTitle?: string;
    worktree?: { branch?: string; base?: string };
    /** Squad mode: one workspace, one tab per kind (max 4). Ignores kind. */
    kinds?: string[];
    members?: Array<{ kind: string }>;
}

export interface SessionOpenOptions {
    sessionId: string;
    path?: string;
    /** Internal dispatcher flag: read-only devices observe without acknowledging attention. */
    acknowledgeAttention?: boolean;
}

export interface SessionPromptOptions {
    sessionId: string;
    text: string;
    attachments?: PromptAttachment[];
    streamingBehavior?: StreamingBehavior;
}

export interface SessionShellOptions {
    sessionId: string;
    command: string;
    /** When true the command runs without emitting shell/activity events and the
        outcome comes back as the method result instead of shell.end. For
        programmatic queries (git status, file reads) that must not appear in
        the user's transcript. */
    quiet?: boolean;
}

export interface SessionShellOutcome {
    output: string;
    exitCode: number | null;
    isError: boolean;
}

export interface SessionStopOptions {
    deviceId: string;
    idempotencyKey: string;
    confirmedScope?: CloseScope;
}

export interface SessionSaveAttachmentsOptions {
    sessionId: string;
    attachments: PromptAttachment[];
    folder?: string;
}

export interface SessionReadFileOptions {
    sessionId: string;
    path: string;
}

export interface SessionSource {
    list(options?: SessionListOptions): Promise<SessionInfo[]>;
    start(options: SessionStartOptions): Promise<SessionStartResult>;
    open(options: SessionOpenOptions): Promise<SessionSnapshot>;
    /** Refresh herdr's cached snapshot after an out-of-band CLI mutation. */
    refreshHerdr(): Promise<void>;
    /** Reconcile the authoritative plugin catalog after an out-of-band mutation. */
    refreshPlugins?(): Promise<void>;
    /** The whole herd: workspaces -> tabs -> panes with live agent state. `connected` is herdr event-socket liveness. */
    herdrTree(): Promise<{ workspaces: HerdrTreeWorkspace[]; connected: boolean }>;
    /** Agent kinds supported by the connected Herdr host. */
    agentKinds(): Promise<string[]>;
    /** Kinds whose canonical executable is launchable in the host PATH. */
    installedAgentKinds(kinds: readonly string[]): Promise<string[]>;
    /** Immutable native UI plugin catalog and snapshots. */
    pluginList(deviceId: string): Promise<PluginSummary[]>;
    pluginManifest(options: { pluginId: string; manifestHash: string }): Promise<PluginManifestV1>;
    pluginApprove(options: { deviceId: string; pluginId: string; manifestHash: string; approved: boolean }): Promise<void>;
    pluginInvoke(options: { deviceId: string; pluginId: string; manifestHash: string; contributionId: string; sessionId: string; idempotencyKey: string }): Promise<void>;
    pluginCall(options: { deviceId: string; pluginId: string; manifestHash: string; contributionId: string; input?: unknown; idempotencyKey?: string }): Promise<unknown>;
    /** Declared RPC mode for a catalog contribution, so read-only devices can be allowed through read paths only. */
    pluginRpcMode?(options: { pluginId: string; manifestHash: string; contributionId: string }): 'read' | 'write' | undefined;
    pluginStream(options: { deviceId: string; pluginId: string; manifestHash: string; contributionId: string; channel: string; sessionId?: string }): Promise<null>;
    voiceProviderList(): Promise<VoiceProviderOption[]>;
    voiceProviderSelect(providerId: string): Promise<VoiceProviderOption[]>;
    /** Split layout of one tab (rects in terminal cells) for grid views. */
    herdrLayout(tabId: string): Promise<{
        tabId: string;
        zoomed: boolean;
        area: { x: number; y: number; width: number; height: number };
        panes: { paneId: string; focused: boolean; rect: { x: number; y: number; width: number; height: number } }[];
    }>;
    /** Split a session's pane; with kind, an agent starts in the new pane. */
    paneSplit(options: { sessionId: string; direction: 'right' | 'down'; kind?: string }): Promise<{
        paneId: string;
        sessionId?: string;
    }>;
    /** Pane contents as text, including scrollback via source 'recent'. */
    paneRead(options: {
        sessionId: string;
        lines?: number;
        source?: 'visible' | 'recent' | 'recent_unwrapped';
        ansi?: boolean;
    }): Promise<{ text: string; truncated: boolean }>;
    /** Register a watch; resolves once registered, not once the agent settles. */
    agentWatch(options: {
        sessionId: string;
        until?: ('idle' | 'done' | 'blocked' | 'unknown')[];
        timeoutMs?: number;
    }): Promise<{ watching: boolean }>;
    /** Private correlated wait for peer calls; never consumes the shared session event bus. */
    agentWait(options: {
        sessionId: string;
        until?: ('idle' | 'done' | 'blocked' | 'unknown')[];
        timeoutMs?: number;
    }): Promise<WatchSettlement>;
    layoutExport(sessionId: string): Promise<{ snapshot: LayoutSnapshot }>;
    layoutApply(options: { sessionId: string; snapshot: LayoutSnapshot; label?: string }): Promise<{
        tabId: string;
        started: number;
    }>;
    paneFocus(sessionId: string): Promise<void>;
    /** Focus the adjacent pane in a grid direction, from this session's pane. */
    focusNeighbor(sessionId: string, direction: 'left' | 'right' | 'up' | 'down'): Promise<void>;
    /** Focus the adjacent tab in this session's workspace, from this session's tab. */
    focusTabNeighbor(sessionId: string, direction: 'next' | 'prev'): Promise<void>;
    /** Focus the adjacent workspace, from this session's workspace. */
    focusWorkspaceNeighbor(sessionId: string, direction: 'next' | 'prev'): Promise<void>;
    /** Create a tab in this session's workspace; with kind, an agent starts in it. */
    createTab(sessionId: string, options: { kind?: string; label?: string }): Promise<void>;
    /** Close a tab in this session's workspace. */
    closeTab(sessionId: string, tabId: string): Promise<void>;
    /** Close this session's pane; the tab survives if other panes remain. */
    closePane(sessionId: string): Promise<void>;
    /** Close a workspace and everything in it. */
    closeWorkspace(workspaceId: string): Promise<void>;
    /** Send literal keys to the session's pane (blocked-agent answers). */
    sendKeys(sessionId: string, keys: string[]): Promise<void>;
    paneZoom(options: { sessionId: string; mode?: 'toggle' | 'on' | 'off' }): Promise<{
        changed: boolean;
        zoomed: boolean;
        reason?: string;
    }>;
    stop(sessionId: string, options: SessionStopOptions): Promise<CloseResult>;
    abort(sessionId: string): Promise<void>;
    reload(sessionId: string): Promise<void>;
    prompt(options: SessionPromptOptions): Promise<void>;
    status(sessionId: string): Promise<SessionStatus>;
    shell(options: SessionShellOptions): Promise<SessionShellOutcome | null>;
    readFile(options: SessionReadFileOptions): Promise<{ content: string }>;
    saveAttachments(options: SessionSaveAttachmentsOptions): Promise<{ savedPaths: string[] }>;
    /** Re-fetch one pane attachment blob for a client that missed the first emit. */
    attachmentFetch(options: { sessionId: string; attachmentId: string }): Promise<{ name: string; mimeType: string; data: string } | null>;
    /** Mint a one-time local-only download ticket for the attachment's original bytes. */
    attachmentPrepare(options: { sessionId: string; attachmentId: string }): Promise<{ token: string; name: string; mimeType: string; size: number } | null>;
    /** Read one bounded chunk; hosted transport encrypts the request and response envelope. */
    attachmentRead(options: { sessionId: string; attachmentId: string; offset: number; length: number }): Promise<{ id: string; name: string; mimeType: string; size: number; offset: number; data: string } | null>;
    subscribe(listener: (sessionId: string, event: SessionEventBody) => void): () => void;
    /** Machine-scoped frames share the encrypted session stream and are additive. */
    subscribeMachine?(listener: (frame: PluginsInvalidatedFrame) => void): () => void;
    /** A client just connected: re-push state that only ships on change. */
    resendCumulativeState?(): void;
    dispose(): Promise<void>;
}
