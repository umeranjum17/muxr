/** Runnable proof that the E2EE codec round-trips and rejects tampering. */

import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import {
    createDeviceGrant,
    createPayloadCodec,
    decryptPayload,
    deriveSharedKey,
    deriveV2Key,
    encryptPayload,
    generateKeyPair,
    generateSigningKeyPair,
    isEncryptedPayload,
    isV2Envelope,
    newV2ReplayTracker,
    newV2SenderState,
    openV2,
    sealV2,
    signDetached,
    v2ReplayFromSnapshot,
    v2SenderFromSnapshot,
    v2SenderToSnapshot,
    verifyDetached,
    verifyDeviceGrant,
    type V2Context,
} from './index.js';

// --- legacy v1 codec (local mode; must keep working) -----------------------

const machine = generateKeyPair();
const client = generateKeyPair();

const machineShared = deriveSharedKey(machine.secretKey, client.publicKey);
const clientShared = deriveSharedKey(client.secretKey, machine.publicKey);
assert.equal(machineShared, clientShared, 'both sides must derive the same key');

const plaintext = JSON.stringify({ type: 'session.event', secret: 'do not leak' });
const encrypted = encryptPayload(plaintext, machineShared);
assert.ok(isEncryptedPayload(encrypted), 'payload must be tagged');
assert.ok(!encrypted.includes('do not leak'), 'plaintext must not appear in ciphertext');
assert.equal(decryptPayload(encrypted, clientShared), plaintext, 'client must decrypt machine payload');

// Tampering must fail loudly, not silently return garbage.
const tampered = `${encrypted.slice(0, -4)}AAAA`;
assert.throws(() => decryptPayload(tampered, clientShared), /authentication|malformed/);

// A third party with its own key must not be able to read it.
const attacker = generateKeyPair();
const attackerShared = deriveSharedKey(attacker.secretKey, machine.publicKey);
assert.throws(() => decryptPayload(encrypted, attackerShared), /authentication/);

// Nonce reuse check: same plaintext twice must produce different ciphertext.
assert.notEqual(encryptPayload(plaintext, machineShared), encryptPayload(plaintext, machineShared));

// Opt-in: no key means passthrough, never silent fake encryption.
const off = createPayloadCodec();
assert.equal(off.enabled, false);
assert.equal(off.encode(plaintext), plaintext);
const on = createPayloadCodec(machineShared);
assert.equal(on.enabled, true);
assert.equal(on.decode(on.encode(plaintext)), plaintext);

// --- v2 strict envelope (hosted) --------------------------------------------

// One flow: host and device derive directional keys from shared roots, exchange
// a pairing-mailbox frame, then a grant hands the device its ingress root, and
// every negative case (wrong key/direction, context mismatch, tamper, replay,
// plaintext, malformed/unknown version, bad snapshot) fails closed.

const dataRoot = nacl.randomBytes(32);
const hostToDevice = deriveV2Key(dataRoot, 'host->client');
const deviceToHost = deriveV2Key(dataRoot, 'client->host');
assert.notEqual(hostToDevice, deviceToHost, 'directional keys must differ');
assert.equal(deriveV2Key(dataRoot, 'host->client'), hostToDevice, 'derivation must be deterministic');
assert.throws(() => deriveV2Key(nacl.randomBytes(16), 'host->client'), /32 bytes/, 'root must be 32 bytes');

const ctx = {
    machineId: 'm1', senderId: 'host', recipientId: 'dev-1',
    channel: 'session', streamId: 'sess-1', keyVersion: 1,
} as const;
const sender = newV2SenderState();
const env = sealV2('hello from host', hostToDevice, ctx, sender);
assert.ok(isV2Envelope(env), 'v2 payload must be tagged');
assert.ok(!env.includes('hello from host'), 'plaintext must not appear in the envelope');
assert.equal(sender.seq, 1, 'sender sequence advances');
const replay = newV2ReplayTracker();
assert.equal(openV2(env, hostToDevice, ctx, replay), 'hello from host', 'device opens host frame');

// Pairing mailbox: same envelope, key derived from the pair-secret root.
const pairRoot = nacl.randomBytes(32);
const pairKey = deriveV2Key(pairRoot, 'host->client');
const pairCtx: V2Context = { ...ctx, channel: 'pairing', streamId: 'mailbox-1' };
const pairEnv = sealV2(JSON.stringify({ hello: 'device' }), pairKey, pairCtx, newV2SenderState());
assert.equal(openV2(pairEnv, pairKey, pairCtx, newV2ReplayTracker()), JSON.stringify({ hello: 'device' }), 'pairing mailbox round-trips');

