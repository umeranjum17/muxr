/**
 * Realtime adapter parity check.
 *
 * Drives the real Realtime path -- real relay, real host, real plugin-stream
 * child holding the real coordinator capability, real provider-facing tool
 * runtime, real RealtimeCodingCoordinator, real Herdr handlers -- against one
 * warmed agent in an isolated Herdr lab session, and requires it to agree with
 * direct Herdr ground truth.
 *
 * Only the provider's LLM token choice is replaced by a scripted tool sequence:
 * every layer below the model is production code.  That boundary is deliberate;
 * which words a model emits is not what this check is about.
 *
 * Required environment:
 *   HERDR_LAB_HELPER  path to the guarded Herdr lab helper
 *   HERDR_LAB_SESSION an already provisioned lab session name
 *   MUXR_PARITY_AGENT public name of the warmed agent in that session
 *   MUXR_PARITY_MARKER a unique marker that agent has already printed
 *   MUXR_PARITY_EVIDENCE directory for evidence files
 *
 * Run: node scripts/diagnostics/application/checkRealtimeParity.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodePayload, encodePayload, nextRequestId, realtimeSocketUrl } from '@muxr/contract';
import { waitForRelay } from './waitForRelay.mjs';

const root = process.cwd();
const helper = process.env.HERDR_LAB_HELPER;
const labSession = process.env.HERDR_LAB_SESSION;
const agentName = process.env.MUXR_PARITY_AGENT;
const marker = process.env.MUXR_PARITY_MARKER;
const evidenceDir = process.env.MUXR_PARITY_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'muxr-parity-'));
if (!helper || !labSession || !agentName || !marker) {
    process.stderr.write('FAIL: HERDR_LAB_HELPER, HERDR_LAB_SESSION, MUXR_PARITY_AGENT and MUXR_PARITY_MARKER are required\n');
    process.exit(2);
}
mkdirSync(evidenceDir, { recursive: true });
const record = (event, detail) => writeFileSync(join(evidenceDir, `${event}.json`), `${JSON.stringify(detail, null, 2)}\n`);

const lab = (args, options = {}) => execFileSync(helper, ['run', labSession, ...args], { encoding: 'utf8', timeout: 60_000, ...options });
const labJson = (args, options) => JSON.parse(lab(args, options));

const machineId = `realtime-parity-${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-parity-host-'));
const pluginRoot = join(root, 'scripts', 'diagnostics', 'fixtures', 'realtime-parity-plugin');
const pluginId = `local.realtime-parity-${process.pid}`;
// The host spawns a plugin child with a curated environment, so the probe's
// configuration and evidence travel through its own state directory.
const stateDir = join(dataDir, 'home', 'plugin-state', pluginId);
const childResultPath = join(stateDir, 'child-result.json');
const channel = `rs_${`parity${process.pid}`.padEnd(8, '0')}`;
const children = [];
const failures = [];
let cleanups = [];

function fail(message) { failures.push(message); }
function spawnChild(name, args, env) {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(`      [${name}] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`      [${name}] ${chunk}`));
    children.push(child);
    return child;
}
function finish(code, message) {
    for (const child of children) child.kill();
    try { cpSync(stateDir, join(evidenceDir, 'child-state'), { recursive: true }); } catch { /* no child state */ }
    for (const undo of cleanups) { try { undo(); } catch { /* best effort */ } }
    rmSync(dataDir, { recursive: true, force: true });
    process.stdout.write(message);
    process.exit(code);
}
process.once('SIGINT', () => finish(130, 'INTERRUPTED realtime parity check\n'));
process.once('SIGTERM', () => finish(143, 'TERMINATED realtime parity check\n'));

