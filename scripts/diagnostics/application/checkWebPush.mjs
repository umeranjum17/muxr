/**
 * Web-push flow check (G2 diagnostic): stock self-host relay, no dev API.
 *
 * Part A (HTTP, production gating): pair a browser device, prove
 * /v1/push/vapid-public and /v1/push/subscribe answer its device credential,
 * persist deviceId + level, reject peer/foreign credentials, and drop the
 * subscription when the device is revoked.
 * Part B (delivery): drive the real PushService against a localhost stub
 * push endpoint — level-filtered sends, urgency/TTL headers, revocation
 * unsubscribes.
 */
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
    createDeviceGrant,
    generateKeyPair,
    generateSigningKeyPair,
    pairingCodeHash,
    sealPairingCodePayload,
} from '@muxr/crypto';
import { waitForRelay } from './waitForRelay.mjs';
import { PushService } from '../../../apps/relay/dist/push/infrastructure/push.js';

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const freePort = await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
    });
});
const stubPort = await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
    });
});

const dataDir = mkdtempSync(join(tmpdir(), 'muxr-webpush-'));
const child = { current: undefined };
const machine = 'muxr-webpush-check';
const signing = generateSigningKeyPair();
const machineBox = generateKeyPair();
const initialDataKey = randomBytes(32).toString('base64');
const expiresAt = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const base = `http://127.0.0.1:${freePort}`;
const json = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...options.headers },
    });
    return { response, body: await response.json().catch(() => ({})) };
};
const bearer = (value) => ({ authorization: `Bearer ${value}` });

// Localhost stub push endpoint: captures web-push deliveries. web-push speaks
// HTTPS unconditionally, so the stub serves a throwaway self-signed cert.
const certDir = mkdtempSync(join(tmpdir(), 'muxr-webpush-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'ignore' });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const deliveries = [];
const stub = createServer({
    key: readFileSync(join(certDir, 'key.pem')),
    cert: readFileSync(join(certDir, 'cert.pem')),
}, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        deliveries.push({
            url: req.url,
            ttl: req.headers.ttl,
            urgency: req.headers.urgency,
            authorization: req.headers.authorization,
            bytes: Buffer.concat(chunks).length,
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{}');
    });
});
await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve));

async function pairBrowser(name, personal = false) {
    const keys = generateKeyPair();
    const claim = randomBytes(32).toString('base64url');
    const opened = await json('/v1/selfhost/pair-sessions', {
        method: 'POST', headers: bearer(mintSecret),
        body: JSON.stringify({ claim, machineSlug: machine, deviceKind: 'browser', authority: 'control', ...(personal ? { personal: true } : {}) }),
    });
    assert(opened.response.ok, `open browser pair failed: ${JSON.stringify(opened.body)}`);
    const pairId = opened.body.pair_id;
    const code = '7KDM4-QXP7N';
    const publishedCode = await json(`/v1/selfhost/pair-sessions/${pairId}/code`, {
        method: 'POST', headers: bearer(mintSecret),
        body: JSON.stringify({ code_hash: pairingCodeHash(code), payload: sealPairingCodePayload(`payload-${name}`, code) }),
    });
    assert(publishedCode.response.ok, `pair code publish failed: ${JSON.stringify(publishedCode.body)}`);
    const claimed = await json(`/v1/selfhost/pair-sessions/${pairId}/claim`, {
        method: 'POST',
        body: JSON.stringify({ claim, device_public_key: keys.publicKey, device_name: name, device_kind: 'browser', mailbox: 'opaque-mailbox' }),
    });
    assert(claimed.response.ok, `browser claim failed: ${JSON.stringify(claimed.body)}`);
    return { id: claimed.body.device_id, credential: claimed.body.device_credential, keys, name };
}

const pairingStore = () => JSON.parse(readFileSync(join(dataDir, 'selfhost-pairing.json'), 'utf8'));
const deviceRecord = (deviceId) => pairingStore().devices.find((entry) => entry.deviceId === deviceId);

const subsFile = () => JSON.parse(readFileSync(join(dataDir, 'push-subscriptions.json'), 'utf8'));

