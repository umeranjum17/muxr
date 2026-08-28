/**
 * Walking-skeleton check.
 *
 * Asserts against a host running --fake:
 * (a) all 20 contract event types arrive end-to-end
 * (b) a request/response round-trip works
 * (c) per-session event seq is monotonic
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
    SESSION_EVENT_TYPES,
    decodePayload,
    encodePayload,
    nextRequestId,
    type ClientRequest,
    type Envelope,
    type HostFrame,
    type SessionEvent,
    type SessionInfo,
    type SessionSnapshot,
} from '@muxr/contract';

const relayUrl = process.env.MUXR_RELAY_URL ?? 'ws://127.0.0.1:8792';
const machineId = process.env.MUXR_MACHINE_ID ?? hostname();
const TIMEOUT_MS = Number(process.env.MUXR_PROBE_TIMEOUT_MS ?? 8000);
const probeCwd = mkdtempSync(join(tmpdir(), 'muxr-probe-'));

const received: SessionEvent[] = [];
const envelopeSeqs: number[] = [];
let wireSeq = 0;
let sessionId: string | undefined;
let listRoundTripDone = false;
let listRoundTripOk = false;

function send(socket: WebSocket, frame: ClientRequest | { type: 'client.hello'; clientId: string }, sessionIdArg?: string): void {
    wireSeq += 1;
    const envelope: Envelope = {
        header: { machineId, ...(sessionIdArg === undefined ? {} : { sessionId: sessionIdArg }), seq: wireSeq, at: Date.now() },
        payload: encodePayload(frame),
    };
    socket.send(JSON.stringify(envelope));
}

function finish(code: number, message: string): never {
    rmSync(probeCwd, { recursive: true, force: true });
    process.stdout.write(message);
    process.exit(code);
}

function maybePass(socket: WebSocket): void {
    const seen = new Set(received.map((event) => event.type));
    const missing = SESSION_EVENT_TYPES.filter((type) => !seen.has(type));
    // Gate on the reply, not merely sending the request.
    if (missing.length > 0 || !listRoundTripOk) return;

    clearTimeout(timer);
    const ordered = received.every((event, index) => event.seq === index + 1);
    const wireMonotonic = envelopeSeqs.every((value, index) => index === 0 || value > envelopeSeqs[index - 1]!);
    const ok = ordered && wireMonotonic && listRoundTripOk;
    const lines = [
        `\nPASS: all ${SESSION_EVENT_TYPES.length} contract event types delivered end to end.`,
        `      request/response round-trip: ${listRoundTripOk ? 'yes' : 'NO'}`,
        `      wire seq monotonic: ${wireMonotonic ? 'yes' : 'NO'}`,
        '',
    ];
    socket.close();
    finish(ok ? 0 : 1, lines.join('\n'));
}

function startListRoundTrip(socket: WebSocket): void {
    const requestId = nextRequestId('probe');
    listRoundTripDone = true;
    send(socket, { type: 'session.list', requestId, params: {} });

}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
    return (
        typeof value === 'object'
        && value !== null
        && 'info' in value
        && typeof (value as SessionSnapshot).info.id === 'string'
    );
}

function promptSession(socket: WebSocket, id: string): void {
    sessionId = id;
    process.stdout.write(`session started: ${sessionId}\n`);
    send(
        socket,
        {
            type: 'session.prompt',
            requestId: nextRequestId('probe'),
            params: { sessionId: id, text: 'widen the event projection' },
        },
        id,
    );
}

function handleSessionList(sessions: SessionInfo[], socket: WebSocket): void {
    if (sessions.length === 0) return;
    if (sessionId === undefined) promptSession(socket, sessions[0]!.id);
}

function handleResult(frame: Extract<HostFrame, { type: 'result' }>, socket: WebSocket): void {
    if (!frame.ok) {
        process.stdout.write(`  (request error) ${frame.error}\n`);
        maybePass(socket);
        return;
    }
    if (listRoundTripDone && Array.isArray(frame.data)) {
        listRoundTripOk = true;
        maybePass(socket);
        return;
    }
    if (listRoundTripDone) {
        maybePass(socket);
        return;
    }
    if (isSessionSnapshot(frame.data)) {
        promptSession(socket, frame.data.info.id);
        maybePass(socket);
        return;
    }
    if (Array.isArray(frame.data)) handleSessionList(frame.data as SessionInfo[], socket);
    maybePass(socket);
}

const socket = new WebSocket(`${relayUrl}?role=client&machineId=${encodeURIComponent(machineId)}`);

const timer = setTimeout(() => {
    finish(1, `\nFAIL: timed out after ${TIMEOUT_MS}ms with ${received.length} events (roundTrip=${listRoundTripOk})\n`);
}, TIMEOUT_MS);

socket.on('open', () => {
    process.stdout.write(`probe connected -> ${relayUrl} (machine "${machineId}")\n`);
    send(socket, {
        type: 'session.start',
        requestId: nextRequestId('probe'),
        params: { cwd: probeCwd },
    });
});

socket.on('message', (raw) => {
    let envelope: Envelope;
    try {
        envelope = JSON.parse(String(raw)) as Envelope;
    } catch {
        return;
    }
    envelopeSeqs.push(envelope.header.seq);

    const frame = decodePayload<HostFrame>(envelope.payload);

    if (frame.type === 'result') {
        handleResult(frame, socket);
        return;
    }

    if (frame.type === 'session.list') {
        if (!listRoundTripDone && received.length >= SESSION_EVENT_TYPES.length) {
            startListRoundTrip(socket);
            return;
        }
        handleSessionList(frame.sessions, socket);
        return;
    }

    if (frame.type === 'session.event') {
        received.push(frame.event);
        process.stdout.write(`  <- ${String(frame.event.seq).padStart(2)} ${frame.event.type}\n`);

        if (received.length >= SESSION_EVENT_TYPES.length && !listRoundTripDone) {
            startListRoundTrip(socket);
        }
        maybePass(socket);
    }
});

socket.on('error', (error) => finish(1, `\nFAIL: ${error.message}\n`));
socket.on('close', () => {
    if (received.length === 0) finish(1, '\nFAIL: relay closed the connection\n');
});
