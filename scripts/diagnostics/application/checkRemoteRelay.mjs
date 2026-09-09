import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import nacl from 'tweetnacl';
import WebSocket from 'ws';
import { waitForRelay } from './waitForRelay.mjs';
import { MachineAuthority } from '../../../apps/relay/dist/admission/infrastructure/machineAuthority.js';

const authorityDir = mkdtempSync(join(tmpdir(), 'muxr-remote-authority-'));
const authority = new MachineAuthority(authorityDir);
const expired = await authority.createEnrollment('wss://relay.example.test', undefined, 1_000);
const expiredClaim = await authority.claimEnrollment(expired.id, { claim: expired.claim, relayUrl: 'wss://relay.example.test', signingPublicKey: Buffer.alloc(32).toString('base64'), name: 'expired' }, 5 * 60_000 + 1_001);
if (expiredClaim.state !== 'expired') throw new Error('expired enrollment was accepted');
const raced = await authority.createEnrollment('wss://relay.example.test');
const raceInput = { claim: raced.claim, relayUrl: 'wss://relay.example.test', signingPublicKey: Buffer.alloc(32, 1).toString('base64'), name: 'race' };
const raceStates = (await Promise.all([authority.claimEnrollment(raced.id, raceInput), authority.claimEnrollment(raced.id, raceInput)])).map((result) => result.state).sort();
if (raceStates.join(',') !== 'already_claimed,issued') throw new Error('concurrent enrollment claim was not single-use');
rmSync(authorityDir, { recursive: true, force: true });

const dataDir = mkdtempSync(join(tmpdir(), 'muxr-remote-relay-'));
const cliHome = mkdtempSync(join(tmpdir(), 'muxr-remote-cli-'));
const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); });
});
const base = `http://127.0.0.1:${port}`;
const relayUrl = 'wss://relay.example.test';
const child = spawn(process.execPath, ['apps/relay/dist/main.js'], {
    env: { ...process.env, MUXR_RELAY_LOCAL_AUTHORITY: '1', MUXR_RELAY_PORT: String(port), MUXR_RELAY_HOST: '127.0.0.1', MUXR_RELAY_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit'],
});
const json = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
    return { response, body: await response.json() };
};
const bearer = (value) => ({ authorization: `Bearer ${value}` });
const proofMessage = (id, publicKey) => Buffer.from(`muxr-enroll-v1\n${id}\n${relayUrl}\n${publicKey}`);
const slug = (publicKey) => `machine-${createHash('sha256').update('muxr-machine-v1\0').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)}`;

async function enroll(name) {
    const opened = await json('/v1/selfhost/enrollments', { method: 'POST', headers: bearer(mint), body: JSON.stringify({ relay_url: relayUrl }) });
    if (opened.response.status !== 201) throw new Error(`enrollment create failed: ${JSON.stringify(opened.body)}`);
    const keys = nacl.sign.keyPair();
    const publicKey = Buffer.from(keys.publicKey).toString('base64');
    const proof = Buffer.from(nacl.sign.detached(proofMessage(opened.body.enrollment_id, publicKey), keys.secretKey)).toString('base64');
    const claimed = await json(`/v1/selfhost/enrollments/${opened.body.enrollment_id}/claim`, {
        method: 'POST', body: JSON.stringify({ claim: opened.body.claim, relay_url: relayUrl, signing_public_key: publicKey, proof, name }),
    });
    if (claimed.response.status !== 201) throw new Error(`enrollment claim failed: ${JSON.stringify(claimed.body)}`);
    const replay = await json(`/v1/selfhost/enrollments/${opened.body.enrollment_id}/claim`, {
        method: 'POST', body: JSON.stringify({ claim: opened.body.claim, relay_url: relayUrl, signing_public_key: publicKey, proof, name }),
    });
    if (replay.response.status !== 409) throw new Error('enrollment replay was accepted');
    return { name, slug: claimed.body.machine_slug, credential: claimed.body.machine_credential, expectedSlug: slug(publicKey) };
}

