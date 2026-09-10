import type { HerdrTreePane } from '@muxr/contract';

/**
 * Deterministic demo fixtures. Recorded shapes, not live data: the replay
 * screen renders these through the real presentation modules (agent labels,
 * status copy, attention presentation, Pierre diff, xterm terminal).
 */

export const DEMO_INSTALL_COMMAND = 'npm install -g --ignore-scripts @trymuxr/cli@latest';

export interface DemoAgent extends HerdrTreePane {
    transcript: string[];
    continuation: string[];
}

export const DEMO_AGENTS: DemoAgent[] = [
    {
        paneId: 'demo-pane-working',
        tabId: 'demo-tab-1',
        focused: true,
        agentName: 'Atlas',
        taskTitle: 'Migrate billing to usage-based plans',
        agentKind: 'claude',
        agentStatus: 'working',
        promptable: true,
        sessionId: 'demo-session-working',
        transcript: [
            '\x1b[1;34m$ yarn typecheck\x1b[0m',
            'Checking 214 files…',
            '\x1b[32m✓ no errors\x1b[0m',
            '\x1b[1;34m$ yarn test billing\x1b[0m',
            '  18 passing, 0 failing',
        ],
        continuation: [
            '\x1b[1;34m$ yarn test billing --watch\x1b[0m',
            '  19 passing, 0 failing',
        ],
    },
    {
        paneId: 'demo-pane-blocked',
        tabId: 'demo-tab-1',
        focused: false,
        agentName: 'Bex',
        taskTitle: 'Rebase release branch onto main',
        agentKind: 'codex',
        agentStatus: 'blocked',
        promptable: true,
        sessionId: 'demo-session-blocked',
        transcript: [
            '\x1b[1;34m$ git fetch origin\x1b[0m',
            '  main: 12 new commits',
            '\x1b[1;34m$ git rebase origin/main\x1b[0m',
            '  rebased 4 commits cleanly',
            '\x1b[33m! remote has 2 commits this branch lacks\x1b[0m',
            'Needs approval: run \x1b[1mgit push --force-with-lease\x1b[0m?',
        ],
        continuation: [
            '\x1b[32mApproval received — continuing\x1b[0m',
            '\x1b[1;34m$ git push --force-with-lease\x1b[0m',
            '  To github.com:acme/app.git',
            '  \x1b[32m+ abc1234...def5678 release → release (forced update)\x1b[0m',
            '\x1b[32mDone — branch is in sync with main.\x1b[0m',
        ],
    },
    {
        paneId: 'demo-pane-done',
        tabId: 'demo-tab-2',
        focused: false,
        agentName: 'Cy',
        taskTitle: 'Add retry with backoff to sync',
        agentKind: 'pi',
        agentStatus: 'done',
        promptable: false,
        sessionId: 'demo-session-done',
        transcript: [
            '\x1b[1;34m$ yarn test sync\x1b[0m',
            '  11 passing, 0 failing',
            '\x1b[32mDone in 4.2s\x1b[0m',
        ],
        continuation: [],
    },
];

export const DEMO_APPROVAL_REQUEST = {
    sessionId: 'demo-session-blocked',
    command: 'git push --force-with-lease',
    reason: 'The remote release branch has 2 commits this branch lacks. Force-with-lease pushes only if the remote is exactly what Bex fetched — a plain --force is refused.',
};

export const DEMO_DONE_PATCH = `diff --git a/src/sync.ts b/src/sync.ts
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
