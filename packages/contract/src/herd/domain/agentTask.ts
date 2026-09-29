/**
 * What an agent is working on, from what Herdr supplies. Host and phone both
 * call this, so a row, the terminal header and a notification say the same thing.
 *
 * Sources, first meaningful one wins:
 * 1. the pane label: a rename, or the agent's own `muxr name --pane`;
 * 2. the harness's own window title (Claude keeps its session topic there);
 * 3. Herdr title metadata, from a naming plugin;
 * 4. the task workspace's label, when that workspace holds only this agent.
 *
 * A source says nothing about the work when all it leaves is the folder or repo
 * name (`π - pockit`, a plugin's `Pockit` fallback), the program's or agent's
 * own name, a state word (`Ready`), or a shell prompt or path. Leading with those made every agent in
 * one repo read the same, so they never count.
 */
export interface AgentTaskSources {
    label?: string | null | undefined;
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

function squash(value: string): string {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Leading spinners and marks a harness puts in front (`✳`, `⠋`). Linear
// scan: the flagged `^[^...]+` repetition is equivalent to skipping chars.
function stripLeadingMarks(value: string): string {
    let i = 0;
    // By code point: a lone UTF-16 half never tests as a letter or number.
    for (const ch of value) {
        if (ch === '#' || ch === '(' || ch === '[' || ch === '"' || ch === "'" || ch === '\u201c' || /[\p{L}\p{N}]/u.test(ch)) break;
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

function meaningful(value: string | null | undefined, noise: ReadonlySet<string>): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    // A shell prompt or a path: where the program sits, not what it does.
    if (/^[^\s@]+@[^\s:]+:/.test(trimmed) || /^[~/]/.test(trimmed)) return undefined;
    const unmarked = stripLeadingMarks(trimmed);
    const parts = unmarked.split(/\s+[-–—|·]\s+/);
    const kept = parts
        .map((part) => stripNoisySuffix(part, noise).trim())
        .filter((part) => {
            const key = squash(part);
            return key.length > 1 && !noise.has(key);
        });
    if (kept.length === 0) return undefined;
    return kept.length === parts.length && kept.every((part, index) => part === parts[index]) ? unmarked : kept.join(' - ');
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

export function agentTask(sources: AgentTaskSources): string | undefined {
    const folder = folderName(sources.cwd);
    const noise = new Set([...PROGRAM_NAMES, ...[folder, sources.agentName, sources.agentKind].flatMap((value) => value ? [squash(value)] : [])]);
    return meaningful(sources.label, noise)
        ?? meaningful(sources.terminalTitle, noise)
        ?? meaningful(sources.title, noise)
        ?? meaningful(sources.workspaceLabel, noise);
}
