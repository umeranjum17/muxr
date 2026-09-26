import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Host, hostId, keyPair } from '@byokit/link';
import { RelayClient } from '@byokit/relay';
import { askVisible, base64, print, printTerminalQr } from '../infrastructure/runtime.mjs';
import { pairingIntent } from '../domain/dist/index.js';
import { readSelfhostState, selfhostCredential, writeSelfhostState } from '../infrastructure/selfhost.mjs';
import { withSelfhostRotationLock } from '../infrastructure/selfhostRelay.mjs';

/**
 * Native pairing over the byokit link (migration step 4, decision D1).
 *
 * `muxr pair` uses the running machine's link host through its owner-only
 * local socket. If no host is running on a relay this machine owns, it opens
 * a short-lived pairing host under a fresh key instead. On a shared relay,
 * the enrolled machine must already be running. The person compares byokit's
 * two words and approves on this computer; selfhost.json remains the device
 * authority.
 *
 * The record is written before the phone proves itself, and pairing only
 * completes once the phone calls `pair.verified` over the machine's real link.
 * A proof that never arrives rolls the record back, so an approved-but-
 * unfinished pairing keeps no access; the phone holds its own key in its
 * secure store from before it first connects, so a crash never strands one.
 */

const PAIR_WINDOW_MS = 120_000;
/** How long the phone has to prove itself over the machine's link. */
const VERIFY_DEADLINE_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function aborted(signal) {
    if (signal === undefined) return new Promise(() => {});
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
}

/** The relay admits a host only once its owner vouches for the key — the same
 *  proof the machine's own link endpoint gives (apps/host linkEndpoint.ts). */
