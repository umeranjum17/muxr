#!/usr/bin/env node
/** Long-running isolated host soak. No service commands, real relay/host/link, fake Herdr load. */
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DeviceLink, pairWithOffer } from '@byokit/link';
import { startFakeStack } from './lib/fakeStack.mjs';
import { LOAD } from './lib/scenario.mjs';
import { treeRssKb } from './lib/hostSignals.mjs';
import { countTerminalFrames } from './lib/terminalFrames.mjs';
import { hostSoakOutcome } from './lib/hostSoakVerdict.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const minutes = Number(flag('--minutes', '60'));
const out = flag('--out', '');
if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240 || args.length % 2 !== 0
    || args.some((arg, index) => index % 2 === 0 && !['--minutes', '--out'].includes(arg))) {
    throw new Error('usage: node perf/hostSoak.mjs [--minutes 1..240] [--out report.json]');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = async (promise, ms, label) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${label} timed out`); })]);
const processRssKb = (pid) => {
    try { return Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4; }
    catch { return NaN; }
};
const cpuTicks = (pid) => {
    try {
        const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
        return Number(fields[11]) + Number(fields[12]);
    } catch { return NaN; }
};
const online = async (link) => {
    for (let i = 0; i < 150; i++) {
        if (link.status === 'online') return;
        if (link.status === 'removed' || link.status === 'refused') throw new Error(`device ${link.status}`);
        await sleep(100);
    }
    throw new Error('device did not reconnect');
};

// The only consent here is from this process to the throwaway host it started.
async function pairLab(stack) {
    const path = `${stack.root}/muxr/host/pair.sock`;
    for (let i = 0; i < 150 && !existsSync(path); i++) await sleep(100);
    if (!existsSync(path)) throw new Error('lab host pairing socket did not start');
    const socket = createConnection(path);
    let pending = '';
    let reply;
    const offer = new Promise((resolve, reject) => {
        socket.on('error', reject);
        socket.on('data', (chunk) => {
            pending += String(chunk);
            for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
                const line = JSON.parse(pending.slice(0, end));
                pending = pending.slice(end + 1);
                if (line.offer) resolve(line.offer.text);
                if (line.approval) {
                    if (reply === undefined) { reject(new Error('unexpected pairing approval')); return; }
                    socket.write(JSON.stringify({ yes: true }) + '\n');
                }
                if (line.error) reject(new Error(line.error));
            }
        });
    });
    socket.on('connect', () => socket.write('{"intent":{"kind":"native","authority":"control","personal":false}}\n'));
    try {
        report.stage = 'claiming lab offer';
        const text = await deadline(offer, 15000, 'lab offer');
        reply = pairWithOffer(text, { name: 'Host soak phone', onWords: () => undefined });
        const claim = await deadline(reply, 15000, 'lab consent');
        report.stage = 'completing pairing';
        const pairing = new DeviceLink(claim);
        await online(pairing);
        const details = await pairing.request('pair.complete', { deviceName: 'Host soak phone' }, { timeoutMs: 15000 });
        const grant = { ...claim, host: details.machineBoxPublicKey, urls: [details.linkUrl], device: { ...claim.device, id: details.deviceId, role: details.authority } };
        report.stage = 'proving machine link';
        const link = new DeviceLink(grant);
        await online(link);
        await pairing.request('pair.verified', {}, { timeoutMs: 10000 });
        pairing.stop();
        return { grant, link };
    } finally { socket.destroy(); }
}

let stack;
let link;
let grant;
const streams = [];
const deliberateEnds = new WeakSet();
const report = { startedAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), minutes, load: LOAD, samples: [], reconnectMs: [], terminalFrames: 0, unexpectedStreamEnds: 0, outcome: 'inconclusive' };
try {
    stack = await startFakeStack({ ...LOAD, transport: 'loopback' });
    ({ link, grant } = await pairLab(stack));
    report.stage = 'listing sessions';
    const listed = await link.request('session.list', { type: 'session.list', requestId: 'soak-list', params: {} }, { timeoutMs: 15000 });
    if (!listed?.ok) throw new Error(`session.list failed: ${listed?.error ?? 'empty response'}`);
    const sessions = listed.data;
    if (!Array.isArray(sessions) || sessions.length < 16) throw new Error(`expected 16 host sessions, got ${sessions?.length}`);
    const paneSessions = sessions.slice(0, 16);
    const open = async () => {
        for (const [index, session] of paneSessions.entries()) {
            const channel = `tm_s${index}_${Date.now()}`;
            const stream = await link.stream('terminal', { requestId: `soak-${index}`, sessionId: session.id, channel, cols: 80, rows: 24, mode: 'observe' });
            // One reader never takes its first chunk. The other fifteen stay
            // live, proving slow-device credit cannot grow the host write tail.
            stream.onData = index === 0 ? () => new Promise(() => {}) : countTerminalFrames(() => { report.terminalFrames += 1; });
            stream.onEnd = (error) => {
                if (deliberateEnds.has(stream)) return;
                report.unexpectedStreamEnds += 1;
                report.streamEnds ??= [];
                if (report.streamEnds.length < 5) report.streamEnds.push(error ?? 'clean');
            };
            streams.push(stream);
        }
    };
    await open();
    const started = Date.now();
    const end = started + minutes * 60000;
    let lastReconnect = started;
    while (Date.now() < end) {
        const ticks = cpuTicks(stack.pids.host);
        report.samples.push({ elapsedSeconds: Math.round((Date.now() - started) / 1000), hostProcessRssKb: processRssKb(stack.pids.host), hostTreeRssKb: treeRssKb(stack.pids.host), relayRssKb: treeRssKb(stack.pids.relay), hostCpuTicks: ticks, frames: report.terminalFrames });
        if (Date.now() - lastReconnect >= 60000) {
            for (const stream of streams.splice(0)) { deliberateEnds.add(stream); stream.end(); }
            link.stop();
            const at = Date.now();
            link = new DeviceLink(grant);
            await online(link);
            report.reconnectMs.push(Date.now() - at);
            await open();
            lastReconnect = Date.now();
        }
        await sleep(5000);
    }
    const samples = report.samples;
    const settled = samples.filter((sample) => sample.elapsedSeconds >= 60);
    const head = settled.slice(0, Math.max(1, Math.floor(settled.length / 5)));
    const tail = settled.slice(-Math.max(1, Math.floor(settled.length / 5)));
    const mean = (part, key) => Math.round(part.reduce((sum, sample) => sum + sample[key], 0) / part.length);
    report.hostRssDriftKb = settled.length ? mean(tail, 'hostProcessRssKb') - mean(head, 'hostProcessRssKb') : null;
    const reconnects = [...report.reconnectMs].sort((a, b) => a - b);
    report.connectMs = reconnects.length ? { median: reconnects[Math.floor(reconnects.length / 2)], p95: reconnects[Math.ceil(reconnects.length * .95) - 1] } : null;
    report.peakHostTreeRssKb = Math.max(...samples.map((sample) => sample.hostTreeRssKb));
    report.hostCpuPercent = samples.length > 1 ? Math.round((samples.at(-1).hostCpuTicks - samples[0].hostCpuTicks) / (samples.at(-1).elapsedSeconds - samples[0].elapsedSeconds)) : null;
    report.outcome = hostSoakOutcome(report, settled.length, stack.childHealth());
} catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.outcome = 'failed';
} finally {
    report.finishedAt = new Date().toISOString();
    for (const stream of streams) { deliberateEnds.add(stream); stream.end(); }
    link?.stop();
    stack?.stop();
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
}
if (report.outcome === 'failed' || minutes >= 15 && report.outcome !== 'pass') process.exitCode = 1;
