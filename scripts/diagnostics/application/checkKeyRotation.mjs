/** Rotating the machine keys retires the old host on the relay and ends every pairing; a fresh pairing works. */
import { randomUUID } from 'node:crypto';
import { createSignedPeerDescriptor, generateKeyPair } from '@trymuxr/crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostId } from '@byokit/link';
import { waitForRelay } from './waitForRelay.mjs';
import { linkLabClient, requestLab } from './linkLabClient.mjs';
import { machineIdentity } from '../../setup/index.mjs';
import { writeSelfhostCrypto } from '../../../apps/host/dist/machine/infrastructure/selfhostCrypto.js';

const root = mkdtempSync(join(tmpdir(), 'muxr-key-rotation-'));
const home = join(root, 'muxr');
const children = [];
const env = { ...process.env, MUXR_HOME: home, MUXR_DATA_DIR: join(root, 'host'), MUXR_NO_SERVICE_COMMANDS: '1' };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_URL', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH']) delete env[key];

async function until(check, what, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function launch(args, extra = {}) {
    const child = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; });
    child.stderr.on('data', (part) => { output += part; });
    child.output = () => output;
    children.push(child);
    return child;
}

async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
}

const rotate = (...flags) => spawnSync(process.execPath, ['scripts/cli.mjs', 'devices', 'rotate-keys', ...flags], { env, encoding: 'utf8' });
const readState = () => JSON.parse(readFileSync(join(home, 'selfhost.json'), 'utf8'));
const hostOf = (crypto) => hostId(Buffer.from(crypto.boxPublicKey, 'base64'));
const authorizePeer = async (device) => {
    const source = machineIdentity(undefined);
    const target = readState().machine;
    const now = Date.now();
    const descriptor = createSignedPeerDescriptor({
        sourceMachineId: source.id, sourceMachineSigningSecretKey: source.crypto.signingSecretKey,
        targetMachineId: target.id, targetMachineSigningPublicKey: target.crypto.signingPublicKey,
        peerPublicKey: generateKeyPair().publicKey, preparedAt: now, expiresAt: now + 60_000,
        nonce: randomUUID(), sourceName: 'Rotation peer',
    });
    const authorized = await requestLab(device, 'peer.authorize', {
        descriptor, capabilities: ['list', 'read'],
        mutation: { operationId: randomUUID(), notValidAfter: now + 60_000 },
    });
    const listed = await requestLab(device, 'peer.list');
    const relationship = listed.peers.find((peer) => peer.peerDeviceId === authorized.peerDeviceId);
    if (relationship?.state !== 'connected') throw new Error('peer authorization did not connect');
    return relationship;
};

try {
    const relay = launch(['apps/relay/dist/main.js'], {
        MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: join(root, 'relay'), MUXR_RELAY_MDNS: '0',
    });
    const port = await waitForRelay(relay);
    const owner = JSON.parse(readFileSync(join(root, 'relay', 'mint-secret'), 'utf8'));
    const hosts = () => fetch(`http://127.0.0.1:${port}/relay/v1/hosts`, { headers: { authorization: `Bearer ${owner}` } })
        .then((response) => response.json()).then((body) => body.hosts ?? []);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, machine: { ...machineIdentity(undefined), name: 'Rotation machine' },
        relayPort: port, relayUrl: `ws://127.0.0.1:${port}`, relayLocation: 'local', relayRole: 'single-machine',
        connectionMode: 'lan', webEnabled: false, mintSecret: owner })}\n`, { mode: 0o600 });
    const socketPath = join(root, 'host', 'pair.sock');
    const start = async () => {
        const host = launch(['apps/host/dist/main.js', '--fake'], { MUXR_MODE: 'selfhost', MUXR_DATA_DIR: join(root, 'host') });
        await until(() => host.output().includes('link relay: online'), 'link host online');
        await until(() => existsSync(socketPath), 'host pairing socket');
        return host;
    };

    const first = await start();
    const device = await linkLabClient(socketPath);
    await requestLab(device, 'machines.list');
    if (readState().machine.crypto.devices.length !== 1) throw new Error('lab device was not paired');
    const peer = await authorizePeer(device);
    const before = readState().machine.crypto;

    if (rotate().status === 0 || readState().machine.crypto.boxSecretKey !== before.boxSecretKey) {
        throw new Error('rotation ran without --unpair-all');
    }
    const active = rotate('--unpair-all');
    if (active.status === 0 || !active.stderr.includes('stop the foreground muxr host')
        || JSON.stringify(readState().machine.crypto) !== JSON.stringify(before)) throw new Error('rotation did not refuse the live foreground host');
    await stop(first);
    const rotated = rotate('--unpair-all');
    if (rotated.status !== 0) throw new Error(`rotation failed: ${rotated.stderr}`);
    const after = readState().machine.crypto;
    for (const key of ['signingSecretKey', 'signingPublicKey', 'boxSecretKey', 'boxPublicKey', 'dataKey']) {
        if (after[key] === before[key]) throw new Error(`${key} was not replaced`);
    }
    if (after.keyVersion !== before.keyVersion + 1 || after.devices.length !== 0) throw new Error('rotation kept the old version or pairings');
    let rejected = false;
    try { writeSelfhostCrypto(join(home, 'selfhost.json'), before); }
    catch { rejected = true; }
    if (!rejected || readState().machine.crypto.boxPublicKey !== after.boxPublicKey) throw new Error('a stale host commit restored the retired keys');
    if ((await hosts()).some((host) => host.id === hostOf(before))) throw new Error('relay still admits the old host key');
    await until(() => device.status !== 'online', 'old pairing drops off the retired host');

    await start();
    await until(async () => (await hosts()).some((host) => host.id === hostOf(after) && host.online), 'new host key online on the relay');
    if ((await hosts()).some((host) => host.id === hostOf(before))) throw new Error('restarted host re-enrolled the old key');
    if (device.status === 'online') throw new Error('old pairing reached the rotated host');
    device.stop();
    const repaired = await linkLabClient(socketPath);
    try {
        await requestLab(repaired, 'machines.list');
        const disconnected = await requestLab(repaired, 'peer.revoke', { relationshipId: peer.relationshipId,
            mutation: { operationId: randomUUID(), notValidAfter: Date.now() + 60_000 } });
        if (disconnected.state !== 'already-revoked') throw new Error('rotation did not retire the old peer relationship');
        const freshPeer = await authorizePeer(repaired);
        const freshDisconnect = await requestLab(repaired, 'peer.revoke', { relationshipId: freshPeer.relationshipId,
            mutation: { operationId: randomUUID(), notValidAfter: Date.now() + 60_000 } });
        if (freshDisconnect.state !== 'revoked') throw new Error('fresh peer collaboration could not disconnect');
    }
    finally { repaired.stop(); }
    process.stdout.write('PASS: rotation refuses a live host, retires keys and peers, and re-pairing supports fresh collaboration\n');
} finally {
    await Promise.all(children.map(stop));
    rmSync(root, { recursive: true, force: true });
}
