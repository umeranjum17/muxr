#!/usr/bin/env node
/**
 * Terminal-driven tools in muxr: editors and TUIs (nvim, lazygit, btop),
 * Herdr plugin panes and actions (terminal-browser, file-viewer, muxr setup),
 * and every pane that has no agent.
 *
 * muxr already routes an agent-less pane as `shell:<paneId>`, so none of this
 * needs a new transport -- open the thing in its own tab, then navigate to that
 * route. A launched pane carries the tool's name as its Herdr label, which is
 * how a later call finds it again: visible state on the pane, not a private index.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

const TOOL_PATH = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(delimiter);
const ENV = { ...process.env, PATH: TOOL_PATH };
const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';

const run = (cmd, args, timeout = 10_000) => execFileSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: ENV });
// `pane run` answers with nothing at all; every other command answers with JSON.
const call = (...args) => {
    const raw = run(herdr, args).trim();
    return raw === '' ? {} : JSON.parse(raw).result ?? {};
};
const tilde = (path) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/**
 * A terminal title is either a program announcing itself ("NVIM src/app.rs")
 * or the shell echoing `user@host:cwd`, which says nothing the cwd doesn't.
 * ponytail: prompt-shaped heuristic; swap for a foreground-process lookup if it misreads.
 */
const programTitle = (title) => (typeof title === 'string' && title !== '' && !/^\S+@\S+:/.test(title) ? title : undefined);

/** Offered only when the machine actually has them. */
const PROGRAMS = [
    { id: 'nvim', label: 'nvim', icon: 'create-outline', command: 'nvim .' },
    { id: 'vim', label: 'vim', icon: 'create-outline', command: 'vim .' },
    { id: 'lazygit', label: 'lazygit', icon: 'git-branch-outline', command: 'lazygit' },
    { id: 'tig', label: 'tig', icon: 'git-commit-outline', command: 'tig' },
    { id: 'yazi', label: 'yazi', icon: 'folder-outline', command: 'yazi' },
    { id: 'ranger', label: 'ranger', icon: 'folder-outline', command: 'ranger' },
    { id: 'btop', label: 'btop', icon: 'pulse-outline', command: 'btop' },
    { id: 'htop', label: 'htop', icon: 'pulse-outline', command: 'htop' },
    { id: 'k9s', label: 'k9s', icon: 'cube-outline', command: 'k9s' },
];
const SHELL = { id: 'shell', label: 'Shell', icon: 'terminal-outline', command: '' };

function onPath(id) {
    try { run('/usr/bin/env', ['which', id], 3000); return true; } catch { return false; }
}

const panes = () => call('pane', 'list').panes ?? [];
const agentless = () => panes().filter((pane) => !pane.agent);
const enabledPlugins = () => (call('plugin', 'list', '--json').plugins ?? []).filter((plugin) => plugin.enabled);

/** Every launchable thing, keyed by the id that `launch` accepts back. */
function catalog() {
    const entries = [...PROGRAMS.filter((program) => onPath(program.id)), SHELL]
        .map((program) => ({ ...program, kind: 'program', group: 'Tools' }));
    for (const plugin of enabledPlugins()) {
        for (const pane of plugin.panes ?? []) {
            const entrypoint = pane.pane_id ?? pane.id;
            if (entrypoint === undefined) continue;
            entries.push({
                id: `pane:${plugin.plugin_id}:${entrypoint}`,
                label: pane.title ?? entrypoint,
                icon: 'extension-puzzle-outline',
                kind: 'plugin-pane',
                group: plugin.name ?? plugin.plugin_id,
                plugin: plugin.plugin_id,
                entrypoint,
            });
        }
        for (const action of plugin.actions ?? []) {
            const actionId = action.action_id ?? action.id;
            if (actionId === undefined) continue;
            entries.push({
                id: `action:${plugin.plugin_id}:${actionId}`,
                label: action.title ?? actionId,
                icon: 'flash-outline',
                kind: 'plugin-action',
                group: plugin.name ?? plugin.plugin_id,
                plugin: plugin.plugin_id,
                actionId,
            });
        }
    }
    return entries;
}

