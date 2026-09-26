/** Real Herdr backend through a paired byokit device link and terminal stream. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextRequestId, newTerminalChannel } from '@muxr/contract';
import { linkHerdrLab } from './linkHerdrLab.mjs';
import { requestLab } from './linkLabClient.mjs';

const root = mkdtempSync(join(tmpdir(), 'muxr-link-herdr-'));
const workdir = join(root, 'cwd');
mkdirSync(workdir);
const pluginId = `local.action-e2e-${process.pid}`;
const pluginRoot = join(root, 'action-plugin');
mkdirSync(pluginRoot);
writeFileSync(join(pluginRoot, 'herdr-plugin.toml'), `id = "${pluginId}"
name = "Action failure e2e"
version = "0.1.0"
min_herdr_version = "0.8.0"
platforms = ["linux", "macos"]

[[actions]]
id = "fail"
title = "Fail safely"
contexts = ["pane"]
command = ["sh", "-c", "echo '/tmp/private-action w9ZZ:p9' >&2; exit 7"]
`);
writeFileSync(join(pluginRoot, 'muxr-ui.json'), `${JSON.stringify({ schemaVersion: 1, pluginId,
    contributions: [{ slot: 'session.toolbar', id: 'fail', type: 'button', label: 'Fail safely',
        action: { type: 'plugin.invoke', actionId: 'fail' } }] })}\n`);
const events = [];
let lab;
let terminal;
const workspaces = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

try {
    lab = await linkHerdrLab(root, 'herdr-e2e', (frame) => {
        if (frame?.type === 'session.event') events.push({ sessionId: frame.sessionId, event: frame.event });
    }, (herdr) => herdr(['plugin', 'link', pluginRoot, '--enabled']));
    const request = (type, params) => requestLab(lab.link, type, params);
    const herdrJson = (args) => JSON.parse(lab.herdr(args));
    const discovered = await request('session.list');
    if (!Array.isArray(discovered)) throw new Error('session.list did not return agents');
    const catalog = await request('herdr.agentKinds');
    if (!Array.isArray(catalog?.kinds) || catalog.kinds.length === 0 || catalog.kinds.length > 64
        || !catalog.kinds.every((kind) => /^[a-z][a-z0-9_-]{0,31}$/.test(kind))) throw new Error('invalid agent kinds catalog');
    process.stdout.write('ok: live Herdr catalog and session list\n');

    const shell = await request('session.start', { cwd: workdir, kind: 'shell', label: 'shell-e2e' });
    const shellId = shell?.info?.id;
    if (shell?.info?.workspaceId) workspaces.add(shell.info.workspaceId);
    if (typeof shellId !== 'string' || shell.info.agentKind !== undefined) throw new Error('phone-started Shell published an agentKind');
    const tree = await request('herdr.tree');
    const panes = tree.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
    const shellPane = panes.find((pane) => pane.sessionId === shellId);
    if (shellPane?.agentKind !== undefined) throw new Error('Shell counted as an agent in herdr.tree');
    process.stdout.write('ok: shell classification\n');

    const started = await request('session.start', { cwd: workdir, kind: 'pi', label: 'e2e' });
    const id = started?.info?.id;
    if (started?.info?.workspaceId) workspaces.add(started.info.workspaceId);
    if (typeof id !== 'string') throw new Error('session.start returned no id');
    await until(() => events.some((entry) => entry.sessionId === id && entry.event.type === 'session.created'), 'session.created');
    await until(async () => (await request('session.status', { sessionId: id }))?.promptable === true,
        'current generation promptable', 60_000);
    process.stdout.write('ok: agent generation started and promptable\n');

    const plugins = await request('plugin.list');
    const action = plugins.find((plugin) => plugin.pluginId === pluginId);
    if (typeof action?.manifestHash !== 'string') throw new Error('Herdr action fixture not discovered');
    await request('plugin.approve', { pluginId, manifestHash: action.manifestHash, approved: true });
    let bounded;
    try {
        await request('plugin.invoke', { pluginId, manifestHash: action.manifestHash,
            contributionId: 'fail', sessionId: id, idempotencyKey: `action-e2e-${Date.now().toString(36)}` });
    } catch (error) { bounded = error.message; }
    if (bounded !== 'plugin action failed') throw new Error(`action error was not bounded: ${bounded}`);
    process.stdout.write('ok: action failure bounded\n');

    let shellPaneId = shellPane?.paneId;
    if (typeof shellPaneId !== 'string') {
        const fresh = await request('herdr.tree');
        shellPaneId = fresh.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes))
            .find((pane) => pane.sessionId === shellId)?.paneId;
    }
    if (typeof shellPaneId !== 'string') throw new Error('Shell has no pane');
    const titlePanes = [shellPaneId];
    while (titlePanes.length < 3) {
        const split = herdrJson(['pane', 'split', titlePanes.at(-1), '--direction', titlePanes.length === 1 ? 'right' : 'down', '--no-focus']);
        if (typeof split.result?.pane?.pane_id !== 'string') throw new Error('pane split failed');
        titlePanes.push(split.result.pane.pane_id);
    }
    const titleSessions = [];
    await until(async () => {
        const live = await request('herdr.tree');
        const all = live.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
        titleSessions.length = 0;
        for (const paneId of titlePanes) {
            const sessionId = all.find((pane) => pane.paneId === paneId)?.sessionId;
            if (typeof sessionId === 'string') titleSessions.push(sessionId);
        }
        return titleSessions.length === titlePanes.length;
    }, 'split pane sessions');
    for (const paneId of titlePanes) lab.herdr(['pane', 'run', paneId,
        'i=0; while :; do printf "\\033]0;perf %s\\007" $((i++)); sleep 0.1; done']);
    await sleep(400);
    const mark = events.length;
    await sleep(3000);
    for (const sessionId of titleSessions) {
        const updates = events.slice(mark).filter((entry) => entry.sessionId === sessionId && entry.event.type === 'session.updated').length;
        if (updates > 6) throw new Error(`session.updated exceeded 500ms coalescing cap (${updates}/3s)`);
    }
    for (const paneId of titlePanes) { try { lab.herdr(['pane', 'send-text', paneId, '\x03']); } catch {} }
    for (const paneId of titlePanes.slice(1)) { try { lab.herdr(['pane', 'close', paneId]); } catch {} }
    process.stdout.write('ok: title updates coalesced\n');

    const channel = newTerminalChannel();
    terminal = await lab.link.stream('terminal', { sessionId: id, channel, requestId: nextRequestId('lab'),
        cols: 100, rows: 30 });
    const frames = [];
    let attached;
    let streamError;
    let partial = '';
    const decoder = new TextDecoder();
    terminal.onData = (bytes) => {
        partial += decoder.decode(bytes, { stream: true });
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
            const frame = JSON.parse(line);
            if (frame.type === 'result') {
                if (frame.ok) attached = frame.data;
                else streamError = frame.error;
            }
            if (frame.type === 'terminal.frame') frames.push(frame);
        }
    };
    await until(() => { if (streamError) throw new Error(streamError); return attached?.paneId; }, 'terminal.attach result');
    await until(() => frames.length > 0, 'terminal initial paint');
    const marker = `e2e${Date.now().toString(36)}`;
    await terminal.write(`${JSON.stringify({ type: 'terminal.input', text: marker })}\n`);
    await until(() => Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes, 'base64'))).toString('utf8').includes(marker),
        'typed input echoed in terminal frames');
    process.stdout.write('ok: terminal paint and input over link stream\n');

    await request('session.prompt', { sessionId: id, text: 'say nothing' });
    await request('session.abort', { sessionId: id });
    terminal.end();
    terminal = undefined;
    await request('session.stop', { sessionId: id });
    process.stdout.write('PASS e2e: Herdr backend loop over link\n');
} finally {
    terminal?.end();
    if (lab !== undefined) {
        for (const workspace of workspaces) { try { lab.herdr(['workspace', 'close', workspace]); } catch {} }
        try { lab.herdr(['plugin', 'unlink', pluginId]); } catch {}
        await lab.stop();
    }
    rmSync(root, { recursive: true, force: true });
}
