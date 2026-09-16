/**
 * Per-agent slash catalogue. Each harness speaks its own commands, so entries
 * are scoped to the agent kind and never shown to another harness; an unknown
 * kind falls back to an empty list and the caller offers a custom-command row.
 *
 * Kept hardcoded here rather than in the host muxr config: this is phone-side
 * presentation data and the palette must work offline with no host round-trip.
 *
 * `common` surfaces first on a phone; `dangerous` moves the row into a
 * separated destructive section behind a two-tap confirm.
 */
export type AgentCommand = {
    command: string;
    description: string;
    arguments?: string;
    common?: boolean;
    dangerous?: boolean;
};

const COMMANDS: Record<string, readonly AgentCommand[]> = {
    claude: [
        { command: '/compact', description: 'Summarize the conversation', arguments: '[instructions]', common: true },
        { command: '/model', description: 'Choose the active model', arguments: '[model]', common: true },
        { command: '/review', description: 'Review the working tree', arguments: '[instructions]', common: true },
        { command: '/status', description: 'Show session status and usage', common: true },
        { command: '/clear', description: 'Wipe conversation context', dangerous: true },
        { command: '/rewind', description: 'Drop messages back to an earlier point', dangerous: true },
        { command: '/help', description: 'Show Claude Code commands', arguments: '[topic]' },
        { command: '/init', description: 'Scaffold a CLAUDE.md for this project' },
        { command: '/memory', description: 'Edit project memory' },
        { command: '/permissions', description: 'Review tool permissions' },
        { command: '/resume', description: 'Continue a previous session', arguments: '[session]' },
        { command: '/agents', description: 'Manage subagents', arguments: '[instructions]' },
        { command: '/mcp', description: 'Manage MCP servers' },
        { command: '/cost', description: 'Show token usage and cost' },
        { command: '/doctor', description: 'Diagnose the installation' },
    ],
    codex: [
        { command: '/compact', description: 'Summarize the conversation', arguments: '[instructions]', common: true },
        { command: '/model', description: 'Choose model and reasoning effort', arguments: '[model]', common: true },
        { command: '/review', description: 'Review the working tree', arguments: '[instructions]', common: true },
        { command: '/diff', description: 'Show the working tree diff', common: true },
        { command: '/new', description: 'Start a fresh session, dropping this one', dangerous: true },
        { command: '/status', description: 'Show session configuration and usage' },
        { command: '/init', description: 'Scaffold agent instructions for this project' },
        { command: '/approvals', description: 'Choose the approval policy', arguments: '[policy]' },
        { command: '/mcp', description: 'Manage MCP servers' },
        { command: '/mention', description: 'Mention a file by path', arguments: '[path]' },
        { command: '/theme', description: 'Change the theme', arguments: '[theme]' },
    ],
    pi: [
        { command: '/compact', description: 'Compact context', arguments: '[instructions]', common: true },
        { command: '/model', description: 'Switch models', arguments: '[search]', common: true },
        { command: '/settings', description: 'Open session settings' },
        { command: '/hotkeys', description: 'Show keyboard shortcuts' },
    ],
    opencode: [
        { command: '/compact', description: 'Summarize the conversation', common: true },
        { command: '/models', description: 'Choose an available model', common: true },
        { command: '/review', description: 'Review the working tree', common: true },
        { command: '/sessions', description: 'Switch sessions', common: true },
        { command: '/new', description: 'Start a fresh session, dropping this one', dangerous: true },
        { command: '/undo', description: 'Revert the last tool changes', dangerous: true },
        { command: '/help', description: 'Show OpenCode commands' },
        { command: '/init', description: 'Scaffold agent instructions for this project' },
        { command: '/share', description: 'Share the current session' },
        { command: '/theme', description: 'Change the theme', arguments: '[theme]' },
    ],
};

export function agentCommands(kind: string | undefined): readonly AgentCommand[] {
    return kind === undefined ? [] : COMMANDS[kind.toLowerCase()] ?? [];
}