let mintSecret;
try {
    // Production gating proof: no MUXR_RELAY_DEVELOPMENT_API here.
    child.current = spawn('node', ['apps/relay/dist/main.js'], {
        env: {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_PORT: String(freePort),
            MUXR_RELAY_HOST: '127.0.0.1',
            MUXR_RELAY_DATA_DIR: dataDir,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForRelay(freePort);
    mintSecret = JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8'));

    const browser = await pairBrowser('browser-pwa');
    const accountId = `local:${machine}`;

    // Owner-authorized personal browsers carry a 30d credential; the claim
    // body cannot request it, and normal browsers stay 8h. Lifetimes are
    // read off the real pairing store, not echoed request bodies.
    const personal = await pairBrowser('browser-personal', true);
    const eightHours = 8 * 60 * 60_000;
    const thirtyDays = 30 * 24 * 60 * 60_000;
    const normalTtl = (deviceRecord(browser.id)?.expiresAt ?? 0) - Date.now();
    const personalTtl = (deviceRecord(personal.id)?.expiresAt ?? 0) - Date.now();
    assert(normalTtl > eightHours - 60_000 && normalTtl <= eightHours, `normal browser credential not 8h: ${normalTtl}`);
    assert(personalTtl > thirtyDays - 60_000 && personalTtl <= thirtyDays, `personal browser credential not 30d: ${personalTtl}`);
    // A personal marker on a NATIVE session must not lengthen anything: the
    // marker is browser-only at issuance.
    const nativeOpened = await json('/v1/selfhost/pair-sessions', {
        method: 'POST', headers: bearer(mintSecret),
        body: JSON.stringify({ claim: randomBytes(32).toString('base64url'), machineSlug: machine, deviceKind: 'native', personal: true }),
    });
    assert(nativeOpened.response.ok, `native session with stray personal flag rejected: ${nativeOpened.response.status}`);
    process.stdout.write('ok  personal 30d propagates through relay issuance; normal browsers stay 8h\n');

    // Legacy hosted action surface stays unreachable without the dev API.
    const action = await json('/v1/push/action', {
        method: 'POST', headers: bearer('acctok_legacy'),
        body: JSON.stringify({ sessionId: 's', answer: 'y' }),
    });
    assert(action.response.status === 404, `dev-only push action reachable in production: ${action.response.status}`);

    const vapidAnon = await json('/v1/push/vapid-public');
    assert(vapidAnon.response.status === 403, `vapid-public answered without a device credential: ${vapidAnon.response.status}`);
    const vapidPeer = await json('/v1/push/vapid-public', { headers: bearer('muxr_dc_bogus') });
    assert(vapidPeer.response.status === 403, `vapid-public answered a foreign credential: ${vapidPeer.response.status}`);
    const vapid = await json('/v1/push/vapid-public', { headers: bearer(browser.credential) });
    assert(vapid.response.ok && typeof vapid.body.publicKey === 'string', `device vapid-public failed: ${JSON.stringify(vapid.body)}`);

    // Subscribe persists the credential-bound deviceId plus the level.
    const subscription = {
        endpoint: `https://127.0.0.1:${stubPort}/push/${browser.id}`,
        keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) },
    };
    const badSub = await json('/v1/push/subscribe', {
        method: 'POST', headers: bearer(browser.credential),
        body: JSON.stringify({ subscription: { endpoint: 'http://cleartext/', keys: { p256dh: 'a', auth: 'b' } } }),
    });
    assert(badSub.response.status === 400, `cleartext subscription accepted: ${badSub.response.status}`);
    const userinfoSub = await json('/v1/push/subscribe', {
        method: 'POST', headers: bearer(browser.credential),
        body: JSON.stringify({ subscription: { endpoint: 'https://user:pw@push.example/hook', keys: { p256dh: 'a', auth: 'b' } } }),
    });
    assert(userinfoSub.response.status === 400, `userinfo endpoint accepted: ${userinfoSub.response.status}`);
    const remoteHttpSub = await json('/v1/push/subscribe', {
        method: 'POST', headers: bearer(browser.credential),
        body: JSON.stringify({ subscription: { endpoint: 'http://push.example/hook', keys: { p256dh: 'a', auth: 'b' } } }),
    });
    assert(remoteHttpSub.response.status === 400, `non-loopback http endpoint accepted: ${remoteHttpSub.response.status}`);
    const badLevel = await json('/v1/push/subscribe', {
        method: 'POST', headers: bearer(browser.credential),
        body: JSON.stringify({ subscription, level: 'everything' }),
    });
    assert(badLevel.response.status === 400, `invalid level accepted: ${badLevel.response.status}`);
    const sub = await json('/v1/push/subscribe', {
        method: 'POST', headers: bearer(browser.credential),
        body: JSON.stringify({ subscription, level: 'important' }),
    });
    assert(sub.response.ok, `device subscribe failed: ${JSON.stringify(sub.body)}`);
    const stored = subsFile().accounts[accountId] ?? [];
    assert(stored.length === 1 && stored[0].deviceId === browser.id && stored[0].level === 'important',
        `deviceId/level not persisted: ${JSON.stringify(stored)}`);

    // Per-device cap: six subscriptions collapse to the five newest.
    for (let index = 0; index < 5; index += 1) {
        const extra = await json('/v1/push/subscribe', {
            method: 'POST', headers: bearer(browser.credential),
            body: JSON.stringify({ subscription: { endpoint: `https://127.0.0.1:${stubPort}/push/${browser.id}-${index}`, keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) } }, level: 'all' }),
        });
        assert(extra.response.ok, `capped subscribe failed: ${JSON.stringify(extra.body)}`);
    }
    const capped = (subsFile().accounts[accountId] ?? []).filter((entry) => entry.deviceId === browser.id);
    assert(capped.length === 5, `per-device cap not enforced: ${capped.length}`);
    assert(!capped.some((entry) => entry.endpoint === subscription.endpoint), 'cap dropped the newest instead of the oldest');
    process.stdout.write('ok  subscription endpoints allowlisted; per-device cap enforced\n');

    // Revocation drops the web subscription and rejects the credential.
    const revoked = await json(`/v1/selfhost/devices/${encodeURIComponent(browser.id)}`, {
        method: 'DELETE', headers: bearer(mintSecret),
    });
    assert(revoked.response.ok, `revoke failed: ${JSON.stringify(revoked.body)}`);
    const afterRevoke = subsFile().accounts[accountId] ?? [];
    assert(afterRevoke.length === 0, `revoked device kept its web subscription: ${JSON.stringify(afterRevoke)}`);
    const vapidRevoked = await json('/v1/push/vapid-public', { headers: bearer(browser.credential) });
    assert(vapidRevoked.response.status === 403, `revoked credential still answered: ${vapidRevoked.response.status}`);
    process.stdout.write('ok  web push reachable with device auth, persists deviceId+level, revocation unsubscribes\n');

    // Part B: delivery semantics against the stub endpoint.
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const push = new PushService(dataDir);
    await push.load();
    const stubSub = {
        endpoint: `https://127.0.0.1:${stubPort}/push/stub`,
        keys: { p256dh: ecdh.getPublicKey('base64'), auth: randomBytes(16).toString('base64') },
    };
    await push.subscribe('acct:b', stubSub, { deviceId: 'dev-important', level: 'important' });
    await push.subscribe('acct:b', { ...stubSub, endpoint: `https://127.0.0.1:${stubPort}/push/stub-all` }, { deviceId: 'dev-all', level: 'all' });
    const blocked = { eventId: 'ev-blocked', kind: 'blocked', reasonCode: 'agent-blocked', agentName: 'Bex', sessionId: 's1', machineId: 'm' };
    const out1 = await push.notify('acct:b', blocked);
    assert(out1.sent === 2, `blocked expected 2 sends, got ${JSON.stringify(out1)}`);
    assert(deliveries.length === 2 && deliveries.every((d) => d.urgency === 'high' && String(d.ttl) === '86400'),
        `blocked urgency/TTL wrong: ${JSON.stringify(deliveries)}`);
    deliveries.length = 0;
    const done = { eventId: 'ev-done', kind: 'done', reasonCode: 'agent-done', agentName: 'Cy', sessionId: 's2', machineId: 'm' };
    const out2 = await push.notify('acct:b', done);
    assert(out2.sent === 1, `done expected 1 send (all-level only), got ${JSON.stringify(out2)}`);
    assert(deliveries.length === 1 && deliveries[0].url === '/push/stub-all', `done went to the wrong subs: ${JSON.stringify(deliveries)}`);
    deliveries.length = 0;
    await push.removeWebDevice('acct:b', 'dev-all');
    const out3 = await push.notify('acct:b', { ...blocked, eventId: 'ev-blocked-2' });
    assert(out3.sent === 1, `post-revocation blocked expected 1 send, got ${JSON.stringify(out3)}`);
    assert(deliveries.length === 1 && deliveries[0].url === '/push/stub', `revoked device still notified: ${JSON.stringify(deliveries)}`);
    deliveries.length = 0;
    // Delivery-time authorization: a subscription whose device grant died is
    // pruned, not sent to — even with no explicit revoke call in between.
    // Unsafe endpoints never reach storage, whatever the caller claims.
    await push.setAuthorizer(async (_accountId, deviceId) => deviceId !== 'dev-important');
    const out4 = await push.notify('acct:b', { ...blocked, eventId: 'ev-blocked-3' });
    assert(out4.sent === 0, `dead device notified: ${JSON.stringify(out4)}`);
    assert(deliveries.length === 0, `dead device delivery attempted: ${JSON.stringify(deliveries)}`);
    // Unsafe endpoints never reach storage, whatever the caller claims.
    const subscribeThrows = async (endpoint) => {
        try {
            await push.subscribe('acct:b', { endpoint, keys: { p256dh: 'a', auth: 'b' } }, { deviceId: 'dev-x' });
        } catch (cause) {
            if (/not an allowed Web Push destination/.test(cause instanceof Error ? cause.message : String(cause))) return;
            throw cause;
        }
        throw new Error(`unsafe endpoint accepted: ${endpoint}`);
    };
    await subscribeThrows('http://push.example/hook');
    await subscribeThrows('https://user:pw@push.example/hook');
    await subscribeThrows('javascript:alert(1)');
    for (let index = 0; index < 6; index += 1) {
        await push.subscribe('acct:cap', { ...stubSub, endpoint: `https://127.0.0.1:${stubPort}/push/cap-${index}` }, { deviceId: 'dev-cap' });
    }
    const persisted = JSON.parse(readFileSync(join(dataDir, 'push-subscriptions.json'), 'utf8'));
    assert((persisted.accounts['acct:cap'] ?? []).length === 5, 'direct per-device cap not enforced');
    process.stdout.write('ok  web push level-filtered delivery, urgency/TTL, revocation unsubscribes\n');
    process.stdout.write('ok  delivery re-checks device authorization and prunes the dead\n');

    process.stdout.write('PASS e2e: self-host web push subscribe/notify/revoke with device auth\n');
} catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
} finally {
    stub.close();
    child.current?.kill();
    if (child.current !== undefined) await new Promise((resolve) => child.current.once('exit', resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
}
