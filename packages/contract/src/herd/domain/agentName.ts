/**
 * The name an unnamed agent reads as. Host and phone both call `derivedAgentName`,
 * so the agent never has one name on the machine and another on the phone.
 *
 * Order, first meaningful one wins:
 * 1. the Agent Name Herdr published;
 * 2. the Agent Kind's own label (Claude, Codex, OpenCode) — Herdr publishes the
 *    kind long before it ever publishes a name;
 * 3. the folder the pane runs in;
 * 4. `Agent`.
 *
 * A pane with no kind is a plain shell, not a nameless agent; screens that draw
 * that row still say `Shell` themselves. This only names the agent.
 */

const AGENT_KIND_LABELS: Readonly<Record<string, string>> = {
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    pi: 'Pi',
};

/** A kind's human label, or undefined when there is none to show. */
export function agentKindLabel(kind?: string | null): string | undefined {
    const value = kind?.trim();
    if (value === undefined || value === '') return undefined;
    return AGENT_KIND_LABELS[value.toLowerCase()] ?? value;
}

/** The last path segment of a cwd: the folder a pane runs in. */
export function agentFolderName(cwd?: string | null): string | undefined {
    const parts = cwd?.replace(/\/+$/, '').split('/');
    const last = parts?.pop();
    return last !== undefined && last !== '' ? last : undefined;
}

export interface AgentNameSources {
    agentName?: string | null | undefined;
    agentKind?: string | null | undefined;
    cwd?: string | null | undefined;
}

/** The name to show for an agent: its published name, else its kind, else its folder, else `Agent`. */
export function derivedAgentName(sources?: AgentNameSources): string {
    const named = sources?.agentName?.trim();
    if (named !== undefined && named !== '') return named;
    return agentKindLabel(sources?.agentKind) ?? agentFolderName(sources?.cwd) ?? 'Agent';
}
