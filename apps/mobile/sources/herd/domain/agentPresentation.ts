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

const AGENT_KIND_LABELS: Readonly<Record<string, string>> = {
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    pi: 'Pi',
};

export function agentKindLabel(kind?: string): string | undefined {
    const value = kind?.trim();
    if (value === undefined || value === '') return undefined;
    return AGENT_KIND_LABELS[value.toLocaleLowerCase('und')] ?? value;
}



/** One-to-one live Herdr DTO presentation. Only absent-value placeholders are local. */
export function agentLabels(pane?: AgentInfo): AgentLabels {
    const hasAgent = pane?.agentName !== undefined
        || pane?.taskTitle !== undefined
        || pane?.agentKind !== undefined
        || pane?.displayAgent !== undefined;
    const agentName = pane?.agentName?.trim() || (hasAgent ? 'Unnamed agent' : 'Shell');
    return {
        taskTitle: pane?.taskTitle?.trim() || (hasAgent ? agentName : 'Untitled task'),
        agentName,
        ...(pane?.agentKind === undefined ? {} : { agentKind: pane.agentKind }),
        ...(pane?.displayAgent === undefined ? {} : { displayAgent: pane.displayAgent }),
    };
}

function uniqueLabels(values: readonly (string | undefined)[]): string[] {
    const seen = new Set<string>();
    return values.flatMap((value) => {
        const label = value?.trim();
        if (label === undefined || label === '') return [];
        const key = label.normalize('NFKC').toLocaleLowerCase('und');
        if (seen.has(key)) return [];
        seen.add(key);
        return [label];
    });
}

export function agentNameLine(labels: AgentLabels): string {
    const name = labels.agentName.localeCompare(labels.taskTitle, undefined, { sensitivity: 'accent' }) === 0
        ? undefined
        : labels.agentName;
    return uniqueLabels([name, labels.displayAgent]).join(' · ');
}

export function agentIdentityLine(labels: AgentLabels): string {
    const name = labels.agentName.localeCompare(labels.taskTitle, undefined, { sensitivity: 'accent' }) === 0
        ? undefined
        : labels.agentName;
    return uniqueLabels([name, agentKindLabel(labels.agentKind), labels.displayAgent]).join(' · ');
}

export function agentStateLabel(status: AgentLifecycle, changedAt?: number, now = Date.now()): string {
    const label = HERD_STATUS_LABELS[status];
    if (status === 'working' || status === 'starting' || changedAt === undefined) return label;
    return `${label} · ${compactAge(now - changedAt)}`;
}

export function agentAccessibilityLabel(labels: AgentLabels, status: AgentLifecycle, changedAt?: number): string {
    const state = changedAt === undefined ? HERD_STATUS_LABELS[status] : agentStateLabel(status, changedAt);
    return [labels.taskTitle, state, agentIdentityLine(labels)]
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
