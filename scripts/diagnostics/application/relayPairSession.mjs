/**
 * Pairs a phone the pre-step-4 way: a relay pair session, the phone's claim
 * mailbox, and the CLI-side grant upload with the device record in
 * selfhost.json. Step 4 moved `muxr pair` for native phones onto the byokit
 * link, so the old native flow survives here for the tests that exercise
 * upgrade (a phone paired before the link existed) and the relay transport
 * those phones still hold.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newPairingCode, pairingCodeHash, pairingIntent } from '../../setup/index.mjs';
import { createDeviceGrant, deriveV2Key, newV2ReplayTracker, openV2, sealPairingCodePayload } from '@muxr/crypto';

export async function relayPairSession({ home, port, claim, machineName = 'self-host' }) {
    const stateFile = join(home, 'selfhost.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${state.mintSecret}`, 'content-type': 'application/json' };
    const claimSecret = randomBytes(32).toString('base64url');
    const pairSecret = randomBytes(32).toString('base64url');
    const created = await (await fetch(new URL('/v1/selfhost/pair-sessions', base), {
        method: 'POST', headers, body: JSON.stringify({ claim: claimSecret, machineSlug: state.machine.id, deviceKind: 'native', authority: 'control' }),
    })).json();
    const code = newPairingCode();
    const payload = Buffer.from(JSON.stringify({
        v: '2', generation: String(state.machine.crypto.keyVersion), id: created.pair_id, claim: claimSecret, pair: pairSecret,
        machine: state.machine.id, name: state.machine.name ?? machineName, machinePk: state.machine.crypto.signingPublicKey,
        r: state.relayUrl, authority: 'control',
    })).toString('base64url');
    await fetch(new URL(`/v1/selfhost/pair-sessions/${encodeURIComponent(created.pair_id)}/code`, base), {
        method: 'POST', headers, body: JSON.stringify({ code_hash: pairingCodeHash(code), payload: sealPairingCodePayload(payload, code) }),
    });
    const text = pairingIntent({ kind: 'native' }).pairingLocator(state.relayUrl, code);
    // The phone claims and then waits for the grant, so the old CLI's side
    // polls concurrently, exactly as `muxr pair` used to.
    const storedPromise = claim(text);
    const deadline = Date.now() + 20_000;
    let polled;
    for (;;) {
        const reply = await (await fetch(new URL(`/v1/selfhost/pair-sessions/${encodeURIComponent(created.pair_id)}`, base), { headers })).json();
        if (reply.state === 'claimed' && reply.mailbox !== undefined) { polled = reply; break; }
        if (Date.now() > deadline) throw new Error('old-style pairing never claimed');
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const request = JSON.parse(openV2(polled.mailbox, deriveV2Key(pairSecret, 'client->host'), {
        machineId: state.machine.id, senderId: polled.devicePublicKey, recipientId: state.machine.id,
        channel: 'pairing', streamId: created.pair_id, keyVersion: state.machine.crypto.keyVersion,
    }, newV2ReplayTracker()));
    void request;
    const deviceId = polled.deviceId;
    const ingressKey = Buffer.from(randomBytes(32)).toString('base64');
    const intent = pairingIntent({ kind: 'native' });
    const grant = JSON.stringify(createDeviceGrant({
        machineId: state.machine.id,
        machineSigningSecretKey: state.machine.crypto.signingSecretKey,
        machineKey: { publicKey: state.machine.crypto.boxPublicKey, secretKey: state.machine.crypto.boxSecretKey },
        deviceId,
        devicePublicKey: polled.devicePublicKey,
        dataKey: state.machine.crypto.dataKey,
        ingressKey,
        keyVersion: state.machine.crypto.keyVersion,
        expiresAt: intent.grantExpiresAt(),
        authority: 'control',
    }));
    // The old CLI also recorded the device in selfhost.json — the machine's
    // own authority, which is what a restarted host enrols the phone from.
    state.machine.crypto.devices = [
        ...state.machine.crypto.devices.filter((device) => device.deviceId !== deviceId),
        { deviceId, devicePublicKey: polled.devicePublicKey, ingressKey, expiresAt: new Date(intent.grantExpiresAt()).toISOString(), authority: 'control' },
    ];
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const uploaded = await fetch(new URL(`/v1/selfhost/pair-sessions/${encodeURIComponent(created.pair_id)}/grant`, base), {
        method: 'POST', headers, body: JSON.stringify({ grant }),
    });
    if (!uploaded.ok) throw new Error(`old-style grant upload failed (${uploaded.status})`);
    return await storedPromise;
}
