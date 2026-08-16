export interface ModelMode {
    key: string;
    name: string;
    description?: string;
    disabled?: boolean;
    contextWindow?: number;
    providerName?: string;
    providerKind?: string;
}

export const ALL_PROVIDERS = '__all__';

// Only a real provider name groups the rail: permission modes carry prose in
// `description`, which would otherwise become one rail entry per option.
export function providerOf(model: ModelMode): string {
    return model.providerName ?? 'other';
}

export function groupByProvider(models: ModelMode[]): Array<{ name: string; count: number; kind?: string }> {
    const tally = new Map<string, { count: number; kind?: string }>();
    for (const model of models) {
        const name = providerOf(model);
        const entry = tally.get(name);
        if (entry) entry.count += 1;
        else tally.set(name, { count: 1, kind: model.providerKind });
    }
    return [...tally.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, entry]) => ({ name, count: entry.count, kind: entry.kind }));
}

// Substring per token, never subsequence: a fuzzy match makes "kimi" return Claude.
// Returns -1 when any token misses; higher scores are better matches.
function scoreOption(model: ModelMode, tokens: string[]): number {
    const name = model.name.toLowerCase();
    const tail = name.slice(name.lastIndexOf('/') + 1);
    const haystack = `${name} ${(model.description ?? '').toLowerCase()}`;
    let score = 0;
    for (const token of tokens) {
        const at = name.indexOf(token);
        if (at < 0) {
            if (!haystack.includes(token)) return -1;
            score += 1;
        } else if (tail.startsWith(token)) score += 8;
        else if (at === 0) score += 6;
        else if (/[\s/\-_.:]/.test(name[at - 1] ?? '')) score += 4;
        else score += 2;
    }
    return score;
}

export function filterModels(
    models: ModelMode[],
    provider: string,
    search: string,
): ModelMode[] {
    const scoped = provider === ALL_PROVIDERS
        ? models
        : models.filter((model) => providerOf(model) === provider);
    const needle = search.trim().toLowerCase();
    if (!needle) {
        return scoped;
    }
    // Every space-separated token has to hit, so "v1 engine" finds ~/Projects/v1-design-engine.
    const tokens = needle.split(/\s+/);
    return scoped
        .map((model, index) => ({ model, index, score: scoreOption(model, tokens) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.model);
}
