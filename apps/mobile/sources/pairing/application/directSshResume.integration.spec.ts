import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceGrant, generateKeyPair, generateSigningKeyPair, pairingCodeHash, sealPairingCodePayload } from '@muxr/crypto';
import { startRelay, type RelayHandle } from '../../../../relay/src/relay';

/*
 * Flow test for resuming an interrupted Direct SSH pairing. The phone side is
 * the real claim path, the relay is the real relay over HTTP, and `muxr pair`
 * speaks to it the way the CLI does. Only the byte route (the SSH forward) is
 * doubled, so a test can drop a request before it arrives or lose its reply
 * after the relay committed it.
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

const MACHINE_ID = 'machine-resume-flow-desk';
const CLAIM = 'claim_'.padEnd(43, 'c');
const machineSigning = generateSigningKeyPair();
const machineBox = generateKeyPair();
const realFetch = globalThis.fetch;
const relays: RelayHandle[] = [];

const reused = 'This pairing code cannot be reused. Create a fresh one on the machine (run `muxr pair`).';
const sshDropMessage = 'The SSH connection dropped. Check the connection, then try again with the same code.';

type Step = 'pair-code' | 'claim' | 'grant';
/** Per step: `request` never reaches the relay; `reply` is committed there, then lost. */
type Faults = Partial<Record<Step, 'request' | 'reply' | 'abort'>>;

async function desk() {
    const dataDir = mkdtempSync(join(tmpdir(), 'muxr-resume-'));
    const relay = await startRelay({
        port: 0,
        host: '127.0.0.1',
        config: { dataDir, localAuthority: true, authMode: 'strict', e2eeMode: 'off', developmentApi: false, advertiseMdns: false },
    });
    relays.push(relay);
    const base = `http://127.0.0.1:${relay.port}`;
    const owner = { authorization: `Bearer ${JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8'))}`, 'content-type': 'application/json' };
    const call = async (path: string, init: RequestInit = {}) => {
        const response = await realFetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
        return { status: response.status, body: await response.json() as Record<string, any> };
    };
    /** `muxr pair` on the computer: open a session and publish its short code. */
    const muxrPair = async (code = 'ABCDE23456') => {
        const { body } = await call('/v1/selfhost/pair-sessions', { method: 'POST', headers: owner, body: JSON.stringify({ claim: CLAIM, machineSlug: MACHINE_ID, deviceKind: 'native' }) });
        const pairId = body.pair_id as string;
        const payload = Buffer.from(JSON.stringify({
            v: '2', generation: '1', id: pairId, claim: CLAIM, pair: 'pair_'.padEnd(43, 'p'),
            machine: MACHINE_ID, name: 'desk', machinePk: machineSigning.publicKey, r: 'wss://desk.lan:8792', authority: 'control',
        })).toString('base64url');
        await call(`/v1/selfhost/pair-sessions/${pairId}/code`, { method: 'POST', headers: owner, body: JSON.stringify({ code_hash: pairingCodeHash(code), payload: sealPairingCodePayload(payload, code) }) });
        return { code, pairId };
    };
    /** The computer answers a claim with the grant it signs for the claiming device. */
    const answerClaim = async (pairId: string) => {
        const { body: polled } = await call(`/v1/selfhost/pair-sessions/${pairId}`, { headers: owner });
        const grant = createDeviceGrant({
            machineId: MACHINE_ID, machineSigningSecretKey: machineSigning.secretKey, machineKey: machineBox,
            deviceId: polled.deviceId, devicePublicKey: polled.devicePublicKey,
            dataKey: new Uint8Array(32).fill(1), ingressKey: new Uint8Array(32).fill(2),
            keyVersion: 1, expiresAt: Date.now() + 3_600_000, authority: polled.authority,
        });
        await call(`/v1/selfhost/pair-sessions/${pairId}/grant`, { method: 'POST', headers: owner, body: JSON.stringify({ grant: JSON.stringify(grant) }) });
    };
    return { port: relay.port, dataDir, call, muxrPair, answerClaim };
}

