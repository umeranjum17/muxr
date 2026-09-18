/**
 * End-to-end `muxr pair` QR onboarding through a live self-host relay.
 *
 * First contact is the product: the host prints a terminal QR, the phone scans
 * it, and pairing completes without the user ever typing a string. Nothing
 * else in the suite proved that chain — checkPairing covers cloud accounts and
 * the relay self-check covers store mechanics with opaque strings — so a QR
 * that encoded the wrong text, or a claim the host could not finish, would
 * ship with every lane green. This check drives the real CLI against a real
 * relay and claims the pairing exactly the way the phone does, with the
 * shared crypto module.
 *
 * Spawns its own relay on MUXR_RELAY_PORT=0 and reads the bound port from
 * waitForRelay, so it can never pass against a relay it did not start.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { waitForRelay } from './waitForRelay.mjs';
import {
    deriveV2Key,
    generateKeyPair,
    newV2SenderState,
    openPairingCodePayload,
    sealV2,
    verifyDeviceGrant,
} from '../../../packages/crypto/dist/index.js';

const repoRoot = join(fileURLToPath(new URL('../../..', import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'muxr-pair-qr-'));
const relayDataDir = join(scratch, 'relay-data');
const cliHome = join(scratch, 'cli-home');

// The CLI state helpers write to $MUXR_HOME, defaulting to the real ~/.muxr.
// Redirect this process BEFORE any setup module is imported: a check that
// clobbers the operator's machine identity is worse than no check.
process.env.MUXR_HOME = cliHome;
process.env.MUXR_NO_SERVICE_COMMANDS = '1';
// Cross-feature access goes through setup's public barrel.
const { machineIdentity, pairingCodeHash, printTerminalQr, pairingIntent, writeSelfhostState } = await import('../../setup/index.mjs');

const children = [];
const fail = (msg) => {
    process.stdout.write(`\nFAIL: ${msg}\n`);
    for (const child of children) child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. A real relay, isolated: scratch data dir, no mDNS, kernel-picked port.
const relay = spawn('node', [join(repoRoot, 'apps/relay/dist/main.js')], {
    cwd: repoRoot,
    env: { ...process.env, MUXR_RELAY_PORT: '0', MUXR_RELAY_HOST: '127.0.0.1', MUXR_RELAY_DATA_DIR: relayDataDir, MUXR_RELAY_MDNS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(relay);
const PORT = await waitForRelay(relay).catch((error) => fail(error.message));
const BASE = `http://127.0.0.1:${PORT}`;
const RELAY_URL = `ws://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// 2. Scratch CLI state: a machine identity and the relay's owner mint secret,
//    exactly what `muxr setup` leaves behind before `muxr pair`.
const mintSecret = JSON.parse(readFileSync(join(relayDataDir, 'mint-secret'), 'utf8'));
writeSelfhostState({
    version: 1,
    machine: machineIdentity(undefined),
    relayPort: PORT,
    relayUrl: RELAY_URL,
    relayLocation: 'local',
    relayRole: 'single-machine',
    connectionMode: 'lan',
    webEnabled: false,
    mintSecret,
});

// ---------------------------------------------------------------------------
// 3. The QR a user scans must encode exactly the pairing string they could
//    paste. Render through printTerminalQr with a stubbed TTY, decode the
//    utf8 half-block art back to modules, and compare against a fresh
//    QRCode.create of the same text. One wrong module and a camera reads
//    nothing, so the comparison is exhaustive.
const locator = pairingIntent({ kind: 'native' }).pairingLocator(RELAY_URL, '7KDM4-QXP7N');
const rendered = await renderTerminalQrInProcess(locator);
if (rendered.includes('QR omitted')) fail(`printTerminalQr refused a normal terminal: ${rendered}`);
const expected = QRCode.create(locator, { errorCorrectionLevel: 'M' });
const decoded = decodeUtf8Qr(rendered, expected.modules.size);
let wrong = 0;
for (let y = 0; y < decoded.size; y += 1) {
    for (let x = 0; x < decoded.size; x += 1) {
        if (decoded.modules[y][x] !== (expected.modules.data[y * decoded.size + x] ? 1 : 0)) wrong += 1;
    }
}
if (wrong !== 0) fail(`terminal QR differs from the pairing string in ${wrong} of ${decoded.size * decoded.size} modules — a phone scan would silently fail`);
if (decoded.width > 80) fail(`terminal QR needs ${decoded.width} columns; it must fit a standard 80-column terminal`);

// ---------------------------------------------------------------------------
// 4. The real `muxr pair` against that relay. This check is not a TTY, so the
//    honest fallback must name the string path — and the saved file must hold
//    the exact text the QR above encoded.
const pair = spawn('node', [join(repoRoot, 'scripts/cli.mjs'), 'pair'], {
    cwd: repoRoot,
    env: { ...process.env, MUXR_HOME: cliHome },
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(pair);
let pairOut = '';
pair.stdout.on('data', (chunk) => { pairOut += chunk; });
pair.stderr.on('data', (chunk) => { pairOut += chunk; });
const printed = await waitFor(
    () => /Pairing string \(expires in two minutes\):\s*(\S+)/.exec(pairOut),
    15_000,
    'muxr pair never printed a pairing string',
);
const printedLocator = printed[1];
const printedUrl = new URL(printedLocator);
const relayUrl = new URL(RELAY_URL);
if (!['ws:', 'wss:'].includes(printedUrl.protocol)
    || `${printedUrl.origin}${printedUrl.pathname}` !== `${relayUrl.origin}${relayUrl.pathname}`
    || printedUrl.searchParams.getAll('pair').length !== 1) {
    fail(`muxr pair printed a malformed locator: ${printedLocator}`);
}
// Piped output intentionally carries no QR art at all: the isTTY gate
// skips the renderer, so the exact string below is the whole fallback.
if (!pairOut.includes('Pairing string (expires in two minutes)')) fail('piped muxr pair never labelled the fallback string');
const savedPath = join(cliHome, 'pairing-string.txt');
if (!existsSync(savedPath)) fail('muxr pair did not save pairing-string.txt');
if (readFileSync(savedPath, 'utf8').trim() !== printedLocator) fail('saved pairing string differs from the printed one');

// ---------------------------------------------------------------------------
// 5. Claim it the way the phone does: code -> sealed payload -> mailbox ->
//    claim -> verified grant, all through the shared crypto module.
const code = printedUrl.searchParams.get('pair');
const resolved = await post('/v1/selfhost/pair-code', { code_hash: pairingCodeHash(code) });
if (resolved.status !== 200 || typeof resolved.body.payload !== 'string') fail(`pair-code resolve failed (${resolved.status}) ${JSON.stringify(resolved.body)}`);
// The CLI seals base64url(JSON): open, then decode, exactly like the
// phone's payload= deep link parameter.
const compact = openPairingCodePayload(resolved.body.payload, code);
const payload = JSON.parse(Buffer.from(compact, 'base64url').toString('utf8'));
if (payload.v !== '2'
    || [payload.id, payload.claim, payload.pair, payload.machine, payload.machinePk].some((v) => typeof v !== 'string' || v.length <= 20)) {
    fail(`resolved pairing payload is not a complete v2 record: ${Object.keys(payload).join(',')}`);
}
const deviceKey = generateKeyPair();
const deviceName = 'QR journey phone';
const mailbox = sealV2(
    JSON.stringify({ devicePublicKey: deviceKey.publicKey, machineSigningPublicKey: payload.machinePk, deviceName }),
    deriveV2Key(payload.pair, 'client->host'),
    { machineId: payload.machine, senderId: deviceKey.publicKey, recipientId: payload.machine, channel: 'pairing', streamId: payload.id, keyVersion: Number(payload.generation ?? 1) },
    newV2SenderState(),
);
const claimBody = {
    claim: payload.claim,
    device_public_key: deviceKey.publicKey,
    device_name: deviceName,
    device_kind: 'native',
    mailbox,
};
const claimed = await post(`/v1/selfhost/pair-sessions/${encodeURIComponent(payload.id)}/claim`, claimBody);
if (claimed.status !== 201 || typeof claimed.body.device_credential !== 'string') fail(`phone claim failed (${claimed.status}) ${JSON.stringify(claimed.body)}`);
// One-time means one-time: a replayed claim must be refused.
const replay = await post(`/v1/selfhost/pair-sessions/${encodeURIComponent(payload.id)}/claim`, claimBody);
if (replay.status !== 409) fail(`a consumed QR claimed twice (status ${replay.status})`);

// The machine notices the claim on its next poll (2s cadence) before the
// grant appears; the app retries the same way.
let grantResponse;
for (let waited = 0; waited <= 15_000; waited += 500) {
    grantResponse = await fetch(`${BASE}/v1/selfhost/pair-sessions/${encodeURIComponent(payload.id)}/grant`, {
        headers: { authorization: `Bearer ${claimed.body.device_credential}` },
    }).then((r) => r.json().catch(() => ({})));
    if (typeof grantResponse.grant === 'string') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
}
const grant = verifyDeviceGrant(JSON.parse(grantResponse.grant), {
    pinnedMachineSigningPublicKey: payload.machinePk,
    deviceKey,
    deviceId: claimed.body.device_id,
});
if (grant.machineId !== payload.machine || grant.authority !== 'control') fail('verified grant is not control access to the scanned machine');

// ---------------------------------------------------------------------------
// 6. The host side must finish on its own: mailbox decrypted, grant uploaded,
//    device recorded durably.
const exitCode = await waitFor(() => (pair.exitCode === null ? undefined : pair.exitCode), 20_000, 'muxr pair did not finish after the phone claimed');
if (exitCode !== 0) fail(`muxr pair exited ${exitCode}: ${pairOut.slice(-400)}`);
if (!pairOut.includes('paired and verified')) fail(`muxr pair did not confirm the pairing: ${pairOut.slice(-400)}`);
const listed = await runCli(['devices', 'list']).catch((cause) => fail(cause.message));
if (!listed.includes(deviceName)) fail(`muxr devices list does not show the paired phone: ${listed.slice(-300)}`);

// The pair child has usually exited already, so only wait on live children.
for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
    }
}
rmSync(scratch, { recursive: true, force: true });
process.stdout.write(
    'PASS: pair QR onboarding journey\n' +
    `      terminal QR decodes to the exact pairing string (0 of ${decoded.size * decoded.size} modules differ, ≥4-module quiet zone): yes\n` +
    '      piped fallback prints the exact string: yes   saved string equals the printed one: yes\n' +
    '      phone code->payload->claim->grant verified against the pinned machine key: yes\n' +
    '      replayed claim refused: yes   muxr pair confirmed and device listed: yes\n',
);

// --- helpers ---------------------------------------------------------------

function post(path, body) {
    return fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${mintSecret}` },
        body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

function runCli(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [join(repoRoot, 'scripts/cli.mjs'), ...args], {
            cwd: repoRoot,
            env: { ...process.env, MUXR_HOME: cliHome },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { out += chunk; });
        child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`cli ${args.join(' ')} exited ${code}: ${out.slice(-300)}`))));
    });
}

async function waitFor(produce, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = produce();
        if (value !== undefined && value !== null) return value;
        if (Date.now() > deadline) fail(message);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/** Render through the real printTerminalQr with a stubbed TTY and captured stdout. */
