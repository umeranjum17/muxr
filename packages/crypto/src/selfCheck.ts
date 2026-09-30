/** Runnable proof that the E2EE codec round-trips and rejects tampering. */

import assert from 'node:assert/strict';
import {
    createDeviceGrant,
    createSignedPeerDescriptor,
    generateKeyPair,
    generateSigningKeyPair,
    signDetached,
    verifyDetached,
    verifyDeviceGrant,
    verifySignedPeerDescriptor,
    grantAuthority,
    grantIsPeer,
    grantHasExpired,
    openPeerInstallBundle,
    sealPeerInstallBundle,
} from './index.js';

const dataRoot = crypto.getRandomValues(new Uint8Array(32));

// --- machine identity + device grants ---------------------------------------

const machineSigning = generateSigningKeyPair();
const machineX = generateKeyPair();
const deviceX = generateKeyPair();
const ingressRoot = crypto.getRandomValues(new Uint8Array(32));
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

// Grant and install bundle negative cases.
const wrongPinned = generateSigningKeyPair().publicKey;
const installBundle = sealPeerInstallBundle({
    payload: {
        v: 1, relationshipId: 'peer-install-1', targetMachineId: 'm2',
        targetMachineSigningPublicKey: targetSigning.publicKey, relayUrl: 'wss://relay.example.test',
        peerDeviceId: 'peer-1', grant: peerGrant,
        capabilities: ['list', 'read', 'status', 'watch', 'prompt'], issuedAt: Date.now(),
    },
    targetMachineSigningSecretKey: targetSigning.secretKey,
    targetMachineKey: machineX,
    peerPublicKey: preparedPeer.publicKey,
});
const installOptions = { peerKey: preparedPeer, pinnedTargetMachineSigningPublicKey: targetSigning.publicKey };
assert.equal(openPeerInstallBundle(installBundle, installOptions).peerDeviceId, openedPeerGrant.deviceId);
assert.throws(() => openPeerInstallBundle(installBundle, { ...installOptions, pinnedTargetMachineSigningPublicKey: wrongPinned }), /pinned/, 'install bundles reject the wrong machine authority');
const sealedInstall = JSON.parse(installBundle);
assert.throws(() => openPeerInstallBundle(JSON.stringify({ ...sealedInstall, box: tamperBase64(sealedInstall.box) }), installOptions), /decryption/, 'tampered install boxes fail');
assert.throws(() => openPeerInstallBundle(JSON.stringify({ ...sealedInstall, sig: signDetached(Buffer.from('different bundle'), targetSigning.secretKey) }), installOptions), /signature/, 'tampered install signatures fail');
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

process.stdout.write('PASS: crypto selfCheck (signed grants, peer descriptors, install bundles)\n');
