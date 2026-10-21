/**
 * What an agent is working on, from what Herdr supplies. Host and phone both
 * call this, so a row, the terminal header and a notification say the same thing.
 *
 * Sources, first meaningful one wins:
 * 1. Herdr title metadata: the task-titles plugin owns pane titles;
 * 2. the Herdr tab label, as Herdr's sidebar shows it but in words
 *    (`labelWords`), even when it is the agent's own name (a launcher names
 *    both alike); Herdr's default bare number names nothing;
 * 3. the pane label: the agent's own `muxr name --pane`;
 * 4. the harness's own window title (Claude keeps its session topic there);
 * 5. the task workspace's label, when that workspace holds only this agent.
 *
 * A source says nothing about the work when all it leaves is the folder or repo
 * name (`π - pockit`, a plugin's `Pockit` fallback), the program's or agent's
 * own name, a state word (`Ready`), a shell prompt or path, or the title Claude
 * makes of a Firstmate doorbell. Leading with those made every agent in
 * one repo read the same, so they never count. The tab label is the exception:
 * the phone names a pane exactly as Herdr's sidebar does.
 */
export interface AgentTaskSources {
    label?: string | null | undefined;
    tabLabel?: string | null | undefined;
    terminalTitle?: string | null | undefined;
    title?: string | null | undefined;
    workspaceLabel?: string | null | undefined;
    agentName?: string | null | undefined;
    agentKind?: string | null | undefined;
    cwd?: string | null | undefined;
}

const PROGRAM_NAMES = [
    'claude', 'claude code', 'codex', 'openai codex', 'pi', 'opencode', 'oc', 'cursor', 'cursor agent',
    'gemini', 'gemini cli', 'copilot', 'amp', 'droid', 'bash', 'zsh', 'fish', 'sh', 'nu', 'shell',
    // A window title that only reports the program's state.
    'ready', 'working', 'thinking', 'idle', 'waiting', 'running', 'done',
].map(squash);

function isWordChar(ch: string): boolean {
    return /[\p{L}\p{N}]/u.test(ch);
}

function isSpaceChar(ch: string): boolean {
    return /\s/.test(ch);
}

// Letters and numbers only, e.g. `Fix login!` and `fix-login` compare equal.
// Linear filter: the flagged `[^...]+` repetition is one test per char.
function squash(value: string): string {
    let out = '';
    for (const ch of value.toLowerCase()) {
        if (isWordChar(ch)) out += ch;
    }
    return out;
}

// Leading spinners and marks a harness puts in front (`✳`, `⠋`). Linear
// scan: the flagged `^[^...]+` repetition is equivalent to skipping chars.
function stripLeadingMarks(value: string): string {
    let i = 0;
    // By code point: a lone UTF-16 half never tests as a letter or number.
    for (const ch of value) {
        if (ch === '#' || ch === '(' || ch === '[' || ch === '"' || ch === "'" || ch === '\u201c' || isWordChar(ch)) break;
        i += ch.length;
    }
    return value.slice(i);
}

// A trailing `(note)` that only names the program, folder or state, e.g.
// `Fix login (pi)`. Linear: `lastIndexOf` instead of the flagged
// `\s*\(([^)]*)\)$` repetition.
function stripNoisySuffix(part: string, noise: ReadonlySet<string>): string {
    if (!part.endsWith(')')) return part;
    const open = part.lastIndexOf('(');
    if (open === -1) return part;
    const inner = part.slice(open + 1, -1);
    if (inner.includes(')')) return part;
    return noise.has(squash(inner)) ? part.slice(0, open).trimEnd() : part;
}

// Claude titles a pane from its first prompt, so a Firstmate doorbell
// (`Firstmate operational input waiting: …`) titles every lead
// `Firstmate operational inbox message`: the doorbell, not the work.
function isDoorbellTitle(value: string): boolean {
    const key = squash(value);
    return key.startsWith('firstmate') && (key.includes('inbox') || key.includes('operational') || key.includes('instruction'));
}

