/** Safe offline fallback. Connected screens replace this with the bounded
 * catalog reported by the current Herdr host. Persistence keeps the superset so
 * an existing session remains readable while the host is offline. */
export const FALLBACK_AGENT_KINDS = [
    'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
    'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok',
    'hermes', 'kilo', 'qodercli', 'maki',
] as const;
export const AGENT_KINDS = FALLBACK_AGENT_KINDS;

export type AgentAvailability = 'installed' | 'unavailable' | 'unknown';
export type AgentCatalogOption = { kind: string; availability: AgentAvailability };

export function resolveAgentCatalog(result: { kinds?: string[]; installed?: string[] }): {
    options: AgentCatalogOption[];
    authoritative: boolean;
} {
    const kinds = [...new Set((result.kinds ?? []).filter((kind) => /^[a-z][a-z0-9_-]{0,31}$/.test(kind)))].slice(0, 64);
    if (kinds.length === 0) {
        return {
            options: FALLBACK_AGENT_KINDS.map((kind) => ({ kind, availability: 'unknown' })),
            authoritative: false,
        };
    }
    if (!Array.isArray(result.installed)) {
        return { options: kinds.map((kind) => ({ kind, availability: 'unknown' })), authoritative: false };
    }
    const installed = new Set(result.installed.filter((kind) => kinds.includes(kind)));
    // A non-empty manifest catalog with zero executable hits is usually a
    // stripped daemon PATH, not authoritative proof that every agent vanished.
    // Preserve the host's bounded catalog as unknown until at least one probe
    // succeeds instead of collapsing the composer to Shell and overwriting the
    // user's saved choice.
    if (installed.size === 0) {
        return { options: kinds.map((kind) => ({ kind, availability: 'unknown' })), authoritative: false };
    }
    return {
        options: kinds.map((kind): AgentCatalogOption => ({
            kind,
            availability: installed.has(kind) ? 'installed' : 'unavailable',
        })).sort((left, right) => Number(right.availability === 'installed') - Number(left.availability === 'installed')
            || left.kind.localeCompare(right.kind)),
        authoritative: true,
    };
}