// Wrong key / wrong direction.
assert.throws(() => openV2(env, deviceToHost, ctx, newV2ReplayTracker()), /authentication/, 'opposite direction key must fail');
assert.throws(() => openV2(env, deriveV2Key(nacl.randomBytes(32), 'host->client'), ctx, newV2ReplayTracker()), /authentication/, 'unrelated key must fail');

// Context mismatch: every field is authenticated inside the seal.
assert.throws(() => openV2(env, hostToDevice, { ...ctx, machineId: 'm2' }, replay), /context mismatch/);
assert.throws(() => openV2(env, hostToDevice, { ...ctx, senderId: 'spoof' }, replay), /context mismatch/);
assert.throws(() => openV2(env, hostToDevice, { ...ctx, recipientId: 'dev-2' }, replay), /context mismatch/);
assert.throws(() => openV2(env, hostToDevice, { ...ctx, channel: 'terminal' }, replay), /context mismatch/);
assert.throws(() => openV2(env, hostToDevice, { ...ctx, streamId: 'sess-2' }, replay), /context mismatch/);
assert.throws(() => openV2(env, hostToDevice, { ...ctx, keyVersion: 2 }, replay), /context mismatch/);
assert.throws(() => sealV2('x', hostToDevice, { ...ctx, channel: 'nope' } as unknown as V2Context, newV2SenderState()), /unknown channel/, 'seal rejects bad context');

// Tamper, plaintext, malformed, unknown version.
const flipAt = Math.floor(env.length / 2);
const tamperedEnv = env.slice(0, flipAt) + (env[flipAt] === 'A' ? 'B' : 'A') + env.slice(flipAt + 1);
assert.throws(() => openV2(tamperedEnv, hostToDevice, ctx, newV2ReplayTracker()), /authentication/, 'tampered ciphertext must fail');
assert.throws(() => openV2('hello clear', hostToDevice, ctx, newV2ReplayTracker()), /non-v2/, 'cleartext fails closed');
assert.throws(() => openV2('e2ee:v1:abc.def', hostToDevice, ctx, newV2ReplayTracker()), /non-v2/, 'legacy frame fails closed in strict mode');
assert.throws(() => openV2('e2ee:v2:', hostToDevice, ctx, newV2ReplayTracker()), /malformed/, 'empty envelope fails');
assert.throws(() => openV2('e2ee:v2:' + Buffer.concat([Buffer.from([3]), Buffer.alloc(24)]).toString('base64'), hostToDevice, ctx, newV2ReplayTracker()), /unknown version/, 'bad version fails');
assert.throws(() => openV2(env.slice(0, env.length - 8), hostToDevice, ctx, newV2ReplayTracker()), /malformed|authentication/, 'truncated envelope fails');

// Replay: same envelope twice; out-of-order within an epoch.
assert.throws(() => openV2(env, hostToDevice, ctx, replay), /replay/, 'replayed envelope must fail');
const outOfOrderSender = newV2SenderState();
const outOfOrderReplay = newV2ReplayTracker();
const seqA = sealV2('a', hostToDevice, ctx, outOfOrderSender);
const seqB = sealV2('b', hostToDevice, ctx, outOfOrderSender);
assert.equal(openV2(seqB, hostToDevice, ctx, outOfOrderReplay), 'b');
assert.throws(() => openV2(seqA, hostToDevice, ctx, outOfOrderReplay), /replay/, 'older sequence is a replay');

// Restart safety: snapshots persist epoch+sequence and the replay window, so a
// restored sender never emits a lower sequence and a restored receiver still
// rejects old frames.
const restoredSender = v2SenderFromSnapshot(JSON.parse(JSON.stringify(v2SenderToSnapshot(sender))));
assert.equal(restoredSender.seq, sender.seq, 'persisted sender resumes the sequence');
const envAfterRestart = sealV2('after restart', hostToDevice, ctx, restoredSender);
assert.equal(openV2(envAfterRestart, hostToDevice, ctx, newV2ReplayTracker()), 'after restart');
const restoredReplay = v2ReplayFromSnapshot(JSON.parse(JSON.stringify(replay.toSnapshot())));
assert.throws(() => openV2(env, hostToDevice, ctx, restoredReplay), /replay/, 'persisted tracker still rejects old frames');
assert.throws(() => v2SenderFromSnapshot({ epoch: 'AA==', seq: 0 }), /16 bytes/, 'bad epoch fails closed');
assert.throws(() => v2SenderFromSnapshot({ epoch: newV2SenderState().epoch, seq: -1 }), /non-negative/, 'bad seq fails closed');
assert.throws(() => v2ReplayFromSnapshot({ epochs: [{ epoch: 'AA==', maxSeq: 0 }] }), /malformed/, 'bad replay snapshot fails closed');

