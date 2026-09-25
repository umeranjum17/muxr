import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceGrant, generateKeyPair, generateSigningKeyPair, pairingCodeHash, sealPairingCodePayload } from '@muxr/crypto';
import { SelfhostPairing } from '../../../../relay/src/admission/infrastructure/selfhostPairing';

/*
 * Flow test for resuming an interrupted Direct SSH pairing. The phone side is
 * the real claim path; the relay side is the relay's real pairing store, so the
 * one-shot code lookup, single-use claim and two-minute window are the ones a
 * user meets. Only the byte route (fetch through the tunnel) is doubled, so a
 * test can drop it the way a dying SSH forward does.
 */

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock('../infrastructure/nativeSecretStore', () => ({
    getNativeSecret: async (key: string) => secrets.get(key) ?? null,
    setNativeSecret: async (key: string, value: string) => { secrets.set(key, value); },
    deleteNativeSecret: async (key: string) => { secrets.delete(key); },
}));
vi.mock('../infrastructure/webSecureStore', () => ({}));
vi.mock('@/connection', () => ({}));

import { claimHostedPairing } from './hostedE2ee';

const MACHINE_ID = 'machine_resume_flow_000000';
const machineSigning = generateSigningKeyPair();
const machineBox = generateKeyPair();

/** `muxr pair` on the computer: open a session and publish its short code. */
async function muxrPair(relay: SelfhostPairing): Promise<string> {
    const claim = 'claim_'.padEnd(43, 'c');
    const { pairId } = await relay.createSession({ claim, machineSlug: MACHINE_ID, deviceKind: 'native' });
    const payload = Buffer.from(JSON.stringify({
        v: '2', generation: '1', id: pairId, claim, pair: 'pair_'.padEnd(43, 'p'),
        machine: MACHINE_ID, name: 'desk', machinePk: machineSigning.publicKey, r: 'wss://desk.lan:8792', authority: 'control',
    })).toString('base64url');
    const code = 'ABCDE23456';
    await relay.publishCode(pairId, MACHINE_ID, { codeHash: pairingCodeHash(code), payload: sealPairingCodePayload(payload, code) });
    return code;
}

/** The SSH forward: the phone's fetches reach the relay store until the tunnel drops. */
function tunnel(relay: SelfhostPairing, drop: { claim?: boolean }) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
        const path = new URL(input).pathname;
        const body = init.body === undefined ? {} : JSON.parse(String(init.body));
        const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
        calls.push(path.split('/').pop()!);
        if (path === '/v1/selfhost/pair-code') {
            const result = await relay.resolveCode(body.code_hash);
            if (result.state === 'resolved') return reply(200, { payload: result.payload, expires_in: Math.floor((result.expiresAt - Date.now()) / 1000) });
            return reply(result.state === 'expired' ? 410 : 404, { error: result.state === 'expired' ? 'pairing_code_expired' : 'invalid_pairing_code' });
        }
        const pairId = decodeURIComponent(path.split('/')[4]!);
        if (path.endsWith('/claim')) {
            if (drop.claim === true) throw new TypeError('Network request failed');
            const result = await relay.claim(pairId, {
                claim: body.claim, devicePublicKey: body.device_public_key, deviceName: body.device_name, deviceKind: body.device_kind === 'browser' ? 'browser' : 'native', mailbox: body.mailbox,
            });
            if (result.state !== 'issued') return reply(result.state === 'already_claimed' ? 409 : 400, { error: result.state });
            // The computer answers the claim with the grant it signs for this device.
            const polled = await relay.poll(pairId, MACHINE_ID);
            await relay.uploadGrant(pairId, MACHINE_ID, JSON.stringify(createDeviceGrant({
                machineId: MACHINE_ID, machineSigningSecretKey: machineSigning.secretKey, machineKey: machineBox,
                deviceId: polled.deviceId!, devicePublicKey: polled.devicePublicKey!,
                dataKey: new Uint8Array(32).fill(1), ingressKey: new Uint8Array(32).fill(2),
                keyVersion: 1, expiresAt: Date.now() + 3_600_000, authority: polled.authority,
            })));
            return reply(200, { device_id: result.deviceId, device_credential: result.credential });
        }
        const grant = await relay.fetchGrant(pairId, (await relay.poll(pairId, MACHINE_ID)).deviceId ?? '');
        return grant === undefined ? reply(404, { error: 'grant_not_available' }) : reply(200, { grant });
    });
    return calls;
}

const sshPairingString = (code: string) => `ws://127.0.0.1:41234?pair=${code}`;

describe('an interrupted Direct SSH pairing', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('resumes with the same code inside the window and ends with an uninterrupted pairing\'s authority', async () => {
        const relay = new SelfhostPairing(mkdtempSync(join(tmpdir(), 'muxr-resume-')));
        const code = await muxrPair(relay);
        const drop = { claim: true };
        const calls = tunnel(relay, drop);

        await expect(claimHostedPairing(sshPairingString(code), { resumable: true })).rejects.toThrow(TypeError);
        drop.claim = false;
        const grant = await claimHostedPairing(sshPairingString(code), { resumable: true });

        expect(calls.filter((call) => call === 'pair-code')).toHaveLength(1);
        expect(grant).toMatchObject({ machineId: MACHINE_ID, authority: 'control', source: 'selfhost', relayUrl: 'wss://desk.lan:8792' });
        // Consumed: a later retry of the finished code gets no second grant.
        await expect(claimHostedPairing(sshPairingString(code), { resumable: true })).rejects.toThrow(/invalid or was already used/);
    });

    it('refuses to resume once the code has expired, and says to get a fresh one', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const relay = new SelfhostPairing(mkdtempSync(join(tmpdir(), 'muxr-resume-')));
        const code = await muxrPair(relay);
        const drop = { claim: true };
        tunnel(relay, drop);

        await expect(claimHostedPairing(sshPairingString(code), { resumable: true })).rejects.toThrow(TypeError);
        drop.claim = false;
        vi.setSystemTime(Date.now() + 2 * 60_000 + 1);
        await expect(claimHostedPairing(sshPairingString(code), { resumable: true })).rejects.toThrow('This pairing code expired. Create a fresh one on the machine.');
    });

    it('refuses to resume a code another device consumed', async () => {
        const relay = new SelfhostPairing(mkdtempSync(join(tmpdir(), 'muxr-resume-')));
        const code = await muxrPair(relay);
        const drop = { claim: true };
        tunnel(relay, drop);

        await expect(claimHostedPairing(sshPairingString(code), { resumable: true })).rejects.toThrow(TypeError);
        // Someone holding the opened pairing claims it before the retry.
        const [session] = (relay as unknown as { state: { sessions: { pairId: string }[] } }).state.sessions;
        await relay.claim(session!.pairId, { claim: 'claim_'.padEnd(43, 'c'), devicePublicKey: generateKeyPair().publicKey, deviceName: 'other', deviceKind: 'native', mailbox: 'm' });
        drop.claim = false;
        await expect(claimHostedPairing(sshPairingString(code), { resumable: true })).rejects.toThrow(/already used/);
        await expect(claimHostedPairing(sshPairingString(code), { resumable: true })).rejects.toThrow(/invalid or was already used/);
    });
});
