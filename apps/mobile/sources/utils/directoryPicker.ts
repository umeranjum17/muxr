/**
 * Shell-completion-style browser target for the directory picker.
 * A trailing slash lists that directory; otherwise list its dirname and
 * prefix-filter rows by the basename. An empty (or bare relative) input
 * lists the host home directory.
 */
export function resolveListingTarget(typed: string): { listPath: string; prefix: string } {
    if (typed.endsWith('/')) return { listPath: typed, prefix: '' };
    const slash = typed.lastIndexOf('/');
    if (slash === -1) return { listPath: '', prefix: typed };
    return { listPath: typed.slice(0, slash + 1), prefix: typed.slice(slash + 1) };
}

export function basename(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
}

/** One folder, however it was written: `/a/b` and `/a/b/` are the same choice. */
export function folderKey(path: string): string {
    return path.replace(/\/+$/, '') || '/';
}

/** Open workspaces first, then recent folders, each folder once. */
export function wherePlaces(open: readonly (string | undefined)[], recent: readonly string[]): { path: string; note?: string }[] {
    const places: { path: string; note?: string }[] = [];
    const seen = new Set<string>();
    const add = (path: string, note?: string) => {
        if (seen.has(folderKey(path))) return;
        seen.add(folderKey(path));
        places.push(note === undefined ? { path } : { path, note });
    };
    for (const path of open) if (path !== undefined) add(path, 'Open');
    for (const path of recent) add(path);
    return places;
}
