import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
    createDeviceGrant,
    generateKeyPair,
    generateSigningKeyPair,
    openPairingCodePayload,
    pairingCodeHash,
    sealPairingCodePayload,
    verifyDeviceGrant,
} from '@muxr/crypto';
import { waitForRelay } from './waitForRelay.mjs';
import { SelfhostPairing } from '../../../apps/relay/dist/admission/infrastructure/selfhostPairing.js';

const expiryDir = mkdtempSync(join(tmpdir(), 'muxr-pair-expiry-'));
const expiryStore = new SelfhostPairing(expiryDir);
const expirySession = await expiryStore.createSession({ claim: 'x'.repeat(43), machineSlug: 'expiry', deviceKind: 'native' }, 1_000);
await expiryStore.publishCode(expirySession.pairId, 'expiry', { codeHash: 'h'.repeat(43), payload: 'sealed' }, 1_000);
const expiredCode = await expiryStore.resolveCode('h'.repeat(43), 121_001);
if (expiredCode.state !== 'expired' || [join(expiryDir, 'selfhost-pairing.json'), join(expiryDir, 'selfhost-pairing.json.bak')]
    .some((file) => readFileSync(file, 'utf8').includes('sealed'))) {
    throw new Error('expired pairing code was not deleted');
}
rmSync(expiryDir, { recursive: true, force: true });

const dataDir = mkdtempSync(join(tmpdir(), 'muxr-revoke-'));
const child = { current: undefined };
const machine = 'muxr-revoke-check';
const signing = generateSigningKeyPair();
const machineBox = generateKeyPair();
const initialDataKey = randomBytes(32).toString('base64');
const expiresAt = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

const freePort = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
    });
});
const base = `http://127.0.0.1:${freePort}`;
const wsBase = `ws://127.0.0.1:${freePort}`;

const json = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...options.headers },
    });
    return { response, body: await response.json() };
};
const bearer = (value) => ({ authorization: `Bearer ${value}` });

