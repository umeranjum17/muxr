/**
 * End-to-end device pairing through a live relay.
 *
 * Proves the relay only ever holds a sealed blob: the account secret is sealed
 * to the new device's public key and unsealed with its private key.
 */
import { waitForRelay } from './waitForRelay.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sodium from 'libsodium-wrappers';

const PORT = process.env.MUXR_RELAY_PORT ?? '8812';
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-pairing-'));
const children = [];
const done = (code, msg) => {
    process.stdout.write(msg);
    for (const child of children) child.kill('SIGTERM');
    process.exit(code);
};

const relay = spawn('node', ['apps/relay/dist/main.js'], {
    env: { ...process.env, MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT, MUXR_RELAY_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`));
children.push(relay);
await waitForRelay(PORT);

const post = async (path, body, token) => {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
};

await sodium.ready;

// The already-authorised device owns an account.
const account = await post('/v1/accounts', {});
if (account.status !== 201) done(1, `\nFAIL: account create returned ${account.status}\n`);
const accountToken = account.body.token;

// New device: box keypair, publishes its public key, polls.
const device = sodium.crypto_box_keypair();
const publicKey = Buffer.from(device.publicKey).toString('base64');

const started = await post('/v1/auth/account/request', { publicKey });
if (started.body.state !== 'requested') done(1, `\nFAIL: expected requested, got ${JSON.stringify(started.body)}\n`);

// Junk must be refused before it reaches the map.
const junk = await post('/v1/auth/account/request', { publicKey: 'not-a-key' });
if (junk.status !== 400) done(1, `\nFAIL: junk publicKey accepted (${junk.status})\n`);

// An unauthenticated approval must not be possible.
const anon = await post('/v1/auth/account/response', { publicKey, response: 'x' });
if (anon.status !== 401) done(1, `\nFAIL: unauthenticated approve returned ${anon.status}\n`);
const forged = await post('/v1/auth/account/response', { publicKey, response: 'x' }, 'acctok_wrong');
if (forged.status !== 403) done(1, `\nFAIL: forged token returned ${forged.status}\n`);

// Approver seals the account secret to the new device's public key.
const secret = sodium.randombytes_buf(32);
const sealed = sodium.crypto_box_seal(secret, device.publicKey);
const approved = await post(
    '/v1/auth/account/response',
    { publicKey, response: Buffer.from(sealed).toString('base64') },
    accountToken,
);
if (approved.status !== 200) done(1, `\nFAIL: approve returned ${approved.status}\n`);

// New device polls again and unseals.
const polled = await post('/v1/auth/account/request', { publicKey });
if (polled.body.state !== 'authorized') done(1, `\nFAIL: expected authorized, got ${JSON.stringify(polled.body)}\n`);
if (polled.body.token !== accountToken) done(1, '\nFAIL: account token not handed to the new device\n');

const opened = sodium.crypto_box_seal_open(
    Buffer.from(polled.body.response, 'base64'),
    device.publicKey,
    device.privateKey,
);
if (Buffer.compare(Buffer.from(opened), Buffer.from(secret)) !== 0) {
    done(1, '\nFAIL: unsealed secret does not match\n');
}

const relaySawPlaintext = polled.body.response.includes(Buffer.from(secret).toString('base64'));
if (relaySawPlaintext) done(1, '\nFAIL: plaintext secret visible in relay response\n');

done(
    0,
    '\nPASS: device pairing through the relay\n' +
        '      junk key rejected: yes   unauthenticated approve rejected: yes\n' +
        '      forged account token rejected: yes\n' +
        '      secret unsealed by new device: yes   relay saw ciphertext only: yes\n',
);