async function relayEnrolment(relayUrl, ownerToken, id, name) {
    // ws(s):// to http(s)://: the control API answers on the same origin.
    const base = new URL(relayUrl.replace(/^ws/i, 'http')).origin;
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
    const relay = new URL(relayUrl.replace(/^ws/i, 'http'));
    const scheme = relay.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${relay.host}/link/v1/${hostId(Buffer.from(machineBoxPublicKeyBase64, 'base64'))}`;
}

/**
 * Run one native link pairing against `state`. `approve` answers the approval
 * prompt (tests inject it; the terminal prompt is the default). Resolves with
 * the paired device record once the phone has proven itself, or throws when
 * pairing was declined, failed, or never completed.
 */
export async function linkPair(state, { approve, pairMs = PAIR_WINDOW_MS, signal, intent = pairingIntent({ kind: 'native' }) } = {}) {
    if (typeof selfhostCredential(state) !== 'string') throw new Error('muxr is not set up yet; run `muxr setup` first');
    let running;
    try { running = await pairOnRunningHost(join(process.env.MUXR_HOME ?? join(homedir(), '.muxr'), 'host', 'pair.sock'), approve ?? showApproval, signal, intent); }
    catch (error) { if (error?.code !== 'ECONNREFUSED' && error?.code !== 'ENOENT') throw error; }
    if (running !== undefined) return running;
    if (state.relayLocation === 'remote') throw new Error('start muxr on this computer before pairing on a shared relay');
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
        // The temporary pairing host serves exactly two requests: the phone asking for
        // its machine details, and the same phone proving it reached the
        // machine's real link. Everything else is the machine link's business.
        allow: (req) => req.op === 'pair.complete' || req.op === 'pair.verified',
        handle: (req, device) => servePairing(state, req, device, claims, done, intent),
    });
    const client = new RelayClient(host, {
        url: new URL('/relay/v1/host', new URL(state.relayUrl.replace(/^ws/i, 'http'))).toString().replace(/^http/, 'ws'),
        name: `${machine.name ?? 'muxr'} pairing`,
        ...(enrol === undefined ? {} : { enrol }),
    });
    done.promise = new Promise((resolve, reject) => { done.resolve = resolve; done.reject = reject; });
    try {
        await untilOnline(client);
        let offer = freshOffer(host, state.relayUrl, client.id, intent, state);
        showOffer(offer, intent);
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
                print(offer.expires <= Date.now() ? 'Pairing QR expired — a fresh one is shown below.' : 'Pairing QR used — a fresh one is shown below.');
                burned = false;
                offer = freshOffer(host, state.relayUrl, client.id, intent, state);
                showOffer(offer, intent);
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
            if (claim.answered === true && claim.verified !== true) await claim.rollback();
        }
    }
}

// The running machine owns its relay registration. A local, owner-only socket
// lets the CLI display its offer and answer consent without a second host key.
export async function startHostPairingServer(endpoint, socketPath, relayUrl) {
    if (existsSync(socketPath)) {
        const info = lstatSync(socketPath);
        if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('unsafe pairing socket path');
        unlinkSync(socketPath);
    }
    const sockets = new Set();
    let busy = false;
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        if (busy) { socket.end(`${JSON.stringify({ error: 'another pairing is in progress' })}\n`); return; }
        busy = true;
        const controller = new AbortController();
        let approve;
        let burned = false;
        let configure;
        const configured = new Promise((resolve) => { configure = resolve; });
        let input = '';
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (input.length > 4096) { socket.destroy(); return; }
            const lines = input.split('\n');
            input = lines.pop() ?? '';
            for (const line of lines) {
                try {
                    const answer = JSON.parse(line);
                    if (answer.intent !== undefined && configure !== undefined) {
                        const raw = answer.intent;
                        if (raw?.kind !== 'native' && raw?.kind !== 'browser') throw new Error('invalid pairing kind');
                        const intent = pairingIntent(raw);
                        if (raw.authority !== intent.authority || raw.personal !== intent.personal) throw new Error('invalid pairing intent');
                        configure(intent);
                        configure = undefined;
                    } else if (typeof answer.yes === 'boolean') {
                        approve?.(answer.yes);
                        approve = undefined;
                    } else throw new Error('invalid pairing answer');
                } catch { socket.destroy(); }
            }
        });
        socket.on('close', () => controller.abort());
        const send = (value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
        const state = readSelfhostState();
        const claims = new Map();
        const done = {};
        done.promise = new Promise((resolve, reject) => { done.resolve = resolve; done.reject = reject; });
        const confirm = async (request) => {
            const yes = await new Promise((resolve) => {
                approve = resolve;
                send({ approval: { name: request.name, words: request.words } });
                controller.signal.addEventListener('abort', () => resolve(false), { once: true });
            });
            burned = true;
            return yes;
        };
        const session = { kind: 'native', confirm, handle: async () => { throw new Error('pairing is not configured'); } };
        void (async () => {
            let completed;
            let failure;
            try {
                const intent = await Promise.race([configured, aborted(controller.signal)]);
                if (intent === undefined) return;
                session.kind = intent.kind;
                session.handle = (req, grant) => servePairing(state, req, grant, claims, done, intent,
                    (grantId, deviceId) => endpoint.admitPairedDevice(grantId, deviceId));
                const offerOptions = pairingOfferOptions(intent, state);
                let offer = endpoint.offerPairing(session, relayUrl, offerOptions);
                send({ offer });
                for (;;) {
                    const outcome = await Promise.race([done.promise, aborted(controller.signal), sleep(Math.min(1000, Math.max(offer.expires - Date.now(), 0)))]);
                    if (outcome !== undefined) { completed = outcome; await sleep(250); return; }
                    if (controller.signal.aborted) return;
                    if (offer.expires <= Date.now() || burned) {
                        burned = false;
                        offer = endpoint.offerPairing(session, relayUrl, offerOptions);
                        send({ offer });
                    }
                }
            } catch (error) { failure = error instanceof Error ? error.message : String(error); }
            finally {
                endpoint.stopPairing();
                for (const claim of claims.values()) {
                    clearTimeout(claim.timer);
                    if (claim.answered && !claim.verified) {
                        await claim.rollback();
                        await endpoint.rejectPairedDevice(claim.grantId);
                    }
                }
                busy = false;
                if (failure !== undefined) send({ error: failure });
                if (completed !== undefined) send({ result: completed });
                socket.end();
            }
        })();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); chmodSync(socketPath, 0o600); resolve(); }); });
    return { close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        if (existsSync(socketPath) && lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
    } };
}

export async function pairOnRunningHost(socketPath, approve = showApproval, signal, intent = pairingIntent({ kind: 'native' })) {
    if (!existsSync(socketPath)) return undefined;
    const info = lstatSync(socketPath);
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('unsafe pairing socket');
    if (signal?.aborted) throw new Error('pairing cancelled');
    const socket = createConnection(socketPath);
    socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind: intent.kind, authority: intent.authority, personal: intent.personal } })}\n`));
    let input = '';
    const cancel = () => socket.destroy(new Error('pairing cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        return await new Promise((resolve, reject) => {
            socket.on('error', reject);
            socket.on('close', () => reject(new Error('running host stopped during pairing')));
            socket.on('data', (chunk) => {
                input += chunk.toString('utf8');
                if (input.length > 4096) { socket.destroy(); return; }
                const lines = input.split('\n');
                input = lines.pop() ?? '';
                for (const line of lines) {
                    try {
                        const event = JSON.parse(line);
                        if (event.offer) showOffer(event.offer, intent);
                        else if (event.approval) void Promise.resolve(approve(event.approval)).then((yes) => socket.write(`${JSON.stringify({ yes })}\n`), reject);
                        else if (event.error) reject(new Error(event.error));
                        else if (event.result) resolve(event.result);
                    } catch (error) { reject(error); }
                }
            });
        });
    } finally { signal?.removeEventListener('abort', cancel); socket.destroy(); }
}

