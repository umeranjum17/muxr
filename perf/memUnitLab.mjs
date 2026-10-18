#!/usr/bin/env node
/**
 * Lab driver for the muxr.service unit-memory investigation.
 *
 * Starts the real relay + host from this checkout against fake Herdr, pairs a
 * synthetic device, then drives one of the child-spawning paths the task names:
 *
 *   --mode grandchild   machine.shell commands that background a grandchild.
 *                       The pre-fix host leaked it (execFile killed only the
 *                       direct child); the fixed host reaps the process group.
 *   --mode terminal     repeated terminal attach/detach churn
 *   --mode home         Home traffic (tree poll + Live tiles + dials)
 *
 * It writes an action log; sample the unit cgroup (memory and nprocs) while it
 * runs to see what the unit actually holds.
 */
import { createConnection } from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { DeviceLink, pairWithOffer } from '@byokit/pair';
import { startFakeStack } from './lib/fakeStack.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const mode = flag('--mode', 'grandchild');
const minutes = Number(flag('--minutes', '10'));
const panes = Number(flag('--panes', '60'));
const agents = Number(flag('--agents', '20'));
const intervalMs = Number(flag('--interval-ms', '4000'));
const perRound = Number(flag('--per-round', '1'));
const payloadMb = Number(flag('--payload-mb', '0'));
const control = flag('--control', '') !== '';
const logPath = flag('--log', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label} timed out`); })]);

const log = [];
const note = (line) => { log.push(`${new Date().toISOString()} ${line}`); console.log(line); };
const flush = () => { if (logPath) writeFileSync(logPath, log.join('\n') + '\n'); };

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
        const claim = await deadline(pairWithOffer(text, { name: 'Mem phone', onWords: () => undefined }), 30_000, 'lab consent');
        const pairing = new DeviceLink(claim);
        await online(pairing, 30_000);
        const details = await pairing.request('pair.complete', { deviceName: 'Mem phone' }, { timeoutMs: 30_000 });
        const grant = { ...claim, host: details.machineBoxPublicKey, urls: [details.linkUrl], device: { ...claim.device, id: details.deviceId, role: details.authority } };
        const link = new DeviceLink(grant);
        await online(link, 30_000);
        await pairing.request('pair.verified', {}, { timeoutMs: 30_000 });
        pairing.stop();
        return { grant, link };
    } finally { socket.destroy(); }
}
const online = async (link, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (link.status === 'online') return;
        if (link.status === 'removed' || link.status === 'refused') throw new Error(`device ${link.status}`);
        await sleep(20);
    }
    throw new Error('not online');
};

let stack;
try {
    stack = await startFakeStack({ panes, agents, titleChurnHz: 2, terminalBytesPerSecond: 4096, transport: 'loopback' });
    note(`stack up pids=${JSON.stringify(stack.pids)} herdr=${stack.herdrPid}`);
    // The host connects to the relay asynchronously after the stack is up; a
    // first pairing attempt can race that connect and be closed as unreachable.
    let paired;
    for (let attempt = 0; attempt < 8 && paired === undefined; attempt++) {
        try {
            paired = await pair(stack);
        } catch (e) {
            note(`pair attempt ${attempt} failed: ${e?.message ?? e}`);
            await sleep(1500);
        }
    }
    if (paired === undefined) throw new Error('could not pair after retries');
    const { grant, link } = paired;
    note('paired');
    const listed = await link.request('session.list', { type: 'session.list', requestId: 'list', params: {} }, { timeoutMs: 30_000 });
    const sessions = listed.data;

    const end = Date.now() + minutes * 60_000;
    if (mode === 'grandchild') {
        let round = 0;
        while (Date.now() < end) {
            for (let k = 0; k < perRound; k++) {
                const tag = `muxr-gc-${process.pid}-${round}-${k}`;
                // A login shell backgrounds a grandchild and exits; execFile kills
                // only the direct child, so the grandchild is orphaned and stays
                // charged to this cgroup. payloadMb > 0 makes the grandchild
                // allocate like a real dev server / build a phone shell started.
                const child = payloadMb > 0
                    ? `/usr/bin/python3 -c "import time; a=bytearray(${payloadMb}*1024*1024); a[0]=1; time.sleep(1800)" &`
                    : 'sleep 1800 &';
                const command = control
                    ? `echo control-${tag}`
                    : `sh -c '${child} echo started' ; echo ${tag}`;
                const at = Date.now();
                try {
                    const frame = await link.request('machine.shell', { type: 'machine.shell', requestId: tag, params: { command, cwd: '.' } }, { timeoutMs: 25_000 });
                    note(`shell ${tag} -> exit=${frame?.data?.exitCode ?? frame?.exitCode} ms=${Date.now() - at}`);
                } catch (e) { note(`shell ${tag} FAILED ${e?.message ?? e}`); }
            }
            round++;
            await sleep(intervalMs);
        }
    } else if (mode === 'terminal') {
        let round = 0;
        while (Date.now() < end) {
            const sessionId = sessions[round % sessions.length].id;
            try {
                const stream = await link.stream('terminal', { requestId: `term-${round}`, sessionId, channel: `ch_${round}_${Date.now()}`, cols: 81, rows: 40, mode: 'control' });
                let frames = 0;
                stream.onData = () => { frames++; };
                await sleep(1500);
                stream.end();
                note(`terminal ${round} attach+drain frames=${frames} then end`);
            } catch (e) { note(`terminal ${round} FAILED ${e?.message ?? e}`); }
            round++;
            await sleep(intervalMs);
        }
    } else if (mode === 'home') {
        const stops = [];
        stops.push(setInterval(() => void link.request('herdr.tree', { type: 'herdr.tree', requestId: `tree-${Date.now()}`, params: {} }, { timeoutMs: 20_000 }).catch(() => {}), 5_000));
        for (let t = 0; t < 5; t++) {
            const sessionId = sessions[t % sessions.length].id;
            stops.push(setInterval(() => void link.request('pane.read', { type: 'pane.read', requestId: `pr-${Date.now()}`, params: { sessionId, source: 'visible' } }, { timeoutMs: 20_000 }).catch(() => {}), 3_000));
        }
        stops.push(setInterval(() => { const fresh = new DeviceLink(grant); void online(fresh, 15_000).then(() => fresh.request('machine.hello', { type: 'machine.hello', requestId: `h-${Date.now()}`, params: {} }, { timeoutMs: 15_000 })).catch(() => {}).finally(() => fresh.stop()); }, 20_000));
        while (Date.now() < end) await sleep(5_000);
        for (const s of stops) clearInterval(s);
    }
    note('drive complete');
} catch (e) {
    note(`DRIVER ERROR ${e?.stack ?? e?.message ?? e}`);
} finally {
    flush();
    stack?.stop();
}
process.exit(0);
