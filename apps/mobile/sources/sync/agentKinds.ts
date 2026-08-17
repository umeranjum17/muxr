/** Safe offline fallback. Connected screens replace this with the bounded
 * catalog reported by the current Herdr host. Persistence keeps the superset so
 * an existing session remains readable while the host is offline. */
export const FALLBACK_AGENT_KINDS = [
    'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
    'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok',
    'hermes', 'kilo', 'qodercli', 'maki',
] as const;
export const AGENT_KINDS = FALLBACK_AGENT_KINDS;
