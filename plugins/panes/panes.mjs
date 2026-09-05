#!/usr/bin/env node
/**
 * Terminal-driven tools in muxr: editors and TUIs, declared Herdr panes,
 * global commands for plugins that have no pane, and every pane with no agent.
 *
 * muxr already routes an agent-less pane as `shell:<paneId>`. A launched pane
 * carries the tool's name as its Herdr label, which is how a later call finds
 * it again: visible state on the pane, not a private index.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

const TOOL_PATH = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(delimiter);
const ENV = { ...process.env, PATH: TOOL_PATH };
const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';

const run = (cmd, args, timeout = 10_000) => execFileSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: ENV });
const call = (...args) => {
    const raw = run(herdr, args).trim();
    return raw === '' ? {} : JSON.parse(raw).result ?? {};
};
const tilde = (path) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const programTitle = (title) => (typeof title === 'string' && title !== '' && !/^\S+@\S+:/.test(title) ? title : undefined);

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

function humanize(value) {
    const parts = String(value).split(/[._-]+/).filter(Boolean);
    if (parts.length === 0) return 'Untitled';
    return parts.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}

function pluginDisplayName(plugin) {
    const name = typeof plugin.name === 'string' ? plugin.name.trim() : '';
    return name === '' ? 'Extension' : name;
}

function contributionTitle(value, fallbackId) {
    const title = typeof value === 'string' ? value.trim() : '';
    return title === '' ? humanize(fallbackId) : title;
}

const panes = () => call('pane', 'list').panes ?? [];
const agentless = () => panes().filter((pane) => !pane.agent);
const enabledPlugins = () => (call('plugin', 'list', '--json').plugins ?? []).filter((plugin) => plugin.enabled);

function catalog() {
    const entries = [...PROGRAMS.filter((program) => onPath(program.id)), SHELL].map((program, index) => ({
        ...program,
        kind: 'program',
        title: program.label,
        identity: `program:${program.id}`,
        order: index,
        displayName: program.label,
    }));
    const plugins = enabledPlugins()
        .map((plugin) => ({ plugin, displayName: pluginDisplayName(plugin) }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName) || String(left.plugin.plugin_id).localeCompare(String(right.plugin.plugin_id)));
    for (const { plugin, displayName } of plugins) {
        const pluginPanes = [];
        for (const pane of plugin.panes ?? []) {
            const entrypoint = pane.pane_id ?? pane.id;
            if (entrypoint === undefined) continue;
            pluginPanes.push({
                id: `pane:${plugin.plugin_id}:${entrypoint}`,
                identity: `plugin:${plugin.plugin_id}:pane:${entrypoint}`,
                title: contributionTitle(pane.title, entrypoint),
                icon: 'extension-puzzle-outline',
                kind: 'plugin-pane',
                plugin: plugin.plugin_id,
                entrypoint,
                displayName,
            });
        }
        pluginPanes.sort((left, right) => left.title.localeCompare(right.title));
        entries.push(...pluginPanes);
        if (pluginPanes.length > 0) continue;
        const actions = [];
        for (const action of plugin.actions ?? []) {
            const actionId = action.action_id ?? action.id;
            if (actionId === undefined) continue;
            const contexts = action.contexts ?? [];
            if (!contexts.includes('global')) continue;
            actions.push({
                id: `action:${plugin.plugin_id}:${actionId}`,
                identity: `plugin:${plugin.plugin_id}:action:${actionId}`,
                title: contributionTitle(action.title, actionId),
                icon: 'flash-outline',
                kind: 'plugin-action',
                plugin: plugin.plugin_id,
                actionId,
                displayName,
            });
        }
        actions.sort((left, right) => left.title.localeCompare(right.title));
        entries.push(...actions);
    }
    return entries;
}

function paneRow(pane, group) {
    const cwd = pane.foreground_cwd || pane.cwd || '';
    return {
        id: pane.pane_id,
        title: pane.label || programTitle(pane.terminal_title_stripped) || basename(cwd) || 'Shell',
        subtitle: tilde(cwd),
        icon: 'terminal-outline',
        group,
        action: { type: 'kernel.navigate', target: 'session', sessionId: `shell:${pane.pane_id}` },
    };
}

function matchRunning(pane, launchers) {
    const programHits = launchers.filter((entry) => entry.kind === 'program' && entry.label === pane.label);
    if (programHits.length === 1) return programHits[0];
    const pluginId = typeof pane.plugin_id === 'string' ? pane.plugin_id : undefined;
    const paneId = pane.plugin_pane_id ?? pane.entrypoint ?? pane.declared_pane_id;
    if (pluginId !== undefined && paneId !== undefined) {
        return launchers.find((entry) => entry.kind === 'plugin-pane' && entry.plugin === pluginId && entry.entrypoint === paneId);
    }
    const titled = launchers.filter((entry) => entry.kind === 'plugin-pane' && entry.title === pane.label);
    return titled.length === 1 ? titled[0] : undefined;
}

function runningTitle(pane) {
    const cwd = pane.foreground_cwd || pane.cwd || '';
    return pane.label || programTitle(pane.terminal_title_stripped) || basename(cwd) || 'Shell';
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
    const here = tilde(String(input.cwd ?? '') || homedir());
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
    const launchers = [];
    const seen = new Set();
    for (const entry of catalog()) {
        if (seen.has(entry.identity)) continue;
        seen.add(entry.identity);
        launchers.push(entry);
    }
    const matched = new Set();
    const running = [];
    const runningIds = new Set();
    for (const pane of agentless()) {
        if (runningIds.has(pane.pane_id)) continue;
        runningIds.add(pane.pane_id);
        const launcher = matchRunning(pane, launchers);
        if (launcher !== undefined) matched.add(launcher.identity);
        const cwd = pane.foreground_cwd || pane.cwd || '';
        running.push({
            id: `running:${pane.pane_id}`,
            title: runningTitle(pane),
            subtitle: tilde(cwd),
            icon: launcher?.icon ?? 'terminal-outline',
            group: 'Running',
            metadata: [{ value: 'Running', tone: 'positive' }],
            action: { type: 'kernel.navigate', target: 'session', sessionId: `shell:${pane.pane_id}` },
        });
    }
    const launchInput = { tool: undefined, ...(sessionId === undefined ? {} : { sessionId }) };
    const leftover = launchers.filter((entry) => !matched.has(entry.identity));
    const terminalApps = leftover.filter((entry) => entry.kind === 'program').map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: `Start in ${here}`,
        icon: entry.icon,
        group: 'Terminal apps',
        metadata: [{ value: 'Terminal' }],
        action: { type: 'plugin.call', contributionId: 'launch', input: { ...launchInput, tool: entry.id } },
    }));
    const pluginTools = leftover.filter((entry) => entry.kind === 'plugin-pane').map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: `${entry.displayName} · Start in ${here}`,
        icon: entry.icon,
        group: 'Plugin tools',
        metadata: [{ value: 'Pane' }],
        action: { type: 'plugin.call', contributionId: 'launch', input: { ...launchInput, tool: entry.id } },
    }));
    const pluginCommands = leftover.filter((entry) => entry.kind === 'plugin-action').map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.displayName,
        icon: entry.icon,
        group: 'Plugin commands',
        metadata: [{ value: 'Command' }],
        action: { type: 'plugin.call', contributionId: 'launch', input: { ...launchInput, tool: entry.id } },
    }));
    process.stdout.write(JSON.stringify({ items: [...running, ...terminalApps, ...pluginTools, ...pluginCommands] }));
} else if (method === 'launch') {
    const entry = catalog().find((candidate) => candidate.id === String(input.tool ?? ''));
    if (entry === undefined) throw new Error('unknown tool');
    const source = panes().find((pane) => pane.pane_id === String(input.paneId ?? ''));
    if (source === undefined) throw new Error('no calling session');
    const cwd = String(input.cwd ?? '') || source.foreground_cwd || source.cwd || homedir();

    if (entry.kind === 'plugin-action') {
        call('plugin', 'action', 'invoke', entry.actionId, '--plugin', entry.plugin);
    } else if (entry.kind === 'plugin-pane') {
        call('plugin', 'pane', 'open', '--plugin', entry.plugin, '--entrypoint', entry.entrypoint,
            '--placement', 'tab', '--workspace', source.workspace_id, '--cwd', cwd);
    } else {
        const target = call('tab', 'create', '--workspace', source.workspace_id).root_pane?.pane_id;
        if (target === undefined) throw new Error('herdr did not return a pane');
        call('pane', 'rename', target, entry.label);
        call('pane', 'run', target, entry.command === ''
            ? `cd ${shellQuote(cwd)}`
            : `cd ${shellQuote(cwd)} && exec ${entry.command}`);
    }
    process.stdout.write(JSON.stringify({ opened: entry.title }));
} else {
    throw new Error('unknown method');
}
