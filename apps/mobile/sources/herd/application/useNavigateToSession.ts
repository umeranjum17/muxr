import * as React from 'react';
import type { Router } from 'expo-router';
import { useRouter } from 'expo-router';
import type { HerdrTreeTab } from '@muxr/contract';
import { focusAgent } from './FocusAgent';

// The pane this device last opened in each tab, so a tab tap returns to it.
// In memory only: it is a convenience, not state worth persisting, and it
// is scoped by computer, workspace and tab so a reused id elsewhere never
// matches. Invalid entries are ignored at resolve time and overwritten.
const lastPaneByTab = new Map<string, string>();
const tabKey = (machineId: string, workspaceId: string, tabId: string): string => `${machineId}\u0000${workspaceId}\u0000${tabId}`;

export function rememberPaneSelection(scope: { machineId: string; workspaceId: string; tabId: string }, sessionId: string): void {
    lastPaneByTab.set(tabKey(scope.machineId, scope.workspaceId, scope.tabId), sessionId);
}

/**
 * The pane a tab tap opens: the pane this device last selected there if
 * it still exists, else the tab's focused pane, else its first openable
 * pane. `undefined` means the tab has nothing to open yet.
 */
export function resolveTabPane(tab: HerdrTreeTab, scope: { machineId: string; workspaceId: string }): string | undefined {
    const openable = tab.panes.filter((pane) => pane.sessionId !== undefined);
    const remembered = lastPaneByTab.get(tabKey(scope.machineId, scope.workspaceId, tab.tabId));
    const kept = openable.find((pane) => pane.sessionId === remembered);
    return (kept ?? openable.find((pane) => pane.focused) ?? openable[0])?.sessionId;
}

type AgentNavigation = Pick<Router, 'canDismiss' | 'dismissTo' | 'push'>;

export function navigateToSession(router: AgentNavigation, sessionId: string) {
    const { href, action } = focusAgent({ agentRoute: sessionId, aboveHome: router.canDismiss() });
    if (action === 'dismissTo') router.dismissTo(href);
    else router.push(href);
}

export function useNavigateToSession() {
    const router = useRouter();
    return React.useCallback((sessionId: string) => navigateToSession(router, sessionId), [router]);
}
