#!/usr/bin/env node
/**
 * Short-lived smoke for the browser session service (exits on its own).
 *
 * Starts the service headless in a scratch state dir with the pinned Chrome,
 * serves a tiny loopback fixture, and drives the real socket the host
 * adapter uses: open, navigate, snapshot (no field values), fill (password
 * refused), click, then the ownership loop -- take (barrier + real tab
 * capture) -> every agent op refused status-only -> sealed private
 * signaling with a paired device (hello / presented / heartbeat) -> give
 * back refused on a page that still shows a sign-in field -> give back on a
 * safe page -> agent ops work again under a new generation.
 *
 *   node plugins/browser/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
    deriveBrowserSessionKeys,
    generateKeyPair,
    newV2ReplayTracker,
    newV2SenderState,
    openBrowserSessionMessage,
    sealBrowserSessionMessage,
    verifyDeviceGrant,
} from '@muxr/crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'muxr-browser-smoke-'));
const fixture = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url?.startsWith('/login')) {
        response.end('<title>Sign in</title><h1>Sign in</h1><form><label>Email <input name="email" type="text"></label><label>Password <input name="password" type="password" value="hunter2"></label><label>Code <input name="otp" autocomplete="one-time-code"></label><button type="button">Sign in</button></form>');
        return;
    }
    response.end('<title>Home</title><h1>Welcome</h1><p>Signed in as <b>owner</b></p><a href="/login">Sign in again</a><button type="button" id="go">Continue</button><input name="note" type="text" value="prefilled">');
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;

const service = spawn(process.execPath, [join(HERE, 'session-service.mjs')], {
    env: { ...process.env, MUXR_BROWSER_SERVICE_DIR: dir, MUXR_BROWSER_HEADLESS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
    service.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
    service.once('exit', (code) => reject(new Error(`service exited ${code}`)));
});

const socket = connect(join(dir, 'control.sock'));
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
const waiting = new Map();
let buffer = '';
socket.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
        const reply = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        waiting.get(reply.id)?.(reply);
        waiting.delete(reply.id);
    }
});
const call = (op, params) => new Promise((resolve) => {
    const id = randomUUID();
    waiting.set(id, resolve);
    socket.write(`${JSON.stringify({ id, op, params })}\n`);
});
const ok = async (op, params) => {
    const reply = await call(op, params);
    if (!reply.ok) throw new Error(`${op} failed: ${reply.error}`);
    return reply.data;
};
const refused = async (op, params, state) => {
    const reply = await call(op, params);
    if (reply.ok) throw new Error(`${op} should have been refused`);
    if (reply.data !== undefined) throw new Error(`${op} refusal leaked data`);
    if (state !== undefined && reply.state !== state) throw new Error(`${op} refusal reported ${reply.state}, expected ${state}`);
    return reply;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

let failed;
try {
    // Pair a device: the grant verifies against the service's own signing key.
    const deviceId = 'dev_smoke';
    const deviceKey = generateKeyPair();
    const enrolled = await ok('device.enroll', { deviceId, devicePublicKey: deviceKey.publicKey });
    const grant = verifyDeviceGrant(enrolled.grant, { pinnedMachineSigningPublicKey: enrolled.signingPublicKey, deviceKey, deviceId });
    const keys = deriveBrowserSessionKeys(grant);
    const sender = newV2SenderState();
    const replay = newV2ReplayTracker();
    const signal = async (session, generation, message) => {
        const scope = { serviceId: enrolled.serviceId, deviceId, session, generation, keyVersion: grant.keyVersion };
        const sealed = sealBrowserSessionMessage(message, keys, scope, 'device->service', sender);
        const reply = await ok('session.signal', { session, deviceId, generation, message: sealed });
        return openBrowserSessionMessage(reply.message, keys, scope, 'service->device', replay);
    };

    // Agent side.
    const { session } = await ok('session.open', { context: '/tmp/smoke' });
    assert(/^bsn_/.test(session), 'session handle shape');
    await refused('session.navigate', { session, url: 'javascript:alert(1)' });
    await refused('session.navigate', { session, url: 'data:text/html,hi' });
    await refused('session.navigate', { session, url: 'chrome://settings' });
    await refused('session.navigate', { session, url: 'file:///etc/passwd' });
    const navigated = await ok('session.navigate', { session, url: `${origin}/login` });
    assert(navigated.site === '127.0.0.1', 'site after navigation');
    const login = await ok('session.snapshot', { session });
    assert(login.text.includes('"Sign in"'), 'snapshot names the button');
    assert(!login.text.includes('hunter2'), 'snapshot never carries a password value');
    const passwordRef = Number(/\[(\d+)\] textbox "Password"/.exec(login.text)?.[1]);
    const emailRef = Number(/\[(\d+)\] textbox "Email"/.exec(login.text)?.[1]);
    assert(passwordRef > 0 && emailRef > 0, `snapshot refs:\n${login.text}`);
    await refused('session.fill', { session, target: passwordRef, text: 'nope' });
    await refused('session.fill', { session, target: 'input[name=otp]', text: '123456' });
    await ok('session.fill', { session, target: emailRef, text: 'owner@example.test' });
    await ok('session.scroll', { session, dy: 200 });
    await ok('session.click', { session, target: 'button' });

    // Take control on a page that still shows a sign-in field.
    let status = await ok('session.take', { session, deviceId, expectedGeneration: 1, command: 'cmd-take-1' });
    assert(status.state === 'taking-control' && status.generation === 2 && status.owner === 'self', `take: ${JSON.stringify(status)}`);
    const again = await ok('session.take', { session, deviceId, expectedGeneration: 1, command: 'cmd-take-1' });
    assert(again.generation === 2 && again.state === status.state, 'repeated take reconciles instead of replaying');
    await refused('session.take', { session, deviceId, expectedGeneration: 1, command: 'cmd-take-stale' }, 'taking-control');
    for (const [op, params] of [
        ['session.snapshot', {}], ['session.navigate', { url: origin }], ['session.click', { target: 'button' }],
        ['session.fill', { target: 'input[name=email]', text: 'x' }], ['session.scroll', { dy: 10 }], ['session.help', {}],
    ]) await refused(op, { session, ...params }, 'taking-control');
    const hello = await signal(session, 2, { type: 'hello', viewport: { width: 390, height: 700, scale: 3 } });
    assert(hello.type === 'status' && hello.viewport.scale === 2, 'hello caps device scale at 2');
    const presented = await signal(session, 2, { type: 'presented' });
    assert(presented.status.state === 'you-control', `presented: ${JSON.stringify(presented)}`);
    const beat = await signal(session, 2, { type: 'heartbeat' });
    assert(beat.status.state === 'you-control', 'heartbeat keeps the seat');
    await refused('session.snapshot', { session }, 'you-control');
    await refused('session.signal', { session, deviceId: 'dev_other', generation: 2, message: 'e2ee:v2:xx' });
    status = await ok('session.return', { session, deviceId, expectedGeneration: 2, command: 'cmd-return-1' });
    assert(status.state === 'paused' && /sign-in field/.test(status.reason ?? ''), `unsafe give back: ${JSON.stringify(status)}`);
    await refused('session.snapshot', { session }, 'paused');

    // Heartbeat loss while owned pauses without handing back.
    status = await ok('session.resume', { session, deviceId, expectedGeneration: 2, command: 'cmd-resume-1' });
    assert(status.state === 'taking-control' && status.generation === 3, `resume: ${JSON.stringify(status)}`);
    // The device sizes the tab and triggers capture with its hello; only then does a presented frame count.
    await signal(session, 3, { type: 'hello', viewport: { width: 390, height: 700, scale: 2 } });
    await signal(session, 3, { type: 'presented' });
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    status = await ok('session.status', { session, deviceId });
    assert(status.state === 'paused' && status.owner === 'self' && /stopped answering/.test(status.reason ?? ''), `missed heartbeats: ${JSON.stringify(status)}`);
    await ok('session.close', { session });

    // A safe page: give back reopens the agent under a new generation.
    const second = (await ok('session.open', { context: '/tmp/smoke' })).session;
    await ok('session.navigate', { session: second, url: origin });
    const home = await ok('session.snapshot', { session: second });
    assert(home.text.includes('"Welcome"') && home.text.includes('[') && !home.text.includes('hunter2'), 'home snapshot lists roles and no secret values');
    status = await ok('session.take', { session: second, deviceId, expectedGeneration: 1, command: 'cmd-take-2' });
    assert(status.state === 'taking-control', `take on safe page: ${JSON.stringify(status)}`);
    await signal(second, 2, { type: 'hello', viewport: { width: 390, height: 700, scale: 2 } });
    await signal(second, 2, { type: 'presented' });
    await refused('session.snapshot', { session: second }, 'you-control');
    status = await ok('session.return', { session: second, deviceId, expectedGeneration: 2, command: 'cmd-return-2' });
    assert(status.state === 'agent-driving' && status.generation === 3 && status.owner === 'agent', `give back: ${JSON.stringify(status)}`);
    const after = await ok('session.snapshot', { session: second });
    assert(after.text.includes('"Continue"'), 'agent continues in the same context');
    // Watching while the agent drives is allowed for the owner; a message that does not open is still refused.
    await refused('session.signal', { session: second, deviceId, generation: 3, message: 'e2ee:v2:xx' });
    status = await ok('session.help', { session: second });
    assert(status.state === 'waiting-for-you', 'help enters waiting-for-you');
    await refused('session.snapshot', { session: second }, 'waiting-for-you');
    await ok('session.close', { second, session: second });
    process.stdout.write('browser session smoke: ok\n');
} catch (error) {
    failed = error;
} finally {
    socket.end();
    fixture.close();
    service.kill('SIGTERM');
    await new Promise((resolve) => { service.once('exit', resolve); setTimeout(resolve, 5_000); });
    rmSync(dir, { recursive: true, force: true });
}
if (failed) {
    process.stderr.write(`browser session smoke: ${failed.message}\n`);
    process.exit(1);
}
