#!/usr/bin/env node
/**
 * Declared terminal applications in Tools; ordinary agent-less panes in Panes.
 *
 * Tools exposes enabled plugins' explicitly global actions. Pane definitions
 * alone may be setup/administration screens; they are not app launchers.
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
const programTitle = (title) => (typeof title === 'string' && title !== '' && !/^\S+@\S+:/.test(title) ? title : undefined);

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
    const entries = [];
    const plugins = enabledPlugins()
        .map((plugin) => ({ plugin, displayName: pluginDisplayName(plugin) }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName) || String(left.plugin.plugin_id).localeCompare(String(right.plugin.plugin_id)));
    for (const { plugin, displayName } of plugins) {
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
        if (actions.length === 1) actions[0].title = displayName;
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
    const launchInput = { tool: undefined, ...(sessionId === undefined ? {} : { sessionId }) };
    const pluginCommands = launchers.filter((entry) => entry.kind === 'plugin-action').map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: `Start in ${here}`,
        icon: entry.icon,
        action: { type: 'plugin.call', contributionId: 'launch', input: { ...launchInput, tool: entry.id } },
    }));
    process.stdout.write(JSON.stringify({ items: pluginCommands }));
} else if (method === 'launch') {
    const entry = catalog().find((candidate) => candidate.id === String(input.tool ?? ''));
    if (entry === undefined) throw new Error('unknown tool');
    const source = panes().find((pane) => pane.pane_id === String(input.paneId ?? ''));
    if (source === undefined) throw new Error('no calling session');

    if (entry.kind === 'plugin-action') {
        call('plugin', 'action', 'invoke', entry.actionId, '--plugin', entry.plugin);
    }
    process.stdout.write(JSON.stringify({ opened: entry.title }));
} else {
    throw new Error('unknown method');
}