async function ticket(machine, target = machine.slug) {
    return json('/v1/selfhost/tickets', {
        method: 'POST', headers: bearer(machine.credential),
        body: JSON.stringify({ role: 'machine', machineSlug: target, transport: 'relay' }),
    });
}

let mint;
let socket;
try {
    await waitForRelay(port);
    mint = JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8'));
    const badEnrollment = await json('/v1/selfhost/enrollments', { method: 'POST', headers: bearer(mint), body: JSON.stringify({ relay_url: relayUrl }) });
    const badKey = nacl.sign.keyPair();
    const badPublicKey = Buffer.from(badKey.publicKey).toString('base64');
    const badProof = await json(`/v1/selfhost/enrollments/${badEnrollment.body.enrollment_id}/claim`, { method: 'POST',
        body: JSON.stringify({ claim: badEnrollment.body.claim, relay_url: relayUrl, signing_public_key: badPublicKey,
            proof: Buffer.from(randomBytes(64)).toString('base64'), name: 'Attacker' }) });
    if (badProof.response.status !== 403) throw new Error('invalid enrollment proof was accepted');

    const a = await enroll('Build server');
    const b = await enroll('Laptop');

    const cliEnrollment = await json('/v1/selfhost/enrollments', {
        method: 'POST', headers: bearer(mint), body: JSON.stringify({ relay_url: relayUrl }),
    });
    const cliPayload = Buffer.from(JSON.stringify({ v: 1, id: cliEnrollment.body.enrollment_id,
        claim: cliEnrollment.body.claim, relay: relayUrl })).toString('base64url');
    const cliResult = spawnSync(process.execPath, ['scripts/cli.mjs', 'connect', '--enrollment', `muxr://enroll?payload=${cliPayload}`, '--no-pair'], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, HOME: cliHome, MUXR_HOME: join(cliHome, '.muxr'), MUXR_NO_SERVICE_COMMANDS: '1', MUXR_REMOTE_CONTROL_BASE: base, MUXR_REMOTE_HOST_ONLINE: '1' },
    });
    if (cliResult.status !== 0) throw new Error(`CLI enrollment failed: ${cliResult.stderr || cliResult.stdout}`);
    const cliState = JSON.parse(readFileSync(join(cliHome, '.muxr', 'selfhost.json'), 'utf8'));
    if (cliState.relayLocation !== 'remote' || typeof cliState.machineCredential !== 'string' || cliState.mintSecret !== undefined) {
        throw new Error('CLI remote state contains the wrong authority');
    }
    const replacement = await json('/v1/selfhost/enrollments', {
        method: 'POST', headers: bearer(mint), body: JSON.stringify({ relay_url: relayUrl }),
    });
    const replacementPayload = Buffer.from(JSON.stringify({ v: 1, id: replacement.body.enrollment_id,
        claim: replacement.body.claim, relay: relayUrl })).toString('base64url');
    const replacementResult = spawnSync(process.execPath, ['scripts/cli.mjs', 'connect', '--enrollment', `muxr://enroll?payload=${replacementPayload}`, '--no-pair', '--force'], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, HOME: cliHome, MUXR_HOME: join(cliHome, '.muxr'), MUXR_NO_SERVICE_COMMANDS: '1', MUXR_REMOTE_CONTROL_BASE: base, MUXR_REMOTE_HOST_ONLINE: '1' },
    });
    if (replacementResult.status !== 0) throw new Error(`CLI re-enrollment failed: ${replacementResult.stderr || replacementResult.stdout}`);
    const replacedState = JSON.parse(readFileSync(join(cliHome, '.muxr', 'selfhost.json'), 'utf8'));
    if (replacedState.machine.id !== cliState.machine.id || replacedState.machineCredential === cliState.machineCredential) {
        throw new Error('CLI re-enrollment did not rotate the existing machine credential');
    }
    if (existsSync(join(cliHome, '.muxr', 'selfhost.previous.json')) || existsSync(join(cliHome, '.muxr', 'selfhost.pending.json'))) {
        throw new Error('successful re-enrollment retained temporary credential backups');
    }
    const expiredHome = mkdtempSync(join(tmpdir(), 'muxr-expired-host-'));
    mkdirSync(join(expiredHome, '.muxr'), { recursive: true, mode: 0o700 });
    writeFileSync(join(expiredHome, '.muxr', 'selfhost.json'), `${JSON.stringify({ ...replacedState, credentialExpiresAt: new Date(0).toISOString() })}\n`, { mode: 0o600 });
    const expiredHost = spawnSync(process.execPath, ['apps/host/dist/main.js'], { encoding: 'utf8',
        env: { ...process.env, HOME: expiredHome, MUXR_HOME: join(expiredHome, '.muxr'), MUXR_MODE: 'selfhost' } });
    if (expiredHost.status !== 0 || !expiredHost.stderr.includes('credential expired')) throw new Error('expired machine credential did not stop the host cleanly');
    rmSync(expiredHome, { recursive: true, force: true });
    writeFileSync(join(cliHome, '.muxr', 'selfhost.pending.json'), `${JSON.stringify(replacedState)}\n`, { mode: 0o600 });
    const resumed = spawnSync(process.execPath, ['scripts/cli.mjs', 'connect', '--resume'], { cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, HOME: cliHome, MUXR_HOME: join(cliHome, '.muxr'), MUXR_NO_SERVICE_COMMANDS: '1', MUXR_REMOTE_CONTROL_BASE: base, MUXR_REMOTE_HOST_ONLINE: '1' } });
    if (resumed.status !== 0 || existsSync(join(cliHome, '.muxr', 'selfhost.pending.json')) || existsSync(join(cliHome, '.muxr', 'selfhost.previous.json'))) {
        throw new Error(`pending enrollment did not resume cleanly: ${resumed.stderr || resumed.stdout}`);
    }

    if (a.slug !== a.expectedSlug || b.slug !== b.expectedSlug || a.slug === b.slug) throw new Error('server-derived machine slug is invalid');
    const authorityFile = readFileSync(join(dataDir, 'machine-authority.json'), 'utf8');
    if (authorityFile.includes(a.credential) || authorityFile.includes(b.credential)) throw new Error('machine credential persisted in plaintext');

    if ((await ticket(a)).response.status !== 200) throw new Error('machine A could not mint its own ticket');
    if ((await ticket(a, b.slug)).response.status !== 403) throw new Error('machine A minted a ticket for machine B');
    const clientRole = await json('/v1/selfhost/tickets', { method: 'POST', headers: bearer(a.credential),
        body: JSON.stringify({ role: 'client', machineSlug: a.slug, transport: 'relay' }) });
    if (clientRole.response.status !== 403) throw new Error('machine credential minted a client ticket');

    const pairClaim = randomBytes(32).toString('base64url');
    const pair = await json('/v1/selfhost/pair-sessions', { method: 'POST', headers: bearer(b.credential),
        body: JSON.stringify({ claim: pairClaim, machineSlug: b.slug, deviceKind: 'native' }) });
    if (pair.response.status !== 201) throw new Error('machine B could not open pairing');
    const crossPoll = await json(`/v1/selfhost/pair-sessions/${pair.body.pair_id}`, { headers: bearer(a.credential) });
    if (crossPoll.body.state !== 'expired') throw new Error('machine A observed machine B pairing state');
    const deviceKey = randomBytes(32).toString('base64');
    const device = await json(`/v1/selfhost/pair-sessions/${pair.body.pair_id}/claim`, { method: 'POST',
        body: JSON.stringify({ claim: pairClaim, device_public_key: deviceKey, device_name: 'Phone', device_kind: 'native', mailbox: 'opaque' }) });
    if (device.response.status !== 201) throw new Error('device claim failed');
    const grantUpload = await json(`/v1/selfhost/pair-sessions/${pair.body.pair_id}/grant`, { method: 'POST', headers: bearer(b.credential), body: JSON.stringify({ grant: 'opaque-grant' }) });
    if (grantUpload.response.status !== 200) throw new Error('machine B could not upload its device grant');
    const crossList = await json(`/v1/selfhost/devices?machine=${encodeURIComponent(b.slug)}`, { headers: bearer(a.credential) });
    if (crossList.response.status !== 403) throw new Error('machine A listed machine B devices');
    const crossRevoke = await json(`/v1/selfhost/devices/${device.body.device_id}`, { method: 'DELETE', headers: bearer(a.credential) });
    if (crossRevoke.response.status !== 404) throw new Error('machine A revoked machine B device');

    const unusedResult = await ticket(b);
    const liveResult = await ticket(b);
    if (unusedResult.response.status !== 200 || liveResult.response.status !== 200) throw new Error(`machine B ticket mint failed: ${JSON.stringify([unusedResult.body, liveResult.body])}`);
    const unused = unusedResult.body.ticket;
    const live = liveResult.body.ticket;
    const ticketState = JSON.parse(readFileSync(join(dataDir, 'tickets.json'), 'utf8'));
    const authorityState = JSON.parse(readFileSync(join(dataDir, 'machine-authority.json'), 'utf8'));
    const liveCredentialIds = new Set(authorityState.machines.filter((machine) => machine.revokedAt === undefined).map((machine) => machine.credentialId));
    if (!ticketState.slice(-2).every((entry) => liveCredentialIds.has(entry.machineCredentialId))) throw new Error('ticket credential id is not active');
    socket = new WebSocket(`ws://127.0.0.1:${port}/relay?ticket=${encodeURIComponent(live)}`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('revoked machine peer stayed connected')), 3000);
        socket.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason) }); });
    });
    const revoked = await json(`/v1/selfhost/machines/${encodeURIComponent(b.slug)}`, { method: 'DELETE', headers: bearer(mint) });
    if (revoked.response.status !== 200) throw new Error('owner could not revoke machine B');
    const close = await closed;
    if (close.code !== 1008 || close.reason !== 'machine revoked') throw new Error(`machine revoke closed incorrectly: ${JSON.stringify(close)}`);
    const unusedSocket = new WebSocket(`ws://127.0.0.1:${port}/relay?ticket=${encodeURIComponent(unused)}`);
    const unusedClosed = await new Promise((resolve) => unusedSocket.once('close', (code) => resolve(code)));
    if (unusedClosed !== 1008) throw new Error('unused ticket survived machine revocation');
    if ((await ticket(b)).response.status !== 403) throw new Error('revoked machine credential still minted tickets');
    const childTicket = await json('/v1/selfhost/tickets', { method: 'POST', headers: bearer(device.body.device_credential),
        body: JSON.stringify({ role: 'client', machineSlug: b.slug, transport: 'relay' }) });
    if (childTicket.response.status !== 403) throw new Error('device credential survived parent machine revocation');
    const revokedGrant = await json(`/v1/selfhost/pair-sessions/${pair.body.pair_id}/grant`, { headers: bearer(device.body.device_credential) });
    if (revokedGrant.response.status !== 403) throw new Error('device retrieved a grant after parent machine revocation');
    const repeatRevoke = await json(`/v1/selfhost/machines/${encodeURIComponent(b.slug)}`, { method: 'DELETE', headers: bearer(mint) });
    if (repeatRevoke.response.status !== 200) throw new Error('machine revocation is not idempotent');
    if ((await ticket(a)).response.status !== 200) throw new Error('revoking B affected machine A');
    process.stdout.write('PASS e2e: shared remote relay machine isolation and revocation\n');
} finally {
    socket?.terminate();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
}
