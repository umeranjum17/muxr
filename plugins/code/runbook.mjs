#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const method = process.argv[2];
const stateDir = process.env.MUXR_PLUGIN_STATE_DIR;
if (!stateDir) throw new Error('MUXR_PLUGIN_STATE_DIR is required');
const file = join(stateDir, 'commands.json');
const TOOL_PATH = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(delimiter);
const runFile = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: TOOL_PATH } });

function commands() {
    if (!existsSync(file)) {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(file, JSON.stringify([
            { id: 'status', label: 'Git status', run: 'git status --short' },
            { id: 'disk', label: 'Disk usage', run: 'df -h .' },
            { id: 'agents', label: 'Running agents', run: 'herdr agent list' },
        ], null, 2), { mode: 0o600 });
    }
    return JSON.parse(readFileSync(file, 'utf8'));
}

function repoRoots() {
    const workspaces = JSON.parse(runFile('herdr', ['workspace', 'list'])).result.workspaces ?? [];
    const panes = JSON.parse(runFile('herdr', ['pane', 'list'])).result.panes ?? [];
    const roots = new Set();
    for (const workspace of workspaces) {
        const configured = workspace.worktree?.repo_root;
        const candidates = typeof configured === 'string' && configured !== ''
            ? [configured]
            : panes.filter((pane) => pane.workspace_id === workspace.workspace_id)
                .map((pane) => pane.foreground_cwd ?? pane.cwd);
        for (const candidate of new Set(candidates)) {
            if (typeof candidate !== 'string' || candidate === '') continue;
            try { roots.add(runFile('git', ['-C', candidate, 'rev-parse', '--show-toplevel']).trim()); }
            catch { /* a pane can leave a repository while this list is built */ }
        }
    }
    return [...roots].filter((root) => root !== '' && existsSync(root)).slice(0, 24);
}

function folderTree() {
    const nodes = [];
    const seen = new Set();
    const roots = repoRoots();
    const aliases = new Map();
    const aliasCounts = new Map();
    for (const root of roots) {
        const name = basename(root) || 'repository';
        const count = (aliasCounts.get(name) ?? 0) + 1;
        aliasCounts.set(name, count);
        aliases.set(root, `~/${name}${count === 1 ? '' : ` ${count}`}`);
    }
    const perRoot = Math.max(8, Math.floor(256 / Math.max(1, roots.length)));
    for (const root of roots) {
        if (nodes.length >= 256) break;
        const rootStart = nodes.length;
        const rootAlias = aliases.get(root);
        nodes.push({ name: basename(root) || 'repository', path: rootAlias, actual: root, kind: 'folder' });
        seen.add(root);
        let files = [];
        try { files = runFile('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).slice(0, 600); }
        catch { /* an existing workspace may stop being a git checkout mid-read */ }
        const paths = new Set();
        for (const path of files) {
            const parts = path.split('/').slice(0, -1);
            for (let index = 1; index <= parts.length; index += 1) paths.add(parts.slice(0, index).join('/'));
        }
        for (const relative of [...paths].sort()) {
            if (nodes.length >= 256 || nodes.length - rootStart >= perRoot) break;
            const actual = join(root, relative);
            if (seen.has(actual)) continue;
            const parentRelative = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
            nodes.push({
                name: relative.split('/').pop(),
                path: join(rootAlias, relative),
                actual,
                kind: 'folder',
                parent: parentRelative === '' ? rootAlias : join(rootAlias, parentRelative),
            });
            seen.add(actual);
        }
    }
    return nodes;
}

function publicFolders(tree) {
    return tree.map(({ actual: _actual, ...node }) => node);
}

function selectedFolder(tree, value) {
    return tree.find((node) => node.path === value)?.actual;
}

if (method === 'list') {
    const items = commands().slice(0, 32).map((entry) => ({ ...entry, subtitle: entry.run }));
    process.stdout.write(JSON.stringify({ title: `${items.length} commands`, items }));
} else if (method === 'detail') {
    const found = commands().find((entry) => entry.id === String(input.id ?? ''));
    const folders = folderTree();
    process.stdout.write(JSON.stringify({ ...(found ?? { label: 'Unknown', run: '', id: '' }), cwd: folders[0]?.path ?? '', folders: publicFolders(folders) }));
} else {
    const found = commands().find((entry) => entry.id === String(input.id ?? ''));
    if (found === undefined) throw new Error('unknown command');
    const folders = folderTree();
    const cwd = selectedFolder(folders, String(input.folder ?? ''));
    if (cwd === undefined) throw new Error('choose an available folder');
    const out = execSync(found.run, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024 });
    process.stdout.write(JSON.stringify(out.trim().slice(-3000) || 'done'));
}
