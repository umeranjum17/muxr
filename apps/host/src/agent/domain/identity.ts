/**
 * Agent identity rules. Agent Route authorizes; Human Name and Task Title never do.
 */

const HUMAN_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' -]{0,72}(?: \d+)?$/u;
const PROVIDER_KINDS = new Set([
    'pi', 'claude', 'codex', 'opencode', 'gemini', 'grok', 'cursor', 'amp', 'copilot',
    'droid', 'kimi', 'kilo', 'devin', 'hermes', 'omp', 'cline', 'kiro', 'maki',
    'mastracode', 'qodercli', 'agy', 'shell',
]);
const GREETING = /^(hi|hey|hello|yo|sup|test|ok|hmm|thanks|help)(\s|$)/i;
const FIRST_PROMPT = /^[a-z0-9]+(?:\s+[a-z0-9]+){2,5}$/;

export interface AgentIdentity {
    /** Agent Route. Stable across pane moves; the only routing key. */
    sessionId: string;
    paneId: string;
    workspaceId: string;
    tabId: string;
    cwd: string;
    /** Human Name. Secondary, spoken, never a routing key. */
    displayName: string;
    /** Task Title. Primary work identity, never a routing key. */
    taskTitle: string;
    /** Provider Kind. Which coding agent, never a name. */
    kind?: string | undefined;
    agentName?: string | undefined;
    createdAt: string;
    ours: boolean;
}

export interface AgentObservation {
    paneId: string;
    previousPaneId?: string | undefined;
    workspaceId?: string | undefined;
    tabId?: string | undefined;
    cwd?: string | undefined;
    agentName?: string | undefined;
    kind?: string | undefined;
    paneLabel?: string | undefined;
    tabLabel?: string | undefined;
    terminalTitle?: string | undefined;
}

export interface AgentAdoptInput {
    sessionId?: string;
    paneId: string;
    workspaceId: string;
    tabId: string;
    cwd: string;
    displayName: string;
    taskTitle?: string | undefined;
    kind?: string | undefined;
    agentName?: string | undefined;
    ours: boolean;
}

export interface NameReservation {
    sessionId: string;
    displayName: string;
    release(): void;
}

export function normalizeHuman(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function humanKey(value: string): string {
    return normalizeHuman(value).toLocaleLowerCase('und').replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

export function isValidHumanName(value: string): boolean {
    return HUMAN_NAME.test(value);
}

export function genericTaskTitle(kind?: string): string {
    const cleanKind = kind?.normalize('NFKC').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
    if (cleanKind === undefined || cleanKind === '') return 'Coding task';
    return `${cleanKind.charAt(0).toLocaleUpperCase()}${cleanKind.slice(1)} task`;
}

/** Task Title from live chrome. Rejects provider kinds, handles, greetings, and paths. */
export function parseTaskTitle(value: string | undefined, kind?: string, humanName?: string): string | undefined {
    let clean = value?.replace(/^[◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/, '').replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (clean === undefined || clean === '') return undefined;
    for (const prefix of [kind, humanName]) {
        if (prefix === undefined || prefix.trim() === '') continue;
        const escaped = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        clean = clean.replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i'), '').trim();
    }
    const lower = clean.toLocaleLowerCase();
    if (clean === '' || lower === kind?.toLocaleLowerCase()) return undefined;
    if (/^pp_|^pph_/i.test(clean) || /^\d+$/.test(clean) || PROVIDER_KINDS.has(lower)) return undefined;
    if (GREETING.test(clean) || FIRST_PROMPT.test(clean)) return undefined;
    if (/^(?:\/|[A-Za-z]:\\|[$>#]|(?:cd|pwd|ls|git|npm|npx|yarn|pnpm|node|python|bash|zsh|fish)\b)|[\\/`]|&&|\|\||\b(?:token|password|secret|credential)\s*=/i.test(clean)) return undefined;
    if (clean.split(/\s+/).length > 8) return undefined;
    return clean;
}

/** Always a Task Title: accepted chrome, else a generic title from Provider Kind. */
export function taskTitleFor(value?: string, kind?: string, humanName?: string): string {
    const parsed = parseTaskTitle(value, kind, humanName);
    if (parsed !== undefined) return parsed;
    return genericTaskTitle(kind);
}

export function parseAgentIdentity(value: unknown): AgentIdentity | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.sessionId !== 'string' || row.sessionId.trim() === '') return undefined;
    if (typeof row.paneId !== 'string' || row.paneId.trim() === '') return undefined;
    if (typeof row.workspaceId !== 'string' || typeof row.tabId !== 'string') return undefined;
    if (typeof row.cwd !== 'string' || row.cwd.trim() === '') return undefined;
    if (typeof row.createdAt !== 'string' || typeof row.ours !== 'boolean') return undefined;
    if (typeof row.displayName !== 'string' || typeof row.taskTitle !== 'string') return undefined;
    const displayName = normalizeHuman(row.displayName);
    const taskTitle = row.taskTitle.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!isValidHumanName(displayName) || taskTitle === '') return undefined;
    const kind = typeof row.kind === 'string' && row.kind.trim() !== '' ? row.kind : undefined;
    const agentName = typeof row.agentName === 'string' && row.agentName.trim() !== '' ? row.agentName : undefined;
    return {
        sessionId: row.sessionId,
        paneId: row.paneId,
        workspaceId: row.workspaceId,
        tabId: row.tabId,
        cwd: row.cwd,
        displayName,
        taskTitle,
        createdAt: row.createdAt,
        ours: row.ours,
        ...(kind === undefined ? {} : { kind }),
        ...(agentName === undefined ? {} : { agentName }),
    };
}
