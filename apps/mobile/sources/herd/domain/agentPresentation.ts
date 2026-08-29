import { type AgentInfo, type AgentLifecycle, type HerdrTreePane, type HerdrTreeWorkspace } from '@muxr/contract';

export interface AgentLabels {
    taskTitle: string;
    agentName: string;
    agentKind?: string;
    displayAgent?: string;
}


export function herdrPaneForSession(
    workspaces: readonly HerdrTreeWorkspace[],
    sessionId: string,
): HerdrTreePane | undefined {
    for (const workspace of workspaces) {
        for (const tab of workspace.tabs) {
            const pane = tab.panes.find((candidate) => candidate.sessionId === sessionId);
            if (pane !== undefined) return pane;
        }
    }
    return undefined;
}

export const HERD_STATUS_LABELS: Record<AgentLifecycle, string> = {
    working: 'Working',
    starting: 'Starting',
    blocked: 'Needs you',
    done: 'Done',
    failed: 'Failed',
    idle: 'Idle',
    unknown: 'Offline',
};



/** One-to-one live Herdr DTO presentation. Only absent-value placeholders are local. */
export function agentLabels(pane?: AgentInfo): AgentLabels {
    const hasAgent = pane?.agentName !== undefined
        || pane?.taskTitle !== undefined
        || pane?.agentKind !== undefined
        || pane?.displayAgent !== undefined;
    return {
        taskTitle: pane?.taskTitle ?? 'Untitled task',
        agentName: pane?.agentName ?? (hasAgent ? 'Unnamed agent' : 'Shell'),
        ...(pane?.agentKind === undefined ? {} : { agentKind: pane.agentKind }),
        ...(pane?.displayAgent === undefined ? {} : { displayAgent: pane.displayAgent }),
    };
}

export function agentIdentityLine(labels: AgentLabels): string {
    return [labels.agentName, labels.agentKind, labels.displayAgent]
        .filter((value): value is string => value !== undefined)
        .join(' · ');
}

export function agentStateLabel(status: AgentLifecycle, changedAt?: number, now = Date.now()): string {
    const label = HERD_STATUS_LABELS[status];
    if (status === 'working' || status === 'starting' || changedAt === undefined) return label;
    return `${label} · ${compactAge(now - changedAt)}`;
}

export function agentAccessibilityLabel(labels: AgentLabels, status: AgentLifecycle, changedAt?: number): string {
    const state = changedAt === undefined ? HERD_STATUS_LABELS[status] : agentStateLabel(status, changedAt);
    return [labels.taskTitle, state, labels.agentName, labels.agentKind, labels.displayAgent]
        .filter((value): value is string => value !== undefined && value !== '')
        .join('. ');
}

export function compactAge(elapsedMs: number): string {
    const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}
