/**
 * Bounded repository tree and text preview. Product code (the browse half of
 * the extracted Files add-on's files.mjs, ported with its flow tests).
 * Read-only: every command here is a git read or a bounded file read; nothing
 * mutates the repository or the index.
 *
 * Trust boundary: the caller supplies only the sessionId; the dispatcher
 * injects the session cwd. A caller-chosen `root` is honored only when it is
 * the session repository itself (single-repo sessions resolve there anyway).
 * File reads stay inside the repository root (symlinks resolved), capped at
 * 24 KiB / 240 lines, with binary files reported as unavailable.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';

export interface FilesInput {
    sessionId: string;
    cwd: string;
    root?: string;
}

export interface FilesRepo {
    root: string;
    name: string;
    path: string;
}

export interface FilesTreeNode {
    name: string;
    path: string;
    kind: 'folder' | 'file';
    hasChildren?: boolean;
}

const PREVIEW_BYTES = 24 * 1024;
const PREVIEW_LINES = 240;
/** Control characters stripped from text previews (the NUL byte flags binary). */
const FILES_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_REPOS = 32;
const MAX_TREE_NODES = 256;

function git(args: string[], directory: string, timeout = 15000): string {
    return execFileSync('git', ['--literal-pathspecs', '-C', directory, ...args], {
        encoding: 'utf8',
        input: '',
        timeout,
        maxBuffer: 4 * 1024 * 1024,
    });
}

/** The session checkout's repository; a caller can never choose it. */
function sessionRoot(cwd: string): string {
    if (cwd === '' || cwd.includes('\0')) throw new Error('No session directory for this session');
    const root = git(['rev-parse', '--show-toplevel'], cwd, 3000).trim();
    if (root === '') throw new Error('unknown repository');
    return root;
}

/** Every repository open across the host's sessions, folders first upstream. */
export function filesRepos(cwds: string[]): { title: string; repos: FilesRepo[] } {
    const seen = new Map<string, FilesRepo>();
    for (const candidate of cwds) {
        if (candidate === '' || candidate.includes('\0')) continue;
        let root: string;
        try {
            root = git(['rev-parse', '--show-toplevel'], candidate, 3000).trim();
        } catch {
            continue;
        }
        if (root === '' || seen.has(root)) continue;
        seen.set(root, { root, name: root.split('/').pop() ?? root, path: root });
    }
    const repos = [...seen.values()].slice(0, MAX_REPOS);
    return { title: `${repos.length} repositories`, repos };
}

/** Resolve the requested root, or the session checkout when absent. An
 *  explicit root is honored only when it is a repository open in some
 *  session; otherwise callers could browse anywhere on the host. */
function selectedRoot(cwd: string, allowedRoots: readonly string[], root?: string): string {
    const requested = String(root ?? '');
    if (requested !== '') {
        if (requested.includes('\0')) throw new Error('unknown repository');
        if (allowedRoots.includes(requested)) return requested;
        try {
            const real = realpathSync(requested);
            if (allowedRoots.includes(real)) return real;
        } catch {
            // Not resolvable: unknown repository below.
        }
        throw new Error('unknown repository');
    }
    return sessionRoot(cwd);
}

function fileTree(paths: string[], folder = ''): { tree: FilesTreeNode[]; total: number; note: string } {
    const prefix = folder === '' ? '' : `${folder}/`;
    const nodes = new Map<string, FilesTreeNode>();
    for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest === '') continue;
        const segments = rest.split('/');
        const name = segments[0] ?? '';
        if (name === '') continue;
        const childPath = prefix + name;
        const directory = segments.length > 1;
        const existing = nodes.get(childPath);
        if (existing === undefined || directory) {
            nodes.set(childPath, {
                name,
                path: childPath,
                kind: directory ? 'folder' : 'file',
                ...(directory ? { hasChildren: true as const } : {}),
            });
        }
    }
    const sorted = [...nodes.values()].sort(
        (a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name),
    );
    const tree = sorted.slice(0, MAX_TREE_NODES);
    return {
        tree,
        total: sorted.length,
        note: sorted.length > tree.length ? `Showing first ${MAX_TREE_NODES} of ${sorted.length}` : '',
    };
}

export function filesList(input: FilesInput & { path?: string; allowedRoots?: readonly string[] }): {
    root: string;
    title: string;
    count: string;
    tree: FilesTreeNode[];
    treeNote: string;
} {
    const root = selectedRoot(input.cwd, input.allowedRoots ?? [], input.root);
    const all = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root)
        .split('\0')
        .filter(Boolean);
    const folder = String(input.path ?? '').replace(/^\/+|\/+$/g, '');
    if (folder.split('/').some((segment) => segment === '..')) throw new Error('invalid folder');
    const listed = fileTree(all, folder);
    return {
        root,
        title: root.split('/').pop() ?? root,
        count: `${all.length} files`,
        tree: listed.tree,
        treeNote: listed.note,
    };
}

export function filesRead(input: FilesInput & { path?: string; allowedRoots?: readonly string[] }): {
    name: string;
    path: string;
    body: string;
    note: string;
} {
    const root = selectedRoot(input.cwd, input.allowedRoots ?? [], input.root);
    const relative = String(input.path ?? '');
    const target = `${root}/${relative}`;
    const realRoot = realpathSync(root);
    let realTarget: string;
    try {
        realTarget = realpathSync(target);
    } catch {
        throw new Error('file unavailable');
    }
    if (!realTarget.startsWith(`${realRoot}/`)) throw new Error('outside repository');
    const stat = statSync(realTarget);
    if (!stat.isFile()) throw new Error('outside repository');
    const bytes = Buffer.alloc(Math.min(stat.size, PREVIEW_BYTES));
    const fd = openSync(realTarget, 'r');
    try {
        readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
        closeSync(fd);
    }
    const binary = bytes.subarray(0, 4096).includes(0);
    const allLines = binary
        ? []
        : bytes
            .toString('utf8')
            .replace(FILES_CONTROL_CHARS, '')
            .split('\n');
    const lines = allLines.slice(0, PREVIEW_LINES);
    const truncated = stat.size > PREVIEW_BYTES || allLines.length > lines.length;
    return {
        name: relative.split('/').pop() ?? relative,
        path: relative,
        body: binary ? 'Binary file — preview unavailable.' : lines.join('\n'),
        note: truncated ? `Preview capped at ${lines.length} lines / 24 KiB.` : '',
    };
}
