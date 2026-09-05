#!/usr/bin/env node
/** Repository and comparison scope are explicit; every file opens that exact diff. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const method = process.argv[2] ?? 'list';
const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
const cwd = typeof input.cwd === 'string' ? input.cwd : '';
function git(args, directory = cwd, difference = false) {
    try { return execFileSync('git', ['--literal-pathspecs', '-C', directory, ...args], { encoding: 'utf8', input: '', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) {
        // --no-index reports a real difference with exit 1, not a failed read.
        if (difference && error.status === 1 && typeof error.stdout === 'string') return error.stdout;
        throw error;
    }
}
const screen = (contributionId, params) => ({ type: 'screen', contributionId, params });
let sessionRoot;
try {
    if (!cwd || cwd.includes('\0')) throw new Error('No session directory');
    sessionRoot = realpathSync(git(['rev-parse', '--show-toplevel']).trim());
} catch {
    process.stdout.write(JSON.stringify({ items: [], actions: [], title: 'Changes', note: 'No Git repository for this session', files: [], worktrees: [] }));
    process.exit(0);
}
function worktrees() {
    const entries = git(['worktree', 'list', '--porcelain', '-z'], sessionRoot).split('\0\0').filter(Boolean);
    return entries.flatMap((entry) => {
        const fields = entry.split('\0');
        const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
        if (!path) return [];
        let root; try { root = realpathSync(path); } catch { return []; }
        const branch = fields.find((field) => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? 'Detached checkout';
        const head = fields.find((field) => field.startsWith('HEAD '))?.slice(5) ?? '';
        return [{ root, branch, head }];
    });
}
const registered = worktrees();
const requested = typeof input.root === 'string' && input.root ? realpathSync(input.root) : sessionRoot;
const selected = registered.find((entry) => entry.root === requested);
if (!selected) throw new Error('Choose a worktree registered with this session repository');
const root = selected.root;
const scope = ['working', 'staged', 'branch'].includes(input.scope) ? input.scope : 'working';
const scopes = [{ id: 'working', label: 'Working tree' }, { id: 'staged', label: 'Staged' }, { id: 'branch', label: 'Branch changes' }];
const commit = (ref) => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], root).trim();
let head;
try { head = commit('HEAD'); } catch { /* New repository before its first commit. */ }
const emptyTree = () => git(['hash-object', '-t', 'tree', '--stdin'], root).trim();
const unborn = !head;
head ??= emptyTree();
let base = head, comparison = scope === 'staged' ? 'Staged vs HEAD' : 'Working tree vs HEAD';
let unavailable = '';
if (scope === 'branch' && unborn) unavailable = 'No committed branch changes yet.';
if (scope === 'branch' && !unborn) {
    let reference;
    try { reference = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root).trim(); } catch { /* local-only repository */ }
    for (const candidate of [reference, 'refs/remotes/origin/main', 'refs/heads/main', 'refs/heads/master'].filter(Boolean)) {
        try {
            commit(candidate);
            base = git(['merge-base', candidate, head], root).trim();
            comparison = `Branch vs ${candidate.replace(/^refs\/(?:heads|remotes)\//, '')} · merge base ${base.slice(0, 8)}`;
            reference = candidate; break;
        } catch { reference = undefined; }
    }
    if (!reference) unavailable = 'No main branch comparison is available in this repository.';
}
function diffArgs(kind = scope) {
    const flags = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
    if (kind === 'staged') return [...flags, '--cached', head];
    if (kind === 'branch') return [...flags, base, head];
    return [...flags, head];
}
function files() {
    if (unavailable) return [];
    const records = git([...diffArgs(), '--numstat', '-z'], root).split('\0').filter(Boolean);
    const tracked = records.map((record) => {
        const [added, deleted, ...path] = record.split('\t');
        return { path: path.join('\t'), added, deleted, kind: scope };
    });
    const untracked = scope === 'working' ? git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean)
        .map((path) => ({ path, added: '', deleted: '', kind: 'untracked' })) : [];
    return [...tracked, ...untracked];
}
const params = (extra = {}) => ({ sessionId, root, scope, ...extra });
function workingFileAction(file) {
    // Deleted paths and links have useful patches but cannot open as current files.
    try {
        if (lstatSync(join(root, file.path)).isFile()) return { type: 'kernel.navigate', target: 'file', path: join(root, file.path) };
    } catch { /* A deletion is still reviewable. */ }
    return screen('changes.file', params({ path: file.path, kind: file.kind, head, base }));
}
if (method === 'worktrees') {
    // Recent branch commits first, with the conversation's checkout labelled.
    const recent = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], sessionRoot).trim().split('\n');
    const rank = (entry) => {
        if (entry.root === sessionRoot) return -1;
        const index = recent.indexOf(entry.branch);
        return index < 0 ? recent.length : index;
    };
    const ordered = [...registered].sort((a, b) => rank(a) - rank(b));
    process.stdout.write(JSON.stringify({ title: 'Choose worktree', note: `${registered.length} registered worktrees${registered.length > 50 ? '; showing the 50 most recent' : ''}. This changes the review view, not the agent directory.`,
        worktrees: ordered.slice(0, 50).map((entry) => ({ ...entry, sessionId, title: `${entry.branch}${entry.root === sessionRoot ? ' · session checkout' : ''}`, subtitle: entry.root })) }));
} else if (method === 'patch') {
    const path = typeof input.path === 'string' ? input.path : '';
    if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw new Error('Invalid repository file');
    let patch;
    if (input.kind === 'untracked') {
        const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0');
        if (!untracked.includes(path)) throw new Error('This file is no longer untracked; refresh Changes');
        const stat = lstatSync(join(root, path));
        if (stat.size > 1024 * 1024 || (!stat.isFile() && !stat.isSymbolicLink())) throw new Error('File is too large for an inline diff');
        patch = git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', path], root, true);
    } else {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.head ?? '') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.base ?? '')) throw new Error('Refresh Changes to select a comparison');
        const pinned = (value) => value === emptyTree() ? value : commit(value);
        head = pinned(input.head); base = pinned(input.base);
        if (scope === 'branch') comparison = `Branch comparison ${base.slice(0, 8)} → ${head.slice(0, 8)}`;
        patch = git([...diffArgs(), '--', path], root);
    }
    let patchNote = '';
    if (patch.length > 60000) patchNote = ' · Diff truncated to 60,000 characters';
    else if (!patch) patchNote = ' · No difference in this comparison';
    process.stdout.write(JSON.stringify({ title: basename(path), note: `${root} · ${comparison}${patchNote}`, patch: patch.slice(0, 60000) }));
} else {
    const changed = files();
    const pageCount = Math.max(1, Math.ceil(changed.length / 49));
    const requestedPage = typeof input.page === 'number' || (typeof input.page === 'string' && /^\d+$/.test(input.page)) ? Number(input.page) : 0;
    const page = method === 'browse' && Number.isSafeInteger(requestedPage) ? Math.max(0, Math.min(pageCount - 1, requestedPage)) : 0;
    const rows = changed.slice(page * 49, (page + 1) * 49).map((file) => {
        let count = `+${file.added} / −${file.deleted}`;
        if (file.kind === 'untracked') count = 'Untracked';
        else if (file.added === '-') count = 'Binary';
        return { ...file, title: basename(file.path), subtitle: `${file.path} · ${count}`, sessionId, root, scope, head, base };
    });
    const scopeNotes = { branch: 'Committed branch changes only; working edits are separate.', staged: 'The index that will be committed; unstaged edits are separate.', working: 'Current files compared with HEAD, including untracked files. Committed branch changes are separate.' };
    const note = `${root}\n${selected.branch} · ${comparison}\n${unavailable || scopeNotes[scope]}${changed.length > 49 ? `\nFiles ${page * 49 + 1}–${Math.min(changed.length, (page + 1) * 49)} of ${changed.length}.` : ''}`;
    if (method === 'browse') {
        process.stdout.write(JSON.stringify({ title: `Changes · ${selected.branch}`, root, scope, scopes, note, files: rows, page: String(page), pages: pageCount === 1 ? [] : [
            ...(page > 0 ? [{ ...params(), page: page - 1, id: String(page - 1), label: 'Previous files' }] : []),
            { ...params(), page, id: String(page), label: `${page + 1} of ${pageCount}` },
            ...(page + 1 < pageCount ? [{ ...params(), page: page + 1, id: String(page + 1), label: 'Next files' }] : []),
        ] }));
    } else {
        process.stdout.write(JSON.stringify({ badge: { value: changed.length > 49 ? '49+' : String(changed.length), tone: 'secondary' },
            items: [{ id: 'review-context', title: `${selected.branch} · Working tree`, subtitle: root, group: 'Compared with HEAD', icon: 'git-branch-outline', metadata: [], action: screen('changes.review', params()) },
                ...rows.map((file) => ({ id: file.path, title: file.title, subtitle: file.subtitle, group: file.kind === 'untracked' ? 'Untracked' : 'Working tree', icon: 'git-compare-outline', metadata: [], action: workingFileAction(file) }))],
            actions: [{ id: 'comparison', label: 'Review branch / staged', icon: 'git-compare-outline', action: screen('changes.review', params({ scope: 'branch' })) },
                { id: 'worktrees', label: 'Choose worktree', icon: 'folder-outline', action: screen('changes.worktrees', { sessionId }) }] }));
    }
}
