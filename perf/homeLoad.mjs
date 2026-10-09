#!/usr/bin/env node
/**
 * Home on a busy host: what phones sitting on Home cost the host, and whether
 * the link stays usable. Real relay/host/link, fake Herdr at the given size.
 *
 * Each simulated phone does what the app's Home does today: a herdr.tree poll
 * every 5 s, five Live tiles reading their pane every 3 s, one controlled
 * terminal, and a fresh dial (open + machine.hello) every 20 s, which is what a
 * phone coming back from the background pays.
 *
 *   node perf/homeLoad.mjs --minutes 5 --phones 2 --panes 120 --agents 80 --out report.json
 */
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DeviceLink, pairWithOffer } from '@byokit/link';
import { startFakeStack } from './lib/fakeStack.mjs';
import { treeRssKb } from './lib/hostSignals.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const minutes = Number(flag('--minutes', '5'));
const phones = Number(flag('--phones', '2'));
const panes = Number(flag('--panes', '120'));
const agents = Number(flag('--agents', '80'));
const out = flag('--out', '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = (promise, ms, label) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${label} timed out`); })]);
const cpuTicks = (pid) => {
    try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); } catch { return NaN; }
};
const rssKb = (pid) => { try { return Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4; } catch { return NaN; } };
const online = async (link, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (link.status === 'online') return;
        if (link.status === 'removed' || link.status === 'refused') throw new Error(`device ${link.status}`);
        await sleep(20);
    }
    throw new Error('not online');
};

async function pair(stack) {
    const path = `${stack.root}/muxr/host/pair.sock`;
    for (let i = 0; i < 150 && !existsSync(path); i++) await sleep(100);
    const socket = createConnection(path);
    let pending = '';
    let claimed = false;
    const offer = new Promise((resolve, reject) => {
        socket.on('error', reject);
        socket.on('data', (chunk) => {
            pending += String(chunk);
            for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
                const line = JSON.parse(pending.slice(0, end));
                pending = pending.slice(end + 1);
                if (line.offer) resolve(line.offer.text);
                if (line.approval && claimed) socket.write('{"yes":true}\n');
                if (line.error) reject(new Error(line.error));
            }
        });
    });
    socket.on('connect', () => socket.write('{"intent":{"kind":"native","authority":"control","personal":false}}\n'));
    try {
        const text = await deadline(offer, 30_000, 'lab offer');
        claimed = true;
        const claim = await deadline(pairWithOffer(text, { name: 'Load phone', onWords: () => undefined }), 30_000, 'lab consent');
        const pairing = new DeviceLink(claim);
        await online(pairing, 30_000);
        const details = await pairing.request('pair.complete', { deviceName: 'Load phone' }, { timeoutMs: 30_000 });
        const grant = { ...claim, host: details.machineBoxPublicKey, urls: [details.linkUrl], device: { ...claim.device, id: details.deviceId, role: details.authority } };
        const link = new DeviceLink(grant);
        await online(link, 30_000);
        await pairing.request('pair.verified', {}, { timeoutMs: 30_000 });
        pairing.stop();
        return { grant, link };
    } finally { socket.destroy(); }
}

const report = { startedAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    minutes, phones, panes, agents, loadavgStart: readFileSync('/proc/loadavg', 'utf8').trim(), requests: {}, dials: [], dialFailures: 0,
    linkOffline: 0, streamEnds: 0, frames: 0, samples: [] };
const note = (type, ms, ok, error) => {
    const r = report.requests[type] ??= { ok: 0, failed: 0, ms: [], errors: {} };
    if (ok) { r.ok++; r.ms.push(ms); } else { r.failed++; r.errors[error] = (r.errors[error] ?? 0) + 1; }
};
const timed = (link, type, params) => {
    const at = Date.now();
    return link.request(type, { type, requestId: `${type}-${at}-${Math.random()}`, params }, { timeoutMs: 20_000 })
        .then((frame) => note(type, Date.now() - at, frame?.ok !== false, frame?.error), (error) => note(type, Date.now() - at, false, error?.message ?? String(error)));
};

