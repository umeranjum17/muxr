#!/usr/bin/env node
/**
 * Declared terminal applications in Tools; ordinary agent-less panes in Panes.
 *
 * Tools exposes enabled plugins' explicitly global actions. Pane definitions
 * alone may be setup/administration screens; they are not app launchers.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

const TOOL_PATH = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(delimiter);
const ENV = { ...process.env, PATH: TOOL_PATH };
const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';

let operationDeadline = Infinity;
const run = (cmd, args, timeout = 10_000, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: Math.max(1, Math.min(timeout, operationDeadline - Date.now())), maxBuffer: 4 * 1024 * 1024, env: ENV, ...options });
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
                command: action.command,
                pluginRoot: plugin.plugin_root,
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
    operationDeadline = Date.now() + 24000;
    const entry = catalog().find((candidate) => candidate.id === String(input.tool ?? ''));
    if (entry === undefined) throw new Error('unknown tool');
    const source = panes().find((pane) => pane.pane_id === String(input.paneId ?? ''));
    if (source === undefined) throw new Error('no calling session');

    if (!Array.isArray(entry.command) || entry.command.length === 0 || !entry.command.every((part) => typeof part === 'string' && part.length > 0)
        || typeof entry.pluginRoot !== 'string' || !entry.pluginRoot.startsWith('/')) throw new Error('Tool launch command is unavailable. Reinstall its plugin.');
    // Give every launch an owned tab. An action may split its anchor; its
    // result can never be confused with an unrelated pane created elsewhere.
    const created = call('tab', 'create', '--workspace', source.workspace_id, '--cwd', String(input.cwd || source.cwd || homedir()), '--label', entry.title, '--no-focus');
    const anchor = created.root_pane?.pane_id;
    const tabId = created.tab?.tab_id;
    if (!anchor || !tabId) throw new Error('Could not create a pane for this tool.');
    const context = { workspace_id: source.workspace_id, tab_id: tabId, focused_pane_id: anchor, focused_pane_cwd: String(input.cwd || source.cwd || homedir()), invocation_source: 'muxr' };
    const actionEnv = {
        HOME: homedir(), PATH: TOOL_PATH,
        HERDR_ENV: '1', HERDR_BIN_PATH: herdr,
        HERDR_WORKSPACE_ID: source.workspace_id, HERDR_TAB_ID: tabId, HERDR_PANE_ID: anchor,
        HERDR_PLUGIN_ID: entry.plugin, HERDR_PLUGIN_ACTION_ID: entry.actionId,
        HERDR_PLUGIN_ROOT: entry.pluginRoot, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
        ...(process.env.HERDR_SOCKET_PATH ? { HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH } : {}),
    };
    // Run only the currently enabled plugin's declared argv, without a shell
    // interpolation. The GUI daemon's inherited PATH may omit user installs.
    // This uses the same bounded launcher PATH as discovery, and reports the
    // actual exit instead of acknowledging an asynchronous invocation as done.
    try {
        const argv = entry.command.map((part) => {
            if (isAbsolute(part) || part.startsWith('-')) return part;
            const path = resolve(entry.pluginRoot, part);
            try { return statSync(path).isFile() ? path : part; } catch { return part; }
        });
        run(argv[0], argv.slice(1), 15000, { cwd: context.focused_pane_cwd, env: actionEnv });
        const deadline = Date.now() + 5000;
        let targets = [];
        do {
            targets = panes().filter((pane) => pane.tab_id === tabId && pane.pane_id !== anchor);
            if (targets.length) break;
            await new Promise((done) => setTimeout(done, 150));
        } while (Date.now() < deadline);
        if (targets.length !== 1) throw new Error('Tool did not create one identifiable pane.');
        call('pane', 'close', anchor);
        process.stdout.write(JSON.stringify({ opened: entry.title, navigation: { type: 'kernel.navigate', target: 'session', sessionId: `shell:${targets[0].pane_id}` } }));
    } catch (cause) {
        operationDeadline = Math.min(operationDeadline + 3000, Date.now() + 3000);
        const remaining = panes().filter((pane) => pane.tab_id === tabId && pane.pane_id !== anchor);
        if (!remaining.length) call('pane', 'close', anchor);
        process.stderr.write(`${entry.title} launch failed: ${String(cause?.message ?? cause).slice(0, 1000)}\n`);
        throw new Error(remaining.length
            ? 'The tool did not finish starting. Its pane is available in Panes; check its output before retrying.'
            : 'The tool could not start. Check that its command is installed and runnable on the host, then try again.');
    }
} else {
    throw new Error('unknown method');
}
