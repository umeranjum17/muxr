import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostId } from '@byokit/link';
import { linkUrl } from '@byokit/relay/device';
import { askVisible, base64, print, printTerminalQr } from '../infrastructure/runtime.mjs';
import { pairingIntent } from '../domain/dist/index.js';
import { readSelfhostState, selfhostCredential, writeSelfhostState } from '../infrastructure/selfhost.mjs';
import { withSelfhostRotationLock } from '../infrastructure/selfhostRelay.mjs';

/**
 * Native pairing over the byokit link.
 *
 * `muxr pair` uses the running machine's link host through its owner-only
 * local socket. The machine must already be running on either an owned or
 * shared relay. The person compares byokit's
 * two words and approves on this computer; selfhost.json remains the device
 * authority.
 *
 * The record is written before the phone proves itself, and pairing only
 * completes once the phone calls `pair.verified` over the machine's real link.
 * A proof that never arrives rolls the record back, so an approved-but-
 * unfinished pairing keeps no access; the phone holds its own key in its
 * secure store from before it first connects, so a crash never strands one.
 */

/** How long the phone has to prove itself over the machine's link. */
const VERIFY_DEADLINE_MS = 60_000;

/** How long a fresh host gets to open pair.sock after the service starts. */
const PAIR_SOCKET_WAIT_MS = 15_000;

/**
 * Validation-only bound on that wait, in milliseconds. The failure-path
 * checks assert the same error without burning the full window.
 */
function pairSocketWaitMs() {
    const raw = process.env.MUXR_PAIR_SOCKET_WAIT_MS?.trim();
    if (raw === undefined || raw === '') return PAIR_SOCKET_WAIT_MS;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : PAIR_SOCKET_WAIT_MS;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function aborted(signal) {
    if (signal === undefined) return new Promise(() => {});
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
}

/** The machine's link route on its own relay — where enrolled phones dial. */
export function machineLinkUrl(relayUrl, machineBoxPublicKeyBase64) {
    return linkUrl(relayUrl, hostId(Buffer.from(machineBoxPublicKeyBase64, 'base64')));
}

/**
 * Run one native link pairing against `state`. `approve` answers the approval
 * prompt (tests inject it; the terminal prompt is the default). Resolves with
 * the paired device record once the phone has proven itself, or throws when
 * pairing was declined, failed, or never completed.
 */
export async function linkPair(state, { approve, signal, intent = pairingIntent({ kind: 'native' }) } = {}) {
    if (typeof selfhostCredential(state) !== 'string') throw new Error('muxr is not set up yet; run `muxr setup` first');
    const socketPath = join(process.env.MUXR_HOME ?? join(homedir(), '.muxr'), 'host', 'pair.sock');
    // `muxr setup` starts the service and pairs immediately, but the new host
    // opens pair.sock a couple of seconds later. Retry an absent or refused
    // socket for a bounded window; anything else still throws immediately.
    const deadline = Date.now() + pairSocketWaitMs();
    for (;;) {
        try {
            const running = await pairOnRunningHost(socketPath, approve ?? showApproval, signal, intent);
            if (running !== undefined) return running;
        } catch (error) {
            if (error?.code !== 'ECONNREFUSED' && error?.code !== 'ENOENT') throw error;
        }
        if (signal?.aborted) throw new Error('pairing cancelled');
        if (Date.now() >= deadline) break;
        await Promise.race([sleep(Math.min(500, Math.max(deadline - Date.now(), 0))), aborted(signal)]);
    }
    throw new Error('Start muxr on this computer first, then run `muxr pair` again.');
}

// The running machine owns its relay registration. A local, owner-only socket
// lets the CLI display its offer and answer consent without a second host key.
// `herdrSession` is the Herdr session the host serves (undefined: no Herdr, a
// fake host); lab tooling asks with `lab: true` and never pairs the live default.
export async function startHostPairingServer(endpoint, socketPath, relayUrl, herdrSession) {
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
        let lab = false;
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
                        lab = answer.lab === true;
                        configure(intent);
                        configure = undefined;
                    } else if (typeof answer.yes === 'boolean') {
                        approve?.(answer.yes);
                        approve = undefined;
                    } else if (answer.cancel === true) controller.abort();
                    else throw new Error('invalid pairing answer');
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
                if (lab && herdrSession === 'default') throw new Error('refusing lab pairing: this host serves the live default Herdr session; restart it with HERDR_SESSION set to the lab session');
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
                // Revoke unverified devices before the pairing closes: a phone
                // reads a closed pairing that still accepts its key as kept.
                session.handle = async () => { throw new Error('pairing: closing'); };
                for (const claim of claims.values()) {
                    clearTimeout(claim.timer);
                    if (claim.answered && !claim.verified) {
                        await claim.rollback();
                        await endpoint.rejectPairedDevice(claim.grantId);
                    }
                }
                endpoint.stopPairing();
                busy = false;
                if (controller.signal.aborted) failure = 'pairing cancelled';
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
    socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind: intent.kind, authority: intent.authority, personal: intent.personal },
        // A lab shell (HERDR_SESSION set) must never pair a host serving the live session.
        ...(process.env.HERDR_SESSION?.trim() ? { lab: true } : {}) })}\n`));
    let input = '';
    const cancel = () => socket.write('{"cancel":true}\n');
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
