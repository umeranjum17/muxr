import type {
    AgentLifecycle,
    AttentionEntry,
    HerdrTreePane,
    HerdrTreeWorkspace,
    LifecycleEvent,
    MachineInfo,
    PluginManifestV1,
    PluginSummary,
    SessionInfo,
} from '@muxr/contract';

/**
 * Deterministic replay records, typed as real protocol and domain records —
 * not invented UI shapes. The demo backend serves these through the same
 * request/event/state paths as production; the deleted DemoScreen's sample
 * text survives here only retyped into these records.
 */

export const DEMO_MACHINE_ID = 'demo-machine';

export const DEMO_INSTALL_COMMAND = 'npm install -g --ignore-scripts @trymuxr/cli@latest';

export const DEMO_SESSION_WORKING = 'demo-session-working';
export const DEMO_SESSION_BLOCKED = 'demo-session-blocked';
export const DEMO_SESSION_DONE = 'demo-session-done';

// Load-relative timestamps: ordering (and sane "x min ago" labels) is what
// matters, and a fixed wall-clock date rots — worse, a future-dated event
// out-sorts the live transitions the replay emits.
const MINUTE = 60_000;
const loadedAt = Date.now();
const at = (minutesAgo: number): string => new Date(loadedAt - minutesAgo * MINUTE).toISOString();

function sessionBase(id: string, agentName: string, taskTitle: string, agentKind: string, agentStatus: AgentLifecycle, promptable: boolean): SessionInfo {
    return {
        id,
        cwd: '/home/demo/acme-app',
        messageCount: 12,
        firstMessage: taskTitle,
        agentName,
        taskTitle,
        agentKind,
        agentStatus,
        promptable,
    };
}

export const DEMO_SESSIONS: SessionInfo[] = [
    sessionBase(DEMO_SESSION_WORKING, 'Atlas', 'Migrate billing to usage-based plans', 'claude', 'working', true),
    sessionBase(DEMO_SESSION_BLOCKED, 'Bex', 'Rebase release branch onto main', 'codex', 'blocked', true),
    {
        ...sessionBase(DEMO_SESSION_DONE, 'Cy', 'Add retry with backoff to sync', 'pi', 'done', false),
        messageCount: 31,
    },
];

function paneBase(paneId: string, sessionId: string, agentName: string, taskTitle: string, agentKind: string, agentStatus: AgentLifecycle, promptable: boolean, focused: boolean): HerdrTreePane {
    return {
        paneId,
        tabId: 'demo-tab-main',
        focused,
        sessionId,
        agentName,
        taskTitle,
        agentKind,
        agentStatus,
        promptable,
    };
}

export const DEMO_WORKSPACE: HerdrTreeWorkspace = {
    workspaceId: 'demo-workspace',
    label: 'acme-app',
    focused: true,
    agentStatus: 'blocked',
    worktree: { repo: 'acme-app', branch: 'release', path: '/home/demo/acme-app' },
    tabs: [
        {
            tabId: 'demo-tab-main',
            label: 'release',
            focused: true,
            agentStatus: 'blocked',
            panes: [
                paneBase('demo-pane-working', DEMO_SESSION_WORKING, 'Atlas', 'Migrate billing to usage-based plans', 'claude', 'working', true, false),
                paneBase('demo-pane-blocked', DEMO_SESSION_BLOCKED, 'Bex', 'Rebase release branch onto main', 'codex', 'blocked', true, true),
                paneBase('demo-pane-done', DEMO_SESSION_DONE, 'Cy', 'Add retry with backoff to sync', 'pi', 'done', false, false),
            ],
        },
    ],
};

export const DEMO_MACHINES: MachineInfo[] = [
    { machineId: DEMO_MACHINE_ID, name: 'demo', online: true, platform: 'linux' },
];

export const DEMO_ATTENTION: AttentionEntry[] = [
    {
        sessionId: DEMO_SESSION_BLOCKED,
        reason: 'blocked',
        detail: 'Needs approval: run git push --force-with-lease?',
        at: at(4),
    },
];

function lifecycleEvent(eventId: string, sessionId: string, agentName: string, state: AgentLifecycle, reasonCode: LifecycleEvent['reasonCode'], minutesAgo: number): LifecycleEvent {
    return { eventId, sessionId, agentName, state, reasonCode, reason: reasonCode, at: at(minutesAgo) };
}

export const DEMO_LIFECYCLE = {
    revision: 1,
    events: [
        lifecycleEvent('demo-ev-working', DEMO_SESSION_WORKING, 'Atlas', 'working', 'agent-working', 9),
        lifecycleEvent('demo-ev-blocked', DEMO_SESSION_BLOCKED, 'Bex', 'blocked', 'agent-blocked', 4),
        lifecycleEvent('demo-ev-done', DEMO_SESSION_DONE, 'Cy', 'done', 'agent-done', 11),
    ],
};