function meaningful(value: string | null | undefined, noise: ReadonlySet<string>): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    // A shell prompt or a path: where the program sits, not what it does.
    if (isPromptOrPath(trimmed) || isDoorbellTitle(trimmed)) return undefined;
    const unmarked = stripLeadingMarks(trimmed);
    const parts = splitParts(unmarked);
    const kept = parts
        .map((part) => stripNoisySuffix(part, noise).trim())
        .filter((part) => {
            const key = squash(part);
            return key.length > 1 && !noise.has(key);
        });
    if (kept.length === 0) return undefined;
    return kept.length === parts.length && kept.every((part, index) => part === parts[index]) ? unmarked : kept.join(' - ');
}

// `user@host:` prefixes and leading `/` or `~` paths name the machine, not
// the work. Linear scan: the flagged `^[^\s@]+@[^\s:]+:` repetition is two
// `indexOf` lookups with whitespace checks on the slices between them.
function isPromptOrPath(trimmed: string): boolean {
    if (trimmed.startsWith('/') || trimmed.startsWith('~')) return true;
    const at = trimmed.indexOf('@');
    if (at <= 0) return false;
    for (const ch of trimmed.slice(0, at)) {
        if (isSpaceChar(ch)) return false;
    }
    const rest = trimmed.slice(at + 1);
    const colon = rest.indexOf(':');
    if (colon <= 0) return false;
    for (const ch of rest.slice(0, colon)) {
        if (isSpaceChar(ch)) return false;
    }
    return true;
}

const PART_SEPARATORS = new Set(['-', '\u2013', '\u2014', '|', '\u00b7']);

// `Fix login - pi` splits around `<spaces><dash><spaces>`. Linear scan: the
// flagged `\s+[-\u2013\u2014|\u00b7]\s+` repetition is one pass that only
// splits on a separator with an unconsumed whitespace run on both sides.
function splitParts(value: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let i = 0;
    while (i < value.length) {
        const ch = value[i];
        if (ch !== undefined && PART_SEPARATORS.has(ch)) {
            let s = i - 1;
            while (s >= start && isSpaceChar(value[s] as string)) s -= 1;
            if (s < i - 1) {
                let e = i + 1;
                while (e < value.length && isSpaceChar(value[e] as string)) e += 1;
                if (e > i + 1) {
                    parts.push(value.slice(start, s + 1));
                    start = e;
                    i = e;
                    continue;
                }
            }
        }
        i += 1;
    }
    parts.push(value.slice(start));
    return parts;
}

// The last non-empty `/`-separated segment. Linear split-and-scan instead of
// the flagged `/\/+$/` repetition.
function folderName(cwd: string | null | undefined): string | undefined {
    if (!cwd) return undefined;
    const parts = cwd.split('/');
    for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i] !== '') return parts[i];
    }
    return undefined;
}

/**
 * A Herdr handle in words for a title: `firstmate-addons` reads `Firstmate
 * addons`, and a Firstmate lane's `fm-` prefix goes (`fm-crewhouse` reads
 * `Crewhouse`). Anything that is not a lowercase handle stays as written.
 */
export function labelWords(label: string): string {
    const parts = label.split(/[-_]/);
    if (!parts.every((part) => /^[a-z0-9]+$/.test(part))) return label;
    const words = (parts.length > 1 && parts[0] === 'fm' ? parts.slice(1) : parts).join(' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export function agentTask(sources: AgentTaskSources): string | undefined {
    const folder = folderName(sources.cwd);
    const noise = new Set([...PROGRAM_NAMES, ...[folder, sources.agentName, sources.agentKind].flatMap((value) => value ? [squash(value)] : [])]);
    // A bare number is Herdr's default tab label: it names no work.
    const tabLabel = sources.tabLabel?.trim();
    return meaningful(sources.title, noise)
        ?? (tabLabel && !/^\d+$/.test(tabLabel) ? labelWords(tabLabel) : undefined)
        ?? meaningful(sources.label, noise)
        ?? meaningful(sources.terminalTitle, noise)
        ?? meaningful(sources.workspaceLabel, noise);
}

/**
 * A lifecycle alert's title: who needs you, then their work, in 120 characters.
 * The name leads because a phone's shade cuts a long title from the end.
 * Host push and phone alert share it.
 */
export function agentAlertTitle(event: { taskTitle?: string | undefined; agentName: string; agentKind?: string | undefined }): string {
    const task = agentTask({ title: event.taskTitle, agentName: event.agentName, agentKind: event.agentKind });
    const title = task === undefined ? event.agentName : `${event.agentName} · ${task}`;
    return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}
