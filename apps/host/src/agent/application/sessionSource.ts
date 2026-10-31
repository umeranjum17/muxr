/**
 * Session backend surface consumed by the request dispatcher.
 *
 * Pi-facing methods mirror `RequestMap` in `@trymuxr/contract`. Domain stores
 * (unread, attention) stay separate — the dispatcher wires them.
 */

import type {
    ApplicationLauncher,
    AgentInstallState,
    HerdrRenameTarget,
    HerdrTreeWorkspace,
    LayoutSnapshot,
    PromptAttachment,
    SessionEventBody,
    SessionArtifactMetadata,
    CloseResult,
    CloseScope,
    SessionInfo,
    SessionSnapshot,
    SessionStartResult,
    SessionStatus,
    StreamingBehavior,
    PluginsInvalidatedFrame,
    WatchSettlement,
} from '@trymuxr/contract';
import type { ConversationExport, TerminalSession } from '@byokit/herdr';

export interface VoiceStreamTransport {
    onData: (chunk: Uint8Array) => void | Promise<void>;
    onEnd: (error?: string) => void | Promise<void>;
    write(chunk: Uint8Array | string): Promise<void>;
    end(error?: string): void;
}

export interface SessionListOptions {
    cwd?: string;
    includeSubsessions?: boolean;
    /** Internal operation context: require a tree read begun after this call, not a passive UI listing. */
    fresh?: true;
}

export interface SessionStartOptions {
    cwd: string;
    parentSessionId?: string;
    createCwd?: boolean;
    /** herdr agent kind: pi, claude, codex, opencode, gemini, grok, ... */
    kind?: string;
    label?: string;
    taskTitle?: string;
    /** Internal (never on the peer wire): a Plan Account id resolved by the dispatcher into `planEnv`. */
    planAccount?: string;
    /** Internal launch env for that account: merged into the new pane's env. Absent means today's launch. */
    planEnv?: Record<string, string>;
    /** Published managed-account credential names to remove before the agent opens. */
    planUnset?: string[];
    signIn?: string;
    /** Internal (never on the phone wire): extra launch arguments, e.g. `--resume <id>` for a moved conversation. */
    resumeArgs?: string[];
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
    /** The first prompt to an agent the phone just started; the host holds it until the agent takes it. */
    firstPrompt?: boolean;
}

export interface SessionHandoffOptions {
    sessionId: string;
    targetName: string;
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
    confirmedScope?: CloseScope;
}

/** Move a running agent onto another sign-in of a provider it already uses.
 *  The host splits with that account's env, resumes the same conversation,
 *  and closes the old pane so two accounts never write one conversation. */