async function renderTerminalQrInProcess(value) {
    const stdout = process.stdout;
    const originalWrite = stdout.write.bind(stdout);
    const restore = [];
    let captured = '';
    for (const key of ['isTTY', 'columns']) {
        const had = Object.prototype.hasOwnProperty.call(stdout, key);
        restore.push({ key, had, value: stdout[key] });
        Object.defineProperty(stdout, key, { value: key === 'isTTY' ? true : 100, configurable: true });
    }
    stdout.write = (chunk) => { captured += chunk; return true; };
    try {
        await printTerminalQr(value);
    } finally {
        stdout.write = originalWrite;
        for (const entry of restore) {
            if (entry.had) Object.defineProperty(stdout, entry.key, { value: entry.value, configurable: true });
            else delete stdout[entry.key];
        }
    }
    return captured;
}

/**
 * Decode the SGR-wrapped utf8 half-block QR art into the content matrix.
 * `qrcode` paints two module rows per text line: `█` both dark, `▀` top only,
 * `▄` bottom only, space neither; a final odd module row leaves a phantom
 * bottom half. Leading indent (centering) becomes extra left margin, so the
 * content box is located by its bounding box and the quiet zone must be at
 * least four empty modules on every side — trimmed margin is how a code stops
 * scanning.
 */