// --- machine identity + device grants ---------------------------------------

const machineSigning = generateSigningKeyPair();
const machineX = generateKeyPair();
const deviceX = generateKeyPair();
const ingressRoot = nacl.randomBytes(32);
const grant = createDeviceGrant({
    machineId: 'm1',
    machineSigningSecretKey: machineSigning.secretKey,
    machineKey: machineX,
    deviceId: 'dev-1',
    devicePublicKey: deviceX.publicKey,
    dataKey: dataRoot,
    ingressKey: ingressRoot,
    keyVersion: 1,
    expiresAt: Date.now() + 60_000,
});
assert.equal(grant.signer, machineSigning.publicKey, 'grant names the signing key');
assert.equal(verifyDetached(
    Buffer.from('pinned bytes'),
    signDetached(Buffer.from('pinned bytes'), machineSigning.secretKey),
    machineSigning.publicKey,
), true, 'detached signature verifies');

const openedGrant = verifyDeviceGrant(grant, {
    pinnedMachineSigningPublicKey: machineSigning.publicKey,
    deviceKey: deviceX,
    deviceId: 'dev-1',
});
assert.equal(openedGrant.machineId, 'm1');
assert.equal(openedGrant.devicePublicKey, deviceX.publicKey);
assert.equal(openedGrant.keyVersion, 1);
assert.equal(openedGrant.dataKey, Buffer.from(dataRoot).toString('base64'));
assert.equal(openedGrant.ingressKey, Buffer.from(ingressRoot).toString('base64'));

// The grant's ingress root drives device->host frames; the device derives the
// direction key from the base64 root it received in the grant.
const deviceIngressKey = deriveV2Key(openedGrant.ingressKey, 'client->host');
const ingressCtx = { ...ctx, senderId: 'dev-1', recipientId: 'host' };
const ingressEnv = sealV2('device says hi', deviceIngressKey, ingressCtx, newV2SenderState());
assert.equal(openV2(ingressEnv, deviceIngressKey, ingressCtx, newV2ReplayTracker()), 'device says hi', 'grant ingress key opens device frames');

// Grant negative cases.
const wrongPinned = generateSigningKeyPair().publicKey;
assert.throws(() => verifyDeviceGrant(grant, { pinnedMachineSigningPublicKey: wrongPinned, deviceKey: deviceX }), /pinned/, 'wrong pinned key fails');
assert.throws(() => verifyDeviceGrant(grant, { pinnedMachineSigningPublicKey: machineSigning.publicKey, deviceKey: generateKeyPair() }), /decryption/, 'wrong device key fails');
assert.throws(() => verifyDeviceGrant(grant, { pinnedMachineSigningPublicKey: machineSigning.publicKey, deviceKey: deviceX, deviceId: 'dev-2' }), /device id mismatch/, 'device id binding fails');
assert.throws(() => verifyDeviceGrant({ ...grant, box: tamperBase64(grant.box) }, { pinnedMachineSigningPublicKey: machineSigning.publicKey, deviceKey: deviceX }), /decryption/, 'tampered box fails');
const wrongSig = signDetached(Buffer.from('something else'), machineSigning.secretKey);
assert.throws(() => verifyDeviceGrant({ ...grant, sig: wrongSig }, { pinnedMachineSigningPublicKey: machineSigning.publicKey, deviceKey: deviceX }), /signature/, 'tampered signature fails');
const expired = createDeviceGrant({
    machineId: 'm1',
    machineSigningSecretKey: machineSigning.secretKey,
    machineKey: machineX,
    deviceId: 'dev-1',
    devicePublicKey: deviceX.publicKey,
    dataKey: dataRoot,
    ingressKey: ingressRoot,
    keyVersion: 1,
    expiresAt: Date.now() - 1000,
});
assert.throws(
    () => verifyDeviceGrant(expired, { pinnedMachineSigningPublicKey: machineSigning.publicKey, deviceKey: deviceX }),
    /expired/,
    'expired browser/device grants fail closed',
);

function tamperBase64(value: string): string {
    const at = Math.floor(value.length / 2);
    return value.slice(0, at) + (value[at] === 'A' ? 'B' : 'A') + value.slice(at + 1);
}

process.stdout.write('PASS: crypto selfCheck (legacy codec, v2 envelope, context auth, replay, restart snapshots, grants)\n');