let stack;
const stops = [];
try {
    stack = await startFakeStack({ panes, agents, titleChurnHz: 2, terminalBytesPerSecond: 4096, transport: 'loopback' });
    const phonesUp = [];
    for (let p = 0; p < phones; p++) {
        for (let attempt = 0; ; attempt++) {
            try { phonesUp.push(await pair(stack)); break; } catch (error) {
                if (attempt > 20 || !/another pairing/.test(String(error?.message))) throw error;
                await sleep(1_000);
            }
        }
    }
    const listed = await phonesUp[0].link.request('session.list', { type: 'session.list', requestId: 'list', params: {} }, { timeoutMs: 30_000 });
    const sessions = listed.data;
    const end = Date.now() + minutes * 60_000;
    for (const [p, { grant, link }] of phonesUp.entries()) {
        let last = link.status;
        stops.push(setInterval(() => { if (link.status !== last) { if (link.status === 'offline') report.linkOffline++; last = link.status; } }, 50));
        stops.push(setInterval(() => void timed(link, 'herdr.tree', {}), 5_000));
        for (let t = 0; t < 5; t++) {
            const sessionId = sessions[(p * 5 + t) % sessions.length].id;
            stops.push(setInterval(() => void timed(link, 'pane.read', { sessionId, source: 'visible' }), 3_000));
        }
        const stream = await link.stream('terminal', { requestId: `term-${p}`, sessionId: sessions[p].id, channel: `tm_${p}_${Date.now()}`, cols: 81, rows: 40, mode: 'control' });
        stream.onData = () => { report.frames++; };
        stream.onEnd = () => { report.streamEnds++; };
        stops.push({ end: () => stream.end() });
        const dial = async () => {
            const at = Date.now();
            const fresh = new DeviceLink(grant);
            try {
                await online(fresh, 20_000);
                const open = Date.now() - at;
                const helloAt = Date.now();
                await fresh.request('machine.hello', { type: 'machine.hello', requestId: `hello-${at}`, params: {} }, { timeoutMs: 20_000 });
                report.dials.push({ open, hello: Date.now() - helloAt });
            } catch (error) { report.dialFailures++; report.dials.push({ failed: error?.message ?? String(error), after: Date.now() - at }); } finally { fresh.stop(); }
        };
        stops.push(setInterval(() => void dial(), 20_000));
    }
    const started = Date.now();
    while (Date.now() < end) {
        report.samples.push({ s: Math.round((Date.now() - started) / 1000), hostRssKb: rssKb(stack.pids.host), hostTreeRssKb: treeRssKb(stack.pids.host), relayRssKb: rssKb(stack.pids.relay), hostTicks: cpuTicks(stack.pids.host), relayTicks: cpuTicks(stack.pids.relay), load: Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) });
        await sleep(5_000);
    }
    await sleep(21_000); // let in-flight requests settle or time out
} catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
} finally {
    for (const s of stops) s.end ? s.end() : clearInterval(s);
    report.childHealth = stack?.childHealth();
    stack?.stop();
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null; };
for (const r of Object.values(report.requests)) { r.p50 = pct(r.ms, .5); r.p95 = pct(r.ms, .95); r.max = pct(r.ms, 1); delete r.ms; }
const opens = report.dials.filter((d) => d.open !== undefined);
report.dial = { attempts: report.dials.length, failed: report.dialFailures, openP50: pct(opens.map((d) => d.open), .5), openP95: pct(opens.map((d) => d.open), .95), openMax: pct(opens.map((d) => d.open), 1), helloP95: pct(opens.map((d) => d.hello), .95) };
const s = report.samples;
if (s.length > 1) {
    const secs = s.at(-1).s - s[0].s;
    report.hostCpuPercent = Math.round((s.at(-1).hostTicks - s[0].hostTicks) / secs);
    report.relayCpuPercent = Math.round((s.at(-1).relayTicks - s[0].relayTicks) / secs);
    report.hostRssMaxKb = Math.max(...s.map((x) => x.hostRssKb));
    report.hostTreeRssMaxKb = Math.max(...s.map((x) => x.hostTreeRssKb));
    report.loadavgMean = Math.round(s.reduce((a, x) => a + x.load, 0) / s.length);
}
report.finishedAt = new Date().toISOString();
const { samples, dials, ...summary } = report;
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
