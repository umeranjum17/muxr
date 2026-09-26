/** Runnable proof that the E2EE codec round-trips and rejects tampering. */

import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import {
    createDeviceGrant,
    createSignedPeerDescriptor,
    generateKeyPair,
    generateSigningKeyPair,
    openPairingCodePayload,
    pairingCodeHash,
    sealPairingCodePayload,
    signDetached,
    verifyDetached,
    verifyDeviceGrant,
    verifySignedPeerDescriptor,
    grantAuthority,
    grantIsPeer,
    grantHasExpired,
    parsePairingCode,
} from './index.js';

// --- short pairing-code payload ---------------------------------------------

const pairingCode = '7KDM4-QXP7N';
const pairingPayload = JSON.stringify({ pairSecret: 'high-entropy-secret', relay: 'wss://relay.example' });
const pairingCiphertext = sealPairingCodePayload(pairingPayload, pairingCode);
assert.ok(!pairingCiphertext.includes('high-entropy-secret'), 'relay-stored code payload hides the pairing secret');
assert.ok(!pairingCodeHash(pairingCode).includes('7KDM4'), 'relay lookup does not contain the human code');
assert.equal(openPairingCodePayload(pairingCiphertext, pairingCode), pairingPayload, 'pairing code opens its payload');
assert.ok(parsePairingCode(pairingCode).ok, 'pairing code parser accepts the spoken form');
assert.ok(!parsePairingCode('nope').ok, 'pairing code parser rejects an expected bad code');
assert.throws(() => openPairingCodePayload(pairingCiphertext, '8KDM4-QXP7N'), /authentication/, 'wrong pairing code fails closed');

const dataRoot = nacl.randomBytes(32);

// --- machine identity + device grants ---------------------------------------

const machineSigning = generateSigningKeyPair();
const machineX = generateKeyPair();
const deviceX = generateKeyPair();
const ingressRoot = nacl.randomBytes(32);
const targetSigning = generateSigningKeyPair();
const preparedPeer = generateKeyPair();
const peerDescriptor = createSignedPeerDescriptor({
    sourceMachineId: 'm1',
    sourceMachineSigningSecretKey: machineSigning.secretKey,
    targetMachineId: 'm2',
    targetMachineSigningPublicKey: targetSigning.publicKey,
    peerPublicKey: preparedPeer.publicKey,
    preparedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce: 'prepare-1',
});
assert.equal(verifySignedPeerDescriptor(peerDescriptor, {
    targetMachineId: 'm2', targetMachineSigningPublicKey: targetSigning.publicKey,
}).peerPublicKey, preparedPeer.publicKey, 'target verifies the machine-signed prepared peer key');
assert.throws(() => verifySignedPeerDescriptor(peerDescriptor, {
    targetMachineId: 'm3', targetMachineSigningPublicKey: targetSigning.publicKey,
}), /target binding/, 'prepared descriptors cannot be redirected');
assert.throws(() => createSignedPeerDescriptor({
    sourceMachineId: 'm1', sourceMachineSigningSecretKey: machineSigning.secretKey,
    targetMachineId: 'm2', targetMachineSigningPublicKey: targetSigning.publicKey,
    peerPublicKey: preparedPeer.publicKey, preparedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000, nonce: 'too-long',
}), /too long/, 'prepared peer descriptors have a bounded replay window');

const grant = createDeviceGrant({
    machineId: 'm1',
    machineSigningSecretKey: machineSigning.secretKey,
    machineKey: machineX,
    deviceId: 'dev-1',
    devicePublicKey: deviceX.publicKey,
    dataKey: dataRoot,
    ingressKey: ingressRoot,
    keyVersion: 2,
    expiresAt: Date.now() + 60_000,
});
assert.equal(grant.signer, machineSigning.publicKey, 'grant names the signing key');
assert.throws(() => createDeviceGrant({
    machineId: 'm1', machineSigningSecretKey: machineSigning.secretKey, machineKey: machineX,
    deviceId: 'dev-1', devicePublicKey: deviceX.publicKey, dataKey: dataRoot, ingressKey: ingressRoot,
    keyVersion: 0, expiresAt: Date.now() + 60_000,
}), /generation/, 'invalid grant generations are rejected');
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
assert.equal(openedGrant.keyVersion, 2);
assert.equal(openedGrant.authority, 'control');
assert.equal(grantIsPeer(openedGrant), false, 'native grants are not peers');
assert.equal(grantAuthority(openedGrant), 'control');
assert.equal(openedGrant.dataKey, Buffer.from(dataRoot).toString('base64'));
assert.equal(openedGrant.ingressKey, Buffer.from(ingressRoot).toString('base64'));

const peerGrant = createDeviceGrant({
    machineId: 'm2', machineSigningSecretKey: targetSigning.secretKey, machineKey: machineX,
    deviceId: 'peer-1', devicePublicKey: preparedPeer.publicKey, dataKey: dataRoot, ingressKey: ingressRoot,
    keyVersion: 1, expiresAt: Date.now() + 60_000, deviceKind: 'peer',
    capabilities: ['list', 'read', 'status', 'watch', 'prompt'],
});
const openedPeerGrant = verifyDeviceGrant(peerGrant, {
    pinnedMachineSigningPublicKey: targetSigning.publicKey, deviceKey: preparedPeer, deviceId: 'peer-1',
});
assert.equal(openedPeerGrant.deviceKind, 'peer');
assert.deepEqual(openedPeerGrant.capabilities, ['list', 'read', 'status', 'watch', 'prompt']);
assert.equal(openedPeerGrant.authority, undefined, 'peer grants never carry broad control authority');
assert.equal(grantIsPeer(openedPeerGrant), true);
assert.equal(grantHasExpired(openedPeerGrant, Date.now() - 1), false, 'fresh peer grant has not expired');
assert.equal(grantAuthority(openedPeerGrant), undefined, 'peer grants never carry broad control authority');
assert.throws(() => createDeviceGrant({
    machineId: 'm2', machineSigningSecretKey: targetSigning.secretKey, machineKey: machineX,
    deviceId: 'peer-1', devicePublicKey: preparedPeer.publicKey, dataKey: dataRoot, ingressKey: ingressRoot,
    keyVersion: 1, expiresAt: Date.now() + 60_000, deviceKind: 'peer', authority: 'control',
    capabilities: ['list', 'read', 'status', 'watch', 'prompt'],
}), /broad authority/, 'peer grants reject control authority');

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
    keyVersion: 2,
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

process.stdout.write('PASS: crypto selfCheck (pairing code, signed grants, peer descriptors)\n');
