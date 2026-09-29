/**
 * Git history for the directory the session is in. Product code (the history
 * half of the extracted Files add-on's history.mjs, ported with its flow
 * tests). Read-only: every command here is a git read; nothing writes.
 *
 * Trust boundary: the caller supplies only the sessionId; the dispatcher
 * injects the session cwd. Commit SHAs must look like hex; anything else is
 * rejected before it reaches git.
 */
import { execFileSync } from 'node:child_process';

export interface HistoryInput {
    sessionId: string;
    cwd: string;
}

export interface HistoryCommit {
    sha: string;
    short: string;
    subject: string;
    author: string;
    date: string;
    meta: string;
    sessionId: string;
}

const LOG_LIMIT = 25;
const MAX_PATCH_CHARS = 60_000;

function git(args: string[], directory: string): string {
    return execFileSync('git', ['--literal-pathspecs', '-C', directory, ...args], {
        encoding: 'utf8',
        input: '',
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
    });
}

function repo(cwd: string): string {
    if (cwd === '' || cwd.includes('\0')) throw new Error('no directory for this session');
    return cwd;
}

export function historyLog(input: HistoryInput): {
    title: string;
    count: string;
    commits: HistoryCommit[];
} {
    if (input.cwd === '' || input.cwd.includes('\0')) {
        // A session can have no working directory yet; that is an empty state,
        // not a crash.
        return { title: 'Git history', count: 'No repository for this session', commits: [] };
    }
    const root = git(['rev-parse', '--show-toplevel'], repo(input.cwd)).trim();
    const commits = git(['log', `-${LOG_LIMIT}`, '--date=short', '--pretty=%H%x1f%h%x1f%s%x1f%an%x1f%ad'], repo(input.cwd))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [sha, short, subject, author, date] = line.split('\x1f');
            return {
                sha: sha ?? '',
                short: short ?? '',
                subject: subject ?? '',
                author: author ?? '',
                date: date ?? '',
                meta: `${short} · ${author} · ${date}`,
                sessionId: input.sessionId,
            };
        });
    return { title: root.split('/').pop() ?? root, count: `${commits.length} recent commits`, commits };
}

export function historyShow(input: HistoryInput & { sha?: string }): {
    subject: string;
    meta: string;
    patch: string;
} {
    const sha = String(input.sha ?? '');
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('invalid commit');
    const header = git(['show', '-s', '--date=short', '--pretty=%s%n%an · %ad', sha], repo(input.cwd))
        .trim()
        .split('\n');
    // The viewer needs a patch, not a commit message, so keep them apart.
    return {
        subject: header[0] ?? sha,
        meta: header[1] ?? '',
        patch: git(['show', '--format=', '--no-color', sha], repo(input.cwd)).slice(0, MAX_PATCH_CHARS),
    };
}
