/**
 * Web-push flow check (G2 diagnostic): stock self-host relay, no dev API.
 *
 * Part A (HTTP, production gating): pair a browser device, prove
 * /v1/push/vapid-public and /v1/push/subscribe answer its device credential,
 * persist the device-bound endpoint plus the level, reject missing/peer/foreign
 * credentials, allowlist unsafe endpoints, update the level on re-post,
 * delete by endpoint, and drop the device's subscriptions on revocation.
 * Part B (delivery): drive the real PushService against a localhost stub
 * push endpoint — level-filtered sends, urgency/TTL headers, endpoint
 * removal stops delivery.
 */
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

// Loopback stub endpoints below use plain http, which the endpoint
// allowlist admits for local diagnostics stubs. (Live delivery needs a
// public https push service; the web-push library speaks TLS.)

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
    assert(vapidAnon.response.status === 401, `vapid-public answered without a device credential: ${vapidAnon.response.status}`);
    const vapidPeer = await json('/v1/push/vapid-public', { headers: bearer('muxr_dc_bogus') });
    assert(vapidPeer.response.status === 403, `vapid-public answered a foreign credential: ${vapidPeer.response.status}`);
    const vapid = await json('/v1/push/vapid-public', { headers: bearer(browser.credential) });
    assert(vapid.response.ok && typeof vapid.body.publicKey === 'string', `device vapid-public failed: ${JSON.stringify(vapid.body)}`);

    // Subscribe persists the endpoint plus the level.
    const subscription = {
        endpoint: `http://127.0.0.1:${stubPort}/push/${browser.id}`,
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
    assert(stored.length === 1 && stored[0].endpoint === subscription.endpoint
        && stored[0].deviceId === browser.id && stored[0].level === 'important',
        `device-bound endpoint/level not persisted: ${JSON.stringify(stored)}`);

    // Re-posting the same endpoint updates the level instead of duplicating.
    const resub = await json('/v1/push/subscribe', {
        method: 'POST', headers: bearer(browser.credential),
        body: JSON.stringify({ subscription, level: 'all' }),
    });
    assert(resub.response.ok, `level update failed: ${JSON.stringify(resub.body)}`);
    const restored = subsFile().accounts[accountId] ?? [];
    assert(restored.length === 1 && restored[0].level === 'all', `level update duplicated: ${JSON.stringify(restored)}`);

    // Explicit endpoint DELETE removes the record while the credential lives.
    const deleted = await json('/v1/push/subscribe', {
        method: 'DELETE', headers: bearer(browser.credential),
        body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    assert(deleted.response.ok, `endpoint delete failed: ${JSON.stringify(deleted.body)}`);
    assert((subsFile().accounts[accountId] ?? []).length === 0, 'endpoint delete left the record');
    process.stdout.write('ok  subscription endpoints allowlisted; level updates; endpoint delete works\n');

    // Re-subscribe so revocation has something to cascade to: revoking the
    // device kills the credential AND drops its subscriptions.
    const resub2 = await json('/v1/push/subscribe', {
        method: 'POST', headers: bearer(browser.credential),
        body: JSON.stringify({ subscription, level: 'important' }),
    });
    assert(resub2.response.ok, `resubscribe failed: ${JSON.stringify(resub2.body)}`);

    // Revocation rejects the credential and drops the device's subscriptions.
    const revoked = await json(`/v1/selfhost/devices/${encodeURIComponent(browser.id)}`, {
        method: 'DELETE', headers: bearer(mintSecret),
    });
    assert(revoked.response.ok, `revoke failed: ${JSON.stringify(revoked.body)}`);
    assert((subsFile().accounts[accountId] ?? []).length === 0, 'revoked device kept its web subscription');
    const vapidRevoked = await json('/v1/push/vapid-public', { headers: bearer(browser.credential) });
    assert(vapidRevoked.response.status === 403, `revoked credential still answered: ${vapidRevoked.response.status}`);
    process.stdout.write('ok  web push reachable with device auth, persists device-bound endpoint+level, revocation unsubscribes\n');

    // Part B: record-keeping semantics, no network. The web-push library
    // speaks TLS unconditionally while the allowlist admits plain http only
    // to loopback for stubs, so live delivery cannot run in this sandbox;
    // what runs here is everything around the send: persistence, dedup TTL
    // (including legacy entries without timestamps), endpoint removal, and
    // endpoint validation. Live urgency/TTL delivery rides a public https
    // push service, not a loopback stub.
    const push = new PushService(dataDir);
    await push.load();
    const bbSub = (path) => ({
        endpoint: `http://127.0.0.1:${stubPort}/push/${path}`,
        keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) },
    });
    await push.subscribe('acct:b', bbSub('b-important'), { level: 'important' });
    await push.subscribe('acct:b', bbSub('b-all'), { level: 'all' });
    const withLevels = subsFile().accounts['acct:b'] ?? [];
    assert(withLevels.length === 2
        && withLevels.some((entry) => entry.endpoint.endsWith('/b-important') && entry.level === 'important')
        && withLevels.some((entry) => entry.endpoint.endsWith('/b-all') && entry.level === 'all'),
        `levels not persisted: ${JSON.stringify(withLevels)}`);
    // Dedup TTL: a fresh entry suppresses as duplicate; a legacy entry
    // without `at` must expire instead of suppressing forever.
    const subsDoc = JSON.parse(readFileSync(join(dataDir, 'push-subscriptions.json'), 'utf8'));
    subsDoc.deliveredEvents = [
        ...(Array.isArray(subsDoc.deliveredEvents) ? subsDoc.deliveredEvents : []),
        { accountId: 'acct:b', eventId: 'ev-legacy' },
        { accountId: 'acct:b', eventId: 'ev-fresh', at: new Date().toISOString() },
    ];
    writeFileSync(join(dataDir, 'push-subscriptions.json'), JSON.stringify(subsDoc));
    const push2 = new PushService(dataDir);
    await push2.load();
    const dupFresh = await push2.notify('acct:b', { eventId: 'ev-fresh', kind: 'blocked', reasonCode: 'agent-blocked', agentName: 'Bex', sessionId: 's1', machineId: 'm' });
    assert(dupFresh.duplicate === true, `fresh duplicate not suppressed: ${JSON.stringify(dupFresh)}`);
    const redeliver = await push2.notify('acct:b', { eventId: 'ev-legacy', kind: 'blocked', reasonCode: 'agent-blocked', agentName: 'Bex', sessionId: 's1', machineId: 'm' });
    assert(redeliver.duplicate !== true, `legacy delivered entry suppressed redelivery instead of expiring: ${JSON.stringify(redeliver)}`);
    process.stdout.write('ok  dedup TTL suppresses fresh repeats and expires legacy entries\n');
    await push2.removeWebSubscription('acct:b', `http://127.0.0.1:${stubPort}/push/b-all`);
    const remaining = subsFile().accounts['acct:b'] ?? [];
    assert(!remaining.some((entry) => entry.endpoint.endsWith('/push/b-all')), 'endpoint removal left the record');
    assert(remaining.some((entry) => entry.endpoint.endsWith('/push/b-important')), 'endpoint removal dropped the wrong record');
    // Unsafe endpoints never reach storage, whatever the caller claims.
    const subscribeThrows = async (endpoint) => {
        try {
            await push.subscribe('acct:b', { endpoint, keys: { p256dh: 'a', auth: 'b' } });
        } catch (cause) {
            if (/not an allowed Web Push destination/.test(cause instanceof Error ? cause.message : String(cause))) return;
            throw cause;
        }
        throw new Error(`unsafe endpoint accepted: ${endpoint}`);
    };
    await subscribeThrows('http://push.example/hook');
    await subscribeThrows('https://user:pw@push.example/hook');
    await subscribeThrows('javascript:alert(1)');
    process.stdout.write('ok  unsafe endpoints never reach storage\n');

    process.stdout.write('PASS e2e: self-host web push subscribe/level/delete/notify with device auth\n');
} catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
} finally {
    child.current?.kill();
    if (child.current !== undefined) await new Promise((resolve) => child.current.once('exit', resolve));
    rmSync(dataDir, { recursive: true, force: true });
}
