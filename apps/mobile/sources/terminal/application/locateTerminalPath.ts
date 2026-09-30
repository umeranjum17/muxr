import { filesList, filesRead, filesRepos, sessionReadFile } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { terminalPathCandidates } from '../domain/safeTerminalLink';

/** A tapped path as the host knows it. `repo` is set when the path sits in a
 *  repository open in some session, the only places the Files view browses. */
export interface TerminalPathTarget {
    kind: 'folder' | 'file';
    path: string;
    repo?: { root: string; relative: string };
}

/**
 * Where a path tapped in a terminal points on the host. The host expands `~`
 * (machine.listDir reads from home); a relative path is read from the pane's
 * working directory, never the host process's. Candidates are tried longest
 * first (see terminalPathCandidates). When none exists the longest comes back
 * as a file, so Files or the file viewer shows its own not-found state.
 * Null when a relative path has no working directory to read it from.
 */
export async function locateTerminalPath(
    raw: string,
    input: { sessionId: string; cwd?: string | null; observe?: boolean },
): Promise<TerminalPathTarget | null> {
    const cwd = input.cwd?.replace(/\/+$/, '');
    const hostPaths = terminalPathCandidates(raw).flatMap((candidate) => {
        if (/^\$HOME(?=\/|$)/.test(candidate)) return [`~${candidate.slice(5)}`];
        if (/^\$[A-Za-z_][A-Za-z0-9_]*(?:\/|$)/.test(candidate)) return [];
        if (/^[/~]/.test(candidate)) return [candidate];
        return cwd ? [`${cwd}/${candidate}`] : [];
    });
    if (hostPaths.length === 0) return null;
    const repositories = input.observe
        ? await filesRepos()
        : await filesRepos().catch(() => ({ repos: [] }));
    const roots = repositories.repos.map((repo) => repo.root);
    const repoOf = (path: string): TerminalPathTarget['repo'] => {
        const root = roots
            .filter((candidate) => path === candidate || path.startsWith(`${candidate}/`))
            .sort((a, b) => b.length - a.length)[0];
        return root === undefined ? undefined : { root, relative: path.slice(root.length + 1) };
    };
    const target = (kind: TerminalPathTarget['kind'], path: string): TerminalPathTarget => {
        const repo = repoOf(path);
        return repo === undefined ? { kind, path } : { kind, path, repo };
    };
    if (input.observe) {
        const home = cwd?.match(/^(\/(?:Users|home)\/[^/]+)/)?.[1];
        for (const hostPath of hostPaths) {
            const absolutePath = hostPath.startsWith('~/') && home
                ? `${home}/${hostPath.slice(2)}`
                : hostPath;
            const repo = repoOf(absolutePath);
            if (repo === undefined) continue;
            let isFile = true;
            try {
                await filesRead(input.sessionId, { root: repo.root, path: repo.relative });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message !== 'file unavailable' && message !== 'outside repository') throw error;
                isFile = false;
            }
            if (isFile) {
                return target('file', absolutePath);
            }
            const parent = repo.relative.split('/').slice(0, -1).join('/');
            const name = repo.relative.split('/').pop();
            const listing = await filesList(input.sessionId, { root: repo.root, ...(parent === '' ? {} : { path: parent }) });
            if (repo.relative === '' || repo.relative === '.'
                || listing.tree.some((node) => node.name === name && node.kind === 'folder')) {
                return target('folder', absolutePath);
            }
        }
        return null;
    }
    let longest: string | undefined;
    for (const hostPath of hostPaths) {
        const listing = await sync.request('machine.listDir', { path: hostPath });
        longest ??= listing.path;
        if (listing.exists) return target('folder', listing.path);
        const repo = repoOf(listing.path);
        const isFile = repo === undefined
            ? (await sessionReadFile(input.sessionId, listing.path)).success
            : await filesRead(input.sessionId, { root: repo.root, path: repo.relative }).then(() => true, () => false);
        if (isFile) return target('file', listing.path);
    }
    return longest === undefined ? null : target('file', longest);
}
