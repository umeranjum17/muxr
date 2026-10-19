import { createConnection } from 'node:net';
import { loadavg } from 'node:os';
import WebSocket from 'ws';
import { DeviceLink, pairWithOffer } from '@byokit/pair';
import { nextRequestId } from '@trymuxr/contract';

const BASE_WAIT_MS = 25_000;
const PER_LOAD_POINT_MS = 3_000;
const MAX_WAIT_MS = 180_000;

export function linkWaitMs(load = loadavg()[0]) {
    return Math.min(MAX_WAIT_MS, BASE_WAIT_MS + Math.round(PER_LOAD_POINT_MS * load));
}

async function until(check, what, deadline) {
    while (Date.now() < deadline) {
        const result = check();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out: ${what}`);
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
 * Android app pairing from a lab offer. Each offer goes to `presentOffer`; the
 * computer's approval is answered yes; the host's result resolves with the
 * device record it approved once that device has proven itself on the link.
 */
export async function approveLabOffer(socketPath, presentOffer, deadline = Date.now() + APPROVAL_WAIT_MS) {
    const socket = createConnection(socketPath);
    let text = '';
    let result;
    let error;
    socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        const lines = text.split('\n');
        text = lines.pop() ?? '';
        for (const line of lines) {
            const event = JSON.parse(line);
            if (event.offer) presentOffer(event.offer.text);
            if (event.approval) socket.write(`${JSON.stringify({ yes: true })}\n`);
            if (event.result) result = event.result;
            if (event.error) error = event.error;
        }
    });
    socket.on('error', (cause) => { error = cause.message; });
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