function decodeUtf8Qr(text, expectedSize) {
    const lines = text.split('\n')
        .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
        .filter((line) => line !== '');
    if (lines.length === 0 || !/^[ ▀▄█]+$/.test(lines.join(''))) {
        fail('terminal QR output is not plain utf8 half-block art');
    }
    const width = Math.max(...lines.map((line) => [...line].length));
    const rows = [];
    for (const line of lines) {
        const top = [];
        const bottom = [];
        for (const ch of [...line.padEnd(width, ' ')]) {
            top.push(ch === '█' || ch === '▀' ? 1 : 0);
            bottom.push(ch === '█' || ch === '▄' ? 1 : 0);
        }
        rows.push(top, bottom);
    }
    const firstDarkRow = rows.findIndex((row) => row.includes(1));
    const lastDarkRow = rows.length - 1 - [...rows].reverse().findIndex((row) => row.includes(1));
    const columnsOf = (y) => rows[y].map((m, x) => [m, x]).filter(([m]) => m === 1).map(([, x]) => x);
    const darkColumns = rows.flatMap((_, y) => columnsOf(y));
    if (firstDarkRow < 0 || darkColumns.length === 0) fail('terminal QR has no dark modules');
    const left = Math.min(...darkColumns);
    const right = Math.max(...darkColumns);
    const size = lastDarkRow - firstDarkRow + 1;
    if (Math.abs(size - expectedSize) > 1) fail(`terminal QR content is ${size} module rows; expected ${expectedSize}`);
    if (right - left + 1 !== expectedSize) fail(`terminal QR content is ${right - left + 1} module columns; expected ${expectedSize}`);
    if (firstDarkRow < 4 || rows.length - 1 - lastDarkRow < 4 || left < 4 || width - 1 - right < 4) {
        fail('terminal QR quiet zone is thinner than four modules — margin was trimmed');
    }
    // Reconstruct the content grid: an odd module height ends on a half-painted
    // text row, so read row-by-row from the module grid, not text-line pairs.
    const modules = [];
    for (let y = firstDarkRow; y <= lastDarkRow; y += 1) {
        modules.push(rows[y].slice(left, left + expectedSize));
    }
    return { size: expectedSize, width, modules };
}
