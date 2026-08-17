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
 *
 * Needs a running `herdr server`. Run: node scripts/checkHerdrE2E.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
    decodePayload,
    encodePayload,
    newTerminalChannel,
    nextRequestId,
    terminalSocketUrl,
} from '@muxr/contract';
import { waitForRelay } from './waitForRelay.mjs';

const PORT = String(8890 + Math.floor(Math.random() * 40));
const relayUrl = `ws://127.0.0.1:${PORT}`;
const machineId = `herdr-check-${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-herdr-'));
const workdir = mkdtempSync(join(tmpdir(), 'muxr-cwd-'));
const TIMEOUT_MS = 120_000;

const children = [];
const env = { ...process.env };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_E2EE_SHARED_KEY', 'MUXR_RELAY_AUTH']) {
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
    if (createdWorkspaceId !== undefined) {
        try {
            execFileSync(process.env.HERDR_BIN || 'herdr', ['workspace', 'close', createdWorkspaceId], { stdio: 'ignore' });
        } catch { /* best effort after a failed live server */ }
    }
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

    // 2. session.start (async agent.start: the answer must beat the 20s client timeout)
    const started = await request(socket, 'session.start', { cwd: workdir, kind: 'pi', label: 'e2e' });
    const newId = started?.info?.id;
    createdWorkspaceId = started?.info?.workspaceId;
    if (typeof newId !== 'string') fail('session.start returned no session id');
    console.log(`ok: session.start -> ${newId} (status ${started?.status?.agentStatus ?? '?'})`);
    await waitFor(
        () => events.some((entry) => entry.sessionId === newId && entry.event.type === 'session.created'),
        'session.created event',
        40_000,
    );
    console.log('ok: session.created event landed after herdr detected the agent');

    // 3. terminal.attach -> frames
    const channel = newTerminalChannel();
    const attached = await request(socket, 'terminal.attach', { sessionId: newId, channel, cols: 100, rows: 30 });
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

    // 5. prompt + abort round-trip (ack-only requests)
    await request(socket, 'session.prompt', { sessionId: newId, text: 'say nothing' });
    console.log('ok: session.prompt acked');
    await request(socket, 'session.abort', { sessionId: newId });
    console.log('ok: session.abort acked');

    // 6. detach + stop
    term.close();
    await request(socket, 'terminal.detach', { sessionId: newId, channel });
    await request(socket, 'session.stop', { sessionId: newId });
    console.log('ok: detach + stop');

    finish(0, 'PASS e2e: herdr backend loop\n');
}

async function waitFor(predicate, label, budgetMs = 12_000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > budgetMs) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
