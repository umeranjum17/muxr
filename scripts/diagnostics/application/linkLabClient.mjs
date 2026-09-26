import { createConnection } from 'node:net';
import WebSocket from 'ws';
import { DeviceLink, pairWithOffer } from '@byokit/link';
import { nextRequestId } from '@muxr/contract';

async function until(check, what, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = check();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out: ${what}`);
}

/** The real running host's owner-only socket approves one lab device, then its machine link proves it. */
export async function linkLabClient(socketPath, onEvent) {
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
        socket.write(`${JSON.stringify({ intent: { kind: 'native', authority: 'control', personal: false } })}\n`);
        await until(() => { if (error) throw new Error(error); return offer; }, 'link offer');
        const grant = await pairWithOffer(offer, { name: 'Lab device', onWords: () => undefined, WebSocket });
        pairing = new DeviceLink(grant, { WebSocket });
        await until(() => pairing.status === 'online', 'approved pairing link');
        const answer = await pairing.request('pair.complete', { deviceName: 'Lab device' });
        machine = new DeviceLink({ v: 1, secretKey: grant.secretKey, host: answer.machineBoxPublicKey,
            hostName: answer.machineName, urls: [answer.linkUrl],
            device: { id: '', name: 'Lab device', role: 'control' } }, { WebSocket, ...(onEvent === undefined ? {} : { onEvent }) });
        await until(() => machine.status === 'online', 'machine link admits lab device');
        await pairing.request('pair.verified', {});
        await until(() => { if (error) throw new Error(error); return result; }, 'machine proof accepted');
        return machine;
    } catch (cause) {
        machine?.stop();
        throw cause;
    } finally {
        pairing?.stop();
        socket.destroy();
    }
}

export async function requestLab(device, type, params = {}) {
    const frame = await device.request(type, { type, requestId: nextRequestId('lab'), params });
    if (frame?.type !== 'result') throw new Error(`unexpected ${type} answer`);
    if (!frame.ok) throw new Error(frame.error ?? `${type} failed`);
    return frame.data;
}
