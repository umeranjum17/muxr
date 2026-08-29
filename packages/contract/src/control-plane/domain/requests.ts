/**
 * Client -> host request surface.
 *
 * ONE source of truth: `RequestMap` binds each request name to its params and
 * its result. Request and result types are derived from it, so a host handler
 * and a client call site cannot drift apart -- adding a capability means adding
 * one line here, and both sides fail to compile until they agree.
 *
 * The event stream (herd session events) stays separate and remains push-only.
 * Requests are for things a client asks for; events are for things that happen.
 */

/**
 * A saved tab layout. Mirrors herdr's split tree, minus the live pane ids that
 * would be meaningless on restore, plus the agent kind to relaunch per pane.
 */
export type LayoutSnapshot =
    | { type: 'pane'; cwd?: string; kind?: string }
    | {
          type: 'split';
          direction: 'right' | 'down';
          ratio: number;
          first: LayoutSnapshot;
          second: LayoutSnapshot;
      };

import type {
    MachineInfo,
    SessionSnapshot,
    SessionStartResult,
    UnreadCatalog,
} from '../../herd/index.js';
import type { PluginManifestV1, PluginSource, PluginSummary } from '../../plugins/index.js';
import type { LandWorktreeResult } from '../../worktree/index.js';
import type { AttentionCatalog, CloseResult, CloseScope, HerdrTreeWorkspace, LifecycleCatalog, SessionInfo, SessionShellOutcome, SessionStatus } from '../../herd/index.js';
import type {
    PeerAuthorityMetadata,
    PeerCapability,
    PeerMutationMetadata,
    PeerRelationship,
    SignedPeerDescriptor,
} from '../../peer/index.js';

export interface PromptAttachment {
    name: string;
    mimeType: string;
    /** base64 */
    data: string;
}

export type StreamingBehavior = 'steer' | 'followUp';
export type VoiceProviderOption = { id: string; name: string; selected: boolean; source: PluginSource; hasBackend: boolean };

export interface WatchSettlement {
    status: string;
    detail: string;
    timedOut?: boolean;
}

/** Host-owned collaboration ceremony and constrained outbound broker requests. */
export interface PeerRequestMap {
    'peer.prepare': {
        params: {
            targetMachineId: string;
            targetMachineSigningPublicKey: string;
            sourceName?: string;
            sourcePlatform?: string;
            descriptorExpiresAt?: number;
            mutation: PeerMutationMetadata;
        };
        result: { preparationId: string; descriptor: SignedPeerDescriptor; expiresAt: number };
    };
    'peer.authorize': {
        params: {
            descriptor: SignedPeerDescriptor;
            capabilities: PeerCapability[];
            /** Required when the optional start capability is granted. */
            allowedCwds?: string[];
            mutation: PeerMutationMetadata;
            relationshipId?: string;
            /** Target endpoint from the phone's verified machine pairing. */
            targetRelayUrl?: string;
        };
        result: {
            peerDeviceId: string;
            sealedBundle: string;
            capabilities: PeerCapability[];
            keyVersion: number;
            authority?: PeerAuthorityMetadata;
        };
    };
    'peer.install': {
        params: {
            targetMachineId: string;
            sealedBundle: string;
            mutation: PeerMutationMetadata;
            relationshipId?: string;
        };
        result: PeerRelationship;
    };
    'peer.list': {
        params: Record<string, never>;
        result: { peers: PeerRelationship[]; revision?: number };
    };
    'peer.revoke': {
        params: {
            relationshipId: string;
            peerDeviceId?: string;
            mutation: PeerMutationMetadata;
        };
        result: { state: 'revoked' | 'already-revoked'; revokedAt: number; authority?: PeerAuthorityMetadata };
    };
    'peer.remote.list': {
        params: { relationshipId: string };
        result: {
            machineAlias: string;
            sessions: Array<{ sessionId: string; agentName: string; ambiguous?: true }>;
        };
    };
    'peer.remote.read': {
        params: { relationshipId: string; sessionId: string; lines?: number };
        result: { machineAlias: string; agentName: string; text: string; truncated: boolean };
    };
    'peer.remote.status': {
        params: { relationshipId: string; sessionId: string };
        result: { machineAlias: string; agentName: string; status: SessionStatus };
    };
    'peer.remote.watch': {
        params: {
            relationshipId: string;
            sessionId: string;
            until?: ('idle' | 'done' | 'blocked' | 'unknown')[];
            timeoutMs?: number;
            mutation: PeerMutationMetadata;
        };
        result: { machineAlias: string; agentName: string; settlement: WatchSettlement };
    };
    'peer.remote.prompt': {
        params: {
            relationshipId: string;
            sessionId: string;
            text: string;
            streamingBehavior?: StreamingBehavior;
            mutation: PeerMutationMetadata;
        };
        result: { machineAlias: string; agentName: string; delivered: true };
    };
    'peer.remote.start': {
        params: {
            relationshipId: string;
            cwd: string;
            kind?: string;
            label?: string;
            mutation: PeerMutationMetadata;
        };
        result: { machineAlias: string; sessionId: string; agentName: string };
    };
}

