#!/usr/bin/env node
/** Working-tree rows with bounded diff stats; the phone renders one generic item-list. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const cwd = typeof input.cwd === 'string' ? input.cwd : '';
if (cwd === '' || cwd.includes('\0')) {
    process.stdout.write(JSON.stringify({ items: [] }));
    process.exit(0);
}

function git(args, directory = cwd) {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
}

let root = '';
try {
    root = git(['rev-parse', '--show-toplevel']).trim();
    if (root === '') throw new Error('not a repository');
} catch {
    process.stdout.write(JSON.stringify({ items: [] }));
    process.exit(0);
}

function repoGit(args) {
    return git(args, root);
}

function addNumstat(target, output) {
    const records = output.split('\0');
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record === '') continue;
        const [added, deleted, ...pathParts] = record.split('\t');
        let path = pathParts.join('\t');
        // With -z, a rename is `add<TAB>del<TAB><NUL>old<NUL>new<NUL>`.
        if (path === '' && records[index + 2] !== undefined) {
            path = records[index + 2];
            index += 2;
        }
        if (path === '') continue;
        const previous = target.get(path) ?? { added: 0, deleted: 0, binary: false };
        if (added === '-' || deleted === '-') previous.binary = true;
        else {
            previous.added += Number.parseInt(added ?? '0', 10) || 0;
            previous.deleted += Number.parseInt(deleted ?? '0', 10) || 0;
        }
        target.set(path, previous);
    }
}

function untrackedStat(path) {
    try {
        const info = statSync(join(root, path));
        if (!info.isFile() || info.size > 1024 * 1024) return undefined;
        const content = readFileSync(join(root, path));
        if (content.includes(0)) return { binary: true };
        if (content.length === 0) return { lines: 0, binary: false };
        return { lines: content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0), binary: false };
    } catch {
        return undefined;
    }
}

function iconFor(status) {
    if (status.includes('?') || status.includes('A')) return 'add-circle-outline';
    if (status.includes('D')) return 'trash-outline';
    if (status.includes('R')) return 'swap-horizontal-outline';
    return 'git-compare-outline';
}

let porcelain = '';
const stats = new Map();
try {
    porcelain = repoGit(['status', '--porcelain=v1', '-z', '-uall']);
    addNumstat(stats, repoGit(['diff', '--numstat', '-z']));
    addNumstat(stats, repoGit(['diff', '--cached', '--numstat', '-z']));
} catch {
    process.stdout.write(JSON.stringify({ items: [] }));
    process.exit(0);
}

function groupFor(status) {
    if (status.includes('R') || status.includes('C')) return 'Renamed';
    if (status.includes('D')) return 'Deleted';
    if (status.includes('A') || status.includes('?')) return 'New';
    return 'Modified';
}

const records = porcelain.split('\0');
const changed = [];
for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // Porcelain -z appends the source path after a rename/copy destination.
    if (status.includes('R') || status.includes('C')) index += 1;
    changed.push({ status, path });
}
const items = changed.slice(0, 50).map(({ status, path }) => {
    const name = path.split('/').pop() ?? path;
    const stat = stats.get(path);
    const untracked = status === '??' ? untrackedStat(path) : undefined;
    const metadata = stat?.binary || untracked?.binary
        ? [{ value: 'binary', tone: 'secondary' }]
        : [
            ...(stat !== undefined && stat.added > 0 ? [{ value: `+${stat.added}`, tone: 'positive' }] : []),
            ...(stat !== undefined && stat.deleted > 0 ? [{ value: `−${stat.deleted}`, tone: 'danger' }] : []),
            ...(untracked?.lines !== undefined ? [{ value: `+${untracked.lines}`, tone: 'positive' }] : []),
        ];
    return {
        id: path,
        title: name,
        subtitle: path,
        group: groupFor(status),
        icon: iconFor(status),
        metadata,
        action: { type: 'kernel.navigate', target: 'file', path: join(root, path) },
    };
});
process.stdout.write(JSON.stringify({ items, ...(changed.length > 50 ? { badge: { value: '50+', tone: 'warning' } } : {}) }));