/** The SSH forward from the phone to the desk's relay. */
function tunnel(relay: Awaited<ReturnType<typeof desk>>, faults: Faults, options: { oldRelay?: boolean } = {}) {
    const calls: Step[] = [];
    const lostCredentials: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        const step = url.pathname.split('/').pop() as Step;
        calls.push(step);
        const fault = faults[step];
        if (fault === 'abort') throw new DOMException('The request was aborted', 'AbortError');
        if (fault === 'request') throw new TypeError('Network request failed');
        let body = init.body;
        // A relay that predates resuming ignores the field; model it as never receiving it.
        if (options.oldRelay && typeof body === 'string') {
            const { resume_key: _dropped, ...rest } = JSON.parse(body);
            body = JSON.stringify(rest);
        }
        const response = await realFetch(`http://127.0.0.1:${relay.port}${url.pathname}`, { ...init, body });
        if (step === 'claim' && response.ok) {
            const issued = await response.clone().json() as { device_credential: string };
            await relay.answerClaim(url.pathname.split('/')[4]!);
            if (fault === 'reply') lostCredentials.push(issued.device_credential);
        }
        if (fault === 'reply') throw new TypeError('Network request failed');
        return response;
    });
    return { calls, lostCredentials };
}

const ssh = (port: number, code: string) => `ws://127.0.0.1:${port}?pair=${code}`;
const pair = (port: number, code: string) => claimHostedPairing(ssh(port, code), { resumable: true });

