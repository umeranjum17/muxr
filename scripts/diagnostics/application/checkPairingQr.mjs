/**
 * End-to-end `muxr pair` QR onboarding through a live self-host relay.
 *
 * First contact is the product: the computer prints a terminal QR of the
 * byokit link offer, the phone scans it, and pairing completes with an
 * approval on the computer — the two confirmation words shown on both
 * screens (migration step 4, decision D1). Nothing else in the suite proved
 * that chain, so a QR that encoded the wrong text, or an approval prompt that
 * never reached the person at the computer, would ship with every lane green.
 * This check drives the real CLI under a real PTY against a real relay, and
 * claims the pairing exactly the way the phone does, through @byokit/link.
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
import { DeviceLink, keyPair, pairWithOffer } from '@byokit/link';
import { waitForRelay } from './waitForRelay.mjs';

const repoRoot = join(fileURLToPath(new URL('../../..', import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'muxr-pair-qr-'));
const relayDataDir = join(scratch, 'relay-data');
const cliHome = join(scratch, 'cli-home');
const ptyLog = join(scratch, 'pair-session.typescript');

// The CLI state helpers write to $MUXR_HOME, defaulting to the real ~/.muxr.
// Redirect this process BEFORE any setup module is imported: a check that
// clobbers the operator's machine identity is worse than no check.
process.env.MUXR_HOME = cliHome;
process.env.MUXR_NO_SERVICE_COMMANDS = '1';
// Cross-feature access goes through setup's public barrel.
const { machineIdentity, writeSelfhostState } = await import('../../setup/index.mjs');

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
// The native grant is not published until the running host enrols the phone
// on the link. Exercise that host, not just its relay and pairing CLI.
const host = spawn('node', [join(repoRoot, 'apps/host/dist/main.js'), '--fake'], {
    cwd: repoRoot,
    env: { ...process.env, MUXR_HOME: cliHome, MUXR_MODE: 'selfhost', MUXR_DATA_DIR: join(cliHome, 'host-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(host);
let hostOut = '';
host.stdout.on('data', (chunk) => { hostOut += chunk; });
host.stderr.on('data', (chunk) => { hostOut += chunk; });
await waitFor(() => hostOut.includes('host -> ') ? true : undefined, 20_000, `host did not start: ${hostOut}`);

// 3. The QR a user scans must encode exactly the pairing string they could
//    paste. Render through printTerminalQr with a stubbed TTY, decode the
//    utf8 half-block art back to modules, and compare against a fresh
//    QRCode.create of the same text. One wrong module and a camera reads
//    nothing, so the comparison is exhaustive.
const locator = pairingIntent({ kind: 'native' }).pairingLocator(RELAY_URL, '7KDM4-QXP7N');
const rendered = await renderTerminalQrInProcess(locator);
if (rendered.includes('QR omitted')) fail(`printTerminalQr refused a normal terminal: ${rendered}`);
const expected = QRCode.create(offerShape, { errorCorrectionLevel: 'M' });
const decoded = decodeUtf8Qr(rendered, expected.modules.size);
let wrong = 0;
for (let y = 0; y < decoded.size; y += 1) {
    for (let x = 0; x < decoded.size; x += 1) {
        if (decoded.modules[y][x] !== (expected.modules.data[y * decoded.size + x] ? 1 : 0)) wrong += 1;
    }
}
if (wrong !== 0) fail(`terminal QR differs from the offer text in ${wrong} of ${decoded.size * decoded.size} modules — a phone scan would silently fail`);
// The art itself is modules plus the four-module quiet zone on each side;
// the stubbed 100-column terminal only adds centring indent around it.
const qrColumns = expected.modules.size + 8;
if (qrColumns > 80) fail(`the link offer QR needs ${qrColumns} columns; it must fit a standard 80-column terminal`);

// ---------------------------------------------------------------------------
// 4. The real `muxr pair` under a real PTY. It prints the offer QR and the
//    offer text, waits for a phone, shows the confirmation words, and asks
//    the person at the computer to approve.
// The PTY inherits no window size from these pipes, and the QR renderer
// needs real dimensions: set them with stty before the CLI starts.
const pair = spawn('script', ['-q', '-f', '-c', `stty cols 100 rows 60; node ${join(repoRoot, 'scripts/cli.mjs')} pair`, ptyLog], {
    cwd: repoRoot,
    // MUXR_DESKTOP_SOURCE=x11: the lab has no desktop portal to prompt for
    // screen-sharing approval, so pairing must finish without it.
    env: { ...process.env, MUXR_HOME: cliHome, TERM: 'xterm', MUXR_DESKTOP_SOURCE: 'x11' },
    stdio: ['pipe', 'pipe', 'pipe'],
});
children.push(pair);
const pty = () => (existsSync(ptyLog) ? readFileSync(ptyLog, 'utf8') : '');
const printed = await waitFor(
    () => /byokit-link:1:[A-Za-z0-9_-]{100,}/.exec(stripAnsi(pty())),
    20_000,
    'muxr pair never printed a link offer',
);
const offer = printed[0];
if (!stripAnsi(pty()).includes('Scan it with the muxr app')) fail('muxr pair did not tell the person to scan the offer');
// The printed QR art must decode to the exact offer the text shows.
const ptyArt = stripAnsi(pty()).split('\n').filter((line) => /^[ ▀▄█]+$/.test(line)).join('\n');
const ptyDecoded = decodeUtf8Qr(ptyArt + '\n', QRCode.create(offer, { errorCorrectionLevel: 'M' }).modules.size);
const ptyExpected = QRCode.create(offer, { errorCorrectionLevel: 'M' });
let ptyWrong = 0;
for (let y = 0; y < ptyDecoded.size; y += 1) {
    for (let x = 0; x < ptyDecoded.size; x += 1) {
        if (ptyDecoded.modules[y][x] !== (ptyExpected.modules.data[y * ptyDecoded.size + x] ? 1 : 0)) ptyWrong += 1;
    }
}
if (ptyWrong !== 0) fail(`the PTY-rendered offer QR differs from the printed offer in ${ptyWrong} modules`);

// ---------------------------------------------------------------------------
// 5. Claim it the way the phone does: a fresh link key, persisted intent, the
//    byokit claim, the machine details over the pairing link, and the proof
//    over the machine's own link. The words must appear on this screen before
//    the approval, because that is the whole point of decision D1.
const deviceKey = keyPair();
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
if (typeof grantResponse.grant !== 'string') fail(`host did not enrol and publish the native grant: ${pairOut.slice(-400)} ${hostOut.slice(-400)}`);
const grant = verifyDeviceGrant(JSON.parse(grantResponse.grant), {
    pinnedMachineSigningPublicKey: payload.machinePk,
    deviceKey,
    deviceId: claimed.body.device_id,
});
await waitFor(
    () => (pty().includes('Compare these words on the phone') ? true : undefined),
    15_000,
    'the confirmation words never appeared on the computer',
);
const wordsLine = stripAnsi(pty()).match(/Compare these words on the phone:\s*(\S+)/);
if (wordsLine === null || wordsLine[1].length < 3) fail('the approval prompt showed no confirmation words');
// Approve the way the person does: typing yes at the prompt.
pair.stdin.write('y\n');
const pairingGrant = await claiming;
if (typeof pairingGrant.device?.id !== 'string' || pairingGrant.device.id === '') {
    fail('pairWithOffer did not return an approved grant');
}
// The rest of the phone flow: reconnect to the pairing host for the machine
// details, prove the key over the machine's own link, and report the proof.
const pairLink = new DeviceLink(pairingGrant, { WebSocket: WebSocket, timeoutMs: 5_000 });
pairLink.connect();
await waitFor(() => (pairLink.status === 'online' ? true : undefined), 15_000, 'the pairing link never reopened');
const answer = await pairLink.request('pair.complete', { deviceName }, { timeoutMs: 15_000 });
if (typeof answer?.machineId !== 'string' || typeof answer?.linkUrl !== 'string' || !answer.linkUrl.startsWith('ws')) {
    fail(`the machine answered with an incomplete pairing record: ${JSON.stringify(answer).slice(0, 200)}`);
}
if (typeof answer?.machineId !== 'string' || typeof answer?.linkUrl !== 'string' || !answer.linkUrl.startsWith('ws')) {
    fail(`the machine answered with an incomplete pairing record: ${JSON.stringify(answer).slice(0, 200)}`);
}
let machineLink;
const proofDeadline = Date.now() + 45_000;
while (true) {
    machineLink = new DeviceLink({
        v: 1,
        secretKey: Buffer.from(deviceKey.secretKey).toString('base64url'),
        host: answer.machineBoxPublicKey,
        hostName: answer.machineName,
        urls: [answer.linkUrl],
        device: { id: '', name: deviceName, role: 'control' },
    }, { WebSocket: WebSocket, timeoutMs: 5_000 });
    machineLink.connect();
    await waitFor(() => (machineLink.status !== 'connecting' ? true : undefined), 10_000, 'the machine link never settled');
    if (machineLink.status === 'online') break;
    const ended = machineLink.status;
    machineLink.stop();
    if (ended === 'refused') fail('the machine link refused this phone');
    if (Date.now() >= proofDeadline) fail('the machine never enrolled this phone inside the proof window');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
}
machineLink.stop();
await pairLink.request('pair.verified', {}, { timeoutMs: 10_000 });
pairLink.stop();

// The proof window: the phone dials the machine's own link and reports it.
const exitCode = await waitFor(() => (pair.exitCode === null ? undefined : pair.exitCode), 90_000, `muxr pair did not finish after the phone proved itself: ${JSON.stringify(stripAnsi(pty()).slice(-600))}`);
if (exitCode !== 0) fail(`muxr pair exited ${exitCode}: ${stripAnsi(pty()).slice(-400)}`);
if (!stripAnsi(pty()).includes('paired and verified')) fail(`muxr pair did not confirm the pairing: ${stripAnsi(pty()).slice(-400)}`);
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
process.stdout.write('\nPASS: pair QR onboarding journey\n');
process.stdout.write(`      terminal QR decodes to the exact link offer (${decoded.size} modules, ${qrColumns} columns wide): yes\n`);
process.stdout.write('      PTY offer QR matches the printed offer: yes\n');
process.stdout.write('      confirmation words shown on the computer before approval: yes\n');
process.stdout.write('      approval finished the pairing; devices list shows the phone: yes\n');
process.exit(0);

// ---------------------------------------------------------------------------
function stripAnsi(text) {
    // Every CSI sequence (colours, cursor hide/show, mode switches) and the
    // PTY's carriage returns go; only text and half-block art remain.
    return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

async function runCli(args) {
    const child = spawn('node', [join(repoRoot, 'scripts/cli.mjs'), ...args], {
        cwd: repoRoot,
        env: { ...process.env, MUXR_HOME: cliHome },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    if (code !== 0) throw new Error(`muxr ${args.join(' ')} exited ${code}: ${out.slice(-300)}`);
    return out;
}

async function waitFor(produce, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = produce();
        if (value !== undefined && value !== null && value !== false) return value;
        if (Date.now() > deadline) fail(message);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

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
        const { printTerminalQr } = await import('../../setup/index.mjs');
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
    const top = firstDarkRow;
    const bottom = lastDarkRow;
    const size = right - left + 1;
    if (size !== expectedSize) fail(`terminal QR is ${size} modules wide, expected ${expectedSize}`);
    const verticalSize = bottom - top + 1;
    if (verticalSize !== expectedSize) fail(`terminal QR is ${verticalSize} modules tall, expected ${expectedSize}`);
    if (top < 4 || rows.length - 1 - bottom < 4 || left < 4 || width - 1 - right < 4) {
        fail('terminal QR quiet zone is thinner than four modules — a camera needs that margin');
    }
    const modules = [];
    for (let y = top; y <= bottom; y += 1) {
        const row = [];
        for (let x = left; x <= right; x += 1) row.push(rows[y][x]);
        modules.push(row);
    }
    return { size, modules, width };
}