async function pair(name) {
    const keys = generateKeyPair();
    const claim = randomBytes(32).toString('base64url');
    const opened = await json('/v1/selfhost/pair-sessions', {
        method: 'POST', headers: bearer(mintSecret), body: JSON.stringify({ claim, machineSlug: machine, deviceKind: 'native' }),
    });
    if (!opened.response.ok) throw new Error(`open pair failed: ${JSON.stringify(opened.body)}`);
    if (opened.body.expires_in !== 120) throw new Error(`pairing code TTL drifted: ${opened.body.expires_in}`);
    const pairId = opened.body.pair_id;
    const code = '7KDM4-QXP7N';
    const clearPayload = `payload-${randomBytes(24).toString('base64url')}`;
    const encryptedPayload = sealPairingCodePayload(clearPayload, code);
    const codeHash = pairingCodeHash(code);
    const publishedCode = await json(`/v1/selfhost/pair-sessions/${pairId}/code`, {
        method: 'POST', headers: bearer(mintSecret), body: JSON.stringify({ code_hash: codeHash, payload: encryptedPayload }),
    });
    if (!publishedCode.response.ok) throw new Error(`pair code publish failed: ${JSON.stringify(publishedCode.body)}`);
    const atRest = readFileSync(join(dataDir, 'selfhost-pairing.json'), 'utf8');
    if (atRest.includes(code) || atRest.includes(clearPayload)) throw new Error('relay persisted a pairing code or clear payload');
    const resolved = await json('/v1/selfhost/pair-code', {
        method: 'POST', body: JSON.stringify({ code_hash: codeHash }),
    });
    if (!resolved.response.ok || openPairingCodePayload(resolved.body.payload, code) !== clearPayload) {
        throw new Error(`pair code resolve failed: ${JSON.stringify(resolved.body)}`);
    }
    const replayedCode = await json('/v1/selfhost/pair-code', {
        method: 'POST', body: JSON.stringify({ code_hash: codeHash }),
    });
    if (replayedCode.response.status !== 404) throw new Error('consumed pairing code resolved twice');
    const afterResolve = [join(dataDir, 'selfhost-pairing.json'), join(dataDir, 'selfhost-pairing.json.bak')]
        .map((file) => readFileSync(file, 'utf8')).join('');
    if (afterResolve.includes(codeHash) || afterResolve.includes(encryptedPayload)) throw new Error('consumed pairing lookup was not deleted');
    const claimed = await json(`/v1/selfhost/pair-sessions/${pairId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ claim, device_public_key: keys.publicKey, device_name: name, device_kind: 'native', mailbox: 'opaque-mailbox' }),
    });
    if (!claimed.response.ok) throw new Error(`claim failed: ${JSON.stringify(claimed.body)}`);
    const device = { id: claimed.body.device_id, credential: claimed.body.device_credential, keys, name };
    const grant = createGrant(device, initialDataKey, 2);
    const uploaded = await json(`/v1/selfhost/pair-sessions/${pairId}/grant`, {
        method: 'POST', headers: bearer(mintSecret), body: JSON.stringify({ grant: JSON.stringify(grant) }),
    });
    if (!uploaded.response.ok) throw new Error(`grant upload failed: ${JSON.stringify(uploaded.body)}`);
    const fetched = await json(`/v1/selfhost/pair-sessions/${pairId}/grant`, { headers: bearer(device.credential) });
    if (!fetched.response.ok || fetched.body.grant !== JSON.stringify(grant)) throw new Error('paired device did not fetch its grant');
    const deleted = await json(`/v1/selfhost/pair-sessions/${pairId}`, { headers: bearer(mintSecret) });
    if (deleted.body.state !== 'expired') throw new Error('completed pairing handoff was not deleted');
    return device;
}

function createGrant(device, dataKey, keyVersion) {
    return createDeviceGrant({
        machineId: machine,
        machineSigningSecretKey: signing.secretKey,
        machineKey: machineBox,
        deviceId: device.id,
        devicePublicKey: device.keys.publicKey,
        dataKey,
        ingressKey: randomBytes(32),
        keyVersion,
        expiresAt,
    });
}

async function ticket(device) {
    const result = await json('/v1/selfhost/tickets', {
        method: 'POST', headers: bearer(device.credential),
        body: JSON.stringify({ role: 'client', machineSlug: machine, transport: 'relay' }),
    });
    if (!result.response.ok) throw new Error(`ticket failed: ${JSON.stringify(result.body)}`);
    return result.body.ticket;
}

const socketFor = (ticketValue) => new WebSocket(`${wsBase}/relay?ticket=${encodeURIComponent(ticketValue)}`);
const openedSocket = (socket) => new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('close', (code, reason) => reject(new Error(`socket closed before open (${code}: ${String(reason)})`)));
});
const closedSocket = (socket) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), 3000);
    socket.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason) }); });
});
const startRelay = async () => {
    child.current = spawn('node', ['apps/relay/dist/main.js'], {
        env: {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_MDNS: '1',
            MUXR_RELAY_PORT: String(freePort),
            MUXR_RELAY_HOST: '127.0.0.1',
            MUXR_RELAY_DATA_DIR: dataDir,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForRelay(freePort);
};
const stopRelay = async () => {
    const running = child.current;
    if (running === undefined) return;
    child.current = undefined;
    running.kill();
    await new Promise((resolve) => running.once('exit', resolve));
};

let mintSecret;
let socketA;
let socketB;
try {
    await startRelay();
    mintSecret = JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8'));

    const authorityClaim = randomBytes(32).toString('base64url');
    const authoritySession = await json('/v1/selfhost/pair-sessions', {
        method: 'POST', headers: bearer(mintSecret),
        body: JSON.stringify({ claim: authorityClaim, machineSlug: machine, deviceKind: 'native' }),
    });
    const rejectedBrowser = await json(`/v1/selfhost/pair-sessions/${authoritySession.body.pair_id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ claim: authorityClaim, device_public_key: generateKeyPair().publicKey, device_name: 'Browser', device_kind: 'browser', mailbox: 'opaque-mailbox' }),
    });
    if (rejectedBrowser.response.status !== 403 || rejectedBrowser.body.error !== 'wrong_device_kind') {
        throw new Error('browser claim accepted a native/full-control invitation');
    }

    const a = await pair('phone A');
    const b = await pair('phone B');
    const oldUnusedTicketA = await ticket(a);
    socketA = socketFor(await ticket(a));
    await openedSocket(socketA);
    socketB = socketFor(await ticket(b));
    await openedSocket(socketB);

    const revokeClose = closedSocket(socketA);
    const revoked = await json(`/v1/selfhost/devices/${encodeURIComponent(a.id)}`, {
        method: 'DELETE', headers: bearer(mintSecret),
    });
    if (!revoked.response.ok) throw new Error(`revoke failed: ${JSON.stringify(revoked.body)}`);
    const closed = await revokeClose;
    if (closed.code !== 1008 || closed.reason !== 'revoked') throw new Error(`revoked socket closed incorrectly: ${JSON.stringify(closed)}`);

    const rejectedCredential = await json('/v1/selfhost/tickets', {
        method: 'POST', headers: bearer(a.credential),
        body: JSON.stringify({ role: 'client', machineSlug: machine, transport: 'relay' }),
    });
    if (rejectedCredential.response.status !== 403) throw new Error('revoked credential still minted a ticket');

    const oldSocket = socketFor(oldUnusedTicketA);
    const rejectedOldTicket = await closedSocket(oldSocket);
    if (rejectedOldTicket.code !== 1008) throw new Error('pre-revocation ticket authenticated after revocation');

    let bClosed = false;
    socketB.once('close', () => { bClosed = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (bClosed) throw new Error('remaining device socket was closed by targeted revocation');

    const rotatedDataKey = randomBytes(32).toString('base64');
    const grantB = createGrant(b, rotatedDataKey, 3);
    const rotationClose = closedSocket(socketB);
    const published = await json(`/v1/selfhost/machines/${machine}/grants`, {
        method: 'POST', headers: bearer(mintSecret),
        body: JSON.stringify({ key_version: 3, grants: [{ device_id: b.id, grant: JSON.stringify(grantB) }] }),
    });
    if (!published.response.ok) throw new Error(`rotation publish failed: ${JSON.stringify(published.body)}`);
    const rotatedClose = await rotationClose;
    if (rotatedClose.code !== 1008 || rotatedClose.reason !== 'keys rotated') throw new Error('remaining device was not asked to refresh rotated keys');

    const fetchedB = await json(`/v1/machines/${machine}/grant`, { headers: bearer(b.credential) });
    const verifiedB = verifyDeviceGrant(JSON.parse(fetchedB.body.grant), {
        pinnedMachineSigningPublicKey: signing.publicKey,
        deviceKey: b.keys,
        deviceId: b.id,
    });
    if (verifiedB.keyVersion !== 3 || verifiedB.dataKey !== rotatedDataKey) throw new Error('remaining device did not receive rotated key');
    const fetchedA = await json(`/v1/machines/${machine}/grant`, { headers: bearer(a.credential) });
    if (fetchedA.response.status !== 403) throw new Error('revoked device fetched a rotated grant');

    socketB = socketFor(await ticket(b));
    await openedSocket(socketB);

    socketB.close();
    await stopRelay();
    await startRelay();
    const rejectedAfterRestart = await json('/v1/selfhost/tickets', {
        method: 'POST', headers: bearer(a.credential),
        body: JSON.stringify({ role: 'client', machineSlug: machine, transport: 'relay' }),
    });
    if (rejectedAfterRestart.response.status !== 403) throw new Error('revoked credential revived after relay restart');
    socketB = socketFor(await ticket(b));
    await openedSocket(socketB);
    process.stdout.write('PASS e2e: durable two-device self-host revocation, rotation, and restart\n');
} catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
} finally {
    socketA?.close();
    socketB?.close();
    await stopRelay();
    rmSync(dataDir, { recursive: true, force: true });
}
