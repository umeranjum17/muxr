import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { filesList, filesRead, filesRepos } from './files.js';
import { historyLog, historyShow } from './history.js';
import type { RequestResult } from '@trymuxr/contract';
import { createAgentWatchStores, createFakeSessionSource } from '../agent/index.js';
import { createRequestDispatcher } from '../requests/index.js';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-files-'));
afterAll(async () => {
    await requests.close();
    rmSync(scratch, { recursive: true, force: true });
});

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
const requests = createRequestDispatcher({ source: createFakeSessionSource(),
    domain: createAgentWatchStores({ dataDir: join(scratch, 'host') }), machineId: 'folder-chooser', hostVersion: 'test' });

async function listDir(path: string | undefined): Promise<RequestResult<'machine.listDir'>> {
    const result = await requests.dispatch({ type: 'machine.listDir', requestId: 'choose-folder', params: path === undefined ? {} : { path } });
    if (!result.ok) throw new Error(result.error);
    return result.data as RequestResult<'machine.listDir'>;
}

describe("files tree", () => {
    it("chooses a repository, browses its tree and reads bounded previews without escaping", async () => {
        const chooser = join(scratch, 'chooser');
        mkdirSync(chooser);
        for (const name of ['alpha', 'zeta', 'alpharepo', 'zetawt', '.hidden']) mkdirSync(join(chooser, name));
        mkdirSync(join(chooser, 'alpharepo', '.git'));
        writeFileSync(join(chooser, 'zetawt', '.git'), 'gitdir: ../../.git/worktrees/zeta\n');
        writeFileSync(join(chooser, 'notes.txt'), 'x');
        symlinkSync(join(chooser, 'alpha'), join(chooser, 'linked'));
        symlinkSync(join(chooser, 'notes.txt'), join(chooser, 'linkedfile'));
        const folders = await listDir(chooser);
        expect(folders.exists).toBe(true);
        expect(folders.path).toBe(chooser);
        expect(folders.parent).toBe(dirname(chooser));
        expect(folders.entries).toEqual([
            { name: 'alpha', repo: false }, { name: 'alpharepo', repo: true },
            { name: 'linked', repo: false }, { name: 'zeta', repo: false }, { name: 'zetawt', repo: true },
        ]);
        const hidden = await listDir(chooser + '/.');
        expect(hidden.exists).toBe(true);
        expect(hidden.entries.some(entry => entry.name === '.hidden')).toBe(true);
        expect(await listDir(join(chooser, 'notes.txt'))).toEqual({ path: join(chooser, 'notes.txt'), parent: chooser, exists: false, entries: [] });
        expect(await listDir(join(chooser, 'nope'))).toEqual({ path: join(chooser, 'nope'), parent: chooser, exists: false, entries: [] });
        const fromHome = await listDir(relative(homedir(), chooser) + '/');
        expect(fromHome.path).toBe(chooser);
        expect(fromHome.entries.map(entry => entry.name)).toContain('alpha');
        const home = await listDir(undefined);
        expect(home.exists).toBe(true);
        expect(home.path).toBe(homedir());
        const choices = await listDir(scratch);
        const picked = choices.entries.find(entry => entry.name === 'repo');
        expect(picked?.repo).toBe(true);
        const selectedRoot = join(choices.path, picked!.name);

        // lists every repository open across sessions
        {
            const found = filesRepos([selectedRoot, join(scratch, 'nowhere')]);
            expect(found.title).toBe('1 repositories');
            expect(found.repos).toEqual([{ root: repo, name: 'repo', path: repo }]);
        }

        // lists the session repository with folders first and bounded notes
        {
            const listed = filesList({ ...input, root: repo });
            expect(listed.root).toBe(repo);
            expect(listed.title).toBe('repo');
            expect(listed.count).toBe('3 files');
            expect(listed.tree.map((node) => `${node.kind}:${node.name}`)).toEqual(['folder:src', 'file:README.md']);
            expect(listed.tree[0]?.hasChildren).toBe(true);
            expect(listed.treeNote).toBe('');
        }

        // drills into a folder and refuses to leave the repository
        {
            const nested = filesList({ ...input, root: repo, path: 'src' });
            expect(nested.tree.map((node) => `${node.kind}:${node.name}`).sort()).toEqual(['file:app.mjs', 'folder:nested']);
            expect(() => filesList({ ...input, root: repo, path: '../..' })).toThrow('invalid folder');
            expect(() => filesList({ ...input, root: join(scratch, 'nowhere') })).toThrow();
        }

        // reads a bounded text preview and refuses symlinked escapes
        {
            const preview = filesRead({ ...input, root: repo, path: 'src/app.mjs' });
            expect(preview.name).toBe('app.mjs');
            expect(preview.body).toContain('added = 1');
            expect(preview.note).toBe('');
            symlinkSync('/etc/hostname', join(repo, 'escape'));
            expect(() => filesRead({ ...input, root: repo, path: 'escape' })).toThrow('outside repository');
        }

        // reports binary files as unavailable
        {
            writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
            const preview = filesRead({ ...input, root: repo, path: 'blob.bin' });
            expect(preview.body).toBe('Binary file — preview unavailable.');
        }
    });
});