// --- fixture plugin --------------------------------------------------------
rmSync(pluginRoot, { recursive: true, force: true });
mkdirSync(pluginRoot, { recursive: true });
writeFileSync(join(pluginRoot, 'herdr-plugin.toml'), `id = "${pluginId}"
name = "Realtime parity probe"
version = "0.1.0"
min_herdr_version = "0.8.0"
platforms = ["linux", "macos"]
`);
writeFileSync(join(pluginRoot, 'muxr-ui.json'), `${JSON.stringify({
    schemaVersion: 1,
    pluginId,
    minMuxrVersion: 6,
    capabilities: { 'voice.session': 'session' },
    contributions: [{ slot: 'host.stream', id: 'session', type: 'stream', entry: 'entry.mjs' }],
}, null, 2)}\n`);
writeFileSync(join(pluginRoot, 'entry.mjs'), readFileSync(join(root, 'scripts', 'diagnostics', 'fixtures', 'realtime-parity-entry.mjs')));
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
writeFileSync(join(stateDir, 'parity-config.json'), `${JSON.stringify({ agent: agentName, marker }, null, 2)}\n`);
// The fixture is linked into the isolated lab session only; the default
// captain fleet never sees it, and teardown removes it with the session.
lab(['plugin', 'link', pluginRoot, '--enabled']);
cleanups.push(() => { try { lab(['plugin', 'unlink', pluginId]); } catch { /* lab teardown owns it */ } });
cleanups.push(() => rmSync(pluginRoot, { recursive: true, force: true }));
lab(['plugin', 'list']);
console.log('ok: parity probe linked into the isolated lab session only');

// The host's CLI calls must reach the same isolated session.
const shimDir = mkdtempSync(join(tmpdir(), 'muxr-parity-bin-'));
const shim = join(shimDir, 'herdr');
writeFileSync(shim, `#!/usr/bin/env bash\nexec ${JSON.stringify(helper)} run ${JSON.stringify(labSession)} "$@"\n`, { mode: 0o700 });
cleanups.unshift(() => rmSync(shimDir, { recursive: true, force: true }));

const sessionSocket = labJson(['session', 'list', '--json']).sessions.find((entry) => entry.name === labSession)?.socket_path;
if (typeof sessionSocket !== 'string') finish(1, 'FAIL: lab session published no socket path\n');

// --- ground truth (direct Herdr) ------------------------------------------
const directList = labJson(['agent', 'list']).result.agents;
const directAgent = directList.find((entry) => entry.name === agentName);
if (directAgent === undefined) finish(1, `FAIL: direct Herdr does not list agent ${agentName}\n`);
const directStatus = labJson(['agent', 'get', agentName]).result.agent;
const directRead = lab(['agent', 'read', agentName, '--source', 'recent-unwrapped', '--lines', '300', '--format', 'text']);
const truth = {
    name: directAgent.name,
    status: directAgent.agent_status,
    paneId: directAgent.pane_id,
    sessionFile: directAgent.agent_session?.value,
    markerInDirectRead: directRead.includes(marker),
};
record('ground-truth', truth);
if (truth.markerInDirectRead !== true) finish(1, `FAIL: direct Herdr read does not contain ${marker}\n`);
console.log(`ok: direct Herdr ground truth name=${truth.name} status=${truth.status} pane=${truth.paneId}`);

// --- real relay + real host ------------------------------------------------
const env = { ...process.env };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_AUTH', 'HERDR_SESSION']) delete env[key];
Object.assign(env, {
    MUXR_MODE: 'local',
    MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: '0',
    MUXR_RELAY_MDNS: '0',
    MUXR_MACHINE_ID: machineId,
    MUXR_DATA_DIR: dataDir,
    MUXR_RELAY_DATA_DIR: join(dataDir, 'relay'),
    MUXR_HOME: join(dataDir, 'home'),
    HERDR_SOCKET_PATH: sessionSocket,
    HERDR_BIN: shim,
});
const relayPort = await waitForRelay(spawnChild('relay', [join(root, 'apps', 'relay', 'dist', 'main.js')], env))
    .catch((error) => finish(1, `FAIL: relay did not start: ${error.message}\n`));
