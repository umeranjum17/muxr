import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { changesBrowse, changesList, changesPatch, changesWorktrees } from './changesReview.js';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-changes-review-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const repo = join(scratch, 'repo');
const feature = join(scratch, 'feature tree');
mkdirSync(repo);
const git = (args: string[], cwd: string = repo): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Fixture']);
git(['config', 'user.email', 'fixture@example.invalid']);
writeFileSync(join(repo, 'tracked.txt'), 'baseline\n');
git(['add', '.']);
git(['commit', '-q', '-m', 'Baseline']);
git(['worktree', 'add', '-q', '-b', 'feature', feature]);
writeFileSync(join(feature, 'tracked.txt'), 'BRANCH_ONLY\n');
git(['add', '.'], feature);
git(['commit', '-q', '-m', 'Branch change'], feature);
writeFileSync(join(repo, 'base-only.txt'), 'BASE_ONLY\n');
writeFileSync(join(feature, 'tracked.txt'), 'UNCOMMITTED\n');

const sessionId = 'fixture-session';
const headSha = (cwd: string): string => execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const emptyTreeSha = (cwd: string): string =>
    execFileSync('git', ['-C', cwd, 'hash-object', '-t', 'tree', '--stdin'], { encoding: 'utf8', input: '' }).trim();

describe('changes review', () => {
    it('reviews the selected checkout, not unrelated session files', () => {
        const badge = changesList({ sessionId, cwd: repo });
        expect(badge.files.some((file) => file.path === 'base-only.txt')).toBe(true);
        expect(badge.files.find((file) => file.path === 'base-only.txt')?.kind).toBe('untracked');
        expect(badge.count).toBe(1);
        expect(badge.branch).toBe('main');

        const worktrees = changesWorktrees({ sessionId, cwd: repo });
        expect(worktrees.worktrees.some((entry) => entry.root === feature)).toBe(true);
        expect(worktrees.worktrees.find((entry) => entry.root === repo)?.sessionCheckout).toBe(true);
    });

    it('pins branch, working, and staged comparisons to the listed commits', () => {
        const branch = changesBrowse({ sessionId, cwd: repo, root: feature, scope: 'branch' });
        expect(branch.note).toContain('main');
        expect(branch.files.map((file) => file.path)).toEqual(['tracked.txt']);
        const branchPatch = changesPatch({
            sessionId, cwd: repo, root: feature, scope: 'branch', path: 'tracked.txt',
            head: branch.head, base: branch.base,
        });
        expect(branchPatch.patch).toContain('+BRANCH_ONLY');
        expect(branchPatch.patch).not.toContain('UNCOMMITTED');

        const working = changesBrowse({ sessionId, cwd: repo, root: feature, scope: 'working' });
        const workingPatch = changesPatch({
            sessionId, cwd: repo, root: feature, scope: 'working', path: 'tracked.txt',
            head: working.head, base: working.base,
        });
        expect(workingPatch.patch).toContain('+UNCOMMITTED');
        expect(working.files.some((file) => file.path === 'base-only.txt')).toBe(false);

        expect(changesBrowse({ sessionId, cwd: repo, root: feature, scope: 'staged' }).files).toEqual([]);
    });

    it('reviews a deleted path by its patch alone', () => {
        rmSync(join(feature, 'tracked.txt'));
        const working = changesBrowse({ sessionId, cwd: repo, root: feature, scope: 'working' });
        const deleted = working.files.find((file) => file.path === 'tracked.txt');
        expect(deleted).toBeDefined();
        expect(deleted!.openable).toBe(false);
        const deletedPatch = changesPatch({
            sessionId, cwd: repo, root: feature, scope: 'working', path: 'tracked.txt',
            head: working.head, base: working.base,
        });
        expect(deletedPatch.patch).toContain('-BRANCH_ONLY');
    });

    it('handles a repository before its first commit', () => {
        const fresh = join(scratch, 'fresh');
        mkdirSync(fresh);
        git(['init', '-q', '-b', 'main'], fresh);
        writeFileSync(join(fresh, 'first.txt'), 'FIRST_COMMIT_PENDING\n');
        git(['add', '.'], fresh);
        const staged = changesBrowse({ sessionId, cwd: fresh, scope: 'staged' });
        const empty = emptyTreeSha(fresh);
        const first = changesPatch({ sessionId, cwd: fresh, scope: 'staged', path: 'first.txt', head: empty, base: empty });
        expect(first.patch).toContain('+FIRST_COMMIT_PENDING');
        expect(changesBrowse({ sessionId, cwd: fresh, scope: 'branch' }).files).toEqual([]);
    });

    it('pages long working trees and rejects unregistered roots and bad input', () => {
        for (let index = 0; index < 52; index++) writeFileSync(join(feature, `extra-${String(index).padStart(2, '0')}.txt`), 'PAGE_PROOF\n');
        const firstPage = changesBrowse({ sessionId, cwd: repo, root: feature, scope: 'working' });
        expect(firstPage.files).toHaveLength(49);
        expect(firstPage.pageCount).toBe(2);
        const nextPage = changesBrowse({ sessionId, cwd: repo, root: feature, scope: 'working', page: 1 });
        expect(nextPage.files.some((file) => file.path === 'extra-51.txt')).toBe(true);
        expect(nextPage.files.some((file) => firstPage.files.some((first) => first.path === file.path))).toBe(false);
        expect(() => changesBrowse({ sessionId, cwd: repo, root: scratch })).toThrow(/registered/);
        expect(() => changesPatch({ sessionId, cwd: repo, root: feature, path: '../outside', head: headSha(feature), base: headSha(feature) }))
            .toThrow(/Invalid repository file/);
        expect(() => changesPatch({ sessionId, cwd: repo, root: feature, path: 'tracked.txt', head: 'nope', base: headSha(feature) }))
            .toThrow(/Refresh Changes/);
        expect(() => changesPatch({ sessionId, cwd: repo, root: feature, path: 'tracked.txt', head: headSha(feature), base: headSha(feature), kind: 'untracked' }))
            .toThrow(/no longer untracked/);
    });

    it('answers a session without a repository with an empty badge, not a crash', () => {
        const empty = changesList({ sessionId, cwd: join(scratch, 'nowhere') });
        expect(empty.count).toBe(0);
        expect(empty.note).toContain('No Git repository');
    });
});
