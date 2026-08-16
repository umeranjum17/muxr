#!/usr/bin/env node
/**
 * List worktrees and remove the ones you pick. Nothing is auto-selected:
 * "landed", "dirty", "you are here" are printed as facts; what gets cleared
 * is your call.
 *
 *   yarn worktrees:clean                      list, then pick by number
 *   yarn worktrees:clean brave-bridge wt2     remove these, no list
 *
 * Removing a dirty worktree or an unlanded branch asks once more, because
 * git refuses both without a force flag.
 */
import { execFileSync } from 'node:child_process';
import { sep } from 'node:path';
import * as readline from 'node:readline';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitOk = (cwd, ...args) => {
    try {
        execFileSync('git', args, { cwd, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const main = git('.', 'worktree', 'list', '--porcelain').split('\n')[0].replace(/^worktree /, '');
const base = git(main, 'branch', '--show-current');
git(main, 'worktree', 'prune'); // drop registrations whose directory is already gone

/** porcelain: blank-line-separated blocks of `worktree <path>` / `branch refs/heads/<name>` | `detached`. */
const worktrees = git('.', 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => ({
        path: /^worktree (.+)$/m.exec(block)?.[1],
        branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1],
    }))
    .filter((worktree) => worktree.path !== undefined && worktree.path !== main);

function statusOf(worktree) {
    const parts = [];
    if (worktree.branch === undefined) {
        parts.push('detached');
    } else if (gitOk(main, 'merge-base', '--is-ancestor', worktree.branch, base)) {
        parts.push(`landed on ${base}`);
    } else {
        const ahead = git(main, 'rev-list', '--count', `${base}..${worktree.branch}`);
        parts.push(`${ahead} commit${ahead === '1' ? '' : 's'} not on ${base}`);
    }
    parts.push(git(worktree.path, 'status', '--porcelain') === '' ? 'clean' : 'dirty');
    if (process.cwd() === worktree.path || process.cwd().startsWith(worktree.path + sep)) {
        parts.push('you are here');
    }
    return parts.join(', ');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
const confirm = async (question) => (await ask(`${question} (y/N) `)).trim().toLowerCase() === 'y';

let picked = process.argv.slice(2).filter((arg) => arg !== '--yes' && arg !== '-y');
if (picked.length === 0) {
    worktrees.forEach((worktree, index) => {
        console.log(`${index + 1}. ${worktree.path.split('/').pop()}  ${statusOf(worktree)}`);
    });
    const answer = await ask('remove which? (numbers, comma separated; empty = none) ');
    picked = answer.split(',').map((part) => worktrees[Number(part.trim()) - 1]?.path.split('/').pop()).filter(Boolean);
}

for (const name of picked) {
    const worktree = worktrees.find((candidate) => candidate.path.split('/').pop() === name);
    if (worktree === undefined) {
        console.log(`skip  ${name}: no such worktree`);
        continue;
    }
    if (statusOf(worktree).includes('you are here') && !(await confirm(`${name}: you are standing in it. remove anyway?`))) {
        continue;
    }
    let force = '';
    if (git(worktree.path, 'status', '--porcelain') !== '') {
        if (!(await confirm(`${name}: has uncommitted changes. force-remove?`))) continue;
        force = '--force';
    }
    execFileSync('git', ['-C', main, 'worktree', 'remove', ...(force === '' ? [] : [force]), worktree.path], { stdio: 'inherit' });
    if (worktree.branch !== undefined) {
        const landed = gitOk(main, 'merge-base', '--is-ancestor', worktree.branch, base);
        if (landed || (await confirm(`${name}: branch has unlanded commits. delete it too?`))) {
            execFileSync('git', ['-C', main, 'branch', landed ? '-d' : '-D', worktree.branch], { stdio: 'inherit' });
        }
    }
    console.log(`removed ${name}`);
}
rl.close();
