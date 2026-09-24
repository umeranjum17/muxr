import { type AgentInfo, type AgentLifecycle, type HerdrTreePane, type HerdrTreeTab, type HerdrTreeWorkspace, type LifecycleEvent } from '@muxr/contract';
import { compactAge } from '../../utils/compactAge';
import { lifecycleStateSince } from './recentActivity';

export interface AgentLabels {
    /** What every surface leads with, so a row and the screen it opens agree. */
    title: string;
    taskTitle: string;
    agentName: string;
    agentKind?: string;
    provider?: string;
    model?: string;
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
    unknown: 'Offline',
};

const AGENT_KIND_LABELS: Readonly<Record<string, string>> = {
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    pi: 'Pi',
};

// Hermes on Android answers locale-aware string calls through ICU over JNI.
// With a dozen agents they cost more than the rest of Home's render together.
// Root-locale lower case is plain toLowerCase, which stays in the engine for
// ASCII; normalize and localeCompare answers are kept, since the same labels
// come back on every render.
// ponytail: the whole map resets when full; an LRU only if label churn defeats it.
const localeAnswers = new Map<string, string | boolean>();
function remember<T extends string | boolean>(key: string, answer: () => T): T {
    const known = localeAnswers.get(key);
    if (known !== undefined) return known as T;
    const value = answer();
    if (localeAnswers.size >= 512) localeAnswers.clear();
    localeAnswers.set(key, value);
    return value;
}

/** Same words ignoring case, accents still counting. */
function sameLabel(left: string, right: string): boolean {
    return remember(`same\u0000${left}\u0000${right}`, () => left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0);
}

export function agentKindLabel(kind?: string): string | undefined {
    const value = kind?.trim();
    if (value === undefined || value === '') return undefined;
    return AGENT_KIND_LABELS[value.toLowerCase()] ?? value;
}



const UNNAMED_AGENT = 'Unnamed agent';

/**
 * One-to-one live Herdr DTO presentation. Only absent-value placeholders are local.
 *
 * Which Herdr field leads: an agent's name (Herdr's agent name), then its task
 * title (title metadata, else the pane label), then the terminal's own window
 * title. That last one is whatever the program set, often just its working
 * directory, so it only stands in when Herdr supplies nothing better. A shell
 * has no agent name and leads with its pane label, else that window title
 * (`user@host:path`).
 */
export function agentLabels(pane?: AgentInfo & Partial<Pick<HerdrTreePane, 'label' | 'terminalTitle' | 'cwd'>>): AgentLabels {
    const named = pane?.agentName?.trim();
    const kind = pane?.agentKind?.trim();
    const hasAgent = named !== undefined && named !== '' || kind !== undefined && kind !== '';
    const agentName = named || (hasAgent ? UNNAMED_AGENT : 'Shell');
    const task = pane?.taskTitle?.trim() || pane?.label?.trim();
    const shellTitle = pane?.label?.trim() || pane?.terminalTitle?.trim() || pane?.taskTitle?.trim()
        || pane?.cwd?.replace(/\/+$/, '').split('/').pop() || 'Shell';
    return {
        title: hasAgent ? named || task || pane?.terminalTitle?.trim() || agentName : shellTitle,
        taskTitle: hasAgent ? task || agentName : shellTitle,
        agentName,
        ...(pane?.agentKind === undefined ? {} : { agentKind: pane.agentKind }),
        ...(pane?.provider === undefined ? {} : { provider: pane.provider }),
        ...(pane?.model === undefined ? {} : { model: pane.model }),
        ...(pane?.displayAgent === undefined ? {} : { displayAgent: pane.displayAgent }),
    };
}

export function isShellLabels(labels: AgentLabels): boolean {
    return labels.agentKind === undefined && labels.agentName === 'Shell';
}

function uniqueLabels(values: readonly (string | undefined)[]): string[] {
    const seen = new Set<string>();
    return values.flatMap((value) => {
        const label = value?.trim();
        if (label === undefined || label === '') return [];
        const key = remember(`key\u0000${label}`, () => label.normalize('NFKC').toLowerCase());
        if (seen.has(key)) return [];
        seen.add(key);
        return [label];
    });
}

/** `label` unless the title already says it. */
function besideTitle(labels: AgentLabels, label: string): string | undefined {
    const value = label.trim();
    if (value === '' || sameLabel(value, labels.title)) return undefined;
    return value;
}

function agentKindSlug(kind?: string): string | undefined {
    const value = kind?.trim();
    if (value === undefined || value === '') return undefined;
    return value.toLowerCase();
}

/**
 * The line under the title: whatever of task, kind and name the title does not
 * already say, e.g. `Fix login redirect · pi · gpt-5` under `lima`.
 */
export function agentNameLine(labels: AgentLabels): string {
    if (isShellLabels(labels)) return 'Shell';
    const kind = agentKindSlug(labels.agentKind);
    const name = labels.agentName === UNNAMED_AGENT ? undefined : besideTitle(labels, labels.agentName);
    const identity = kind !== undefined && name !== undefined ? `${kind}/${name}` : kind ?? name;
    return uniqueLabels([besideTitle(labels, labels.taskTitle), identity, labels.displayAgent ?? labels.provider, labels.model]).join(' · ');
}

/** The task title, when the title leads with something else: a header's second word. */
export function agentTaskLine(labels: AgentLabels): string | undefined {
    return isShellLabels(labels) ? undefined : besideTitle(labels, labels.taskTitle);
}

/** What runs the agent, without its name, e.g. `pi · gpt-5`: for a row that already leads with the name. */
export function agentKindLine(labels: AgentLabels): string {
    if (isShellLabels(labels)) return 'Shell';
    return uniqueLabels([agentKindSlug(labels.agentKind), labels.displayAgent ?? labels.provider, labels.model]).join(' · ');
}

export function agentIdentityLine(labels: AgentLabels): string {
    return agentNameLine(labels);
}

/** Under this a turn's age says nothing; past it, how long it has run is the point. */
const WORKING_AGE_MS = 60_000;

export function agentStateLabel(status: AgentLifecycle, changedAt?: number, now = Date.now()): string {
    const label = HERD_STATUS_LABELS[status];
    if (status === 'starting' || changedAt === undefined) return label;
    if (status === 'working' && now - changedAt < WORKING_AGE_MS) return label;
    return `${label} · ${compactAge(now - changedAt)}`;
}

export function agentAccessibilityLabel(labels: AgentLabels, status: AgentLifecycle, changedAt?: number, now = Date.now()): string {
    const state = agentStateLabel(status, changedAt, now);
    return [labels.title, state, agentIdentityLine(labels)]
        .filter((value): value is string => value !== undefined && value !== '')
        .join('. ');
}

export function liveCardState(
    labels: AgentLabels,
    status: AgentLifecycle,
    sessionId: string,
    events: readonly LifecycleEvent[],
    now: number,
): { label: string; accessibilityLabel: string } {
    const since = lifecycleStateSince(events, sessionId, status);
    return {
        label: agentStateLabel(status, since, now),
        accessibilityLabel: agentAccessibilityLabel(labels, status, since, now),
    };
}

