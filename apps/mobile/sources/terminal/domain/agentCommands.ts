/** Built-in interactive commands only. The live Herdr kind is the sole selector. */
export type AgentCommand = { command: string; description: string; arguments?: string };

const COMMANDS: Record<string, readonly AgentCommand[]> = {
    claude: [
        { command: '/help', description: 'Show Claude Code commands', arguments: '[topic]' },
        { command: '/model', description: 'Choose the active model', arguments: '[model]' },
        { command: '/compact', description: 'Summarize the conversation', arguments: '[instructions]' },
        { command: '/permissions', description: 'Review tool permissions' },
    ],
    codex: [
        { command: '/model', description: 'Choose model and reasoning effort', arguments: '[model]' },
        { command: '/status', description: 'Show session configuration and usage' },
        { command: '/review', description: 'Review the working tree', arguments: '[instructions]' },
        { command: '/skills', description: 'Browse available skills' },
    ],
    pi: [
        { command: '/model', description: 'Switch models', arguments: '[search]' },
        { command: '/compact', description: 'Compact context', arguments: '[instructions]' },
        { command: '/settings', description: 'Open session settings' },
        { command: '/hotkeys', description: 'Show keyboard shortcuts' },
    ],
    opencode: [
        { command: '/help', description: 'Show OpenCode commands' },
        { command: '/models', description: 'Choose an available model' },
        { command: '/sessions', description: 'Switch sessions' },
        { command: '/compact', description: 'Summarize the conversation' },
    ],
};

export function agentCommands(kind: string | undefined): readonly AgentCommand[] {
    return kind === undefined ? [] : COMMANDS[kind.toLowerCase()] ?? [];
}
