#!/usr/bin/env node
/** Real host/relay flow: quiet herd, client-local replay, and live artifact/lifecycle updates. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { DeviceLink, pairWithOffer } from '@byokit/pair';
import { startFakeStack } from './lib/fakeStack.mjs';
import { CommandScope, useCommandScope } from './lib/commands.mjs';

const outAt = process.argv.indexOf('--out');
const out = outAt < 0 ? undefined : process.argv[outAt + 1];
if (!out || out.startsWith('--')) throw Error('usage: node perf/artifactReplay.mjs --out REPORT.json');
const sourceAt = process.argv.indexOf('--source-root');
const sourceRoot = sourceAt < 0 ? '.' : process.argv[sourceAt + 1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (ready, label) => {
    for (let i = 0; i < 600; i++) { if (ready()) return; await sleep(100); }
    throw Error(`${label} timed out`);
};
const frames = events => Object.fromEntries([...new Set(events.map(type))].map(key => [key, events.filter(event => type(event) === key).length]));
const type = frame => frame.type === 'session.event' ? `session.event/${frame.event.type}` : frame.type;
const request = (link, type, params = {}) => link.request(type, { type, requestId: `${type}-${Date.now()}`, params }, { timeoutMs: 30_000 });
const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), panes: 300 };
let stack;
const scope = new CommandScope();
useCommandScope(scope);
const links = [];
async function pair(events) {
    const offer = await stack.mintPairing();
    let pending;
    try {
        const claim = await pairWithOffer(offer.code, { name: 'Umer', onWords: () => {} });
        pending = new DeviceLink(claim);
        await until(() => pending.status === 'online', 'pending link');
        const details = await pending.request('pair.complete', { deviceName: 'Umer' }, { timeoutMs: 30_000 });
        const grant = { ...claim, host: details.machineBoxPublicKey, urls: [details.linkUrl],
            device: { ...claim.device, id: details.deviceId, role: details.authority } };
        const link = new DeviceLink(grant, { onEvent: event => events.push(event) });
        links.push(link);
        await until(() => link.status === 'online', 'paired link');
        await pending.request('pair.verified', {}, { timeoutMs: 30_000 });
        return { link, grant };
    } finally { pending?.stop(); offer.release(); }
}
async function herdr(method, params) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(`${stack.root}/herdr/herdr.sock`);
        let buffer = '';
        socket.setTimeout(10_000, () => socket.destroy(Error('fixture RPC timed out')));
        socket.on('error', reject);
        socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
        socket.on('data', data => {
            buffer += data;
            if (!buffer.includes('\n')) return;
            socket.destroy();
            const reply = JSON.parse(buffer.split('\n')[0]);
            if (reply.error) reject(Error(reply.error.message)); else resolve(reply.result);
        });
    });
}
try {
    stack = await startFakeStack({ sourceRoot, panes: 300, agents: 150, titleChurnHz: 0, transport: 'loopback' });
    report.sourceRoot = sourceRoot;
    report.pids = { ...stack.pids, herdr: stack.herdrPid };
    report.relayPort = stack.relayPort;
    await until(() => stack.hostLog().includes('link relay: online'), 'host relay ready');
    report.health = await (await fetch(`http://127.0.0.1:${stack.relayPort}/health`)).json();
    const firstEvents = [];
    const first = await pair(firstEvents);
    await request(first.link, 'machine.hello');
    await sleep(1000);
    firstEvents.length = 0;
    const started = Date.now();
    await sleep(30_000);
    report.idle = { seconds: (Date.now() - started) / 1000, counts: frames(firstEvents) };
    assert.deepEqual(report.idle.counts, {}, 'unchanged herd must be silent');

    const pane = stack.world.agents[0].pane_id;
    const file = `${stack.root}/verify.txt`;
    writeFileSync(file, 'Umer artifact replay proof\n');
    report.share = execFileSync(process.execPath, ['scripts/cli.mjs', 'share', file, '--pane', pane], {
        encoding: 'utf8', env: { ...process.env, MUXR_HOME: `${stack.root}/muxr` },
    }).trim();
    assert.equal(readFileSync(`${stack.root}/muxr/attachments/pane/${pane}/verify.txt`, 'utf8'), readFileSync(file, 'utf8'));
    await until(() => firstEvents.some(event => event.event?.artifacts?.some(entry => entry.name === 'verify.txt')), 'live artifact');
    const listed = await request(first.link, 'session.list');
    const sessionId = listed.data.find(session => session.paneId === pane).id;
    await request(first.link, 'unread.acknowledge', { sessionId });
    firstEvents.length = 0;
    const secondEvents = [];
    const second = await pair(secondEvents);
    await request(second.link, 'machine.hello');
    await sleep(1000);
    report.join = { existing: frames(firstEvents), joining: frames(secondEvents) };
    assert.deepEqual(report.join.existing, {}, 'joining client must not wake an existing client');
    assert.equal(report.join.joining['session.event/artifacts.update'], 300);
    assert.equal(report.join.joining['session.event/attachments.update'] ?? 0, 0);
    assert.equal(report.join.joining['plugins.invalidated'], 1);
    assert(secondEvents.some(event => event.event?.artifacts?.some(entry => entry.name === 'verify.txt')));
    const unread = await request(first.link, 'unread.catalog');
    assert(!unread.data.entries.some(entry => entry.sessionId === sessionId), 'replay must not invent unread activity');

    second.link.stop();
    firstEvents.length = 0; secondEvents.length = 0;
    const returning = new DeviceLink(second.grant, { onEvent: event => secondEvents.push(event) });
    links.push(returning);
    await until(() => returning.status === 'online', 'returning client');
    await request(returning, 'machine.hello');
    await sleep(1000);
    report.reconnect = { existing: frames(firstEvents), returning: frames(secondEvents) };
    assert.deepEqual(report.reconnect.existing, {});
    assert.equal(report.reconnect.returning['session.event/artifacts.update'], 300);
    assert.equal(report.reconnect.returning['session.event/attachments.update'] ?? 0, 0);

    firstEvents.length = 0;
    const changeAt = Date.now();
    await herdr('lab.set_agent_status', { pane_id: pane, agent_status: 'failed', title: 'Umer replay validation' });
    await until(() => firstEvents.some(frame => frame.event?.session?.taskTitle === 'Umer replay validation'), 'live task title');
    const updated = firstEvents.find(frame => frame.event?.session?.taskTitle === 'Umer replay validation');
    report.live = { milliseconds: Date.now() - changeAt, counts: frames(firstEvents), taskTitle: updated.event.session.taskTitle, agentStatus: updated.event.session.agentStatus };
    assert.equal(report.live.agentStatus, 'failed');
    assert(firstEvents.some(frame => frame.event?.type === 'lifecycle.update'));
    assert(firstEvents.some(frame => frame.event?.type === 'attention.update'));
    const changedUnread = await request(first.link, 'unread.catalog');
    assert(changedUnread.data.entries.some(entry => entry.sessionId === sessionId));
    report.outcome = 'pass';
} catch (error) {
    report.outcome = 'fail'; report.error = error.message; process.exitCode = 1;
} finally {
    for (const link of links) link.stop();
    try {
        // Reap our process groups before deleting state their exit handlers can write.
        await scope.close();
        scope.cleanup();
    } catch (error) { report.cleanupError = error.message; report.outcome = 'fail'; process.exitCode = 1; }
    report.children = stack?.childHealth();
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
process.exit(process.exitCode ?? 0);
