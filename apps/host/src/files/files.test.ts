import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { filesList, filesRead, filesRepos } from './files.js';
import { historyLog, historyShow } from './history.js';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-files-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const repo = join(scratch, 'repo');
mkdirSync(join(repo, 'src', 'nested'), { recursive: true });
writeFileSync(join(repo, 'README.md'), '# fixture\n\nA boring fixture repository.\n');
writeFileSync(join(repo, 'src', 'app.mjs'), 'export const app = true;\n');
writeFileSync(join(repo, 'src', 'nested', 'deep.txt'), 'deep\n');
const git = (args: string[], cwd: string = repo): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, input: '' });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Fixture']);
git(['config', 'user.email', 'fixture@example.invalid']);
git(['add', '.']);
git(['commit', '-qm', 'One']);
writeFileSync(join(repo, 'src', 'app.mjs'), 'export const app = true;\nexport const added = 1;\n');
git(['add', '.']);
git(['commit', '-qm', 'Two']);

const sessionId = 'fixture-session';
const input = { sessionId, cwd: repo, allowedRoots: [repo] };

describe('files tree', () => {
    it('lists every repository open across sessions', () => {
        const found = filesRepos([repo, join(scratch, 'nowhere')]);
        expect(found.title).toBe('1 repositories');
        expect(found.repos).toEqual([{ root: repo, name: 'repo', path: repo }]);
    });

    it('lists the session repository with folders first and bounded notes', () => {
        const listed = filesList({ ...input, root: repo });
        expect(listed.root).toBe(repo);
        expect(listed.title).toBe('repo');
        expect(listed.count).toBe('3 files');
        expect(listed.tree.map((node) => `${node.kind}:${node.name}`)).toEqual(['folder:src', 'file:README.md']);
        expect(listed.tree[0]?.hasChildren).toBe(true);
        expect(listed.treeNote).toBe('');
    });

    it('drills into a folder and refuses to leave the repository', () => {
        const nested = filesList({ ...input, root: repo, path: 'src' });
        expect(nested.tree.map((node) => `${node.kind}:${node.name}`).sort()).toEqual(['file:app.mjs', 'folder:nested']);
        expect(() => filesList({ ...input, root: repo, path: '../..' })).toThrow('invalid folder');
        expect(() => filesList({ ...input, root: join(scratch, 'nowhere') })).toThrow();
    });

    it('reads a bounded text preview and refuses symlinked escapes', () => {
        const preview = filesRead({ ...input, root: repo, path: 'src/app.mjs' });
        expect(preview.name).toBe('app.mjs');
        expect(preview.body).toContain('added = 1');
        expect(preview.note).toBe('');
        symlinkSync('/etc/hostname', join(repo, 'escape'));
        expect(() => filesRead({ ...input, root: repo, path: 'escape' })).toThrow('outside repository');
    });

    it('reports binary files as unavailable', () => {
        writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
        const preview = filesRead({ ...input, root: repo, path: 'blob.bin' });
        expect(preview.body).toBe('Binary file — preview unavailable.');
    });
});

describe('user-named folders outside the open repositories', () => {
    const spaced = join(scratch, 'My Project');
    mkdirSync(join(spaced, 'notes'), { recursive: true });
    mkdirSync(join(spaced, 'emptydir'), { recursive: true });
    writeFileSync(join(spaced, 'report.md'), '# plan\n\nThe full target.\n');
    writeFileSync(join(spaced, 'notes', 'plan.txt'), 'wrapped and spaced\n');
    writeFileSync(join(scratch, 'outside.txt'), 'outside\n');
    symlinkSync(join(scratch, 'outside.txt'), join(spaced, 'escape'));

    it('lists an absolute out-of-repository folder with spaces as a named folder, never a repository', () => {
        const listed = filesList({ ...input, root: spaced });
        expect(listed.scope).toBe('folder');
        expect(listed.title).toBe('My Project');
        expect(listed.tree.map((node) => `${node.kind}:${node.name}`).sort()).toEqual([
            'file:escape',
            'file:report.md',
            'folder:emptydir',
            'folder:notes',
        ]);
        const nested = filesList({ ...input, root: spaced, path: 'notes' });
        expect(nested.tree.map((node) => node.name)).toEqual(['plan.txt']);
        expect(filesRead({ ...input, root: spaced, path: 'report.md' }).body).toContain('The full target.');
        expect(filesRead({ ...input, root: spaced, path: 'notes/plan.txt' }).body).toContain('wrapped and spaced');
    });

    it('answers an unverifiable path with stable classes the phone can map', () => {
        expect(() => filesList({ ...input, root: join(spaced, 'missing') })).toThrow('unknown repository');
        expect(() => filesRead({ ...input, root: spaced, path: 'missing.md' })).toThrow('file unavailable');
        expect(() => filesList({ ...input, root: spaced, path: 'missing' })).toThrow('file unavailable');
        // An empty folder still answers as a folder, with zero entries.
        expect(filesList({ ...input, root: spaced, path: 'emptydir' }).tree).toEqual([]);
    });

    it("tapping '/' opens the filesystem root itself, never the session repository", () => {
        const listed = filesList({ ...input, root: '/' });
        expect(listed.scope).toBe('folder');
        expect(listed.root).toBe('/');
        expect(listed.title).toBe('/');
    });

    it('reads through the filesystem root without mistaking it for an escape', () => {
        const dirRel = relative('/', join(spaced, 'notes'));
        const fileRel = relative('/', join(spaced, 'notes', 'plan.txt'));
        const listed = filesList({ ...input, root: '/', path: dirRel });
        expect(listed.tree.map((node) => node.name)).toEqual(['plan.txt']);
        expect(filesRead({ ...input, root: '/', path: fileRel }).body).toContain('wrapped and spaced');
    });

    it('keeps the refusal classes intact for named folders', () => {
        expect(() => filesRead({ ...input, root: spaced, path: 'escape' })).toThrow('outside repository');
        expect(() => filesList({ ...input, root: spaced, path: 'escape' })).toThrow('outside repository');
        expect(() => filesList({ ...input, root: spaced, path: '../..' })).toThrow('invalid folder');
        expect(() => filesList({ ...input, root: 'relative/path' })).toThrow('unknown repository');
        expect(() => filesList({ ...input, root: `${spaced}\0` })).toThrow('unknown repository');
    });
});

describe('git history', () => {
    it('logs recent commits with the session attached', () => {
        const log = historyLog(input);
        expect(log.title).toBe('repo');
        expect(log.count).toBe('2 recent commits');
        expect(log.commits.map((commit) => commit.subject)).toEqual(['Two', 'One']);
        expect(log.commits[0]?.sessionId).toBe(sessionId);
        expect(log.commits[0]?.meta).toContain('Fixture');
    });

    it('shows one commit patch and rejects hostile SHAs', () => {
        const sha = logSha();
        const shown = historyShow({ ...input, sha });
        expect(shown.subject).toBe('Two');
        expect(shown.patch).toContain('added = 1');
        expect(() => historyShow({ ...input, sha: '../../etc' })).toThrow('invalid commit');
        expect(() => historyShow({ ...input, sha: 'zzz' })).toThrow('invalid commit');
    });

    it('treats a session without a directory as an empty state', () => {
        expect(historyLog({ sessionId, cwd: '' })).toEqual({
            title: 'Git history',
            count: 'No repository for this session',
            commits: [],
        });
    });
});

function logSha(): string {
    const sha = historyLog(input).commits[0]?.sha;
    if (sha === undefined) throw new Error('fixture repository has no commits');
    return sha;
}