/** The blocked request, as the agent asked it. */
export const DEMO_BLOCKED_DETAIL = 'Needs approval: run git push --force-with-lease? The remote release branch has 2 commits this branch lacks.';
export const DEMO_CONTINUE_COMMAND = 'git push --force-with-lease';

/** Recorded terminal transcripts (ANSI preserved; xterm renders them). */
export const DEMO_TRANSCRIPTS: Record<string, string[]> = {
    [DEMO_SESSION_WORKING]: [
        '\x1b[1;34m$ yarn typecheck\x1b[0m',
        'Checking 214 files…',
        '\x1b[32m✓ no errors\x1b[0m',
        '\x1b[1;34m$ yarn test billing\x1b[0m',
        '  18 passing, 0 failing',
    ],
    [DEMO_SESSION_BLOCKED]: [
        '\x1b[1;34m$ git fetch origin\x1b[0m',
        '  main: 12 new commits',
        '\x1b[1;34m$ git rebase origin/main\x1b[0m',
        '  rebased 4 commits cleanly',
        '\x1b[33m! remote has 2 commits this branch lacks\x1b[0m',
        'Needs approval: run \x1b[1mgit push --force-with-lease\x1b[0m?',
    ],
    [DEMO_SESSION_DONE]: [
        '\x1b[1;34m$ yarn test sync\x1b[0m',
        '  11 passing, 0 failing',
        '\x1b[32mDone in 4.2s\x1b[0m',
    ],
};

export const DEMO_CONTINUATION: string[] = [
    '\x1b[32mApproval received — continuing\x1b[0m',
    '\x1b[1;34m$ git push --force-with-lease\x1b[0m',
    '  To github.com:acme/app.git',
    '  \x1b[32m+ abc1234...def5678 release → release (forced update)\x1b[0m',
    '\x1b[32mDone — branch is in sync with main.\x1b[0m',
];

/** The done agent's artifact, served as the session's changed file. */
export const DEMO_ARTIFACT_PATH = 'src/sync.ts';
export const DEMO_ARTIFACT_CONTENT = `export class MuxrClient {
    connect(): void {
        void this.open();
    }

    /**
     * A returning tab waited out exponential backoff while frozen. Reset the
     * counter so the next reconnect starts at the base delay instead of up to
     * 30s out. Never opens a socket itself, so it cannot duplicate one.
     */
    resetReconnectBackoff(): void {
        this.reconnectAttempt = 0;
    }
}
`;
export const DEMO_ARTIFACT_PATCH = `diff --git a/src/sync.ts b/src/sync.ts
index 3a1f9c2..b7d4e11 100644
--- a/src/sync.ts
+++ b/src/sync.ts
@@ -12,6 +12,14 @@ export class MuxrClient {
     connect(): void {
         void this.open();
     }
+
+    /**
+     * A returning tab waited out exponential backoff while frozen. Reset the
+     * counter so the next reconnect starts at the base delay instead of up to
+     * 30s out. Never opens a socket itself, so it cannot duplicate one.
+     */
+    resetReconnectBackoff(): void {
+        this.reconnectAttempt = 0;
+    }
 }
`;

/**
 * The production terminal-keys manifest, retyped as the record the plugin
 * boundary serves. The real keys row renders from this through the same
 * plugin snapshot path — no invented approval card.
 */
export const DEMO_PLUGIN_MANIFEST_HASH = 'demo-manifest-hash-1';

export const DEMO_PLUGIN_SUMMARY: PluginSummary = {
    pluginId: 'muxr.terminal-keys',
    name: 'Terminal keys',
    version: '0.1.0',
    source: { kind: 'local' },
    manifestHash: DEMO_PLUGIN_MANIFEST_HASH,
    approved: true,
    capabilities: {},
    hasBackend: false,
    warnings: [],
};

export const DEMO_PLUGIN_MANIFEST: PluginManifestV1 = {
    schemaVersion: 1,
    pluginId: 'muxr.terminal-keys',
    contributions: [
        {
            slot: 'terminal.key-row',
            id: 'keys',
            type: 'key-row',
            keys: [
                { label: 'esc', accessibilityLabel: 'Escape', send: '\u001b' },
                { label: 'tab', accessibilityLabel: 'Tab', send: '\t', shift: '\u001b[Z' },
                { label: '^C', accessibilityLabel: 'Control C', send: '\u0003' },
                { label: '^D', accessibilityLabel: 'Control D', send: '\u0004' },
                { label: '\u23ce', accessibilityLabel: 'Enter', send: '\r' },
                { label: '\u2190', accessibilityLabel: 'Left arrow', send: '\u001b[D' },
                { label: '\u2191', accessibilityLabel: 'Up arrow', send: '\u001b[A' },
                { label: '\u2193', accessibilityLabel: 'Down arrow', send: '\u001b[B' },
                { label: '\u2192', accessibilityLabel: 'Right arrow', send: '\u001b[C' },
            ],        },
    ],
};
