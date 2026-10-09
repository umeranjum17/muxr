/** Check product voice stream attachment through a real host/relay in a guarded Herdr lab.
 * Provider audio and native speech require the separate device journey. */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineIdentity } from '../../setup/index.mjs';
import { waitForRelay } from './waitForRelay.mjs';
import { linkLabClient } from './linkLabClient.mjs';

const root = process.cwd();
const helper = process.env.HERDR_LAB_HELPER;
const labSession = process.env.HERDR_LAB_SESSION;
const evidenceDir = process.env.MUXR_PARITY_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'muxr-parity-'));
if (!helper || !labSession) {
    process.stderr.write('FAIL: HERDR_LAB_HELPER and HERDR_LAB_SESSION are required\n');
    process.exit(2);
}
mkdirSync(evidenceDir, { recursive: true });
const record = (event, detail) => writeFileSync(join(evidenceDir, `${event}.json`), `${JSON.stringify(detail, null, 2)}\n`);

const lab = (args, options = {}) => execFileSync(helper, ['run', labSession, ...args], { encoding: 'utf8', timeout: 60_000, ...options });
const labJson = (args, options) => JSON.parse(lab(args, options));

const dataDir = mkdtempSync(join(tmpdir(), 'muxr-parity-host-'));
const children = [];
const failures = [];
let cleanups = [];
let control;
let productStream;

function fail(message) { failures.push(message); }
function spawnChild(name, args, env) {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(`      [${name}] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`      [${name}] ${chunk}`));
    children.push(child);
    return child;
}
function finish(code, message) {
    productStream?.end();
    control?.stop();
    for (const child of children) child.kill();
    for (const undo of cleanups) { try { undo(); } catch { /* best effort */ } }
    rmSync(dataDir, { recursive: true, force: true });
    process.stdout.write(message);
    process.exit(code);
}
process.once('SIGINT', () => finish(130, 'INTERRUPTED realtime parity check\n'));
process.once('SIGTERM', () => finish(143, 'TERMINATED realtime parity check\n'));

// The host's CLI calls must reach the same isolated session.
const shimDir = mkdtempSync(join(tmpdir(), 'muxr-parity-bin-'));
const shim = join(shimDir, 'herdr');
writeFileSync(shim, `#!/usr/bin/env bash\nexec ${JSON.stringify(helper)} run ${JSON.stringify(labSession)} "$@"\n`, { mode: 0o700 });
cleanups.unshift(() => rmSync(shimDir, { recursive: true, force: true }));

const sessionSocket = labJson(['session', 'list', '--json']).sessions.find((entry) => entry.name === labSession)?.socket_path;
if (typeof sessionSocket !== 'string') finish(1, 'FAIL: lab session published no socket path\n');

// --- real relay + real host, admitted through byokit ------------------------
const env = { ...process.env };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_AUTH']) delete env[key];
Object.assign(env, {
    MUXR_MODE: 'selfhost',
    MUXR_RELAY_PORT: '0',
    MUXR_RELAY_MDNS: '0',
    MUXR_DATA_DIR: dataDir,
    MUXR_RELAY_DATA_DIR: join(dataDir, 'relay'),
    MUXR_HOME: join(dataDir, 'home'),
    MUXR_NO_SERVICE_COMMANDS: '1',
    HERDR_SESSION: labSession,
    HERDR_SOCKET_PATH: sessionSocket,
    HERDR_BIN: shim,
    HERDR_BIN_PATH: shim,
});
const relayPort = await waitForRelay(spawnChild('relay', [join(root, 'apps', 'relay', 'dist', 'main.js')], env))
    .catch((error) => finish(1, `FAIL: relay did not start: ${error.message}\n`));
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const machine = machineIdentity(undefined);
const owner = JSON.parse(readFileSync(join(dataDir, 'relay', 'mint-secret'), 'utf8'));
mkdirSync(env.MUXR_HOME, { recursive: true });
writeFileSync(join(env.MUXR_HOME, 'selfhost.json'), `${JSON.stringify({ version: 1, machine,
    relayPort, relayUrl, relayLocation: 'local', relayRole: 'single-machine', connectionMode: 'lan',
    webEnabled: false, mintSecret: owner })}\n`, { mode: 0o600 });
spawnChild('host', [join(root, 'apps', 'host', 'dist', 'main.js')], env);
const pairSocket = join(dataDir, 'pair.sock');
const pairDeadline = Date.now() + 25_000;
while (!existsSync(pairSocket)) {
    if (Date.now() > pairDeadline) finish(1, 'FAIL: real link host did not start\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
}
control = await linkLabClient(pairSocket);

function collectFrames(linkStream, frames, label) {
    const decoder = new TextDecoder();
    let partial = '';
    linkStream.onData = (chunk) => {
        partial += decoder.decode(chunk, { stream: true });
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
            try {
                const frame = JSON.parse(line);
                frames.push(frame);
                console.log(`      [${label}] ${JSON.stringify(frame).slice(0, 300)}`);
            } catch { /* a partial or non-frame line */ }
        }
    };
}

try {
    // A paired control device opens the product voice stream directly.
    const productChannel = `rs_${`voice${process.pid}`.padEnd(8, '0')}`;
    const productFrames = [];
    productStream = await control.stream('voice', { channel: productChannel });
    collectFrames(productStream, productFrames, 'voice');
    const productDeadline = Date.now() + 30_000;
    while (Date.now() < productDeadline && productFrames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    productStream.end();
    productStream = undefined;
    record('product-voice-stream', { frames: productFrames.length, first: productFrames[0] });
    if (productFrames.length === 0) fail('the product voice stream attached but its runtime emitted no frame');
    else if (/\/home\/|\/tmp\/|sk-|\.pem|Bearer /.test(JSON.stringify(productFrames))) {
        fail('a product voice frame leaked a path or a credential');
    }
} catch (error) {
    fail(`real Realtime request path failed: ${error.message}`);
}

if (failures.length > 0) {
    for (const message of failures) process.stderr.write(`FAIL: ${message}\n`);
    finish(1, `FAIL: product voice attachment (${failures.length} failure(s))\n`);
}
record('verdict', { passed: true });
console.log('PASS product voice stream: runtime attached through the authenticated link, no path or credential leaks');
finish(0, 'PASS product voice attachment\n');
