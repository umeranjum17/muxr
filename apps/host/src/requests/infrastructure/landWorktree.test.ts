import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { landWorktree } from './landWorktree.js';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Base repo on `master` with one commit, plus a `feature` worktree beside it. */
function fixture(): { repo: string; worktree: string } {
    const root = mkdtempSync(join(tmpdir(), 'muxr-land-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'wt');
    git(root, 'init', '-b', 'master', repo);
    git(repo, 'config', 'user.email', 'test@test');
    git(repo, 'config', 'user.name', 'test');
    writeFileSync(join(repo, 'file.txt'), 'one\ntwo\nthree\nfour\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'worktree', 'add', '-b', 'feature', worktree);
    return { repo, worktree };
}

function commitWorktreeChange(worktree: string, name: string, content: string): void {
    writeFileSync(join(worktree, name), content);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-m', 'work');
}

describe('landWorktree', () => {
    it('lands a clean branch and keeps the worktree directory', async () => {
        const { repo, worktree } = fixture();
        commitWorktreeChange(worktree, 'new.txt', 'hello\n');

        const result = await landWorktree(worktree, 'ship it', false);

        expect(result).toEqual({ status: 'landed', branch: 'feature', into: 'master', stashLeft: false });
        expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('hello\n');
        expect(existsSync(worktree)).toBe(true);
    });

    it('squashes several commits into one with the caller\'s message', async () => {
        const { repo, worktree } = fixture();
        commitWorktreeChange(worktree, 'a.txt', 'a\n');
        commitWorktreeChange(worktree, 'b.txt', 'b\n');

        const result = await landWorktree(worktree, 'ship it', false);

        expect(result.status).toBe('landed');
        expect(git(repo, 'log', '-1', '--format=%s')).toBe('ship it\n');
        expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('2\n'); // init + squash
    });

    it('commits uncommitted worktree changes instead of losing them', async () => {
        const { repo, worktree } = fixture();
        writeFileSync(join(worktree, 'dirty.txt'), 'unsaved\n');

        const result = await landWorktree(worktree, 'ship it', false);

        expect(result.status).toBe('landed');
        expect(readFileSync(join(repo, 'dirty.txt'), 'utf8')).toBe('unsaved\n');
    });

    it('reports an already-landed branch instead of failing', async () => {
        const { worktree } = fixture();
        commitWorktreeChange(worktree, 'new.txt', 'hello\n');
        await landWorktree(worktree, 'ship it', false);

        const again = await landWorktree(worktree, 'ship it', false);
        expect(again.status).toBe('already-landed');
    });

    it('refuses to merge over base-checkout dirt and names the files', async () => {
        const { repo, worktree } = fixture();
        commitWorktreeChange(worktree, 'file.txt', 'branch\n');
        writeFileSync(join(repo, 'file.txt'), 'base local edit\n');
        const before = git(repo, 'rev-parse', 'master');

        const result = await landWorktree(worktree, 'ship it', false);

        expect(result).toEqual({ status: 'blocked-dirty-base', files: ['file.txt'] });
        // Nothing moved: base dirt intact, master untouched.
        expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('base local edit\n');
        expect(git(repo, 'rev-parse', 'master')).toBe(before);
    });

    it('stashes, lands, and restores base dirt when the hunks do not clash', async () => {
        const { repo, worktree } = fixture();
        commitWorktreeChange(worktree, 'file.txt', 'one\ntwo\nthree\nbranch\n');
        writeFileSync(join(repo, 'file.txt'), 'base edit\ntwo\nthree\nfour\n');

        const result = await landWorktree(worktree, 'ship it', true);

        expect(result).toEqual({ status: 'landed', branch: 'feature', into: 'master', stashLeft: false });
        // Branch content merged, base edit re-applied on top, stash empty.
        expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('base edit\ntwo\nthree\nbranch\n');
        expect(git(repo, 'stash', 'list')).toBe('');
    });

    it('keeps the stash when it would not re-apply cleanly', async () => {
        const { repo, worktree } = fixture();
        commitWorktreeChange(worktree, 'file.txt', 'branch\n');
        writeFileSync(join(repo, 'file.txt'), 'base local edit\n');

        const result = await landWorktree(worktree, 'ship it', true);

        expect(result.status).toBe('landed');
        if (result.status !== 'landed') return;
        expect(result.stashLeft).toBe(true);
        // The work landed; the user's edit is safe in the stash, not lost.
        expect(git(repo, 'show', 'master:file.txt')).toBe('branch\n');
        expect(git(repo, 'stash', 'list')).toContain('muxr-land feature');
    });

    it('aborts a conflicting rebase and reports it without losing the branch', async () => {
        const { repo, worktree } = fixture();
        commitWorktreeChange(worktree, 'file.txt', 'branch\n');
        writeFileSync(join(repo, 'file.txt'), 'base moved\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-m', 'base moved');

        const result = await landWorktree(worktree, 'ship it', false);

        expect(result.status).toBe('conflict');
        if (result.status !== 'conflict') return;
        expect(result.step).toBe('rebase');
        // Rebase was aborted: the branch still has its commit, master kept its own.
        expect(git(worktree, 'status', '--porcelain')).toBe('');
        expect(git(repo, 'show', 'master:file.txt')).toBe('base moved\n');
    });
});