describe('an interrupted Direct SSH pairing', () => {
    afterEach(async () => {
        secrets.delete('muxr.hosted-e2ee.pending-pair.v1');
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await Promise.all(relays.splice(0).map((relay) => relay.close()));
    });

    it('pairs on the first try exactly as before, with one lookup and one claim', async () => {
        const relay = await desk();
        const { code } = await relay.muxrPair();
        const { calls } = tunnel(relay, {});

        const grant = await pair(relay.port, code);

        expect(grant).toMatchObject({ machineId: MACHINE_ID, authority: 'control', source: 'selfhost', relayUrl: 'wss://desk.lan:8792' });
        expect(calls).toEqual(['pair-code', 'claim', 'grant']);
    });

    it('resumes a drop before the relay committed, and a finished code stays spent', async () => {
        const relay = await desk();
        const { code } = await relay.muxrPair();
        const faults: Faults = { claim: 'request' };
        const { calls } = tunnel(relay, faults);

        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        faults.claim = undefined;
        faults.grant = 'abort';
        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        faults.grant = 'request';
        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        faults.grant = undefined;
        const grant = await pair(relay.port, code);

        expect(calls.filter((call) => call === 'pair-code')).toHaveLength(1);
        expect(grant).toMatchObject({ machineId: MACHINE_ID, authority: 'control' });
        await expect(pair(relay.port, code)).rejects.toThrow(reused);
    });

    it('recovers a lookup and a claim whose replies were lost after the relay committed them', async () => {
        const relay = await desk();
        const { code, pairId } = await relay.muxrPair();
        const faults: Faults = { 'pair-code': 'reply' };
        const { calls, lostCredentials } = tunnel(relay, faults);

        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        faults['pair-code'] = undefined;
        faults.claim = 'reply';
        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        // The sealed lookup kept for a repeat leaves the relay's disk once the claim commits.
        expect(readFileSync(join(relay.dataDir, 'selfhost-pairing.json'), 'utf8')).not.toContain(pairingCodeHash(code));
        faults.claim = undefined;
        const grant = await pair(relay.port, code);

        expect(calls.filter((call) => call === 'pair-code')).toHaveLength(2);
        expect(grant).toMatchObject({ machineId: MACHINE_ID, authority: 'control', source: 'selfhost' });
        // The credential the lost reply carried is dead; the device holds the one it resumed with.
        const lost = await relay.call(`/v1/selfhost/pair-sessions/${pairId}/grant`, { headers: { authorization: `Bearer ${lostCredentials[0]}` } });
        expect(lost).toEqual({ status: 403, body: { error: 'grant download requires a paired device credential' } });
        expect(grant.credential).not.toBe(lostCredentials[0]);
        await expect(pair(relay.port, code)).rejects.toThrow(reused);
    });

    it('refuses committed answers to strangers, then recovers after repeated lost replies', async () => {
        const relay = await desk();
        const { code, pairId } = await relay.muxrPair();
        const faults: Faults = { 'pair-code': 'reply' };
        tunnel(relay, faults);
        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);

        // Someone else with the code, without this device's resume key.
        const lookup = (resumeKey?: string) => relay.call('/v1/selfhost/pair-code', { method: 'POST', body: JSON.stringify({ code_hash: pairingCodeHash(code), ...(resumeKey === undefined ? {} : { resume_key: resumeKey }) }) });
        expect(await lookup()).toEqual({ status: 404, body: { error: 'invalid_pairing_code' } });
        expect(await lookup('k'.repeat(43))).toEqual({ status: 404, body: { error: 'invalid_pairing_code' } });

        // Someone holding the claim secret, with another device key, after the phone's claim reply was lost.
        faults['pair-code'] = undefined;
        faults.claim = 'reply';
        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        const stranger = (devicePublicKey: string, resumeKey: string) => relay.call(`/v1/selfhost/pair-sessions/${pairId}/claim`, {
            method: 'POST',
            body: JSON.stringify({ claim: CLAIM, device_public_key: devicePublicKey, device_name: 'other', device_kind: 'android', mailbox: 'm', resume_key: resumeKey }),
        });
        expect(await stranger(generateKeyPair().publicKey, 'k'.repeat(43))).toEqual({ status: 409, body: { error: 'already_claimed' } });
        const phonePublicKey = (JSON.parse(secrets.get('muxr.hosted-e2ee.device.v2')!) as { publicKey: string }).publicKey;
        expect(await stranger(phonePublicKey, 'k'.repeat(43))).toEqual({ status: 409, body: { error: 'already_claimed' } });

        for (let attempt = 0; attempt < 4; attempt++) {
            await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        }
        faults.claim = undefined;
        await expect(pair(relay.port, code)).resolves.toMatchObject({ machineId: MACHINE_ID, authority: 'control', source: 'selfhost' });
        await expect(pair(relay.port, code)).rejects.toThrow(reused);
        await expect(pair(relay.port, code)).rejects.toThrow(reused);

        // A fresh code still pairs normally afterwards.
        const fresh = await relay.muxrPair('FGHJK78923');
        await expect(pair(relay.port, fresh.code)).resolves.toMatchObject({ machineId: MACHINE_ID });
    });

    it('refuses a repeat after the pairing window, at the relay as well as on the phone', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const relay = await desk();
        const { code } = await relay.muxrPair();
        const faults: Faults = { claim: 'abort' };
        tunnel(relay, faults);

        await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
        faults.claim = undefined;
        vi.setSystemTime(Date.now() + 2 * 60_000 + 1);
        await expect(pair(relay.port, code)).rejects.toThrow('This pairing code expired. Create a fresh one on the machine.');

        const late = await relay.muxrPair('FGHJK78923');
        const key = 'k'.repeat(43);
        const lookup = () => relay.call('/v1/selfhost/pair-code', { method: 'POST', body: JSON.stringify({ code_hash: pairingCodeHash(late.code), resume_key: key }) });
        expect((await lookup()).status).toBe(200);
        vi.setSystemTime(Date.now() + 2 * 60_000 + 1);
        expect(await lookup()).toEqual({ status: 404, body: { error: 'invalid_pairing_code' } });
    });

    it('keeps the old answers across versions: a new phone on an old relay, an old phone on a new relay', async () => {
        // New phone, old relay: the repeat is refused as a spent code, as before.
        for (const lost of ['pair-code', 'claim'] as const) {
            const relay = await desk();
            const { code } = await relay.muxrPair();
            const faults: Faults = { [lost]: 'reply' };
            tunnel(relay, faults, { oldRelay: true });
            await expect(pair(relay.port, code)).rejects.toThrow(sshDropMessage);
            faults[lost] = undefined;
            await expect(pair(relay.port, code)).rejects.toThrow(reused);
            // ...and an ordinary pairing still works on it.
            const fresh = await relay.muxrPair('FGHJK78923');
            await expect(pair(relay.port, fresh.code)).resolves.toMatchObject({ machineId: MACHINE_ID });
        }

        // Old phone, new relay: requests without a resume key pair normally and get no repeats.
        const relay = await desk();
        const { code } = await relay.muxrPair();
        const faults: Faults = { 'pair-code': 'reply' };
        tunnel(relay, faults);
        await expect(claimHostedPairing(ssh(relay.port, code))).rejects.toThrow('Network request failed');
        faults['pair-code'] = undefined;
        await expect(claimHostedPairing(ssh(relay.port, code))).rejects.toThrow('This pairing code is invalid or was already used. Create a fresh one on the machine.');
        const fresh = await relay.muxrPair('FGHJK78923');
        await expect(claimHostedPairing(ssh(relay.port, fresh.code))).resolves.toMatchObject({ machineId: MACHINE_ID });
    });
});
