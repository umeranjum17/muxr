/**
 * `herdr agent start --kind` values. One list, so the new-agent screen and the
 * split-with-agent picker cannot drift apart. Mirrors `herdr agent start --help`;
 * kinds the installed herdr doesn't know fail gracefully at start time.
 */
export const AGENT_KINDS = [
    'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
    'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok',
    'hermes', 'kilo', 'qodercli', 'maki',
] as const;
export const COMMON_AGENT_KINDS = AGENT_KINDS;
