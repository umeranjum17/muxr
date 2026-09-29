import { agentTask, type AgentInfo, type AgentLifecycle, type HerdrTreePane, type HerdrTreeTab, type HerdrTreeWorkspace, type LifecycleEvent } from '@muxr/contract';
import { compactAge } from '../../utils/compactAge';
import { lifecycleStateSince } from './recentActivity';

export interface AgentLabels {
    /** What every surface leads with: the task, else the agent's name. */
    title: string;
    /** What the agent is working on, when anything Herdr supplies says so. */
    task?: string;
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
 * An agent leads with what it is working on (`agentTask`: its pane label, its
 * own window title, Herdr title metadata, or the host's task-workspace
 * fallback already folded into `taskTitle`), else its Herdr name. Who runs it
 * goes on the line under that. A shell has no agent name and leads with its
 * pane label, else its window title (`user@host:path`).
 */
export function agentLabels(pane?: AgentInfo & Partial<Pick<HerdrTreePane, 'label' | 'terminalTitle' | 'cwd'>>): AgentLabels {
    const named = pane?.agentName?.trim();
    const kind = pane?.agentKind?.trim();
    const hasAgent = named !== undefined && named !== '' || kind !== undefined && kind !== '';
    const agentName = named || (hasAgent ? UNNAMED_AGENT : 'Shell');
    const task = hasAgent ? agentTask({
        label: pane?.label,
        terminalTitle: pane?.terminalTitle,
        title: pane?.taskTitle,
        agentName: named,
        agentKind: kind,
        cwd: pane?.cwd,
    }) : undefined;
    const shellTitle = pane?.label?.trim() || pane?.terminalTitle?.trim() || pane?.taskTitle?.trim()
        || pane?.cwd?.replace(/\/+$/, '').split('/').pop() || 'Shell';
    return {
        title: hasAgent ? task ?? (named || pane?.terminalTitle?.trim() || agentName) : shellTitle,
        ...(task === undefined ? {} : { task }),
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

function agentKindSlug(kind?: string): string | undefined {
    const value = kind?.trim();
    if (value === undefined || value === '') return undefined;
    return value.toLowerCase();
}

/** The agent's name beside a title that leads with its task; nothing when the title already is the name. */
export function agentBesideName(labels: AgentLabels): string | undefined {
    if (isShellLabels(labels) || labels.task === undefined || labels.agentName === UNNAMED_AGENT) return undefined;
    return sameLabel(labels.agentName, labels.title) ? undefined : labels.agentName;
}

/**
 * Who is doing it, the line under the title: `pi · zulu-2`, or `pi` when the
 * title is the name. `withName` keeps the name for a title that leads with neither.
 */
export function agentWhoLine(labels: AgentLabels, withName = false): string {
    if (isShellLabels(labels)) return 'Shell';
    const name = withName && labels.agentName !== UNNAMED_AGENT ? labels.agentName : agentBesideName(labels);
    return [agentKindSlug(labels.agentKind), name].filter((part) => part !== undefined).join(' · ');
}

/** The line under the title with the agent's state: `pi · zulu-2 · Working`. */
export function agentWhoStateLine(labels: AgentLabels, state: string): string {
    return [agentWhoLine(labels), state].filter((part) => part !== '').join(' · ');
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
    return [labels.title, state, agentWhoLine(labels)]
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


/** An agent's name is Herdr's handle: typed straight into its alphabet. */
export function agentHandle(text: string): string {
    return text.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9_-]/g, '');
}

/** The name a rename sheet's answer sets, or null when it changes nothing (cancelled, blank or unchanged). */
export function renamedTo(typed: string | null, current: string): string | null {
    const name = typed?.trim() ?? '';
    return name === '' || name === current ? null : name;
}
