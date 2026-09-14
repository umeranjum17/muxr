import { type AgentInfo, type AgentLifecycle, type HerdrTreePane, type HerdrTreeTab, type HerdrTreeWorkspace } from '@muxr/contract';

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



/** One-to-one live Herdr DTO presentation. Only absent-value placeholders are local. */
export function agentLabels(pane?: AgentInfo & Partial<Pick<HerdrTreePane, 'label' | 'terminalTitle' | 'cwd'>>): AgentLabels {
    const named = pane?.agentName?.trim();
    const kind = pane?.agentKind?.trim();
    const hasAgent = named !== undefined && named !== '' || kind !== undefined && kind !== '';
    const agentName = named || (hasAgent ? 'Unnamed agent' : 'Shell');
    const terminalTitle = pane?.terminalTitle?.trim();
    const meaningfulTerminalTitle = terminalTitle !== undefined && !/^(?:[^@\s]+@[^:\s]+:|[~/])/.test(terminalTitle)
        ? terminalTitle : undefined;
    const shellTitle = pane?.label?.trim() || pane?.taskTitle?.trim() || meaningfulTerminalTitle || 'Shell';
    return {
        taskTitle: hasAgent ? pane?.taskTitle?.trim() || agentName : shellTitle,
        agentName,
        ...(pane?.agentKind === undefined ? {} : { agentKind: pane.agentKind }),
        ...(pane?.displayAgent === undefined ? {} : { displayAgent: pane.displayAgent }),
    };
}

export function isShellLabels(labels: AgentLabels): boolean {
    return labels.agentKind === undefined && labels.agentName === 'Shell';
}

/** Firstmate's generic launch wrapper is not a useful task label on the phone. */
export function isGenericLaunchTitle(title: string): boolean {
    return /^(?:(?:FIRSTMATE_OP:\s*)?v1[ -]launch-brief|firstmate-op-v1-launch-brief)(?:[: -]|$)/i.test(title);
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

function distinctAgentName(labels: AgentLabels): string | undefined {
    const name = labels.agentName.trim();
    if (name === '') return undefined;
    if (name.localeCompare(labels.taskTitle, undefined, { sensitivity: 'accent' }) === 0) return undefined;
    return name;
}

function agentKindSlug(kind?: string): string | undefined {
    const value = kind?.trim();
    if (value === undefined || value === '') return undefined;
    return value.toLocaleLowerCase('und');
}

/** Kind and animal name as one token, e.g. `pi/fox`. */
export function agentNameLine(labels: AgentLabels): string {
    if (isShellLabels(labels)) return 'Shell';
    const kind = agentKindSlug(labels.agentKind);
    const name = distinctAgentName(labels);
    const identity = kind !== undefined && name !== undefined ? `${kind}/${name}` : kind ?? name;
    return uniqueLabels([identity, labels.displayAgent]).join(' · ');
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
