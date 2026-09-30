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
export type AgentCatalogOption = {
    kind: string;
    availability: AgentAvailability;
    signedIn?: 'yes' | 'no' | 'unknown';
    installHint?: string;
    signInHint?: string;
};

export function resolveAgentCatalog(result: {
    kinds?: string[];
    installed?: string[];
    readiness?: Record<string, { signedIn: 'yes' | 'no' | 'unknown'; installHint?: string; signInHint?: string }>;
}): { options: AgentCatalogOption[]; authoritative: boolean } {
    const kinds = [...new Set((result.kinds ?? []).filter((kind) => /^[a-z][a-z0-9_-]{0,31}$/.test(kind)))].slice(0, 64);
    const authoritative = Array.isArray(result.installed);
    const installed = new Set(result.installed ?? []);
    const catalog = kinds.length > 0 ? kinds : [...FALLBACK_AGENT_KINDS];
    return {
        options: catalog.map((kind): AgentCatalogOption => {
            let availability: AgentAvailability = 'unknown';
            if (authoritative) availability = installed.has(kind) ? 'installed' : 'unavailable';
            return { kind, availability, ...result.readiness?.[kind] };
        }).sort((left, right) => Number(right.availability === 'installed') - Number(left.availability === 'installed')),
        authoritative,
    };
}
