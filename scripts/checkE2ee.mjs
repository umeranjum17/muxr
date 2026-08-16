/**
 * Proves E2EE end to end: host and client share a key, the relay routes frames
 * it cannot read, and a session event still arrives intact.
 */
import { waitForRelay } from './waitForRelay.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createPayloadCodec, deriveSharedKey, generateKeyPair, isEncryptedPayload } from '@muxr/crypto';

const PORT = process.env.MUXR_RELAY_PORT ?? '8798';
const MACHINE = 'e2ee-check';
const RELAY = `ws://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-e2ee-relay-'));

const machineKeys = generateKeyPair();
const clientKeys = generateKeyPair();
const hostShared = deriveSharedKey(machineKeys.secretKey, clientKeys.publicKey);
const clientShared = deriveSharedKey(clientKeys.secretKey, machineKeys.publicKey);

const env = {
    ...process.env,
    MUXR_MODE: 'local',
    MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT,
    MUXR_RELAY_URL: RELAY,
    MUXR_MACHINE_ID: MACHINE,
    MUXR_E2EE_SHARED_KEY: hostShared,
    MUXR_HOME: dataDir,
    MUXR_RELAY_DATA_DIR: dataDir,
};
const children = [];
const start = (n, a) => { const c = spawn('node', a, { env, stdio: ['ignore', 'pipe', 'pipe'] }); c.stdout.on('data', d => process.stdout.write(`[${n}] ${d}`)); c.stderr.on('data', d => process.stderr.write(`[${n}] ${d}`)); children.push(c); };
const done = (code, msg) => { process.stdout.write(msg); for (const c of children) c.kill('SIGTERM'); process.exit(code); };

start('relay', ['apps/relay/dist/main.js']);
await waitForRelay(PORT);
start('host', ['apps/host/dist/main.js', '--fake']);
await delay(900);

const codec = createPayloadCodec(clientShared);
const socket = new WebSocket(`${RELAY}?role=client&machineId=${MACHINE}`);
const timer = setTimeout(() => done(1, '\nFAIL: no encrypted event within 20s\n'), 20000);
let wire = 0, sessionId, sawCiphertext = false, plaintextLeak = false, decrypted = 0;
const send = (frame, sid) => {
    wire += 1;
    socket.send(JSON.stringify({
        header: { machineId: MACHINE, ...(sid ? { sessionId: sid } : {}), seq: wire, at: Date.now() },
        payload: codec.encode(JSON.stringify(frame)),
    }));
};

socket.on('open', () => send({ type: 'session.start', requestId: 'e1', params: { cwd: mkdtempSync(join(tmpdir(), 'muxr-e2ee-')) } }));

socket.on('message', (raw) => {
    const envelope = JSON.parse(String(raw));

    // The relay forwarded this. It must be ciphertext on the wire.
    if (isEncryptedPayload(envelope.payload)) sawCiphertext = true;
    if (envelope.payload.includes('session.event') || envelope.payload.includes('assistant')) plaintextLeak = true;

    const frame = JSON.parse(codec.decode(envelope.payload));
    decrypted += 1;

    if (frame.type === 'result' && frame.ok && frame.data?.info && !sessionId) {
        sessionId = frame.data.info.id;
        send({ type: 'session.prompt', requestId: 'e2', params: { sessionId, text: 'go' } }, sessionId);
        return;
    }
    if (frame.type === 'session.event' && frame.event.type === 'session.error') {
        clearTimeout(timer);
        const ok = sawCiphertext && !plaintextLeak && decrypted > 5;
        done(ok ? 0 : 1, ok
            ? `\nPASS: E2EE end to end\n      wire was ciphertext: yes\n      plaintext leak to relay: no\n      frames decrypted by client: ${decrypted}\n`
            : `\nFAIL: ciphertext=${sawCiphertext} leak=${plaintextLeak} decrypted=${decrypted}\n`);
    }
});
socket.on('error', (e) => done(1, `\nFAIL: ${e.message}\n`));