const relayUrl = `ws://127.0.0.1:${relayPort}`;
env.MUXR_RELAY_URL = relayUrl;
spawnChild('host', [join(root, 'apps', 'host', 'dist', 'main.js')], env);
await new Promise((resolve) => setTimeout(resolve, 2000));

// --- real host request channel --------------------------------------------
let wireSeq = 0;
const pending = new Map();
const control = new WebSocket(`${relayUrl}?role=client&machineId=${machineId}`);
const send = (socket, frame) => {
    wireSeq += 1;
    socket.send(JSON.stringify({
        header: { machineId, ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }), seq: wireSeq, at: Date.now() },
        payload: encodePayload(frame),
    }));
};
const request = (socket, type, params) => new Promise((resolve, reject) => {
    const requestId = nextRequestId();
    pending.set(requestId, { resolve, reject });
    send(socket, { type, requestId, params });
});
control.on('message', (raw) => {
    let frame;
    try { frame = decodePayload(JSON.parse(String(raw)).payload); } catch { return; }
    if (frame?.type !== 'result') return;
    const entry = pending.get(frame.requestId);
    if (entry === undefined) return;
    pending.delete(frame.requestId);
    frame.ok ? entry.resolve(frame.data) : entry.reject(new Error(frame.error ?? 'request failed'));
});
const opened = new Promise((resolve, reject) => {
    control.once('open', resolve);
    control.once('error', reject);
});
await opened;

// --- real plugin stream ----------------------------------------------------
const streamFrames = [];
const stream = new WebSocket(realtimeSocketUrl(relayUrl, { machineId, channel, role: 'client' }));
stream.on('message', (raw) => {
    let text = String(raw);
    try { text = decodePayload(JSON.parse(text).payload); } catch { /* plain frame */ }
    try {
        const frame = JSON.parse(text);
        streamFrames.push(frame);
        console.log(`      [stream] ${JSON.stringify(frame).slice(0, 300)}`);
    } catch { /* not a frame */ }
});
await new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', reject);
});