function pairingOfferOptions(intent, state) {
    return {
        kind: intent.kind,
        authority: intent.authority,
        ...(intent.kind === 'browser' ? {
            lifetime: intent.grantExpiresAt() - Date.now(),
            base: `${(state.webOrigin ?? state.relayUrl.replace(/^ws/i, 'http')).replace(/\/$/, '')}/pair`,
        } : {}),
    };
}

function freshOffer(host, relayUrl, hostIdOnRelay, intent, state) {
    const relay = new URL(relayUrl.replace(/^ws/i, 'http'));
    const scheme = relay.protocol === 'https:' ? 'wss' : 'ws';
    const options = pairingOfferOptions(intent, state);
    return host.offer({ urls: [`${scheme}://${relay.host}/link/v1/${hostIdOnRelay}`], role: intent.authority === 'observe' ? 'view' : 'control',
        kind: intent.kind, ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }),
        ...(options.base === undefined ? {} : { base: options.base }) });
}

/**
 * The approved phone asks for its machine details over the pairing link, dials
 * the machine's own link, and proves it there with `pair.verified`. The answer
 * only settles once that proof arrives; a claim that never proves itself rolls
 * its record back when the deadline passes.
 */
async function servePairing(state, req, device, claims, done, intent, admit) {
    const key = device.key;
    if (req.op === 'pair.verified') {
        const claim = claims.get(key);
        if (claim === undefined || claim.answered !== true) throw new Error('pairing: no open claim for this device');
        const record = readSelfhostState()?.machine.crypto.devices.find((entry) => entry.deviceId === claim.deviceId);
        if (record === undefined) throw new Error('pairing: device is no longer admitted');
        claim.verified = true;
        clearTimeout(claim.timer);
        done.resolve(record);
        return { ok: true };
    }
    if (req.op !== 'pair.complete') throw new Error('pairing: unknown request');
    const devicePublicKey = base64(Buffer.from(key, 'base64url'));
    const { record, created } = await withSelfhostRotationLock(async () => {
        const current = readSelfhostState();
        if (current?.machine?.id !== state.machine.id || current.machine.crypto.pendingRotation) throw new Error('pairing: machine authority is changing');
        let record = current.machine.crypto.devices.find((entry) => entry.devicePublicKey === devicePublicKey && (entry.kind ?? 'native') === intent.kind
            && Date.parse(entry.expiresAt) > Date.now());
        const created = record === undefined;
        if (created) {
            const name = typeof req.args?.deviceName === 'string' && req.args.deviceName.trim() !== '' ? req.args.deviceName.trim() : device.name;
            record = {
                ...intent.deviceRecord({ deviceId: `dev_${randomBytes(18).toString('base64url')}`,
                    devicePublicKey, ingressKey: base64(randomBytes(32)), expiresAt: intent.grantExpiresAt() }),
                name,
            };
            current.machine.crypto.devices = [...current.machine.crypto.devices, record];
        }
        if (admit !== undefined) await admit(device.id, record.deviceId);
        if (created) writeSelfhostState(current);
        return { record, created };
    });
    let claim = claims.get(key);
    if (claim === undefined) {
        claim = {};
        claims.set(key, claim);
    }
    claim.answered = true;
    claim.deviceId = record.deviceId;
    claim.grantId = device.id;
    clearTimeout(claim.timer);
    claim.rollback ??= () => {
        if (!created) return;
        const current = readSelfhostState();
        if (current?.machine?.id !== state.machine.id) return;
        const devices = current.machine.crypto.devices.filter((entry) => entry.deviceId !== record.deviceId
            || entry.devicePublicKey !== devicePublicKey);
        if (devices.length !== current.machine.crypto.devices.length) {
            current.machine.crypto.devices = devices;
            writeSelfhostState(current);
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
        authority: intent.authority,
        expiresAt: Date.parse(record.expiresAt),
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

function showOffer(offer, intent) {
    print('');
    print(intent.kind === 'browser'
        ? `This one-time link grants ${intent.authority === 'observe' ? 'view-only' : 'control'} browser access for ${intent.grantDurationLabel()}. Keep it private.`
        : 'This one-time QR grants a phone control of agent sessions on this computer. Keep it private.');
    print(`Pairing code expires at ${new Date(offer.expires).toLocaleString()}.`);
    if (process.stdout.isTTY) printTerminalQr(offer.text);
    print(offer.text);
    print(intent.kind === 'browser'
        ? 'Open it in the browser, then compare the two words on this screen before approving.'
        : 'Scan it with the muxr app, then compare the two words on this screen with the phone before approving.');
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
