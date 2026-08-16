export interface SessionFileCacheEntry {
    content: string | null;
    diff: string | null;
    isBinary: boolean;
    cachedAt: number;
}

export const MAX_SESSION_FILE_CACHE_ENTRIES = 12;
export const MAX_SESSION_FILE_CACHE_BYTES = 12 * 1024 * 1024;

function entryBytes(entry: SessionFileCacheEntry): number {
    return (entry.content === null ? 0 : entry.content.length) + (entry.diff === null ? 0 : entry.diff.length);
}

/** Keep the just-opened file and evict oldest reviewed files under both caps. */
export function boundSessionFileCache(
    entries: Record<string, SessionFileCacheEntry>,
    justOpenedPath: string,
    justOpened: SessionFileCacheEntry,
): Record<string, SessionFileCacheEntry> {
    const next = { ...entries, [justOpenedPath]: justOpened };
    const order = () => Object.entries(next).sort((a, b) => (
        b[1].cachedAt - a[1].cachedAt
        || (a[0] === justOpenedPath ? -1 : b[0] === justOpenedPath ? 1 : a[0].localeCompare(b[0]))
    ));
    const oldestOther = (): string | undefined => [...order()].reverse().find(([path]) => path !== justOpenedPath)?.[0];
    const removeOldest = (): boolean => {
        const path = oldestOther();
        if (path === undefined) return false;
        delete next[path];
        return true;
    };
    while (Object.keys(next).length > MAX_SESSION_FILE_CACHE_ENTRIES && removeOldest()) {}
    const bytes = () => Object.values(next).reduce((sum, entry) => sum + entryBytes(entry), 0);
    while (bytes() > MAX_SESSION_FILE_CACHE_BYTES && removeOldest()) {}
    return next;
}