export interface PlanMoveOptions {
    sessionId: string;
    provider: string;
    folder: string;
    launchEnv: { set: Record<string, string>; unset: string[] };
    /** Bounded idle admission; CLI handoffs can wait longer than phone requests. */
    waitForIdleMs?: number;
    resumeArgs(kind: string, ref: { kind: 'id' | 'path'; value: string }): string[];
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
    /** The whole herd: workspaces -> tabs -> panes with live agent state. `connected` is herdr event-socket liveness; `missing` says no Herdr binary is installed. */
    herdrTree(): Promise<{ workspaces: HerdrTreeWorkspace[]; connected: boolean; missing?: true; outdated?: true; desktopApp?: true }>;
    /** Third-party Applications: enabled plugins' global launcher actions, read from the live Herdr registry. */
    applicationsList(): Promise<{ items: ApplicationLauncher[] }>;
    /** Launch one third-party application action in its own new tab; returns the pane it opened. */
    applicationsLaunch(options: { applicationId: string; sessionId?: string }): Promise<{ title: string; sessionId: string }>;
    /** Agent kinds supported by the connected Herdr host. */
    agentKinds(): Promise<string[]>;
    /** Kinds whose canonical executable is launchable in the host PATH. */
    installedAgentKinds(kinds: readonly string[]): Promise<string[]>;
    /** Per-kind install state from the herdr kit: real binary, first-start auto-installer, or absent. */
    agentInstallStates(kinds: readonly string[]): Promise<Record<string, AgentInstallState>>;
    /** Full herdr power without a shell: each argument stays one argument. Never rejects. */
    herdrCli(args: string[], timeoutMs?: number, env?: Record<string, string>): Promise<{
        stdout: string; stderr: string; exitCode: number | null; timedOut: boolean;
    }>;
    /** Open a kit terminal session on a pane; the kit owns the binary and env. */
    herdrTerminal(paneId: string, opts: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession;
    /**
     * Attach one product-owned realtime voice stream over its pre-opened
     * duplex transport. It uses muxr's own adapter runtime: no catalog entry,
     * manifest hash, or per-device plugin approval.
     */
    voiceStream(options: { deviceId: string; channel: string; sessionId?: string; transport: VoiceStreamTransport }): Promise<null>;
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
    /**
     * Where Herdr's own viewport sits in this pane. `maxOffsetFromBottom` is 0
     * for a pane on the alternate screen: Herdr keeps no scrollback behind a
     * full-screen program, so nothing the phone sends can move a viewport there.
     */
    paneScroll(paneId: string): Promise<{ offsetFromBottom: number; maxOffsetFromBottom: number }>;
    /** The text a pane shows now, by pane id. */
    paneVisibleText(paneId: string): Promise<string>;
    /**
     * The pids of the pane's foreground program(s) right now; empty when only
     * its shell holds the pane. Recorded as the owner of the tracked terminal
     * modes, so a later gesture can test whether that program is still there.
     */
    paneForegroundPids(paneId: string): Promise<number[]>;
    /**
     * Restore primary screen and mouse-off after a crashed fullscreen program.
     * Prefers writing the reset onto the pane's PTY as program output, so the
     * shell's command line stays clean; where nothing on the pane can be written
     * it types the reset into the shell instead. Resolves whether a reset landed.
     */
    restorePaneTerminalModes(paneId: string): Promise<boolean>;
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
    paneFocus(sessionId: string, assertActive?: () => void): Promise<void>;
    /** Focus the adjacent pane in a grid direction, from this session's pane. */
    focusNeighbor(sessionId: string, direction: 'left' | 'right' | 'up' | 'down'): Promise<void>;
    /** Focus the adjacent tab in this session's workspace, from this session's tab. */
    focusTabNeighbor(sessionId: string, direction: 'next' | 'prev'): Promise<void>;
    /** Focus the adjacent workspace, from this session's workspace. */
    focusWorkspaceNeighbor(sessionId: string, direction: 'next' | 'prev'): Promise<void>;
    /** Create a tab in this session's workspace; with kind, an agent starts in it. Resolves to the new tab's session when it is known. */
    createTab(sessionId: string, options: { kind?: string; label?: string }): Promise<{ sessionId?: string }>;
    /** Close a tab in this session's workspace. */
    closeTab(sessionId: string, tabId: string): Promise<void>;
    /** Close this session's pane; the tab survives if other panes remain. */
    closePane(sessionId: string): Promise<void>;
    /** Close a workspace and everything in it. */
    closeWorkspace(workspaceId: string): Promise<void>;
    /** Rename an agent (by its pane), a pane, a tab or a workspace in Herdr. */
    rename(target: HerdrRenameTarget, id: string, name: string): Promise<void>;
    /**
     * Send literal keys to the session's pane (blocked-agent answers). With
     * `question`, only while that blocked event is still the one waiting.
     */
    sendKeys(sessionId: string, keys: string[], question?: { eventId: string }): Promise<void>;
    paneZoom(options: { sessionId: string; mode?: 'toggle' | 'on' | 'off' }): Promise<{
        changed: boolean;
        zoomed: boolean;
        reason?: string;
    }>;
    stop(sessionId: string, options: SessionStopOptions): Promise<CloseResult>;
    movePlanAccount?(options: PlanMoveOptions): Promise<{ sessionId: string; paneId?: string; warning?: string }>;
    /** False while the agent has no conversation for `movePlanAccount` to carry yet. */
    canMovePlanAccount?(sessionId: string): Promise<boolean>;
    /** The harness conversation Herdr published for this agent, which the chat view reads; absent until the agent has one. */
    conversation?(sessionId: string): Promise<{ agent: string | undefined; cwd: string; ref: { kind: 'id' | 'path'; value: string } } | undefined>;
    /** Package this agent's conversation into one private bundle file (kit portable bundle; credentials never included). */
    exportConversation?(sessionId: string, options: { to: string; maxBytes?: number }): Promise<ConversationExport>;
    abort(sessionId: string): Promise<void>;
    reload(sessionId: string): Promise<void>;
    prompt(options: SessionPromptOptions): Promise<void>;
    /** The agent writes a handoff note and returns it; no files are changed. */
    handoff(options: SessionHandoffOptions): Promise<{ note: string }>;
    status(sessionId: string): Promise<SessionStatus>;
    shell(options: SessionShellOptions): Promise<SessionShellOutcome | null>;
    readFile(options: SessionReadFileOptions): Promise<{ content: string }>;
    saveAttachments(options: SessionSaveAttachmentsOptions): Promise<{ savedPaths: string[] }>;
    /** Metadata-only newest-first artifact history for one session's pane. */
    artifactList(options: { sessionId: string }): Promise<{ artifacts: SessionArtifactMetadata[]; total: number; truncated: boolean }>;
    /** Re-fetch one pane artifact blob for a client that missed the first emit. */
    artifactFetch(options: { sessionId: string; artifactId: string }): Promise<{ name: string; mimeType: string; data: string } | null>;
    /** Mint a one-time local-only download ticket for the artifact's original bytes. */
    artifactPrepare(options: { sessionId: string; artifactId: string }): Promise<{ token: string; name: string; mimeType: string; size: number } | null>;
    /** Read one bounded chunk; hosted transport encrypts the request and response envelope. */
    artifactRead(options: { sessionId: string; artifactId: string; offset: number; length: number }): Promise<{ id: string; name: string; mimeType: string; size: number; at?: number; offset: number; data: string; sha256?: string } | null>;
    subscribe(listener: (sessionId: string, event: SessionEventBody) => void): () => void;
    /** Machine-scoped frames share the encrypted session stream and are additive. */
    subscribeMachine?(listener: (frame: PluginsInvalidatedFrame) => void): () => void;
    /** Replay only to the connecting client, without broadcasting or noting unread activity. */
    resendCumulativeState?(
        deliver: (sessionId: string, event: SessionEventBody) => void,
        deliverMachine: (frame: PluginsInvalidatedFrame) => void,
    ): void | Promise<void>;
    dispose(): Promise<void>;
    /** Lab-script spelling of dispose: closing the source releases every
     *  socket, subscription and timer it owns so the process can exit. */
    close(): Promise<void>;
}