try {
    send(control, { type: 'client.hello', clientId: 'realtime-parity' });
    const plugins = await request(control, 'plugin.list', {});
    const voice = plugins.find((entry) => entry.pluginId === pluginId);
    if (voice === undefined) fail(`the real host did not discover the parity plugin (${plugins.map((entry) => entry.pluginId).join(', ')})`);
    if (voice?.manifestHash === undefined) fail('the parity plugin has no manifest hash to approve');
    else {
        await request(control, 'plugin.approve', { pluginId, manifestHash: voice.manifestHash, approved: true });
        await request(control, 'plugin.stream', { pluginId, manifestHash: voice.manifestHash, contributionId: 'session', channel });
        console.log('ok: real host attached the real Realtime stream and issued a real coordinator capability');
        // The relay binds the client socket to the machine channel only once
        // the host has attached, so the first frame can arrive before the
        // binding exists. Repeat until the probe acknowledges; it ignores
        // every repeat after the first.
        const armDeadline = Date.now() + 30_000;
        while (Date.now() < armDeadline && !streamFrames.some((frame) => frame.type === 'realtime.transcript' && String(frame.text).startsWith('list_agents'))) {
            stream.send(JSON.stringify({ type: 'realtime.say', text: 'PARITY_RUN' }));
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline && !streamFrames.some((frame) => frame.type === 'realtime.transcript' && frame.text === 'PARITY_DONE')) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    // Realtime voice is product code now: the same host must attach muxr's own
    // adapter runtime over the product request, with no catalog entry and no
    // plugin approval in the path.
    const productChannel = `rs_${`voice${process.pid}`.padEnd(8, '0')}`;
    const productFrames = [];
    const productStream = new WebSocket(realtimeSocketUrl(relayUrl, { machineId, channel: productChannel, role: 'client' }));
    productStream.on('message', (raw) => {
        let text = String(raw);
        try { text = decodePayload(JSON.parse(text).payload); } catch { /* plain frame */ }
        try { productFrames.push(JSON.parse(text)); } catch { /* not a frame */ }
    });
    await new Promise((resolve, reject) => {
        productStream.once('open', resolve);
        productStream.once('error', reject);
    });
    await request(control, 'voice.stream', { channel: productChannel });
    const productDeadline = Date.now() + 30_000;
    while (Date.now() < productDeadline && productFrames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    productStream.close();
    record('product-voice-stream', { frames: productFrames.length, first: productFrames[0] });
    if (productFrames.length === 0) fail('the product voice stream attached but its runtime emitted no frame');
    else {
        const serialized = JSON.stringify(productFrames);
        // Whatever the provider says, a frame never carries a local path or a secret.
        if (/\/home\/|\/tmp\/|sk-|\.pem|Bearer /.test(serialized)) fail('a product voice frame leaked a path or a credential');
    }
} catch (error) {
    fail(`real Realtime request path failed: ${error.message}`);
}

// --- assertions ------------------------------------------------------------
let child;
try { child = JSON.parse(readFileSync(childResultPath, 'utf8')); } catch { fail('the plugin child produced no result'); }
if (child !== undefined) {
    record('realtime-path', child);
    const step = (name) => child.results.find((entry) => entry.step === name)?.value ?? '';
    const listing = step('list_agents');
    if (!listing.includes(agentName)) fail(`list_agents did not include ${agentName}: ${listing.slice(0, 300)}`);
    const status = step('agent_status');
    if (!status.includes(truth.status)) fail(`agent_status did not match direct Herdr ${truth.status}: ${status}`);
    const output = step('read_agent_output');
    if (!output.includes(marker)) fail(`read_agent_output did not contain the direct Herdr marker ${marker}`);
    const queued = step('prompt_agent');
    if (!/Queued/.test(queued)) fail(`prompt_agent did not return a queued receipt: ${queued}`);
    const replayed = step('prompt_agent_same_operation');
    if (replayed !== queued) fail('a repeated prompt_agent through the runtime did not replay the same receipt');
    const fenced = step('prompt_agent_coordinator_replay');
    if (fenced !== queued) fail('the coordinator replay fence did not answer the repeated operation with the same receipt');
    if (step('agent_answer') !== child.joined) fail(`the agent never produced the joined token ${child.joined}`);
    // The split prompt means an echoed input line can never satisfy the answer
    // check: the joined token exists only if Pi really answered.
    if (child.promptText.includes(child.joined)) fail('the prompt text itself contains the joined token, so the answer check is not independent');
}

if (typeof truth.sessionFile === 'string') {
    let turns = [];
    try {
        turns = readFileSync(truth.sessionFile, 'utf8').split('\n').filter((line) => line.includes('part one is KESTREL'));
    } catch { /* session file may already be gone */ }
    record('pi-session-turns', { file: truth.sessionFile, count: turns.length });
    if (turns.length !== 1) fail(`Pi's own session recorded ${turns.length} prompts for one Realtime prompt_agent; exactly one was sent`);
}

const diagnosticsPath = join(dataDir, 'diagnostics.json');
try {
    const events = JSON.parse(readFileSync(diagnosticsPath, 'utf8')).events ?? JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
    const prompts = events.filter((event) => event.event === 'realtime.prompt');
    record('host-diagnostics', { prompts: prompts.length, coordination: events.filter((event) => event.event === 'realtime.coordination').length });
    if (prompts.length !== 1) fail(`the host journal recorded ${prompts.length} realtime.prompt events for one Realtime prompt_agent`);
} catch { /* journal location is host-owned; the Pi session is the authority */ }

if (failures.length > 0) {
    for (const message of failures) process.stderr.write(`FAIL: ${message}\n`);
    finish(1, `FAIL: realtime parity (${failures.length} failure(s))\n`);
}
record('verdict', { passed: true, agent: agentName, marker, joined: child.joined });
console.log('PASS realtime parity: list/status/read match direct Herdr, exactly one prompt, exact answer, no duplicate send');
finish(0, 'PASS realtime adapter parity\n');