export type PeerRequestType = keyof PeerRequestMap;
export type PeerRequestParams<T extends PeerRequestType> = PeerRequestMap[T]['params'];
export type PeerRequestResult<T extends PeerRequestType> = PeerRequestMap[T]['result'];
export type PeerClientRequest = {
    [K in PeerRequestType]: { type: K; requestId: string; params: PeerRequestParams<K> };
}[PeerRequestType];

export interface RequestMap extends PeerRequestMap {
    // --- lifecycle ----------------------------------------------------------
    /**
     * Herdr panes with agents are the only sessions; there is no transcript tree.
     * Pass `includeSubsessions` to include child panes.
     */
    'session.list': {
        params: { cwd?: string; includeSubsessions?: boolean };
        result: SessionInfo[];
    };
    'session.start': {
        params: {
            cwd: string;
            parentSessionId?: string;
            createCwd?: boolean;
            /** herdr agent kind: pi, claude, codex, opencode, gemini, grok, ... */
            kind?: string;
            /** Display label; also names the herdr tab. */
            label?: string;
            /** Explicit concise task identity. Never derived from terminal output. */
            taskTitle?: string;
            /** Create the session inside a new git worktree of the repo at cwd. */
            worktree?: { branch?: string; base?: string };
            /** Squad mode: one workspace, one tab per kind (max 4). Ignores kind. */
            kinds?: string[];
            /** Squad form. Takes precedence over `kinds`. */
            members?: Array<{ kind: string }>;
            /** Required by the peer dispatcher; ordinary trusted clients omit it. */
            peerMutation?: PeerMutationMetadata;
        };
        result: SessionStartResult;
    };
    /** The whole herd: workspaces -> tabs -> panes with live agent state. `connected` is herdr liveness; absent from pre-liveness hosts. */
    'herdr.tree': { params: Record<string, never>; result: { workspaces: HerdrTreeWorkspace[]; connected?: boolean } };
    'herdr.agentKinds': { params: Record<string, never>; result: { kinds: string[]; installed?: string[] } };
    /** Immutable native UI plugin catalog. Safe to enumerate from read-only clients. */
    'plugin.list': {
        params: Record<string, never>;
        result: PluginSummary[];
    };
    /** Return the exact immutable v1 manifest snapshot addressed by its hash. */
    'plugin.manifest': {
        params: { pluginId: string; manifestHash: string };
        result: PluginManifestV1;
    };
    /** Persist or revoke this authenticated device's approval for one exact snapshot. */
    'plugin.approve': {
        params: { pluginId: string; manifestHash: string; approved: boolean };
        result: null;
    };
    /** Invoke an approved plugin contribution with explicit pane context. */
    'plugin.invoke': {
        params: { pluginId: string; manifestHash: string; contributionId: string; sessionId: string; idempotencyKey: string };
        result: null;
    };
    /** Call an approved, manifest-declared plugin RPC entrypoint. Write RPCs require an idempotency key. */
    'plugin.call': {
        params: { pluginId: string; manifestHash: string; contributionId: string; input?: unknown; idempotencyKey?: string };
        result: unknown;
    };
    /** Attach one approved manifest-declared plugin stream to a relay channel. */
    'plugin.stream': {
        params: { pluginId: string; manifestHash: string; contributionId: string; channel: string; sessionId?: string };
        result: null;
    };
    /** Installed realtime providers and the one currently active on this machine. */
    'voice.provider.list': {
        params: Record<string, never>;
        result: VoiceProviderOption[];
    };
    /** Switch the machine to exactly one installed realtime provider. */
    'voice.provider.select': {
        params: { providerId: string };
        result: VoiceProviderOption[];
    };
    /**
     * Full herdr CLI for trusted clients such as the realtime voice agent.
     * Arguments go straight to execFile (never a shell), so this reaches every
     * pane/tab/workspace/worktree/agent command without a second API that drifts.
     */
    'herdr.cli': {
        params: { args: string[]; timeoutMs?: number };
        result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };
    };
    /** Split layout of one tab: pane rects in terminal cells, for grid views. */
    'herdr.layout': {
        params: { tabId: string };
        result: {
            layout: {
                tabId: string;
                zoomed: boolean;
                area: { x: number; y: number; width: number; height: number };
                panes: { paneId: string; focused: boolean; rect: { x: number; y: number; width: number; height: number } }[];
            };
        };
    };
    /** Split a session's pane; with kind, an agent starts in the new pane. */
    'pane.split': {
        params: { sessionId: string; direction: 'right' | 'down'; kind?: string };
        result: { paneId: string; sessionId?: string };
    };
    /**
     * Pane contents as text. One request instead of an observe stream, so a
     * list of tiles costs N requests rather than N live herdr subprocesses.
     * 'recent' reaches into scrollback, which is the only way to see history
     * on a pane the phone cannot meaningfully scroll.
     */
    'pane.read': {
        params: {
            sessionId: string;
            lines?: number;
            source?: 'visible' | 'recent' | 'recent_unwrapped';
            /** Keep escape codes so xterm can render colour. Default strips them. */
            ansi?: boolean;
        };
        result: { text: string; truncated: boolean };
    };
    /**
     * Watch this session's agent until it settles, then emit `watch.settled`
     * so the phone can notify. Returns as soon as the watch is registered --
     * the wait itself outlives any request timeout.
     */
    'agent.watch': {
        params: {
            sessionId: string;
            until?: ('idle' | 'done' | 'blocked' | 'unknown')[];
            timeoutMs?: number;
            /** Required by the peer dispatcher; ordinary trusted clients omit it. */
            peerMutation?: PeerMutationMetadata;
        };
        result: { watching: boolean; settlement?: WatchSettlement };
    };
    /**
     * Capture this session's whole tab as a reusable snapshot: the split tree
     * plus which agent kind sat in each pane. Geometry alone would restore
     * empty boxes, so the kinds ride along and are relaunched on apply.
     */
    'layout.export': { params: { sessionId: string }; result: { snapshot: LayoutSnapshot } };
    /** Recreate a snapshot as a new tab in the same workspace, relaunching agents. */
    'layout.apply': {
        params: { sessionId: string; snapshot: LayoutSnapshot; label?: string };
        result: { tabId: string; started: number };
    };
    /** Focus this session's pane at the desk. */
    'pane.focus': { params: { sessionId: string }; result: null };
    /** Focus the adjacent pane in a grid direction, from this session's pane. */
    'pane.focusNeighbor': {
        params: { sessionId: string; direction: 'left' | 'right' | 'up' | 'down' };
        result: null;
    };
    /** Focus the adjacent tab in this session's workspace, from this session's tab. */
    'tab.focusNeighbor': {
        params: { sessionId: string; direction: 'next' | 'prev' };
        result: null;
    };
    /** Focus the adjacent workspace, from this session's workspace. */
    'workspace.focusNeighbor': {
        params: { sessionId: string; direction: 'next' | 'prev' };
        result: null;
    };
    /**
     * Create a tab in this session's workspace (same cwd). With `kind`, an
     * agent of that kind starts in the new tab's root pane; the new session
     * arrives as a normal session.created once herdr detects it.
     */
    'tab.create': {
        params: { sessionId: string; kind?: string; label?: string };
        result: null;
    };
    /** Close exactly the selected tab; if Herdr would widen to its workspace or worktree group, fail without mutation. */
    'tab.close': { params: { sessionId: string; tabId: string }; result: null };
    /** Close exactly the selected pane; if Herdr would widen to its tab, workspace, or worktree group, fail without mutation. */
    'pane.close': { params: { sessionId: string }; result: null };
    /** Close exactly the selected workspace; if Herdr would widen to its worktree group, fail and require the explicit group action. */
    'workspace.close': { params: { workspaceId: string }; result: null };
    /**
     * Zoom this session's pane to fill its tab. herdr no-ops on a single-pane
     * tab, so the outcome is reported rather than silently doing nothing.
     */
    'pane.zoom': {
        params: { sessionId: string; mode?: 'toggle' | 'on' | 'off' };
        result: { changed: boolean; zoomed: boolean; reason?: string };
    };
    /** Attach to an existing Pi session (resume). */
    'session.open': { params: { sessionId: string; path?: string }; result: SessionSnapshot };
    /**
     * Close the selected Agent. Broader Herdr scopes are never automatic: the
     * first call tries an exact pane close, and every tab/workspace/worktree-group
     * close requires `confirmedScope`. Cancel is no request.
     */
    'session.stop': {
        params: { sessionId: string; confirmedScope?: CloseScope };
        result: CloseResult;
    };
    'session.abort': { params: { sessionId: string }; result: null };
    'session.reload': { params: { sessionId: string }; result: null };

    // --- conversation -------------------------------------------------------
    'session.prompt': {
        params: {
            sessionId: string;
            text: string;
            attachments?: PromptAttachment[];
            streamingBehavior?: StreamingBehavior;
            /** Required by the peer dispatcher; ordinary trusted clients omit it. */
            peerMutation?: PeerMutationMetadata;
        };
        result: null;
    };
    /** Answer a blocked agent's y/n question by typing the key into its pane (push actions). */
    'session.answer': { params: { sessionId: string; answer: 'y' | 'n' }; result: null };
    'session.status': { params: { sessionId: string }; result: SessionStatus };

    // --- shell + slash commands --------------------------------------------
    'session.shell': {
        params: { sessionId: string; command: string; quiet?: boolean };
        result: SessionShellOutcome | null;
    };
    /** Read a file from the session's machine; content is utf8 text. Same trust boundary as session.shell. */
    'session.readFile': { params: { sessionId: string; path: string }; result: { content: string } };
    // --- attachments --------------------------------------------------------
    'session.saveAttachments': {
        params: { sessionId: string; attachments: PromptAttachment[]; folder?: string };
        result: { savedPaths: string[] };
    };
    /**
     * Re-fetch one pane attachment's blob. Blob data rides the attachments
     * event only on an id's first emit, so a client that was offline then
     * holds metadata forever; this is the heal path. null when the id is
     * unknown or the file has no inlineable data (video, oversized).
     */
    'attachment.fetch': {
        params: { sessionId: string; attachmentId: string };
        result: { name: string; mimeType: string; data: string } | null;
    };
    /**
     * Mint a one-time ticket for the attachment's original bytes on the
     * host's loopback HTTP server. Big files stream host -> relay -> phone;
     * they never become a giant base64 JSON frame.
     */
    'attachment.prepare': {
        params: { sessionId: string; attachmentId: string };
        result: { token: string; name: string; mimeType: string; size: number } | null;
    };
    /** Hosted E2EE download path. Chunks ride inside the strict encrypted RPC envelope. */
    'attachment.read': {
        params: { sessionId: string; attachmentId: string; offset: number; length: number };
        result: { id: string; name: string; mimeType: string; size: number; offset: number; data: string } | null;
    };

    // --- unread -------------------------------------------------------------
    'unread.catalog': { params: Record<string, never>; result: UnreadCatalog };
    'unread.acknowledge': { params: { sessionId: string; throughSeq?: number }; result: UnreadCatalog };

    // --- attention ----------------------------------------------------------
    // Read-only on purpose: entries clear when their condition resolves, so
    // there is nothing for a client to dismiss.
    'attention.catalog': { params: Record<string, never>; result: AttentionCatalog };
    'lifecycle.catalog': { params: Record<string, never>; result: LifecycleCatalog };

    // --- machines -----------------------------------------------------------
    'machines.list': { params: Record<string, never>; result: MachineInfo[] };
    /*
     * A shell that is not bound to a session: creating a git worktree has to
     * happen before the session that will live in it exists. Same trust
     * boundary as session.shell, which already runs arbitrary commands.
     */
    'machine.shell': {
        params: { command: string; cwd: string };
        result: { stdout: string; stderr: string; exitCode: number };
    };
    /**
     * Directories inside a directory, for the mobile cwd picker. Same trust
     * boundary as machine.shell: the host runs as the user.
     */
    'machine.listDir': {
        params: { path?: string };
        result: {
            path: string;
            parent: string | null;
            exists: boolean;
            entries: { name: string; repo: boolean }[];
        };
    };

    // --- browser preview ----------------------------------------------------
    /**
     * What content-type a loopback port answers with, probed on the host
     * (where the port is). `text/html` marks a web app worth a Preview chip;
     * anything else is an API the phone should only open externally.
     * `contentType` is null when nothing HTTP answers.
     */
    'preview.probe': { params: { port: number }; result: { contentType: string | null } };
    /**
     * Ask the host to join `channel` and forward it to `port`. Native callers
     * send a per-preview key through this encrypted request; local legacy web
     * preview may omit it because the browser cannot decrypt a raw TCP listener.
     */
    'preview.attach': { params: { channel: string; port: number; key?: string }; result: null };

    // --- worktrees ----------------------------------------------------------
    /**
     * Squash-land a worktree branch into the base checkout's branch. `stash`
     * is the follow-up answer to a `blocked-dirty-base` result: the user saw
     * the overlapping files and agreed to stash, land, and pop. Landing never
     * removes the worktree directory.
     */
    'worktree.land': {
        params: { worktreePath: string; message: string; stash: boolean };
        result: LandWorktreeResult;
    };

    // --- live terminal --------------------------------------------------------
    /**
     * Ask the host to stream the session's pane to `channel`: it spawns
     * `herdr terminal session control` for the pane and joins the channel as
     * `machine`. The caller opens the client side itself; the relay pairs them.
     * Returns the herdr pane id the stream is bound to.
     */
    'terminal.attach': {
        params: {
            sessionId: string;
            channel: string;
            cols: number;
            rows: number;
            /** control (default) takes over the pane; observe just watches. */
            mode?: 'control' | 'observe';
            /** Authenticated v2 sender. Required by a hosted host, ignored in explicit local mode. */
            deviceId?: string;
            /** User explicitly chose to take control from another device. */
            takeover?: boolean;
        };
        result: { paneId: string };
    };
    'terminal.detach': { params: { sessionId: string; channel: string }; result: null };
}

