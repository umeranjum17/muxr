/**
 * The working-tree review surface: pill count, scoped file lists, worktree
 * picker, and per-file patches. Product code (the review half of the
 * extracted Code add-on's changes.mjs, ported with its flow tests). Read-only: every command here is a
 * git read; nothing mutates the repository or the index.
 *
 * Trust boundary: the caller supplies only the sessionId; the dispatcher
 * injects the session cwd. A client-chosen `root` is honored only when it is a
 * worktree registered with the session repository.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import type { ChangesBadge, ChangesBrowse, ChangesFile, ChangesScope, ChangesWorktree } from '@muxr/contract';

export interface ChangesInput {
    sessionId: string;
    cwd: string;
    root?: string;
}

const PAGE_SIZE = 49;
const MAX_PATCH_CHARS = 60_000;
const SCOPES: { id: ChangesScope; label: string }[] = [
    { id: 'working', label: 'Working tree' },
    { id: 'staged', label: 'Staged' },
    { id: 'branch', label: 'Branch changes' },
];

function git(args: string[], directory: string, difference = false): string {
    try {
        return execFileSync('git', ['--literal-pathspecs', '-C', directory, ...args], {
            encoding: 'utf8', input: '', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
        });
    } catch (error) {
        // --no-index reports a real difference with exit 1, not a failed read.
        const status = (error as { status?: number | null }).status;
        const stdout = (error as { stdout?: unknown }).stdout;
        if (difference && status === 1 && typeof stdout === 'string') return stdout;
        throw error;
    }
}

function sessionRoot(cwd: string): string {
    if (cwd === '' || cwd.includes('\0')) throw new Error('No session directory');
    return realpathSync(git(['rev-parse', '--show-toplevel'], cwd).trim());
}

function worktreesOf(sessionRootValue: string): { root: string; branch: string; head: string }[] {
    const entries = git(['worktree', 'list', '--porcelain', '-z'], sessionRootValue).split('\0\0').filter(Boolean);
    return entries.flatMap((entry) => {
        const fields = entry.split('\0');
        const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
        if (!path) return [];
        let root: string;
        try {
            root = realpathSync(path);
        } catch {
            return [];
        }
        const branch = fields.find((field) => field.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? 'Detached checkout';
        const head = fields.find((field) => field.startsWith('HEAD '))?.slice(5) ?? '';
        return [{ root, branch, head }];
    });
}

/** Resolve the requested root, or the session checkout when absent. */
function selectedRoot(sessionRootValue: string, root?: string): { root: string; branch: string } {
    const registered = worktreesOf(sessionRootValue);
    const requested = root !== undefined && root !== '' ? realpathSync(root) : sessionRootValue;
    const selected = registered.find((entry) => entry.root === requested);
    if (selected === undefined) throw new Error('Choose a worktree registered with this session repository');
    return { root: selected.root, branch: selected.branch };
}

function commit(ref: string, root: string): string {
    return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], root).trim();
}

function emptyTree(root: string): string {
    return git(['hash-object', '-t', 'tree', '--stdin'], root).trim();
}

/**
 * A new file is entirely added lines, so counting none of them reports a
 * working tree of untracked files as no change at all. Git counts the same
 * lines for an intent-to-add file, without us having to touch the index.
 */
function untrackedStat(absolute: string): { added: string; deleted: string } {
    try {
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.size > 1024 * 1024) return { added: '-', deleted: '-' };
        const content = readFileSync(absolute);
        if (content.includes(0)) return { added: '-', deleted: '-' };
        let added = 0;
        for (let index = content.indexOf(10); index !== -1; index = content.indexOf(10, index + 1)) added++;
        if (content.length > 0 && content[content.length - 1] !== 10) added++;
        return { added: String(added), deleted: '0' };
    } catch {
        return { added: '-', deleted: '-' };
    }
}

function diffArgs(scope: ChangesScope, head: string, base: string): string[] {
    const flags = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
    if (scope === 'staged') return [...flags, '--cached', head];
    if (scope === 'branch') return [...flags, base, head];
    return [...flags, head];
}

/** Branch comparison base: origin/HEAD, then main, then master, at the merge base. */
function branchBase(head: string, root: string): { base: string; comparison: string; unavailable: string } {
    let reference: string | undefined;
    try {
        reference = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root).trim();
    } catch { /* local-only repository */ }
    for (const candidate of [reference, 'refs/remotes/origin/main', 'refs/heads/main', 'refs/heads/master'].filter(Boolean) as string[]) {
        try {
            commit(candidate, root);
            const base = git(['merge-base', candidate, head], root).trim();
            return { base, comparison: `Branch vs ${candidate.replace(/^refs\/(?:heads|remotes)\//, '')} · merge base ${base.slice(0, 8)}`, unavailable: '' };
        } catch { /* try the next candidate */ }
    }
    return { base: head, comparison: 'Working tree vs HEAD', unavailable: 'No main branch comparison is available in this repository.' };
}

