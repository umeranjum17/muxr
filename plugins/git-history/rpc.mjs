#!/usr/bin/env node
/** Reads history for the directory the session is in; never writes. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const git = (args) => execFileSync('git', ['-C', repo(), ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });

function repo() {
    const cwd = String(input.cwd ?? '');
    if (cwd === '' || cwd.includes('\0')) throw new Error('no directory for this session');
    return cwd;
}

const method = process.argv[2];
if (method === 'log') {
    const cwd = String(input.cwd ?? '');
    if (cwd === '' || cwd.includes('\0')) {
        // A session can have no working directory yet; that is an empty state,
        // not a crash.
        process.stdout.write(JSON.stringify({ title: 'Git history', count: 'No repository for this session', commits: [] }));
        process.exit(0);
    }
    const root = execFileSync('git', ['-C', repo(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 20000 }).trim();
    const commits = git(['log', '-25', '--date=short', '--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%ad']).split('\n').filter(Boolean)
        .map((line) => { const [sha, short, subject, author, date] = line.split('\x1f'); return { sha, short, subject, author, date, meta: `${short} · ${author} · ${date}`, cwd: repo() }; });
    process.stdout.write(JSON.stringify({ title: root.split('/').pop(), count: `${commits.length} recent commits`, commits }));
} else {
    const sha = String(input.sha ?? '');
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('invalid commit');
    const header = git(['show', '-s', '--date=short', '--pretty=%s%n%an · %ad', sha]).trim().split('\n');
    // The viewer needs a patch, not a commit message, so keep them apart.
    process.stdout.write(JSON.stringify({ subject: header[0] ?? sha, meta: header[1] ?? '', patch: git(['show', '--format=', '--no-color', sha]).slice(0, 60000) }));
}
