/**
 * Landing a worktree, machine half. Plain `git` calls through execFile -- no
 * shell string to quote, and each step checks before it acts so a retried land
 * after a mid-failure picks up where the last one stopped instead of stacking
 * duplicate squash commits.
 *
 * The old failure modes this is built against:
 *  - the merge ran through the session's own shell with cwd inside the doomed
 *    worktree, so a successful land deleted the agent's working directory;
 *  - a dirty base checkout aborted the merge with raw stderr and no remedy;
 *  - a failed `worktree remove` left a half-landed state every retry reported
 *    as "nothing to land".
 *
 * Removal is gone from here entirely: landing lands, and deleting the
 * directory is a separate explicit action once no session lives in it.
 */

import { execFile } from 'node:child_process';
import type { LandWorktreeResult } from '@muxr/contract';

interface GitOut {
    stdout: string;
    stderr: string;
    code: number;
}

function git(cwd: string, args: string[]): Promise<GitOut> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            args,
            {
                cwd,
                maxBuffer: 10_000_000,
                env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
            },
            (error, stdout, stderr) => {
                const code = (error as { code?: unknown } | null)?.code;
                if (error !== null && typeof code !== 'number') {
                    reject(error); // git itself failed to spawn
                    return;
                }
                resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 });
            },
        );
    });
}

async function mustRun(cwd: string, args: string[]): Promise<string> {
    const out = await git(cwd, args);
    if (out.code !== 0) {
        throw new Error(`git ${args[0]}: ${out.stderr.trim() || out.stdout.trim()}`);
    }
    return out.stdout;
}

/** Paths with uncommitted state in `cwd`, rename-aware, quoting-proof. */
async function dirtyFiles(cwd: string): Promise<string[]> {
    const out = await mustRun(cwd, ['status', '--porcelain', '-z']);
    const files: string[] = [];
    const entries = out.split('\0');
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry === undefined || entry === '') continue;
        files.push(entry.slice(3));
        // A rename/copy entry is followed by its source path; skip it.
        if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') index++;
    }
    return files;
}

export async function landWorktree(
    worktreePath: string,
    message: string,
    stash: boolean,
): Promise<LandWorktreeResult> {
    const branch = (await mustRun(worktreePath, ['branch', '--show-current'])).trim();
    if (branch === '') throw new Error('The worktree is not on a branch.');

    // First porcelain entry is the main worktree, wherever this one lives.
    const firstLine = (await mustRun(worktreePath, ['worktree', 'list', '--porcelain'])).split('\n')[0] ?? '';
    const repo = firstLine.replace(/^worktree /, '');
    if (repo === '') throw new Error('Could not find the base checkout for this worktree.');

    const into = (await mustRun(repo, ['branch', '--show-current'])).trim();
    if (into === '') throw new Error('The base checkout is not on a branch.');
    if (into === branch) throw new Error('The worktree shares its branch with the base checkout.');

    // Uncommitted work in the worktree belongs in the land, so commit it first.
    if ((await git(worktreePath, ['status', '--porcelain'])).stdout.trim() !== '') {
        await mustRun(worktreePath, ['add', '-A']);
        await mustRun(worktreePath, ['commit', '-m', message]);
    }

    // Nothing to merge means a previous attempt already landed this branch.
    if ((await mustRun(worktreePath, ['rev-list', '--count', `${into}..HEAD`])).trim() === '0') {
        return { status: 'already-landed', branch, into };
    }

    // The merge refuses to run over base-checkout dirt on files the branch
    // touches. Name those files so the caller can ask about stashing them.
    const base = (await mustRun(worktreePath, ['merge-base', into, 'HEAD'])).trim();
    const changed = new Set(
        (await mustRun(worktreePath, ['diff', '--name-only', base, 'HEAD'])).split('\n').filter(Boolean),
    );
    const overlap = (await dirtyFiles(repo)).filter((file) => changed.has(file));
    if (overlap.length > 0 && !stash) {
        return { status: 'blocked-dirty-base', files: overlap };
    }

    if ((await git(worktreePath, ['merge-base', '--is-ancestor', into, 'HEAD'])).code !== 0) {
        const rebase = await git(worktreePath, ['rebase', into]);
        if (rebase.code !== 0) {
            await git(worktreePath, ['rebase', '--abort']);
            return { status: 'conflict', step: 'rebase', branch, detail: rebase.stderr.trim() || rebase.stdout.trim() };
        }
    }

    // One commit lands as it is; several get squashed into one.
    const ahead = Number((await mustRun(worktreePath, ['rev-list', '--count', `${into}..HEAD`])).trim());
    if (ahead > 1) {
        const squashBase = (await mustRun(worktreePath, ['merge-base', into, 'HEAD'])).trim();
        await mustRun(worktreePath, ['reset', '--soft', squashBase]);
        await mustRun(worktreePath, ['commit', '-m', message]);
    }

    let stashed = false;
    if (overlap.length > 0) {
        const pushed = await mustRun(repo, ['stash', 'push', '-u', '-m', `muxr-land ${branch}`, '--', ...overlap]);
        stashed = !pushed.includes('No local changes');
    }

    await mustRun(repo, ['merge', '--ff-only', branch]);

    let stashLeft = false;
    if (stashed) {
        stashLeft = (await git(repo, ['stash', 'pop'])).code !== 0;
    }

    return { status: 'landed', branch, into, stashLeft };
}
