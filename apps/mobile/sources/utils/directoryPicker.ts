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
