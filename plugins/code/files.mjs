#!/usr/bin/env node
/** Bounded repository tree and text preview for the generic declarative explorer. */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const TOOL_PATH = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(delimiter);
const exec = (cmd, args, timeout = 15000) => execFileSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: TOOL_PATH } });
const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';
const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};

function repos() {
    const workspaces = JSON.parse(exec(herdr, ['workspace', 'list'])).result.workspaces ?? [];
    const panes = JSON.parse(exec(herdr, ['pane', 'list'])).result.panes ?? [];
    const seen = new Map();
    for (const workspace of workspaces) {
        const configured = workspace.worktree?.repo_root;
        const candidates = typeof configured === 'string' && configured !== ''
            ? [configured]
            : panes.filter((pane) => pane.workspace_id === workspace.workspace_id)
                .map((pane) => pane.foreground_cwd ?? pane.cwd);
        for (const candidate of new Set(candidates)) {
            if (typeof candidate !== 'string' || candidate === '') continue;
            let root;
            try { root = exec('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], 3000).trim(); }
            catch { continue; }
            if (root !== '' && !seen.has(root)) seen.set(root, { root, name: root.split('/').pop() ?? root, path: root });
        }
    }
    return [...seen.values()].slice(0, 32);
}

function repoRoot(value) {
    const found = repos().find((entry) => entry.root === String(value ?? ''));
    if (found === undefined) throw new Error('unknown repository');
    return found.root;
}

function fileTree(paths, folder = '') {
    const prefix = folder === '' ? '' : `${folder}/`;
    const nodes = new Map();
    for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest === '') continue;
        const [name, ...tail] = rest.split('/');
        const childPath = prefix + name;
        const directory = tail.length > 0;
        const existing = nodes.get(childPath);
        if (existing === undefined || directory) nodes.set(childPath, {
            name,
            path: childPath,
            kind: directory ? 'folder' : 'file',
            ...(directory ? { hasChildren: true } : {}),
        });
    }
    return [...nodes.values()]
        .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name))
        .slice(0, 256);
}

const method = process.argv[2];
if (method === 'repos') {
    const found = repos();
    process.stdout.write(JSON.stringify({ title: `${found.length} repositories`, repos: found }));
} else if (method === 'list') {
    const root = repoRoot(input.root);
    const all = exec('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    const folder = String(input.path ?? '').replace(/^\/+|\/+$/g, '');
    if (folder.split('/').some((segment) => segment === '..')) throw new Error('invalid folder');
    const tree = fileTree(all, folder);
    process.stdout.write(JSON.stringify({
        root,
        title: root.split('/').pop(),
        count: `${all.length} files`,
        tree,
    }));
} else {
    const root = repoRoot(input.root);
    const relative = String(input.path ?? '');
    const target = resolve(root, relative);
    const realRoot = realpathSync(root);
    let realTarget;
    try { realTarget = realpathSync(target); } catch { throw new Error('file unavailable'); }
    if (!realTarget.startsWith(`${realRoot}/`)) throw new Error('outside repository');
    const stat = statSync(realTarget);
    if (!stat.isFile()) throw new Error('outside repository');
    const limit = 24 * 1024;
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    const fd = openSync(realTarget, 'r');
    try { readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
    const binary = bytes.subarray(0, 4096).includes(0);
    const allLines = binary ? [] : bytes.toString('utf8').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').split('\n');
    const lines = allLines.slice(0, 240);
    const truncated = stat.size > limit || allLines.length > lines.length;
    process.stdout.write(JSON.stringify({
        name: relative,
        body: binary ? 'Binary file — preview unavailable.' : lines.join('\n'),
        note: truncated ? `Preview capped at ${lines.length} lines / 24 KiB.` : '',
    }));
}
