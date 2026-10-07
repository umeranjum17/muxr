import { filesList, filesRead, filesRepos, sessionReadFile } from '@/catalog/ops';
import { sync } from '@/catalog/sync';
import { isMissingFileError } from '@/utils/errors';
import { terminalPathCandidates } from '../domain/safeTerminalLink';

/** A tapped path as the host knows it. `repo` is set when the path sits in a
 *  repository open in some session; without it the path is a user-named
 *  folder or file on the computer, which Files opens as exactly that. */
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
/** A tapped path with cosmetic trailing slashes removed. The filesystem
 *  root survives: '/' stays '/', never the empty string that would fall
 *  back to the session repository. Both the resolver below and the Files
 *  route normalise through here, so a root means the same thing on both
 *  sides. */
export function trimmedTapPath(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed === '' ? '/' : trimmed;
}

/** The parent folder and entry name a user-named absolute path verifies
 *  against: Files lists the parent from the filesystem and reads the entry
 *  inside it. Undefined for paths with no parent to ask about. */
function namedDirTarget(absolutePath: string): { dir: string; base: string } | undefined {
    const trimmed = trimmedTapPath(absolutePath);
    if (!trimmed.startsWith('/')) return undefined;
    if (trimmed === '/') return { dir: '/', base: '' };
    const slash = trimmed.lastIndexOf('/');
    return { dir: slash <= 0 ? '/' : trimmed.slice(0, slash), base: trimmed.slice(slash + 1) };
}

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
        let longest: string | undefined;
        for (const hostPath of hostPaths) {
            const absolutePath = hostPath.startsWith('~/') && home
                ? `${home}/${hostPath.slice(2)}`
                : hostPath;
            longest ??= absolutePath;
            const repo = repoOf(absolutePath);
            if (repo !== undefined) {
                let isFile = true;
                try {
                    await filesRead(input.sessionId, { root: repo.root, path: repo.relative });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    // Gone (a missing file or a missing folder root) is not
                    // a file; anything else is a real failure to surface.
                    if (!isMissingFileError(message) && message !== 'outside repository') throw error;
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
                continue;
            }
            // Outside every open repository the path is still openable when
            // the user named it: verify the parent folder on the host, which
            // lists from the filesystem (empty and ignored entries included).
            const named = namedDirTarget(absolutePath);
            if (named === undefined) continue;
            try {
                await filesRead(input.sessionId, { root: named.dir, path: named.base });
                return target('file', absolutePath);
            } catch {
                // Not a readable file: it may be a folder instead.
            }
            try {
                await filesList(input.sessionId, { root: named.dir, path: named.base });
                return target('folder', absolutePath);
            } catch {
                // Unverifiable here; the next candidate may still name it.
            }
        }
        // Nothing verified, but the tap named a file: like control mode,
        // the longest comes back as a file so Files shows its designed
        // missing state. Null is only for taps with no path at all.
        return longest === undefined ? null : target('file', longest);
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