describe("user-named folders outside the open repositories", () => {
    const spaced = join(scratch, 'My Project');
    mkdirSync(join(spaced, 'notes'), { recursive: true });
    mkdirSync(join(spaced, 'emptydir'), { recursive: true });
    writeFileSync(join(spaced, 'report.md'), '# plan\n\nThe full target.\n');
    writeFileSync(join(spaced, 'notes', 'plan.txt'), 'wrapped and spaced\n');
    writeFileSync(join(scratch, 'outside.txt'), 'outside\n');
    symlinkSync(join(scratch, 'outside.txt'), join(spaced, 'escape'));

    it("browses a named folder and the filesystem root without losing refusal classes", () => {
        // lists an absolute out-of-repository folder with spaces as a named folder, never a repository
        {
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
        }

        // answers an unverifiable path with stable classes the phone can map
        {
            expect(() => filesList({ ...input, root: join(spaced, 'missing') })).toThrow('unknown repository');
            expect(() => filesRead({ ...input, root: spaced, path: 'missing.md' })).toThrow('file unavailable');
            expect(() => filesList({ ...input, root: spaced, path: 'missing' })).toThrow('file unavailable');
            // An empty folder still answers as a folder, with zero entries.
            expect(filesList({ ...input, root: spaced, path: 'emptydir' }).tree).toEqual([]);
        }

        // tapping '/' opens the filesystem root itself, never the session repository
        {
            const listed = filesList({ ...input, root: '/' });
            expect(listed.scope).toBe('folder');
            expect(listed.root).toBe('/');
            expect(listed.title).toBe('/');
        }

        // reads through the filesystem root without mistaking it for an escape
        {
            const dirRel = relative('/', join(spaced, 'notes'));
            const fileRel = relative('/', join(spaced, 'notes', 'plan.txt'));
            const listed = filesList({ ...input, root: '/', path: dirRel });
            expect(listed.tree.map((node) => node.name)).toEqual(['plan.txt']);
            expect(filesRead({ ...input, root: '/', path: fileRel }).body).toContain('wrapped and spaced');
        }

        // keeps the refusal classes intact for named folders
        {
            expect(() => filesRead({ ...input, root: spaced, path: 'escape' })).toThrow('outside repository');
            expect(() => filesList({ ...input, root: spaced, path: 'escape' })).toThrow('outside repository');
            expect(() => filesList({ ...input, root: spaced, path: '../..' })).toThrow('invalid folder');
            expect(() => filesList({ ...input, root: 'relative/path' })).toThrow('unknown repository');
            expect(() => filesList({ ...input, root: `${spaced}\0` })).toThrow('unknown repository');
        }
    });
});

describe("git history", () => {
    it("opens recent commits and their patches, with an empty state for a session without a repository", () => {
        // logs recent commits with the session attached
        {
            const log = historyLog(input);
            expect(log.title).toBe('repo');
            expect(log.count).toBe('2 recent commits');
            expect(log.commits.map((commit) => commit.subject)).toEqual(['Two', 'One']);
            expect(log.commits[0]?.sessionId).toBe(sessionId);
            expect(log.commits[0]?.meta).toContain('Fixture');
        }

        // shows one commit patch and rejects hostile SHAs
        {
            const sha = logSha();
            const shown = historyShow({ ...input, sha });
            expect(shown.subject).toBe('Two');
            expect(shown.patch).toContain('added = 1');
            expect(() => historyShow({ ...input, sha: '../../etc' })).toThrow('invalid commit');
            expect(() => historyShow({ ...input, sha: 'zzz' })).toThrow('invalid commit');
        }

        // treats a session without a directory as an empty state
        {
            expect(historyLog({ sessionId, cwd: '' })).toEqual({
                title: 'Git history',
                count: 'No repository for this session',
                commits: [],
            });
        }
    });
});

function logSha(): string {
    const sha = historyLog(input).commits[0]?.sha;
    if (sha === undefined) throw new Error('fixture repository has no commits');
    return sha;
}
