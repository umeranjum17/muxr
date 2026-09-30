import { existsSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_ENTRIES = 500;

/**
 * Directory listing for the mobile cwd picker. Same trust boundary as
 * machine.shell: the host runs as the user, so this only exposes what the
 * user can already see in their own terminal.
 */
export async function listDir(
    rawPath?: string,
): Promise<{
    path: string;
    parent: string | null;
    exists: boolean;
    entries: { name: string; repo: boolean }[];
}> {
    const home = homedir();
    // Default is home; expand a leading ~; everything else resolves against the host cwd.
    const requested = rawPath === undefined || rawPath === '' ? home : rawPath.replace(/^~(?=\/|$)/, home);
    const target = resolve(requested);
    const parent = dirname(target) === target ? null : dirname(target);

    let stats;
    try {
        stats = await stat(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { path: target, parent, exists: false, entries: [] };
        }
        throw error;
    }
    if (!stats.isDirectory()) {
        return { path: target, parent, exists: false, entries: [] };
    }

    const dirents = await readdir(target, { withFileTypes: true });
    // Dot-dirs hide unless the requested path's last segment starts with '.',
    // matching shell completion (typing `/.` reveals hidden entries).
    const lastSegment = (rawPath ?? '').split('/').filter(Boolean).pop() ?? '';
    const showDotDirs = lastSegment.startsWith('.');
    // A symlinked folder (macOS /tmp, /var, a ~/code link) is still a place to work.
    const isFolder = async (entry: Dirent) => entry.isDirectory()
        || (entry.isSymbolicLink() && (await stat(join(target, entry.name)).catch(() => undefined))?.isDirectory() === true);
    const visible = dirents.filter((entry) => showDotDirs || !entry.name.startsWith('.'));
    const folders = await Promise.all(visible.map(isFolder));
    const entries = visible
        .filter((_, index) => folders[index])
        .map((entry) => ({
            name: entry.name,
            // Worktrees keep a `.git` file; plain repos a `.git` directory.
            repo: existsSync(join(target, entry.name, '.git')),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_ENTRIES);

    return { path: target, parent, exists: true, entries };
}
