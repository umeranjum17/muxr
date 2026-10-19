import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { loadavg } from 'node:os';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { DeviceLink, pairWithOffer, parseOffer } from '@byokit/pair';
import { nextRequestId } from '@trymuxr/contract';

const BASE_WAIT_MS = 25_000;
const PER_LOAD_POINT_MS = 3_000;
const MAX_WAIT_MS = 180_000;
const ADB_CALL_MS = 5_000;
const ADB_PROBE_MS = 1_000;
const execFileAsync = promisify(execFile);

export function linkWaitMs(load = loadavg()[0]) {
    return Math.min(MAX_WAIT_MS, BASE_WAIT_MS + Math.round(PER_LOAD_POINT_MS * load));
}

async function until(check, what, deadline, intervalMs = 100) {
    while (Date.now() < deadline) {
        const result = await check();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`timed out: ${what}`);
}

async function adb(serial, args, deadline) {
    const timeout = Math.max(1, Math.min(ADB_CALL_MS, deadline - Date.now()));
    const { stdout } = await execFileAsync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout });
    return stdout;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '[::]']);
const FATAL = /^(bootloader|recovery|sideload)$|cannot bind .*address already in use/i;
const lastLine = (text) => text.trim().split('\n').pop().trim();

async function routeLabRelay(serial, ports, deadline) {
    const state = (await adb(serial, ['get-state'], deadline)).trim();
    if (state !== 'device') throw new Error(state || 'empty answer');
    for (const port of ports) await adb(serial, ['reverse', `tcp:${port}`, `tcp:${port}`], deadline);
    const listed = await adb(serial, ['reverse', '--list'], deadline);
    const routes = listed.split('\n').map((line) => line.trim().split(/\s+/).slice(-2).join(' '));
    const missing = ports.find((port) => !routes.includes(`tcp:${port} tcp:${port}`));
    if (missing !== undefined) throw new Error(`no reverse route on tcp:${missing}: ${lastLine(listed) || 'the device lists no reverse routes'}`);
}

/**
 * Point a device that pairs with a loopback lab at the relay the offer names.
 *
 * The route rides on an adb transport, and a transport is not ready just
 * because the server has a row for it: when the fleet's shared adb server is
 * restarted, or the device's own adbd restarts, every request the fresh server
 * sends answers `device offline` until that transport handshakes. One
 * fire-and-forget `adb reverse` dies inside that window — that is how a
 * desklink lab run ended before it ever reached pairing — so wait for the named
 * device to answer as a device, apply the reverse, and read the route back
 * before the offer is handed over. An offer that names a real address needs no
 * route at all.
 */
export async function forwardLabRelayTo(serial, offerText, deadline) {
    const ports = [...new Set(parseOffer(offerText, 0).urls.map((url) => new URL(url))
        .filter((url) => LOOPBACK.has(url.hostname)).map((url) => url.port))];
    if (ports.length === 0) return [];
    let last = 'no answer yet';
    let fatal;
    await until(async () => {
        try {
            await routeLabRelay(serial, ports, deadline);
            return true;
        } catch (cause) {
            last = lastLine(cause.stderr || cause.message || String(cause)) || 'no answer';
            if (!FATAL.test(last)) return false;
            fatal = new Error(`adb cannot route the lab relay to ${serial}: ${last}`);
            return true;
        }
    }, `the lab relay route on ${serial}`, deadline, ADB_PROBE_MS)
        .catch((timedOut) => { throw new Error(`${timedOut.message}; last adb answer: ${last}`); });
    if (fatal) throw fatal;
    return ports;
}

/** The real running host's owner-only socket approves one lab device, then its machine link proves it. */
export async function linkLabClient(socketPath, onEvent, deadline = Date.now() + linkWaitMs()) {
    const socket = createConnection(socketPath);
    let text = '';
    let offer;
    let result;
    let error;
    socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        const lines = text.split('\n');
        text = lines.pop() ?? '';
        for (const line of lines) {
            const event = JSON.parse(line);
            if (event.offer) offer = event.offer.text;
            if (event.approval) socket.write(`${JSON.stringify({ yes: true })}\n`);
            if (event.result) result = event.result;
            if (event.error) error = event.error;
        }
    });
    socket.on('error', (cause) => { error = cause.message; });
    const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    let pairing;
    let machine;
    try {
        await connected;
        socket.write(`${JSON.stringify({ intent: { kind: 'native', authority: 'control', personal: false }, lab: true })}\n`);
        await until(() => { if (error) throw new Error(error); return offer; }, 'link offer', deadline);
        const grant = await pairWithOffer(offer, { name: 'Lab device', onWords: () => undefined, WebSocket });
        pairing = new DeviceLink(grant, { WebSocket });
        await until(() => pairing.status === 'online', 'approved pairing link', deadline);
        const answer = await pairing.request('pair.complete', { deviceName: 'Lab device' });
        machine = new DeviceLink({ v: 1, secretKey: grant.secretKey, host: answer.machineBoxPublicKey,
            hostName: answer.machineName, urls: [answer.linkUrl],
            device: { id: '', name: 'Lab device', role: 'control' } }, { WebSocket, ...(onEvent === undefined ? {} : { onEvent }) });
        await until(() => machine.status === 'online', 'machine link admits lab device', deadline);
        await pairing.request('pair.verified', {});
        await until(() => { if (error) throw new Error(error); return result; }, 'machine proof accepted', deadline);
        return machine;
    } catch (cause) {
        machine?.stop();
        throw cause;
    } finally {
        pairing?.stop();
        socket.destroy();
    }
}

/** A native code lasts about two minutes, so a device has that long to approve it. */
const APPROVAL_WAIT_MS = 120_000;

/**
 * The computer side for a device this client does not run itself, such as the
 * Android app pairing from a lab offer. Only the first offer goes to
 * `presentOffer`: the host mints a fresh code once it answers, and handing that
 * one to a device already pairing resets its consent screen mid-pairing. The
 * computer's approval is answered yes; the host's
 * result resolves with the device record it approved once that device has
 * proven itself on the link.
 */
export async function approveLabOffer(socketPath, presentOffer, deadline = Date.now() + APPROVAL_WAIT_MS) {
    const socket = createConnection(socketPath);
    let text = '';
    let offered = false;
    let result;
    let error;
    const fail = (cause) => { error = cause instanceof Error ? cause.message : String(cause); };
    socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        const lines = text.split('\n');
        text = lines.pop() ?? '';
        for (const line of lines) {
            // A line that cannot be handled ends this pairing rather than the process, so the caller's cleanup still runs.
            try {
                const event = JSON.parse(line);
                if (event.offer && !offered) { offered = true; void Promise.resolve(presentOffer(event.offer.text, deadline)).catch(fail); }
                if (event.approval) socket.write(`${JSON.stringify({ yes: true })}\n`);
                if (event.result) result = event.result;
                if (event.error) error = event.error;
            } catch (cause) { fail(cause); return; }
        }
    });
    socket.on('error', fail);
    const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    try {
        await connected;
        socket.write(`${JSON.stringify({ intent: { kind: 'native', authority: 'control', personal: false }, lab: true })}\n`);
        return await until(() => { if (error) throw new Error(error); return result; }, 'approved device pairing', deadline);
    } finally {
        socket.destroy();
    }
}

export async function requestLab(device, type, params = {}) {
    const frame = await device.request(type, { type, requestId: nextRequestId('lab'), params });
    if (frame?.type !== 'result') throw new Error(`unexpected ${type} answer`);
    if (!frame.ok) throw new Error(frame.error ?? `${type} failed`);
    return frame.data;
}
