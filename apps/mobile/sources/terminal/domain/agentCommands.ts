/**
 * Per-agent slash catalogue. Each harness speaks its own commands, so entries
 * are scoped to the agent kind and never shown to another harness; an unknown
 * kind falls back to an empty list and the caller offers a custom-command row.
 *
 * Kept hardcoded here rather than in the host muxr config: this is phone-side
 * presentation data and the palette must work offline with no host round-trip.
 *
 * Sources (checked 2026-09-17): Claude Code `code.claude.com/docs/commands`,
 * Codex CLI `developers.openai.com/codex/cli/slash-commands`, pi's bundled
 * `docs/usage.md` slash table, opencode `opencode.ai/docs/tui`.
 *
 * `common` surfaces first on a phone; `dangerous` moves the row into a
 * separated destructive section behind a two-tap confirm, whose context-loss
 * sentence is skipped for `reversible` entries.
 */
export type AgentCommand = {
    command: string;
    description: string;
    arguments?: string;
    common?: boolean;
    dangerous?: boolean;
    reversible?: boolean;
};

const COMMANDS: Record<string, readonly AgentCommand[]> = {
    claude: [
        { command: '/compact', description: 'Summarize the conversation', arguments: '[focus]', common: true },
        { command: '/model', description: 'Select or change the model', arguments: '[model]', common: true },
        { command: '/status', description: 'Version, model, account, connectivity', common: true },
        { command: '/clear', description: 'Start fresh; the old conversation stays in /resume', dangerous: true },
        { command: '/rewind', description: 'Restore code and conversation to a checkpoint', dangerous: true },
        { command: '/cost', description: 'Token usage and cost' },
        { command: '/help', description: 'Show all commands' },
        { command: '/init', description: 'Scaffold a CLAUDE.md for this project' },
        { command: '/memory', description: 'Refine project memory' },
        { command: '/permissions', description: 'View or update tool permissions' },
        { command: '/resume', description: 'Continue a previous session', arguments: '[session]' },
        { command: '/agents', description: 'Guidance for managing subagents' },
        { command: '/mcp', description: 'Manage MCP servers' },
        { command: '/doctor', description: 'Diagnose the installation' },
    ],
    codex: [
        { command: '/compact', description: 'Summarize the conversation', common: true },
        { command: '/model', description: 'Choose model and reasoning effort', common: true },
        { command: '/review', description: 'Review the working tree', arguments: '[instructions]', common: true },
        { command: '/diff', description: 'Show the git diff, including untracked files', common: true },
        { command: '/new', description: 'Start fresh in the same session, dropping this context', dangerous: true },
        { command: '/status', description: 'Show session configuration and usage' },
        { command: '/init', description: 'Scaffold an AGENTS.md for this directory' },
        { command: '/mention', description: 'Attach a file or folder to the conversation', arguments: '[path]' },
        { command: '/approve', description: 'Approve one retry of a denied command' },
        { command: '/skills', description: 'Browse and use skills' },
        { command: '/theme', description: 'Preview and save a theme' },
    ],
    pi: [
        { command: '/compact', description: 'Compact context', arguments: '[prompt]', common: true },
        { command: '/model', description: 'Switch models', arguments: '[search]', common: true },
        { command: '/new', description: 'Start a new session, leaving this one behind', dangerous: true },
        { command: '/resume', description: 'Pick from previous sessions' },
        { command: '/session', description: 'Show session file, messages, tokens, cost' },
        { command: '/thinking', description: 'Switch thinking level' },
        { command: '/settings', description: 'Theme, delivery, transport, preferences' },
        { command: '/hotkeys', description: 'Show keyboard shortcuts' },
        { command: '/share', description: 'Upload as a private gist with shareable link' },
        { command: '/export', description: 'Export session to HTML or JSONL', arguments: '[file]' },
    ],
    opencode: [
        { command: '/compact', description: 'Summarize the current session', common: true },
        { command: '/models', description: 'List available models', common: true },
        { command: '/sessions', description: 'List and switch sessions', common: true },
        { command: '/new', description: 'Start a new session, dropping this one', dangerous: true },
        { command: '/undo', description: 'Undo the last message and its changes', dangerous: true, reversible: true },
        { command: '/redo', description: 'Redo an undone message' },
        { command: '/help', description: 'Show OpenCode commands' },
        { command: '/init', description: 'Scaffold agent instructions for this project' },
        { command: '/share', description: 'Share the current session' },
        { command: '/themes', description: 'List available themes' },
    ],
};

export function agentCommands(kind: string | undefined): readonly AgentCommand[] {
    return kind === undefined ? [] : COMMANDS[kind.toLowerCase()] ?? [];
}

/**
 * The catalogue entry `text` is, when the agent marks that command destructive.
 * Whether a command asks before sending is a property of the command, not of
 * where the person wrote it down, so both the catalogue rows and the person's
 * own actions answer it here.
 */
export function destructiveCommand(kind: string | undefined, text: string): AgentCommand | undefined {
    const command = text.trim();
    return agentCommands(kind).find((entry) => entry.dangerous === true && entry.command === command);
}
