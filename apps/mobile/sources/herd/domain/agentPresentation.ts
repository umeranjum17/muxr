import { type AgentInfo, type AgentLifecycle, type HerdrTreePane, type HerdrTreeTab, type HerdrTreeWorkspace } from '@muxr/contract';

export interface AgentLabels {
    taskTitle?: string;
    agentName?: string;
    agentKind?: string;
    displayAgent?: string;
    shellTitle?: string;
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

/** The workspace and tab a session's pane lives in, from the live tree. */
export function herdrTabForSession(
    workspaces: readonly HerdrTreeWorkspace[],
    sessionId: string,
): { workspace: HerdrTreeWorkspace; tab: HerdrTreeTab } | undefined {
    for (const workspace of workspaces) {
        for (const tab of workspace.tabs) {
            if (tab.panes.some((candidate) => candidate.sessionId === sessionId)) return { workspace, tab };
        }
    }
    return undefined;
}

/** A tab's name for people: its label, else its position. Never an id. */
export function tabLabel(tab: HerdrTreeTab, index: number): string {
    const label = tab.label?.trim() ?? '';
    if (label === '') return `Tab ${index + 1}`;
    // A bare number is herdr's default label; say what it counts.
    return /^\d+$/.test(label) ? `Tab ${label}` : label;
}

export const HERD_STATUS_LABELS: Record<AgentLifecycle, string> = {
    working: 'Working',
    starting: 'Starting',
    blocked: 'Needs you',
    done: 'Done',
    failed: 'Failed',
    idle: 'Idle',
    unknown: 'Status unknown',
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



/** Keep valid Herdr copy byte-for-byte; opaque projection names stay private. */
export function visibleHerdrLabel(value?: string): string | undefined {
    if (value === undefined || value.trim() === '' || /^(?:pp_|pph_)/.test(value.trim())) return undefined;
    return value;
}

/** One-to-one live Herdr DTO presentation. Shell copy is separate from agent fields. */
export function agentLabels(pane?: AgentInfo & Partial<Pick<HerdrTreePane, 'label' | 'terminalTitle' | 'cwd'>>): AgentLabels {
    const agentName = visibleHerdrLabel(pane?.agentName);
    const taskTitle = visibleHerdrLabel(pane?.taskTitle);
    const agentKind = pane?.agentKind;
    const hasAgent = agentName !== undefined || agentKind !== undefined;
    const terminalTitle = pane?.terminalTitle?.trim();
    const meaningfulTerminalTitle = terminalTitle !== undefined && !/^(?:[^@\s]+@[^:\s]+:|[~/])/.test(terminalTitle)
        ? terminalTitle : undefined;
    const shellTitle = visibleHerdrLabel(pane?.label) ?? taskTitle ?? meaningfulTerminalTitle;
    return {
        ...(taskTitle === undefined ? {} : { taskTitle }),
        ...(agentName === undefined ? {} : { agentName }),
        ...(agentKind === undefined ? {} : { agentKind }),
        ...(pane?.displayAgent === undefined ? {} : { displayAgent: pane.displayAgent }),
        ...(!hasAgent && shellTitle !== undefined ? { shellTitle } : {}),
    };
}

export function isShellLabels(labels: AgentLabels): boolean {
    return labels.agentKind === undefined && labels.agentName === undefined;
}

/** Display-only fallback. A missing Herdr name stays missing in AgentLabels. */
export function agentNameLine(labels: AgentLabels): string {
    if (isShellLabels(labels)) return 'Shell';
    return labels.agentName ?? agentKindLabel(labels.agentKind) ?? 'Agent';
}

/** Display-only fallback. A missing Herdr title stays missing in AgentLabels. */
export function agentTaskLine(labels: AgentLabels): string {
    if (isShellLabels(labels)) return labels.shellTitle ?? 'Shell';
    return labels.taskTitle ?? 'Untitled task';
}

export function agentIdentityLine(labels: AgentLabels): string {
    return agentNameLine(labels);
}

export function agentStateLabel(status: AgentLifecycle, changedAt?: number, now = Date.now()): string {
    const label = HERD_STATUS_LABELS[status];
    if (status === 'working' || status === 'starting' || changedAt === undefined) return label;
    return `${label} · ${compactAge(now - changedAt)}`;
}

export function agentAccessibilityLabel(labels: AgentLabels, status: AgentLifecycle, changedAt?: number): string {
    const state = changedAt === undefined ? HERD_STATUS_LABELS[status] : agentStateLabel(status, changedAt);
    const title = agentTaskLine(labels);
    const name = agentIdentityLine(labels);
    return [title, state, title === name ? undefined : name]
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
