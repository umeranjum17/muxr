import { randomBytes } from 'node:crypto';
import { Host, hostId, keyPair } from '@byokit/link';
import { RelayClient } from '@byokit/relay';
import { relayControlUrl } from '@muxr/contract';
import { askVisible, base64, print, printTerminalQr } from '../infrastructure/runtime.mjs';
import { pairingIntent } from '../domain/dist/index.js';
import { selfhostCredential, writeSelfhostState } from '../infrastructure/selfhost.mjs';

/**
 * Native pairing over the byokit link (migration step 4, decision D1).
 *
 * `muxr pair` owns a short-lived pairing host under its own fresh key, so it
 * never replaces the machine's registered link endpoint (a second host under
 * the machine key would stop the running one for good). The person approves
 * the device on this computer by comparing the two words byokit shows on both
 * screens. On approval the CLI writes the device record into selfhost.json —
 * the machine's own authority — and the running host enrols the phone from
 * that record, the same path every already-paired phone takes.
 *
 * The record is written before the phone proves itself, and pairing only
 * completes once the phone calls `pair.verified` over the machine's real link.
 * A proof that never arrives rolls the record back, so an approved-but-
 * unfinished pairing keeps no access; the phone holds its own key in its
 * secure store from before it first connects, so a crash never strands one.
 */

const PAIR_WINDOW_MS = 120_000;
/** How long the phone has to prove itself over the machine's link. */
const VERIFY_DEADLINE_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function aborted(signal) {
    if (signal === undefined) return new Promise(() => {});
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
}

/** The relay admits a host only once its owner vouches for the key — the same
 *  proof the machine's own link endpoint gives (apps/host linkEndpoint.ts). */
async function relayEnrolment(relayUrl, ownerToken, id, name) {
    const base = relayControlUrl(relayUrl);
    const headers = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' };
    const listed = await fetch(new URL('/relay/v1/hosts', base), { headers });
    if (listed.status === 403 || listed.status === 404) return false;
    if (!listed.ok) throw new Error(`link: relay host list failed (${listed.status})`);
    const hosts = await listed.json();
    const known = Array.isArray(hosts) ? hosts : hosts.hosts;
    if (Array.isArray(known) && known.some((host) => host.id === id)) return undefined;
    const created = await fetch(new URL('/relay/v1/enrolments', base), { method: 'POST', headers, body: JSON.stringify({ name }) });
    if (!created.ok) throw new Error(`link: relay enrolment failed (${created.status})`);
    const { token } = await created.json();
    if (typeof token !== 'string') throw new Error('link: relay enrolment returned no token');
    return token;
}

/** The machine's link route on its own relay — where enrolled phones dial. */
export function machineLinkUrl(relayUrl, machineBoxPublicKeyBase64) {
    const relay = new URL(relayControlUrl(relayUrl));
    const scheme = relay.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${relay.host}/link/v1/${hostId(Buffer.from(machineBoxPublicKeyBase64, 'base64'))}`;
}

/**
 * Run one native link pairing against `state`. `approve` answers the approval
 * prompt (tests inject it; the terminal prompt is the default). Resolves with
 * the paired device record once the phone has proven itself, or throws when
 * pairing was declined, failed, or never completed.
 */
export async function pairOverLink(state, { approve, pairMs = PAIR_WINDOW_MS, signal } = {}) {
    if (typeof selfhostCredential(state) !== 'string') throw new Error('muxr is not set up yet; run `muxr setup` first');
    const machine = state.machine;
    const confirm = approve ?? showApproval;
    const keys = keyPair();
    const enrol = await relayEnrolment(state.relayUrl, selfhostCredential(state), hostId(keys.publicKey), `${machine.name ?? 'muxr'} pairing`);
    if (enrol === false) throw new Error('this relay does not serve link pairing; update muxr on this machine');
    // Device keys with an open claim, for rollback when the proof never comes.
    const claims = new Map();
    const done = {};

    // Approvals are answered one at a time, even if two phones connect at once.
    // A confirmed (or declined) connection burns the single-use offer ticket.
    let approvals = Promise.resolve();
    let burned = false;
    const confirmOne = (req) => {
        approvals = approvals.then(() => confirm(req)).then((yes) => { burned = true; return yes; }, () => { burned = true; return false; });
        return approvals;
    };

    const host = await Host.open({
        keys,
        name: machine.name ?? 'muxr',
        pairMs,
        confirm: confirmOne,
        // The pairing host serves exactly two requests: the phone asking for
        // its machine details, and the same phone proving it reached the
        // machine's real link. Everything else is the machine link's business.
        allow: (req) => req.op === 'pair.complete' || req.op === 'pair.verified',
        handle: (req, device) => servePairing(state, req, device, claims, done),
    });
    const client = new RelayClient(host, {
        url: new URL('/relay/v1/host', relayControlUrl(state.relayUrl)).toString().replace(/^http/, 'ws'),
        name: `${machine.name ?? 'muxr'} pairing`,
        ...(enrol === undefined ? {} : { enrol }),
    });
    done.promise = new Promise((resolve, reject) => { done.resolve = resolve; done.reject = reject; });
    try {
        await untilOnline(client);
        let offer = freshOffer(host, state.relayUrl, client.id);
        showOffer(offer);
        while (true) {
            if (signal?.aborted) throw new Error('pairing cancelled');
            const outcome = await Promise.race([
                done.promise,
                aborted(signal),
                sleep(Math.min(1_000, Math.max(offer.expires - Date.now(), 0))),
            ]);
            if (outcome !== undefined) {
                // Let the proof's answer flush to the phone before the pairing
                // host and its relay socket go away.
                await sleep(500);
                return outcome;
            }
            if (signal?.aborted) throw new Error('pairing cancelled');
            if (offer.expires - Date.now() <= 0 || burned) {
                const hadExpired = offer.expires - Date.now() <= 0;
                burned = false;
                offer = freshOffer(host, state.relayUrl, client.id);
                if (hadExpired) {
                    print('Pairing QR expired — a fresh one is shown below.');
                    showOffer(offer);
                }
            }
        }
    } finally {
        client.stop();
        host.close();
        for (const claim of claims.values()) {
            clearTimeout(claim.timer);
            // An answered claim whose proof never arrived keeps no access; a
            // claim still waiting on approval wrote nothing. A verified claim
            // is a completed pairing and keeps its record.
            if (claim.answered === true && claim.verified !== true) claim.rollback();
        }
    }
}

function freshOffer(host, relayUrl, hostIdOnRelay) {
    const relay = new URL(relayControlUrl(relayUrl));
    const scheme = relay.protocol === 'https:' ? 'wss' : 'ws';
    return host.offer({ urls: [`${scheme}://${relay.host}/link/v1/${hostIdOnRelay}`], role: 'control', kind: 'native' });
}

