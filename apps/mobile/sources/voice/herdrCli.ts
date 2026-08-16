const DESTRUCTIVE = [
    'server stop',
    'session stop',
    'session delete',
    'workspace close',
    'worktree remove',
    'tab close',
    'pane close',
    'integration install',
    'integration uninstall',
    'plugin install',
    'plugin uninstall',
    'plugin link',
    'plugin unlink',
    'plugin enable',
    'plugin disable',
    'plugin action invoke',
    'plugin pane close',
    'pane run',
    'pane send-text',
    'pane send-keys',
    'agent send-keys',
    'channel set',
    'config reset-keys',
    'update',
];

/** Structural/direct-input commands the realtime model must confirm by name. */
export function requiresHerdrConfirmation(args: string[]): boolean {
    const flagsWithValues = new Set(['--session', '--remote', '--remote-keybindings']);
    let start = 0;
    while (args[start]?.startsWith('-') === true) {
        start += flagsWithValues.has(args[start]!.toLowerCase()) ? 2 : 1;
    }
    const command = args.slice(start, start + 3).join(' ').toLowerCase();
    return DESTRUCTIVE.some((candidate) => command === candidate || command.startsWith(`${candidate} `));
}
