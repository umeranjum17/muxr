import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listDir } from './listDir.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Two plain dirs, a .git-dir repo, a .git-file worktree, a hidden dir, and a file. */
async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'muxr-listdir-'));
    roots.push(root);
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'zeta'));
    await mkdir(join(root, 'alpharepo'));
    await mkdir(join(root, 'alpharepo', '.git'));
    await mkdir(join(root, 'zetawt'));
    await writeFile(join(root, 'zetawt', '.git'), 'gitdir: ../../.git/worktrees/zeta\n');
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'notes.txt'), 'x');
    return root;
}

describe('listDir', () => {
    it('lists directories only, alpha-sorted, dot-dirs hidden, repo flagged', async () => {
        const root = await fixture();

        const result = await listDir(root);

        expect(result.exists).toBe(true);
        expect(result.path).toBe(root);
        expect(result.parent).toBe(dirname(root));
        expect(result.entries).toEqual([
            { name: 'alpha', repo: false },
            { name: 'alpharepo', repo: true }, // .git directory
            { name: 'zeta', repo: false },
            { name: 'zetawt', repo: true }, // .git file (worktree)
        ]);
    });

    it('shows dot-dirs when the requested path last segment starts with a dot', async () => {
        const root = await fixture();

        const result = await listDir(`${root}/.`);

        expect(result.exists).toBe(true);
        expect(result.entries.some((entry) => entry.name === '.hidden')).toBe(true);
    });

    it('reports exists=false for a file and a missing path, parent still filled', async () => {
        const root = await fixture();

        const asFile = await listDir(join(root, 'notes.txt'));
        expect(asFile).toEqual({ path: join(root, 'notes.txt'), parent: root, exists: false, entries: [] });

        const missing = await listDir(join(root, 'nope'));
        expect(missing).toEqual({ path: join(root, 'nope'), parent: root, exists: false, entries: [] });
    });

    it('defaults to home when no path is given', async () => {
        const result = await listDir(undefined);
        expect(result.exists).toBe(true);
        expect(result.path).toBe(homedir());
    });
});