function changedFiles(root: string, scope: ChangesScope, head: string, base: string): ChangesFile[] {
    const records = git([...diffArgs(scope, head, base), '--numstat', '-z'], root).split('\0').filter(Boolean);
    const tracked = records.map((record) => {
        const [added = '-', deleted = '-', ...path] = record.split('\t');
        return { path: path.join('\t'), added, deleted, kind: scope };
    });
    const untracked = scope === 'working'
        ? git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean)
            .map((path) => ({ path, ...untrackedStat(join(root, path)), kind: 'untracked' as const }))
        : [];
    return [...tracked, ...untracked].map((file) => ({
        path: file.path,
        title: basename(file.path),
        subtitle: `${file.path} · ${file.added === '-' ? 'Binary' : `+${file.added} / −${file.deleted}`}`,
        added: file.added,
        deleted: file.deleted,
        kind: file.kind,
        openable: file.kind === 'untracked' && openableFile(join(root, file.path)),
    }));
}

function openableFile(absolute: string): boolean {
    // Deleted paths and links have useful patches but cannot open as current files.
    try {
        return lstatSync(absolute).isFile();
    } catch {
        return false;
    }
}

interface ResolvedComparison {
    root: string;
    branch: string;
    scope: ChangesScope;
    head: string;
    base: string;
    comparison: string;
    unavailable: string;
    worktreeCount: number;
    sessionRoot: string;
}

function resolveComparison(input: ChangesInput, scope: ChangesScope): ResolvedComparison {
    const sessionRootValue = sessionRoot(input.cwd);
    const { root, branch } = selectedRoot(sessionRootValue, input.root);
    let head: string | undefined;
    try {
        head = commit('HEAD', root);
    } catch { /* New repository before its first commit. */ }
    const unborn = head === undefined;
    const resolvedHead = head ?? emptyTree(root);
    let base = resolvedHead;
    let comparison = scope === 'staged' ? 'Staged vs HEAD' : 'Working tree vs HEAD';
    let unavailable = '';
    if (scope === 'branch') {
        if (unborn) unavailable = 'No committed branch changes yet.';
        else {
            const branchBaseResult = branchBase(resolvedHead, root);
            base = branchBaseResult.base;
            comparison = branchBaseResult.comparison;
            unavailable = branchBaseResult.unavailable;
        }
    }
    return {
        root, branch, scope, head: resolvedHead, base, comparison, unavailable,
        worktreeCount: worktreesOf(sessionRootValue).length,
        sessionRoot: sessionRootValue,
    };
}

function countLabel(count: number): string {
    return `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}`;
}

function scopeNotes(scope: ChangesScope): string {
    const notes: Record<ChangesScope, string> = {
        branch: 'Committed branch changes only; working edits are separate.',
        staged: 'The index that will be committed; unstaged edits are separate.',
        working: 'Current files compared with HEAD, including untracked files. Committed branch changes are separate.',
    };
    return notes[scope];
}

/** The pill payload: count, line summary, and the first page of files. */
export function changesList(input: ChangesInput): ChangesBadge {
    const scope: ChangesScope = 'working';
    try {
        sessionRoot(input.cwd);
    } catch {
        return {
            branch: '', root: '', head: '', base: '', comparison: '', note: 'No Git repository for this session',
            count: 0, countLabel: '0 files', summary: [], files: [],
        };
    }
    const resolved = resolveComparison(input, scope);
    const files = resolved.unavailable === '' ? changedFiles(resolved.root, scope, resolved.head, resolved.base) : [];
    let addedLines = 0;
    let deletedLines = 0;
    for (const file of files) {
        if (/^\d+$/.test(file.added)) addedLines += Number(file.added);
        if (/^\d+$/.test(file.deleted)) deletedLines += Number(file.deleted);
    }
    return {
        branch: resolved.branch,
        root: resolved.root,
        head: resolved.head,
        base: resolved.base,
        comparison: resolved.comparison,
        note: `${resolved.root}\n${resolved.branch} · ${resolved.comparison}\n${resolved.unavailable || scopeNotes(scope)}`,
        count: files.length,
        countLabel: countLabel(files.length),
        summary: resolved.unavailable !== '' ? [] : [
            { label: 'Lines added', value: `+${addedLines.toLocaleString('en-US')}`, tone: 'positive' },
            { label: 'Lines removed', value: `−${deletedLines.toLocaleString('en-US')}`, tone: 'danger' },
        ],
        files: files.slice(0, PAGE_SIZE),
    };
}

