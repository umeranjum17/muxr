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

function lifecycleEvent(eventId: string, sessionId: string, agentName: string, agentKind: string, state: AgentLifecycle, reasonCode: LifecycleEvent['reasonCode'], minutesAgo: number): LifecycleEvent {
    return { eventId, sessionId, agentName, agentKind, state, reasonCode, reason: reasonCode, at: at(minutesAgo) };
}

export const DEMO_LIFECYCLE = {
    revision: 1,
    events: [
        lifecycleEvent('demo-ev-working', DEMO_SESSION_WORKING, 'Atlas', 'claude', 'working', 'agent-working', 9),
        lifecycleEvent('demo-ev-blocked', DEMO_SESSION_BLOCKED, 'Bex', 'codex', 'blocked', 'agent-blocked', 4),
        lifecycleEvent('demo-ev-done', DEMO_SESSION_DONE, 'Cy', 'pi', 'done', 'agent-done', 11),
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

/**
 * The shipped muxr.code Files/Changes surface, retyped verbatim for the
 * recorded run: the session.pills Changes item-list plus its changes.list
 * read RPC. The files browser contributions below round out the same
 * manifest; runbook/history/cmd stay out and fail closed like any
 * unsupported call.
 */
export const DEMO_CODE_MANIFEST_HASH = 'demo-code-manifest-hash-1';

export const DEMO_CODE_SUMMARY: PluginSummary = {
    pluginId: 'muxr.code',
    name: 'Code',
    version: '0.1.0',
    source: { kind: 'local' },
    manifestHash: DEMO_CODE_MANIFEST_HASH,
    approved: true,
    capabilities: {},
    hasBackend: true,
    warnings: [],
};

export const DEMO_CODE_MANIFEST: PluginManifestV1 = {
    schemaVersion: 1,
    pluginId: 'muxr.code',
    minMuxrVersion: 11,
    // Parsed manifest shape, exactly as the host serves it after parsing
    // muxr-ui.json params (mobile never sees the raw file).
    contributions: [
        {
            slot: 'session.pills',
            id: 'changes',
            type: 'native',
            primitive: 'item-list',
            title: 'Changes',
            icon: 'git-compare-outline',
            accessibilityLabel: 'Open changed files',
            source: {
                type: 'plugin.call',
                contributionId: 'changes.list',
            },
        },
        {
            slot: 'host.rpc',
            id: 'changes.list',
            type: 'rpc',
            method: 'list',
            entry: 'changes.mjs',
            mode: 'read',
        },
        {
            slot: 'navigation.primary',
            id: 'files.nav',
            type: 'navigation-item',
            label: 'Files',
            icon: 'document-text-outline',
            contentContributionId: 'files.browse',
        },
        {
            slot: 'navigation.content',
            id: 'files.browse',
            type: 'screen',
            title: '{{data.title}}',
            data: { type: 'plugin.call', contributionId: 'files.repos' },
            children: [
                {
                    type: 'list',
                    title: 'Repositories',
                    emptyText: 'No git repositories open',
                    rows: [],
                    repeat: {
                        path: 'data.repos',
                        template: {
                            type: 'row',
                            title: '{{item.name}}',
                            action: { type: 'screen', contributionId: 'files', params: { root: '{{item.root}}' } },
                        },
                    },
                },
            ],
        },
        {
            slot: 'navigation.content',
            id: 'files',
            type: 'screen',
            title: '{{data.title}}',
            data: { type: 'plugin.call', contributionId: 'files.list' },
            children: [
                { type: 'text', text: '{{data.count}}', tone: 'secondary' },
                {
                    type: 'tree',
                    title: 'Explorer',
                    emptyText: 'No files',
                    path: 'data.tree',
                    source: { type: 'plugin.call', contributionId: 'files.list' },
                },
            ],
        },
        { slot: 'host.rpc', id: 'files.repos', type: 'rpc', method: 'repos', entry: 'files.mjs', mode: 'read' },
        { slot: 'host.rpc', id: 'files.list', type: 'rpc', method: 'list', entry: 'files.mjs', mode: 'read' },
    ],
};

/** The recorded working tree: what the real changes.mjs would report. */
export const DEMO_CHANGES_RESPONSE = {
    items: [
        {
            id: 'src/sync.ts',
            title: 'sync.ts',
            subtitle: 'src/sync.ts',
            icon: 'git-compare-outline',
            metadata: [
                { value: '+8', tone: 'positive' },
            ],
            action: { type: 'kernel.navigate', target: 'file', path: 'src/sync.ts' },
        },
    ],
    total: 1,
};

/**
 * Navigation fixtures: the real bundled production manifests (retyped from
 * plugins/inbox, plugins/status, plugins/code files.*, plugins/servers
 * muxr-ui.json), served through the same plugin snapshot/call seams. No
 * decorative chips: every contribution below has a destination and an
 * answered RPC. The Panes chip in the reference comes from a plugin outside
 * this checkout and cannot be fixtured honestly.
 */
export const DEMO_INBOX_MANIFEST_HASH = 'demo-inbox-manifest-hash-1';

export const DEMO_INBOX_SUMMARY: PluginSummary = {
    pluginId: 'muxr.inbox',
    name: 'Inbox',
    version: '0.1.0',
    source: { kind: 'local' },
    manifestHash: DEMO_INBOX_MANIFEST_HASH,
    approved: true,
    capabilities: {},
    hasBackend: true,
    warnings: [],
};

export const DEMO_INBOX_MANIFEST: PluginManifestV1 = {
    schemaVersion: 1,
    pluginId: 'muxr.inbox',
    contributions: [
        {
            slot: 'navigation.primary',
            id: 'inbox',
            type: 'navigation-item',
            label: 'Inbox',
            icon: 'file-tray-full-outline',
            contentContributionId: 'content',
            badge: { type: 'plugin.call', contributionId: 'count' },
        },
        {
            slot: 'navigation.content',
            id: 'content',
            type: 'native',
            primitive: 'collection',
            title: 'Inbox',
            emptyTitle: 'Nothing needs you',
            emptyMessage: 'Agents show up here when they ask you something, get stuck, or finish',
            icon: 'file-tray-full-outline',
            source: { type: 'plugin.call', contributionId: 'list' },
        },
        { slot: 'host.rpc', id: 'list', type: 'rpc', method: 'list', entry: 'rpc.mjs', mode: 'read' },
        { slot: 'host.rpc', id: 'count', type: 'rpc', method: 'count', entry: 'rpc.mjs', mode: 'read' },
    ],
};

export const DEMO_STATUS_MANIFEST_HASH = 'demo-status-manifest-hash-1';

export const DEMO_STATUS_SUMMARY: PluginSummary = {
    pluginId: 'muxr.status',
    name: 'Status',
    version: '0.1.0',
    source: { kind: 'local' },
    manifestHash: DEMO_STATUS_MANIFEST_HASH,
    approved: true,
    capabilities: {},
    hasBackend: true,
    warnings: [],
};

export const DEMO_STATUS_MANIFEST: PluginManifestV1 = {
    schemaVersion: 1,
    pluginId: 'muxr.status',
    contributions: [
        {
            slot: 'navigation.primary',
            id: 'usage.nav',
            type: 'navigation-item',
            label: 'Usage',
            icon: 'speedometer-outline',
            contentContributionId: 'usage.details',
        },
        {
            slot: 'home.cards',
            id: 'vitals.card',
            type: 'data-card',
            title: 'Machine',
            presentation: 'sheet',
            source: { type: 'plugin.call', contributionId: 'vitals' },
            emptyText: 'Vitals unavailable',
        },
        {
            slot: 'navigation.content',
            id: 'usage.details',
            type: 'screen',
            title: 'Usage',
            data: { type: 'plugin.call', contributionId: 'usage' },
            children: [
                { type: 'tabs', path: 'data.providers', selectedPath: 'data.provider', param: 'provider' },
                {
                    type: 'section',
                    title: 'Today',
                    children: [
                        {
                            type: 'section',
                            columns: 2,
                            children: [
                                { type: 'metric', label: 'Tokens', value: '{{data.todayTokens}}' },
                                { type: 'metric', label: 'Cost', value: '{{data.todayCost}}' },
                            ],
                        },
                        { type: 'progress', path: 'data.fiveHourUsed', max: 100, label: '5-hour limit', valueLabel: '{{data.fiveHourLabel}}' },
                        { type: 'progress', path: 'data.sevenDayUsed', max: 100, label: '7-day limit', valueLabel: '{{data.sevenDayLabel}}' },
                        { type: 'text', text: '{{data.limitLabel}}', tone: 'secondary' },
                    ],
                },
                {
                    type: 'section',
                    title: 'Last 7 days',
                    children: [
                        {
                            type: 'section',
                            columns: 2,
                            children: [
                                { type: 'metric', label: 'Tokens', value: '{{data.weekTokens}}' },
                                { type: 'metric', label: 'Cost', value: '{{data.weekCost}}' },
                            ],
                        },
                        { type: 'chart', variant: 'column', path: 'data.weekSeries', emptyText: 'No measured activity this week' },
                    ],
                },
            ],
        },
        { slot: 'host.rpc', id: 'usage', type: 'rpc', method: 'usage', entry: 'usage.mjs', mode: 'read' },
        { slot: 'host.rpc', id: 'vitals', type: 'rpc', method: 'vitals', entry: 'vitals.mjs', mode: 'read' },
    ],
};

/** Static snapshots in the exact shapes usage.mjs/vitals.mjs emit. */
export const DEMO_VITALS_TEXT = 'memory 3.1 of 15.6G · load 1.20 0.80 0.40 · up 5h · disk 12G used of 100G (12%) · 88G free';

export const DEMO_USAGE_SNAPSHOT = {
    providers: [{ id: 'claude', label: 'Claude' }],
    provider: 'claude',
    providerName: 'Claude',
    todayTokens: '1,540',
    todayCost: '$0.02',
    fiveHourUsed: 62,
    fiveHourLabel: '62% used · resets in 3h',
    sevenDayUsed: 34,
    sevenDayLabel: '34% used',
    limitLabel: 'Plan limits refresh on the Claude schedule.',
    modelSeries: [
        { label: 'Mon', value: 120, valueLabel: '120' },
        { label: 'Tue', value: 340, valueLabel: '340' },
        { label: 'Wed', value: 210, valueLabel: '210' },
    ],
    limitSeries: [],
    weekTokens: '1,540',
    weekCost: '$0.02',
    weekSeries: [
        { label: 'Mon', value: 120, valueLabel: '120' },
        { label: 'Tue', value: 340, valueLabel: '340' },
        { label: 'Wed', value: 210, valueLabel: '210' },
    ],
};

/** The recorded repo, mirroring the files.mjs repos/list shapes. */
export const DEMO_FILES_REPOS = {
    title: '1 repository',
    repos: [{ root: '/home/demo/acme-app', name: 'acme-app', path: '/home/demo/acme-app' }],
};

export const DEMO_FILES_TREE = {
    root: '/home/demo/acme-app',
    title: 'acme-app',
    count: '3 files',
    tree: [
        { name: 'src', path: 'src', kind: 'folder', hasChildren: true },
        { name: 'sync.ts', path: 'src/sync.ts', kind: 'file' },
        { name: 'README.md', path: 'README.md', kind: 'file' },
    ],
};

export const DEMO_PORTS_MANIFEST_HASH = 'demo-ports-manifest-hash-1';

export const DEMO_PORTS_SUMMARY: PluginSummary = {
    pluginId: 'muxr.servers',
    name: 'Servers',
    version: '0.1.0',
    source: { kind: 'local' },
    manifestHash: DEMO_PORTS_MANIFEST_HASH,
    approved: true,
    capabilities: {},
    hasBackend: true,
    warnings: [],
};

export const DEMO_PORTS_MANIFEST: PluginManifestV1 = {
    schemaVersion: 1,
    pluginId: 'muxr.servers',
    contributions: [
        {
            slot: 'navigation.primary',
            id: 'ports.nav',
            type: 'navigation-item',
            label: 'Ports',
            icon: 'git-network-outline',
            contentContributionId: 'ports.browse',
        },
        {
            slot: 'navigation.content',
            id: 'ports.browse',
            type: 'screen',
            title: '{{data.title}}',
            data: { type: 'plugin.call', contributionId: 'ports.list' },
            children: [
                {
                    type: 'list',
                    title: 'Listening',
                    emptyText: 'Nothing listening',
                    rows: [],
                    repeat: {
                        path: 'data.ports',
                        template: {
                            type: 'row',
                            title: '{{item.title}}',
                            subtitle: '{{item.subtitle}}',
                        },
                    },
                },
            ],
        },
        { slot: 'host.rpc', id: 'ports.list', type: 'rpc', method: 'list', entry: 'ports.mjs', mode: 'read' },
    ],
};

/** Nothing listens in the replay: the honest empty state. */
export const DEMO_PORTS_EMPTY = { title: '0 listening', ports: [] };
