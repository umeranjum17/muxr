const AGENT_KINDS_WITHOUT_SCREEN_MANIFESTS = ['omp', 'mastracode'] as const;

export function agentKindsFromManifests(manifests: readonly { agent?: string }[]): string[] {
    return [...new Set([
        ...AGENT_KINDS_WITHOUT_SCREEN_MANIFESTS,
        ...manifests
            .map((manifest) => manifest.agent?.trim())
            .filter((agent): agent is string => agent !== undefined && /^[a-z][a-z0-9_-]{0,31}$/.test(agent)),
    ])].slice(0, 64);
}