/** The review screen: scoped files with pagination. */
export function changesBrowse(input: ChangesInput & { scope?: ChangesScope; page?: number }): ChangesBrowse {
    const scope: ChangesScope = input.scope !== undefined && SCOPES.some((entry) => entry.id === input.scope) ? input.scope : 'working';
    const resolved = resolveComparison(input, scope);
    const files = resolved.unavailable === '' ? changedFiles(resolved.root, scope, resolved.head, resolved.base) : [];
    const pageCount = Math.max(1, Math.ceil(files.length / PAGE_SIZE));
    const page = Math.max(0, Math.min(pageCount - 1, input.page ?? 0));
    const pageNote = files.length > PAGE_SIZE ? `\nFiles ${page * PAGE_SIZE + 1}–${Math.min(files.length, (page + 1) * PAGE_SIZE)} of ${files.length}.` : '';
    let addedLines = 0;
    let deletedLines = 0;
    for (const file of files) {
        if (/^\d+$/.test(file.added)) addedLines += Number(file.added);
        if (/^\d+$/.test(file.deleted)) deletedLines += Number(file.deleted);
    }
    return {
        title: `Changes · ${resolved.branch}`,
        branch: resolved.branch,
        root: resolved.root,
        head: resolved.head,
        base: resolved.base,
        comparison: resolved.comparison,
        note: `${resolved.root}\n${resolved.branch} · ${resolved.comparison}\n${resolved.unavailable || scopeNotes(scope)}${pageNote}`,
        count: files.length,
        countLabel: countLabel(files.length),
        summary: resolved.unavailable !== '' ? [] : [
            { label: 'Lines added', value: `+${addedLines.toLocaleString('en-US')}`, tone: 'positive' as const },
            { label: 'Lines removed', value: `−${deletedLines.toLocaleString('en-US')}`, tone: 'danger' as const },
        ],
        files: files.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
        scope,
        scopes: SCOPES,
        page,
        pageCount,
    };
}

/** The worktree picker, most recent branch first with the session checkout labelled. */
export function changesWorktrees(input: ChangesInput): { title: string; note: string; worktrees: ChangesWorktree[] } {
    const sessionRootValue = sessionRoot(input.cwd);
    const registered = worktreesOf(sessionRootValue);
    const recent = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], sessionRootValue).trim().split('\n');
    const rank = (entry: { root: string; branch: string }): number => {
        if (entry.root === sessionRootValue) return -1;
        const index = recent.indexOf(entry.branch);
        return index < 0 ? recent.length : index;
    };
    const ordered = [...registered].sort((a, b) => rank(a) - rank(b));
    return {
        title: 'Choose worktree',
        note: `${registered.length} registered worktrees${registered.length > 50 ? '; showing the 50 most recent' : ''}. This changes the review view, not the agent directory.`,
        worktrees: ordered.slice(0, 50).map((entry) => ({
            ...entry,
            sessionCheckout: entry.root === sessionRootValue,
            title: `${entry.branch}${entry.root === sessionRootValue ? ' · session checkout' : ''}`,
            subtitle: entry.root,
        })),
    };
}

/** One file's patch inside the selected comparison, pinned to the listed commits. */
export function changesPatch(
    input: ChangesInput & { scope?: ChangesScope; path: string; kind?: ChangesScope | 'untracked'; head?: string; base?: string },
): { title: string; note: string; patch: string } {
    const path = input.path ?? '';
    if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw new Error('Invalid repository file');
    const scope: ChangesScope = input.scope !== undefined && SCOPES.some((entry) => entry.id === input.scope) ? input.scope : 'working';
    const resolved = resolveComparison(input, scope);
    let patch: string;
    if (input.kind === 'untracked') {
        const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], resolved.root).split('\0');
        if (!untracked.includes(path)) throw new Error('This file is no longer untracked; refresh Changes');
        const stat = lstatSync(join(resolved.root, path));
        if (stat.size > 1024 * 1024 || (!stat.isFile() && !stat.isSymbolicLink())) throw new Error('File is too large for an inline diff');
        patch = git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', path], resolved.root, true);
    } else {
        const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
        if (!shaPattern.test(input.head ?? '') || !shaPattern.test(input.base ?? '')) throw new Error('Refresh Changes to select a comparison');
        const pinned = (value: string): string => value === emptyTree(resolved.root) ? value : commit(value, resolved.root);
        const head = pinned(input.head!);
        const base = pinned(input.base!);
        patch = git([...diffArgs(scope, head, base), '--', path], resolved.root);
    }
    let patchNote = '';
    if (patch.length > MAX_PATCH_CHARS) patchNote = ' · Diff truncated to 60,000 characters';
    else if (patch === '') patchNote = ' · No difference in this comparison';
    return {
        title: basename(path),
        note: `${resolved.root} · ${resolved.comparison}${patchNote}`,
        patch: patch.slice(0, MAX_PATCH_CHARS),
    };
}
