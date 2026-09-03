/**
 * e2e: herdr backend, the whole loop.
 *
 * Spawns its own relay and a real (non-fake) host against the live herdr server,
 * then proves:
 *   1. session.list discovers agents herdr already knows about
 *   2. session.start -> snapshot + session.created once herdr detects the agent
 *   3. terminal.attach -> live frame stream with its initial paint
 *   4. typed input reaches the pane and echoes back
 *   5. prompt / abort / detach / stop round-trip
 *   6. title-only session.updated stays under the 500ms host cap
 *   7. an inline Kitty APC reaches the client as a graphics frame
 *
 * Needs a running `herdr server`. Run: node scripts/diagnostics/application/checkHerdrE2E.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import WebSocket from 'ws';
import {
    decodePayload,
    encodePayload,
    newTerminalChannel,
    nextRequestId,
    terminalSocketUrl,
} from '@muxr/contract';
import { waitForRelay } from './waitForRelay.mjs';
import { packagedCloseAvailable } from './packagedCloseAvailable.mjs';

const PORT = String(8890 + Math.floor(Math.random() * 40));
const relayUrl = `ws://127.0.0.1:${PORT}`;
const machineId = `herdr-check-${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-herdr-'));
const workdir = mkdtempSync(join(tmpdir(), 'muxr-cwd-'));
const TIMEOUT_MS = 120_000;

const children = [];
const actionPluginId = `local.action-e2e-${process.pid}`;
const actionPluginRoot = join(dataDir, 'action-plugin');
mkdirSync(actionPluginRoot);
writeFileSync(join(actionPluginRoot, 'herdr-plugin.toml'), `id = "${actionPluginId}"
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
writeFileSync(join(actionPluginRoot, 'muxr-ui.json'), `${JSON.stringify({
    schemaVersion: 1,
    pluginId: actionPluginId,
    contributions: [{
        slot: 'session.toolbar', id: 'fail', type: 'button', label: 'Fail safely',
        action: { type: 'plugin.invoke', actionId: 'fail' },
    }],
}, null, 2)}\n`);
execFileSync(process.env.HERDR_BIN || 'herdr', ['plugin', 'link', actionPluginRoot, '--enabled'], { stdio: 'ignore' });
const env = { ...process.env };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_AUTH']) {
    delete env[key];
}
Object.assign(env, {
    MUXR_MODE: 'local',
    MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT,
    MUXR_RELAY_URL: relayUrl,
    MUXR_MACHINE_ID: machineId,
    MUXR_DATA_DIR: dataDir,
    MUXR_RELAY_DATA_DIR: join(dataDir, 'relay'),
});

function start(name, args) {
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`      [${name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`      [${name}] ${d}`));
    children.push(child);
}

let wireSeq = 0;
const pending = new Map();
const events = [];
let sessionList = [];
let createdWorkspaceId;
let previousWorkspaceId;
let finishing = false;
const timer = setTimeout(() => finish(1, `FAIL: timed out after ${TIMEOUT_MS}ms\n`), TIMEOUT_MS);

function fail(message) {
    finish(1, `FAIL: ${message}\n`);
}

function finish(code, message) {
    if (finishing) return;
    finishing = true;
    clearTimeout(timer);
    for (const child of children) child.kill();
    if (previousWorkspaceId !== undefined) {
        try {
            execFileSync(process.env.HERDR_BIN || 'herdr', ['workspace', 'focus', previousWorkspaceId], { stdio: 'ignore' });
        } catch { /* best effort after a failed live server */ }
    }
    if (createdWorkspaceId !== undefined) {
        try {
            execFileSync(process.env.HERDR_BIN || 'herdr', ['workspace', 'close', createdWorkspaceId], { stdio: 'ignore' });
        } catch { /* best effort after a failed live server */ }
    }
    try {
        execFileSync(process.env.HERDR_BIN || 'herdr', ['plugin', 'unlink', actionPluginId], { stdio: 'ignore' });
    } catch { /* best effort after a failed live server */ }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    process.stdout.write(message);
    process.exit(code);
}

process.once('SIGINT', () => finish(130, 'INTERRUPTED e2e: herdr backend loop\n'));
process.once('SIGTERM', () => finish(143, 'TERMINATED e2e: herdr backend loop\n'));

function request(socket, type, params) {
    const requestId = nextRequestId();
    return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        send(socket, { type, requestId, params });
    });
}

function send(socket, frame, sessionId) {
    wireSeq += 1;
    const envelope = {
        header: { machineId, ...(sessionId === undefined ? {} : { sessionId }), seq: wireSeq, at: Date.now() },
        payload: encodePayload(frame),
    };
    socket.send(JSON.stringify(envelope));
}

