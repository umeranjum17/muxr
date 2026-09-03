/**
 * One flow: our real relay and host, a faked Herdr underneath, a real client on
 * top. It proves the three things the release gate depends on, without a phone:
 * the herd is discoverable, a terminal attach streams frames, and title churn
 * arrives as coalesced session updates.
 *
 * Run: node perf/fake-herdr/stack.smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodePayload, encodePayload, newTerminalChannel, nextRequestId, terminalSocketUrl } from '@muxr/contract';
import { waitForRelay } from '../../scripts/diagnostics/application/waitForRelay.mjs';
import { startFakeHerdr } from './server.mjs';

const PORT = String(8940 + Math.floor(Math.random() * 40));
const relayUrl = `ws://127.0.0.1:${PORT}`;
const machineId = `fake-herdr-smoke-${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), 'fake-herdr-smoke-'));
const TIMEOUT_MS = 120_000;

const fake = await startFakeHerdr({ dir: join(dataDir, 'herdr'), panes: Number(process.env.SMOKE_PANES ?? 6), agents: 2, titleChurnHz: 2, graphicsFrameHz: 4 });

const env = { ...process.env };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_AUTH', 'MUXR_RELAY_URL', 'MUXR_MACHINE_ID']) delete env[key];
Object.assign(env, {
    MUXR_MODE: 'local',
    MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT,
    MUXR_RELAY_URL: relayUrl,
    MUXR_MACHINE_ID: machineId,
    MUXR_DATA_DIR: dataDir,
    MUXR_RELAY_DATA_DIR: join(dataDir, 'relay'),
    HERDR_SOCKET_PATH: fake.socketPath,
    HERDR_CLIENT_SOCKET_PATH: fake.clientSocketPath,
    HERDR_BIN: fake.binPath,
});

const children = [];
const pending = new Map();
const events = [];
let wireSeq = 0;
let finishing = false;
const timer = setTimeout(() => finish(1, `FAIL: timed out after ${TIMEOUT_MS}ms\n`), TIMEOUT_MS);

function finish(code, message) {
    if (finishing) return;
    finishing = true;
    clearTimeout(timer);
    for (const child of children) child.kill('SIGTERM');
    fake.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.stdout.write(message);
    process.exit(code);
}

const fail = (message) => finish(1, `FAIL: ${message}\n`);
process.once('SIGINT', () => finish(130, 'INTERRUPTED\n'));
process.once('SIGTERM', () => finish(143, 'TERMINATED\n'));

function start(name, args) {
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(`      [${name}] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`      [${name}] ${chunk}`));
    children.push(child);
}

function send(socket, frame, sessionId) {
    wireSeq += 1;
    socket.send(JSON.stringify({
        header: { machineId, ...(sessionId === undefined ? {} : { sessionId }), seq: wireSeq, at: Date.now() },
        payload: encodePayload(frame),
    }));
}

function request(socket, type, params) {
    const requestId = nextRequestId();
    return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        send(socket, { type, requestId, params });
    });
}

async function waitFor(predicate, what, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    fail(`${what} never happened`);
}

start('relay', ['apps/relay/dist/main.js']);
await waitForRelay(Number(PORT));
start('host', ['apps/host/dist/main.js']);
await new Promise((resolve) => setTimeout(resolve, 2000));

const socket = new WebSocket(`${relayUrl}?role=client&machineId=${machineId}`);
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
    if (frame?.type === 'session.event') events.push({ sessionId: frame.sessionId, event: frame.event });
});
socket.on('open', () => { void run().catch((error) => fail(error instanceof Error ? error.message : String(error))); });

async function run() {
    send(socket, { type: 'client.hello', clientId: 'fake-herdr-smoke' });

    const sessions = await request(socket, 'session.list', {});
    if (sessions.length !== fake.world.panes.length) {
        fail(`session.list returned ${sessions.length} sessions, the herd has ${fake.world.panes.length}`);
    }
    const agents = sessions.filter((session) => session.agentKind !== undefined);
    if (agents.length !== fake.world.agents.length) {
        fail(`session.list reported ${agents.length} agents, the herd has ${fake.world.agents.length}`);
    }
    console.log(`ok: session.list returned ${sessions.length} sessions, ${agents.length} of them agents`);

    // The phone reaches an agent by the id its card carries, which comes from
    // the tree. A tree id the host cannot resolve is the "that agent is no
    // longer available" the app shows on a tap.
    const tree = await request(socket, 'herdr.tree', {});
    const treePanes = tree.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
    const known = new Set(sessions.map((session) => session.id));
    const orphans = treePanes.filter((pane) => pane.sessionId !== undefined && !known.has(pane.sessionId));
    if (orphans.length > 0) fail(`herdr.tree published ${orphans.length} pane id(s) that session.list does not know`);
    const agentPane = treePanes.find((pane) => pane.agentKind !== undefined);
    if (agentPane?.sessionId === undefined) fail('herdr.tree published no agent pane');
    const agentChannel = newTerminalChannel();
    const agentAttached = await request(socket, 'terminal.attach', {
        sessionId: agentPane.sessionId,
        channel: agentChannel,
        cols: 80,
        rows: 24,
        cellWidthPx: 10,
        cellHeightPx: 20,
        mode: 'control',
    }).catch((error) => { fail(`attaching an agent terminal failed: ${error.message}`); });
    if (typeof agentAttached?.paneId !== 'string') fail('an agent terminal.attach returned no paneId');
    console.log(`ok: an agent terminal attaches (${treePanes.length} tree panes, no orphan ids)`);

    // A shell pane, attached the way the phone attaches: cell metrics included,
    // so the graphics path is live too.
    const shell = sessions.find((session) => session.agentKind === undefined);
    if (shell === undefined) fail('the herd published no shell session');
    const channel = newTerminalChannel();
    const attached = await request(socket, 'terminal.attach', {
        sessionId: shell.id,
        channel,
        cols: 80,
        rows: 24,
        cellWidthPx: 10,
        cellHeightPx: 20,
        mode: 'control',
    });
    if (typeof attached?.paneId !== 'string') fail('terminal.attach returned no paneId');

    const frames = [];
    const terminal = new WebSocket(terminalSocketUrl(relayUrl, { machineId, channel, role: 'client' }));
    terminal.on('message', (raw) => {
        let frame;
        try {
            frame = JSON.parse(String(raw));
        } catch {
            return;
        }
        if (frame.type === 'terminal.frame' && typeof frame.bytes === 'string') frames.push(frame);
    });
    terminal.on('error', (error) => fail(`terminal socket failed: ${error.message}`));
    await waitFor(() => frames.length > 2, 'the terminal stream');
    const text = Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes, 'base64'))).toString('utf8');
    if (!text.includes('frame-')) fail(`terminal frames carried no output (${text.length} bytes)`);
    console.log(`ok: terminal stream live (${frames.length} frames, ${text.length} bytes)`);

    // Herdr's cost model: a scroll costs a full repaint, and the phone gates on
    // seeing one.
    const before = frames.length;
    terminal.send(JSON.stringify({ type: 'terminal.scroll', delta: -10 }));
    await waitFor(() => frames.slice(before).some((frame) => frame.full === true), 'a full repaint after a scroll');
    console.log('ok: a scroll answered with a full repaint');

    await waitFor(() => frames.some((frame) => frame.graphics === true), 'a graphics frame');
    console.log('ok: inline Kitty reached the client as a graphics frame');

    // Title churn: every pane changes twice a second, and the host caps
    // title-only publishes at two per second per session.
    events.length = 0;
    const churnSeconds = 5;
    await new Promise((resolve) => setTimeout(resolve, churnSeconds * 1000));
    const updates = events.filter((entry) => entry.event?.type === 'session.updated');
    const perSession = new Map();
    for (const entry of updates) perSession.set(entry.sessionId, (perSession.get(entry.sessionId) ?? 0) + 1);
    if (perSession.size === 0) fail('title churn never reached the client');
    const worst = Math.max(...perSession.values());
    if (worst > 2 * churnSeconds + 2) fail(`session.updated exceeded the coalescing cap (${worst} in ${churnSeconds}s)`);
    console.log(`ok: title churn arrived coalesced (${updates.length} updates across ${perSession.size} sessions)`);

    finish(0, 'fake-herdr stack smoke ok\n');
}