export type RequestType = keyof RequestMap;
export type RequestParams<T extends RequestType> = RequestMap[T]['params'];
export type RequestResult<T extends RequestType> = RequestMap[T]['result'];

export type ClientRequest = {
    [K in RequestType]: { type: K; requestId: string; params: RequestParams<K> };
}[RequestType];

export type RequestResponse =
    | { type: 'result'; requestId: string; ok: true; data: unknown }
    | { type: 'result'; requestId: string; ok: false; error: string; code?: string };

/** session.start marker for a cwd that does not exist; clients prompt to create it. */
export const MISSING_CWD_ERROR_PREFIX = 'cwd-does-not-exist:';

/** Normalize both old-host crashes and current structured result errors. */
const E2EE_REQUEST_TYPES = new Set([
    'plugin.approve',
    'plugin.invoke',
    'plugin.call',
    'plugin.stream',
    'voice.provider.select',
    'herdr.cli',
]);

export function requestRequiresE2ee(type: string): boolean {
    return type.startsWith('peer.') || E2EE_REQUEST_TYPES.has(type);
}

export function normalizeRequestFailure(
    type: string,
    error: string,
    code?: string,
): { message: string; code?: string } {
    if (code === 'host-contract-mismatch' || /handler is not a function/i.test(error)) {
        return {
            message: `host/APK contract mismatch: this host cannot answer '${type}'; update the host before this app`,
            code: 'host-contract-mismatch',
        };
    }
    return { message: error, ...(code === undefined ? {} : { code }) };
}