function runHerdr(args, timeout = 10_000) {
    return execFileSync(process.env.HERDR_BIN || 'herdr', args, { encoding: 'utf8', timeout });
}

function herdrJson(args, timeout = 10_000) {
    return JSON.parse(runHerdr(args, timeout));
}

start('relay', ['apps/relay/dist/main.js']);
await waitForRelay(PORT);
start('host', ['apps/host/dist/main.js']);
await new Promise((resolve) => setTimeout(resolve, 1500));

const socket = new WebSocket(`${relayUrl}?role=client&machineId=${machineId}`);

socket.on('open', async () => {
    try {
        await run();
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
});

socket.on('message', (raw) => {
    let envelope;
    try {
        envelope = JSON.parse(String(raw));
    } catch {
        return;
    }
    const frame = decodePayload(envelope.payload);
    if (frame?.type === 'result') {
        const entry = pending.get(frame.requestId);
        if (entry === undefined) return;
        pending.delete(frame.requestId);
        frame.ok ? entry.resolve(frame.data) : entry.reject(new Error(frame.error ?? 'request failed'));
        return;
    }
    if (frame?.type === 'session.event') {
        events.push({ sessionId: frame.sessionId, event: frame.event });
        return;
    }
    if (frame?.type === 'session.list') {
        sessionList = frame.sessions ?? [];
    }
});

async function run() {
    // 1. discovery: whatever herdr already knows about shows up without asking
    send(socket, { type: 'client.hello', clientId: 'herdr-e2e' });
    const discovered = await request(socket, 'session.list', {});
    console.log(`ok: session.list returned ${discovered.length} herdr session(s)`);
    const catalog = await request(socket, 'herdr.agentKinds', {});
    if (!Array.isArray(catalog?.kinds) || catalog.kinds.length === 0 || catalog.kinds.length > 64
        || !catalog.kinds.every((kind) => /^[a-z][a-z0-9_-]{0,31}$/.test(kind))) fail('herdr.agentKinds returned an invalid catalog');
    console.log(`ok: herdr.agentKinds returned ${catalog.kinds.length} host-supported kind(s)`);

    const terminalOpenedShell = discovered.find((session) => session.agentKind === undefined);
    const phoneShell = await request(socket, 'session.start', { cwd: workdir, kind: 'shell', label: 'shell-e2e' });
    const shellId = phoneShell?.info?.id;
    createdWorkspaceId = phoneShell?.info?.workspaceId;
    if (typeof shellId !== 'string' || phoneShell.info.agentKind !== undefined) {
        fail('phone-started Shell published an agentKind');
    }
    const shellTree = await request(socket, 'herdr.tree', {});
    const treePanes = shellTree.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
    const phoneShellPane = treePanes.find((pane) => pane.sessionId === shellId);
    if (phoneShellPane?.agentKind !== undefined) fail('phone-started Shell counted as an agent in herdr.tree');
    if (terminalOpenedShell !== undefined) {
        const terminalShellPane = treePanes.find((pane) => pane.sessionId === terminalOpenedShell.id);
        if (terminalShellPane?.agentKind !== undefined) fail('terminal-opened Shell disagreed with phone-started Shell');
    }
    console.log('ok: phone-started and terminal-opened Shell omit agentKind');

    // 2. session.start publishes the Herdr generation before it becomes promptable.
    const started = await request(socket, 'session.start', { cwd: workdir, kind: 'pi', label: 'e2e' });
    const newId = started?.info?.id;
    createdWorkspaceId = started?.info?.workspaceId;
    if (typeof newId !== 'string') fail('session.start returned no session id');
    console.log(`ok: session.start returned current generation (promptable ${String(started?.status?.promptable)})`);
    await waitFor(
        () => events.some((entry) => entry.sessionId === newId && entry.event.type === 'session.created'),
        'session.created event',
        40_000,
    );
    const readyDeadline = Date.now() + 60_000;
    while (true) {
        const current = await request(socket, 'session.status', { sessionId: newId });
        if (current?.promptable === true) break;
        if (Date.now() >= readyDeadline) fail('started Herdr generation never became promptable');
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log('ok: current Herdr generation became promptable');

    // A real failing Herdr action must travel invoke -> log -> bounded public error.
    const plugins = await request(socket, 'plugin.list', {});
    const actionPlugin = plugins.find((plugin) => plugin.pluginId === actionPluginId);
    if (typeof actionPlugin?.manifestHash !== 'string') fail('action failure fixture was not discovered');
    await request(socket, 'plugin.approve', {
        pluginId: actionPluginId, manifestHash: actionPlugin.manifestHash, approved: true,
    });
    let actionFailure;
    try {
        await request(socket, 'plugin.invoke', {
            pluginId: actionPluginId,
            manifestHash: actionPlugin.manifestHash,
            contributionId: 'fail',
            sessionId: newId,
            idempotencyKey: `action-e2e-${Date.now().toString(36)}`,
        });
    } catch (cause) {
        actionFailure = cause instanceof Error ? cause.message : String(cause);
    }
    if (actionFailure !== 'plugin action failed') fail(`action failure was not bounded: ${actionFailure ?? 'request succeeded'}`);
    console.log('ok: failed Herdr action returned a bounded client error through its real log');

    // Title-only session.updated is coalesced to 500ms; a raw 10 Hz OSC 0
    // would otherwise flood the phone store the way the release regression did.
    let shellPaneId = phoneShellPane?.paneId;
    if (typeof shellPaneId !== 'string') {
        const tree = await request(socket, 'herdr.tree', {});
        const panes = tree.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
        shellPaneId = panes.find((pane) => pane.sessionId === shellId)?.paneId;
    }
    if (typeof shellPaneId !== 'string') fail('phone-started Shell has no pane');
    const animatorPaneIds = [shellPaneId];
    while (animatorPaneIds.length < 3) {
        const split = herdrJson(['pane', 'split', animatorPaneIds.at(-1), '--direction', animatorPaneIds.length === 1 ? 'right' : 'down', '--no-focus']);
        const paneId = split.result?.pane?.pane_id;
        if (typeof paneId !== 'string') fail('pane split returned no pane id');
        animatorPaneIds.push(paneId);
    }
    const coalesceSessions = [];
    const sessionDeadline = Date.now() + 12_000;
    while (true) {
        const tree = await request(socket, 'herdr.tree', {});
        const panes = tree.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
        coalesceSessions.length = 0;
        for (const paneId of animatorPaneIds) {
            const sessionId = panes.find((pane) => pane.paneId === paneId)?.sessionId;
            if (typeof sessionId === 'string') coalesceSessions.push(sessionId);
        }
        if (coalesceSessions.length === animatorPaneIds.length) break;
        if (Date.now() >= sessionDeadline) fail('split panes never published session ids');
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const titleAnimator = 'i=0; while :; do printf "\\033]0;perf %s\\007" $((i++)); sleep 0.1; done';
    for (const paneId of animatorPaneIds) {
        runHerdr(['pane', 'run', paneId, titleAnimator]);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const coalesceMark = events.length;
    const coalesceWindowMs = 3_000;
    await new Promise((resolve) => setTimeout(resolve, coalesceWindowMs));
    const watched = new Set(coalesceSessions);
    const coalesceCounts = new Map(coalesceSessions.map((sessionId) => [sessionId, 0]));
    let coalesceFrames = 0;
    for (const entry of events.slice(coalesceMark)) {
        if (entry.event?.type !== 'session.updated' || !watched.has(entry.sessionId)) continue;
        coalesceCounts.set(entry.sessionId, (coalesceCounts.get(entry.sessionId) ?? 0) + 1);
        coalesceFrames += 1;
    }
    const coalesceSeconds = coalesceWindowMs / 1000;
    for (const [sessionId, count] of coalesceCounts) {
        if (count * 1000 > 2 * coalesceWindowMs) {
            fail(`session.updated exceeded the coalescing cap (${count} frames / ${coalesceSeconds}s for ${sessionId})`);
        }
    }
    console.log(`ok: session.updated stayed under the coalescing cap (${coalesceFrames} frames / ${coalesceSeconds}s for ${coalesceCounts.size} sessions)`);
    for (const paneId of animatorPaneIds) {
        try {
            runHerdr(['pane', 'send-text', paneId, '\x03'], 5_000);
        } catch { /* pane may already have exited */ }
    }
    for (const paneId of animatorPaneIds.slice(1)) {
        try {
            runHerdr(['pane', 'close', paneId], 5_000);
        } catch { /* best effort before the workspace close */ }
    }

    // 3. terminal.attach -> frames
    const channel = newTerminalChannel();
    const attached = await request(socket, 'terminal.attach', {
        sessionId: newId, channel, cols: 100, rows: 30, cellWidthPx: 8, cellHeightPx: 16,
    });
    if (typeof attached?.paneId !== 'string') fail('terminal.attach returned no paneId');
    const term = new WebSocket(terminalSocketUrl(relayUrl, { machineId, channel, role: 'client' }));
    const frames = [];
    let closed = false;
    term.on('message', (raw) => {
        try {
            const frame = JSON.parse(String(raw));
            if (frame.type === 'terminal.frame') frames.push(frame);
            if (frame.type === 'terminal.closed') closed = true;
        } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => {
        term.once('open', resolve);
        term.once('error', reject);
    });
    await waitFor(() => frames.length > 0, 'terminal.frame stream');
    console.log(`ok: terminal stream live (${frames.length} frame(s))`);

    // 4. input round-trip: type into the pane and look for the echo in frames
    const marker = `e2e${Date.now().toString(36)}`;
    term.send(JSON.stringify({ type: 'terminal.input', text: marker }));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const text = Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes, 'base64'))).toString('utf8');
    if (!text.includes(marker)) fail(`typed input never echoed back (${frames.length} frames, ${text.length} bytes)`);
    console.log('ok: input echoed back through the terminal stream');

    // Graphics needs cell metrics on attach; Herdr then forwards the pane's
    // own Kitty APC as a graphics:true frame. printf has to run in a shell,
    // so this attach is the phone-started Shell, not the Pi generation.
    const kittyChannel = newTerminalChannel();
    const kittyAttached = await request(socket, 'terminal.attach', {
        sessionId: shellId, channel: kittyChannel, cols: 100, rows: 30, cellWidthPx: 8, cellHeightPx: 16,
    });
    if (typeof kittyAttached?.paneId !== 'string') fail('Kitty terminal.attach returned no paneId');
    const kittyTerm = new WebSocket(terminalSocketUrl(relayUrl, { machineId, channel: kittyChannel, role: 'client' }));
    const kittyFrames = [];
    kittyTerm.on('message', (raw) => {
        try {
            const frame = JSON.parse(String(raw));
            if (frame.type === 'terminal.frame') kittyFrames.push(frame);
        } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Kitty terminal socket never opened')), 5_000);
        kittyTerm.once('open', () => { clearTimeout(timer); resolve(); });
        kittyTerm.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    await waitFor(() => kittyFrames.length > 0, 'Kitty pane terminal.frame stream');
    const listed = herdrJson(['workspace', 'list']);
    previousWorkspaceId = listed.result?.workspaces?.find((workspace) => workspace.focused === true)?.workspace_id;
    const shellPane = herdrJson(['pane', 'get', kittyAttached.paneId]);
    const shellWorkspaceId = shellPane.result?.pane?.workspace_id;
    const shellTabId = shellPane.result?.pane?.tab_id;
    if (typeof shellWorkspaceId !== 'string' || typeof shellTabId !== 'string') fail('Kitty pane has no workspace/tab');
    runHerdr(['workspace', 'focus', shellWorkspaceId]);
    runHerdr(['tab', 'focus', shellTabId]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const kittyPayload = deflateSync(Buffer.alloc(16)).toString('base64');
    const kittyPrintf = `printf '\\033_Ga=T,f=32,s=2,v=2,t=d,o=z,i=9,c=4,r=2;${kittyPayload}\\033\\\\'`;
    runHerdr(['pane', 'run', kittyAttached.paneId, kittyPrintf]);
    const kittyDeadline = Date.now() + 5_000;
    while (!kittyFrames.some((frame) => frame.graphics === true)) {
        if (Date.now() >= kittyDeadline) {
            const arrived = kittyFrames.slice(-8).map((frame) => ({
                graphics: frame.graphics === true,
                reason: frame.graphicsReason,
                bytes: typeof frame.bytes === 'string' ? frame.bytes.length : 0,
                full: frame.full === true,
            }));
            fail(`inline Kitty never arrived as a graphics frame (${JSON.stringify(arrived)})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log('ok: inline Kitty reached the client as a graphics frame');
    kittyTerm.close();
    await request(socket, 'terminal.detach', { sessionId: shellId, channel: kittyChannel });
    if (previousWorkspaceId !== undefined) {
        try {
            runHerdr(['workspace', 'focus', previousWorkspaceId], 5_000);
        } catch { /* restore is best effort; finish() retries */ }
        previousWorkspaceId = undefined;
    }

    // 5. prompt + abort round-trip (ack-only requests)
    await request(socket, 'session.prompt', { sessionId: newId, text: 'say nothing' });
    console.log('ok: session.prompt acked');
    await request(socket, 'session.abort', { sessionId: newId });
    console.log('ok: session.abort acked');

    // 6. detach + stop
    term.close();
    await request(socket, 'terminal.detach', { sessionId: newId, channel });
    const closable = packagedCloseAvailable();
    if (closable.ok) {
        await request(socket, 'session.stop', { sessionId: newId });
        console.log('ok: detach + stop');
    } else {
        try {
            runHerdr(['pane', 'close', attached.paneId], 5_000);
        } catch { /* the workspace close below still collects it */ }
        console.log(`SKIP: session.stop (${closable.reason})`);
    }

    finish(0, 'PASS e2e: herdr backend loop\n');
}

async function waitFor(predicate, label, budgetMs = 12_000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