/**
 * The approved phone asks for its machine details over the pairing link, dials
 * the machine's own link, and proves it there with `pair.verified`. The answer
 * only settles once that proof arrives; a claim that never proves itself rolls
 * its record back when the deadline passes.
 */
async function servePairing(state, req, device, claims, done) {
    const key = device.key;
    if (req.op === 'pair.verified') {
        const claim = claims.get(key);
        if (claim === undefined || claim.answered !== true) throw new Error('pairing: no open claim for this device');
        claim.verified = true;
        clearTimeout(claim.timer);
        done.resolve(state.machine.crypto.devices.find((entry) => entry.deviceId === claim.deviceId));
        return { ok: true };
    }
    if (req.op !== 'pair.complete') throw new Error('pairing: unknown request');
    const devicePublicKey = base64(Buffer.from(key, 'base64url'));
    let record = state.machine.crypto.devices.find((entry) => entry.devicePublicKey === devicePublicKey && entry.kind === undefined);
    if (record === undefined) {
        const name = typeof req.args?.deviceName === 'string' && req.args.deviceName.trim() !== '' ? req.args.deviceName.trim() : device.name;
        record = {
            deviceId: `dev_${randomBytes(18).toString('base64url')}`,
            devicePublicKey,
            ingressKey: base64(randomBytes(32)),
            expiresAt: new Date(pairingIntent({ kind: 'native' }).grantExpiresAt()).toISOString(),
            authority: 'control',
            name,
        };
        state.machine.crypto.devices = [...state.machine.crypto.devices, record];
        writeSelfhostState(state);
    }
    let claim = claims.get(key);
    if (claim === undefined) {
        claim = {};
        claims.set(key, claim);
    }
    claim.answered = true;
    claim.deviceId = record.deviceId;
    clearTimeout(claim.timer);
    claim.rollback = () => {
        const current = state.machine.crypto.devices.filter((entry) => entry.deviceId !== record.deviceId
            || entry.devicePublicKey !== devicePublicKey);
        if (current.length !== state.machine.crypto.devices.length) {
            state.machine.crypto.devices = current;
            writeSelfhostState(state);
        }
    };
    claim.timer = setTimeout(() => {
        done.reject(new Error('pairing did not complete: the phone never reached this machine over the link. Start muxr here, then run `muxr pair` again.'));
    }, VERIFY_DEADLINE_MS);
    return {
        machineId: state.machine.id,
        machineName: state.machine.name ?? 'your computer',
        // byokit fields are base64url; selfhost.json keeps plain base64.
        machineBoxPublicKey: Buffer.from(state.machine.crypto.boxPublicKey, 'base64').toString('base64url'),
        relayUrl: state.relayUrl,
        deviceId: record.deviceId,
        authority: 'control',
        linkUrl: machineLinkUrl(state.relayUrl, state.machine.crypto.boxPublicKey),
    };
}

async function untilOnline(client) {
    const deadline = Date.now() + 15_000;
    while (client.status !== 'online') {
        if (client.status === 'replaced' || client.status === 'refused') throw new Error(`the relay refused the pairing host (${client.status})`);
        if (Date.now() > deadline) throw new Error('could not reach the relay for pairing; run `muxr doctor` for the exact failing check');
        await sleep(100);
    }
}

function showOffer(offer) {
    print('');
    print('This one-time QR grants a phone control of agent sessions on this computer. Keep it private.');
    print(`Pairing code expires at ${new Date(offer.expires).toLocaleString()}.`);
    if (process.stdout.isTTY) printTerminalQr(offer.text);
    print(offer.text);
    print('Scan it with the muxr app, then compare the two words on this screen with the phone before approving.');
    print('Waiting for the device to finish pairing…');
}

async function showApproval(req) {
    print('');
    print(`“${req.name}” wants to pair with this computer.`);
    print('');
    print(`  Compare these words on the phone:  ${req.words}`);
    print('');
    return askVisible('Only approve if the words match. Approve this device? (y/N) ');
}
