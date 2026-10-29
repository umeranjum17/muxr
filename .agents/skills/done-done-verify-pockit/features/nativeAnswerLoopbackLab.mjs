import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeviceLink, hostId, keyPairFrom } from '@byokit/pair';
import { openAnswer, openNoticeContent, sealAnswer } from '@byokit/push';

/** Real relay + host endpoint; only the external Expo provider and agent input sink are fixtures. */
export async function nativeAnswerLoopback({ startRelay, LinkEndpoint, answerAgent, openLifecycleNotice }) {
    const deliveries = [];
    const capturedFetch = async (url, init) => {
        if (!String(url).startsWith('https://exp.host')) return fetch(url, init);
        const body = JSON.parse(String(init?.body));
        deliveries.push(...body);
        return new Response(JSON.stringify({ data: body.map(() => ({ status: 'ok' })) }), { status: 200 });
    };
    const dataDir = mkdtempSync(join(tmpdir(), 'muxr-answer-'));
    const relay = await startRelay({ port: 0, host: '127.0.0.1', linkPush: { fetch: capturedFetch }, config: { dataDir, advertiseMdns: false } });
    const machine = keyPairFrom(randomBytes(32));
    const device = keyPairFrom(randomBytes(32));
    const notice = keyPairFrom(randomBytes(32));
    const b64 = (key) => Buffer.from(key).toString('base64');
    const b64url = (key) => Buffer.from(key).toString('base64url');
    const crypto = {
        boxSecretKey: b64(machine.secretKey), boxPublicKey: b64(machine.publicKey),
        devices: [{ deviceId: 'answer-device', devicePublicKey: b64(device.publicKey), authority: 'control', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
    };
    let endpoint, link;
    const received = [];
    try {
        endpoint = await LinkEndpoint.open({
            relayUrl: `ws://127.0.0.1:${relay.port}`, ownerToken: JSON.parse(readFileSync(join(dataDir, 'mint-secret'), 'utf8')),
            machineId: 'answer-machine', machineName: 'Lab', crypto, currentCrypto: () => crypto,
            grants: { load: () => [], save: () => undefined }, canView: () => false,
            savePushLevel: (_id, level, key) => { crypto.devices[0].pushLevel = level; crypto.devices[0].noticePublicKey = key; },
            answer: async (frame) => {
                assert.equal(frame.type, 'session.answer');
                const result = await answerAgent({ sendKeys: async (session, keys, question) => { received.push({ session, keys, event: question?.eventId }); } }, frame.params);
                return { type: 'result', requestId: frame.requestId, ...result };
            },
        });
        assert.ok(endpoint);
        endpoint.start();
        link = new DeviceLink({ v: 1, secretKey: b64url(device.secretKey), host: b64url(machine.publicKey), hostName: 'Lab',
            urls: [`ws://127.0.0.1:${relay.port}/link/v1/${hostId(machine.publicKey)}`], device: { id: '', name: 'Fixture', role: 'control' } }, {});
        await assert.rejects(link.request('push.subscribe', { type: 'push.subscribe', requestId: 'bad-notice-key', params: {
            token: 'ExponentPushToken[sealed-answer-fixture]', noticePublicKey: Buffer.alloc(32).toString('base64'),
        } }), /notice key is invalid/);
        await link.request('push.subscribe', { type: 'push.subscribe', requestId: 'register-answer', params: {
            token: 'ExponentPushToken[sealed-answer-fixture]', level: 'important', noticePublicKey: b64(notice.publicKey),
        } });
        assert.equal(crypto.devices[0].noticePublicKey, b64(notice.publicKey));
        const notify = async (eventId) => {
            const before = deliveries.length;
            endpoint.notifyAttention({ sessionId: 'origin-session', eventId, kind: 'blocked', machineId: 'answer-machine', agentName: 'Lab agent', question: 'Which path should I take?' });
            const deadline = Date.now() + 5000;
            while (deliveries.length === before) {
                assert.ok(Date.now() < deadline, 'relay did not deliver the question');
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return deliveries.at(-1);
        };
        const sent = await notify('answer-question');
        assert.equal(sent.mutableContent, true);
        assert.equal(sent.categoryId, 'agent-question-native');
        const payload = sent.data;
        assert.equal(openNoticeContent({ body: payload }, notice.secretKey)?.body, 'Which path should I take?');
        assert.equal(openNoticeContent({ body: payload }, device.secretKey), null);
        assert.equal(openNoticeContent({ body: payload }, new Uint8Array()), null);
        const tampered = { ...payload, data: { ...payload.data, sealed: `!${payload.data.sealed.slice(1)}` } };
        assert.equal(openNoticeContent({ body: tampered }, notice.secretKey), null);
        assert.equal(openLifecycleNotice(payload, [{ machineId: 'answer-machine', deviceKey: { secretKey: b64(device.secretKey) } }], b64(notice.secretKey)).body, 'Which path should I take?');
        const reply = sealAnswer({ event: payload.id, action: 'answer', text: 'take the safe path' }, notice.secretKey, machine.publicKey);
        assert.equal(openAnswer({ event: payload.id, action: 'answer', reply }, notice.publicKey, machine.secretKey), 'take the safe path');
        assert.equal(openAnswer({ event: 'another-question', action: 'answer', reply }, notice.publicKey, machine.secretKey), null);
        assert.equal(openAnswer({ event: payload.id, action: 'open', reply }, notice.publicKey, machine.secretKey), null);
        const press = (token, sealed) => fetch(`http://127.0.0.1:${relay.port}/relay/v1/push/action`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, action: 'answer', reply: sealed }),
        });
        assert.equal((await press(payload.action, reply)).status, 200);
        assert.deepEqual(received, [{ session: 'origin-session', event: 'answer-question', keys: [...'take the safe path', 'enter'] }]);
        assert.equal((await press(payload.action, reply)).ok, false);
        const next = (await notify('next-question')).data;
        assert.equal((await press(next.action, reply)).ok, false);
        const revoked = (await notify('revoked-question')).data;
        const revokedReply = sealAnswer({ event: revoked.id, action: 'answer', text: 'y' }, notice.secretKey, machine.publicKey);
        crypto.devices.length = 0;
        assert.equal((await press(revoked.action, revokedReply)).ok, false);
        assert.equal(received.length, 1);
        return { transport: 'real loopback relay; synthetic Expo delivery and agent input sink', question: 'Which path should I take?',
            typed: 'take the safe path', received: received[0].keys.slice(0, -1).join(''), originatingSessionOnly: true,
            sameTokenReplayRefused: true, reboundReplayOpensToNull: true, revokedGrantRefused: true,
            missingWrongTamperedNoticeFallsBack: true, physicalApns: 'not performed', appJavaScript: 'not involved in loopback; native wake not proven' };
    } finally {
        link?.stop();
        endpoint?.close();
        await relay.close();
        rmSync(dataDir, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { startRelay } = await import('../../../../apps/relay/dist/relay.js');
    const { LinkEndpoint } = await import('../../../../apps/host/dist/machine/infrastructure/linkEndpoint.js');
    const { answerAgent } = await import('../../../../apps/host/dist/agent/application/answerAgent.js');
    const { openNotice } = await import('@byokit/seal');
    const result = await nativeAnswerLoopback({ startRelay, LinkEndpoint, answerAgent,
        openLifecycleNotice: (payload, _grants, secret) => openNotice(payload.data, Buffer.from(secret, 'base64')) });
    const root = process.env.DONE_DONE_EVIDENCE_ROOT;
    assert.ok(root, 'DONE_DONE_EVIDENCE_ROOT is required');
    writeFileSync(join(root, 'loopback.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(root, 'steps.json'), JSON.stringify({ target: { version: JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url))).version },
        start: 'Fresh loopback relay, trusted pairing identity and a separate synthetic installation notification key.',
        steps: ['Register the notification public key over the authenticated link.', 'Receive a sealed question.', 'Seal and POST a short answer to the real relay action route.',
            'Open and route the same text to the original session.', 'Replay its token, rebind its ciphertext and revoke its grant: each is refused.'],
        result: 'The host received the same fixture text once. No APNs delivery or native background wake was exercised.' }, null, 2));
    console.log(JSON.stringify(result, null, 2));
}