function paneRow(pane, group) {
    const cwd = pane.foreground_cwd || pane.cwd || '';
    return {
        id: pane.pane_id,
        title: pane.label || programTitle(pane.terminal_title_stripped) || basename(cwd) || 'shell',
        subtitle: tilde(cwd),
        icon: 'terminal-outline',
        group,
        action: { type: 'kernel.navigate', target: 'session', sessionId: `shell:${pane.pane_id}` },
    };
}

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const method = process.argv[2];

if (method === 'list') {
    const labelOf = new Map((call('workspace', 'list').workspaces ?? []).map((workspace) => [workspace.workspace_id, workspace.label]));
    const items = agentless()
        .map((pane) => paneRow(pane, labelOf.get(pane.workspace_id) ?? 'Other'))
        .sort((left, right) => left.group.localeCompare(right.group) || left.id.localeCompare(right.id));
    process.stdout.write(JSON.stringify({ items }));
} else if (method === 'tools') {
    // The host injects the calling session's pane and cwd; a caller cannot choose them.
    const here = tilde(String(input.cwd ?? '') || homedir());
    // A row action carries only its declared input, so the host would enrich
    // nothing. Echo back the session the app gave us and it re-resolves the
    // pane on the launch call; the id is validated there, never trusted here.
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
    const live = new Map(agentless().filter((pane) => pane.label).map((pane) => [pane.label, pane]));
    const items = catalog().map((entry) => {
        const open = live.get(entry.label);
        return {
            id: entry.id,
            title: entry.label,
            subtitle: open ? tilde(open.foreground_cwd || open.cwd || '') : `Open in ${here}`,
            icon: entry.icon,
            group: open ? 'Running' : entry.group,
            ...(open ? { metadata: [{ value: 'running', tone: 'positive' }] } : {}),
            action: open
                ? { type: 'kernel.navigate', target: 'session', sessionId: `shell:${open.pane_id}` }
                : { type: 'plugin.call', contributionId: 'launch', input: { tool: entry.id, ...(sessionId === undefined ? {} : { sessionId }) } },
        };
    });
    // Anything already open is one tap; launching is the fallback below it.
    items.sort((left, right) => Number(right.group === 'Running') - Number(left.group === 'Running'));
    process.stdout.write(JSON.stringify({ items }));
} else if (method === 'launch') {
    const entry = catalog().find((candidate) => candidate.id === String(input.tool ?? ''));
    if (entry === undefined) throw new Error('unknown tool');
    const source = panes().find((pane) => pane.pane_id === String(input.paneId ?? ''));
    if (source === undefined) throw new Error('no calling session');
    const cwd = String(input.cwd ?? '') || source.foreground_cwd || source.cwd || homedir();

    if (entry.kind === 'plugin-action') {
        // Fire-and-forget, and the plugin picks its own placement: Herdr resolves
        // this action against the pane focused at the desk, not the phone's session.
        call('plugin', 'action', 'invoke', entry.actionId, '--plugin', entry.plugin);
    } else if (entry.kind === 'plugin-pane') {
        call('plugin', 'pane', 'open', '--plugin', entry.plugin, '--entrypoint', entry.entrypoint,
            '--placement', 'tab', '--workspace', source.workspace_id, '--cwd', cwd);
    } else {
        // Its own tab, not a split: a TUI on a phone wants the whole viewport.
        const target = call('tab', 'create', '--workspace', source.workspace_id).root_pane?.pane_id;
        if (target === undefined) throw new Error('herdr did not return a pane');
        // The label is how `tools` finds this pane next time, and it names the tab on the desk.
        call('pane', 'rename', target, entry.label);
        call('pane', 'run', target, entry.command === ''
            ? `cd ${JSON.stringify(cwd)}`
            : `cd ${JSON.stringify(cwd)} && exec ${entry.command}`);
    }
    process.stdout.write(JSON.stringify({ opened: entry.label }));
} else {
    throw new Error('unknown method');
}
