/** Rank human labels, keeping exact matches and genuine ambiguity intact. */
export function spokenMatches<T>(query: string, entries: readonly T[], labels: (entry: T) => readonly string[]): T[] {
    const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('und')
        .replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const needle = normalize(query);
    if (!needle || /[\/\\]/.test(query)) return [];
    const candidates = entries.map((entry) => ({ entry, labels: labels(entry).map(normalize).filter(Boolean) }));
    const exact = candidates.filter((candidate) => candidate.labels.includes(needle));
    if (exact.length) return exact.map((candidate) => candidate.entry);
    const words = needle.split(/\s+/);
    const partial = candidates.filter((candidate) => candidate.labels.some((label) =>
        words.every((word) => label.split(/\s+/).some((token) => token === word || word.length >= 3 && token.startsWith(word)))));
    if (partial.length) return partial.map((candidate) => candidate.entry);
    if (needle.length < 3) return [];
    const distance = (left: string, right: string): number => {
        let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
        for (let i = 0; i < left.length; i++) {
            const next = [i + 1];
            for (let j = 0; j < right.length; j++) {
                next.push(Math.min(next[j]! + 1, previous[j + 1]! + 1, previous[j]! + Number(left[i] !== right[j])));
            }
            previous = next;
        }
        return previous[right.length]!;
    };
    const rank = (tokens: boolean) => candidates.map((candidate) => ({
        ...candidate,
        score: Math.max(0, ...(tokens ? candidate.labels.flatMap((label) => label.split(/\s+/)) : candidate.labels)
            .map((label) => 1 - distance(needle, label) / Math.max(needle.length, label.length))),
    })).filter((candidate) => candidate.score >= 0.75).sort((left, right) => right.score - left.score);
    const whole = rank(false);
    const ranked = whole.length ? whole : rank(true);
    return ranked.filter((candidate) => ranked[0]!.score - candidate.score < 0.15).map((candidate) => candidate.entry);
}
