#!/usr/bin/env node
/**
 * Lab for `features/host-shell-process-group.md`.
 *
 * Drives a real `machine.shell` request over a private fake-Herdr stack: the
 * command backgrounds a child that inherits the request's stdout pipe. With a
 * process-group kill the reply returns promptly and the child is gone; on the
 * pre-fix host the reply hangs on the 60 s timeout and the child is orphaned.
 *
 * Usage (from the repo root, after `yarn build`):
 *   node .agents/skills/verify-pockit/features/hostShellGroupLab.mjs
 * Exit 0 prints PASS with the reply time; nonzero explains what leaked.
 */
import { createConnection } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceLink, pairWithOffer } from '@byokit/pair';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label} timed out`); })]);

const online = async (link, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (link.status === 'online') return;
        if (link.status === 'removed' || link.status === 'refused') throw new Error(`device ${link.status}`);
        await sleep(20);
    }
    throw new Error('device did not come online');
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
        const claim = await deadline(pairWithOffer(text, { name: 'Shell phone', onWords: () => undefined }), 30_000, 'lab consent');
        const pairing = new DeviceLink(claim);
        await online(pairing, 30_000);
        const details = await pairing.request('pair.complete', { deviceName: 'Shell phone' }, { timeoutMs: 30_000 });
        const grant = { ...claim, host: details.machineBoxPublicKey, urls: [details.linkUrl], device: { ...claim.device, id: details.deviceId, role: details.authority } };
        const link = new DeviceLink(grant);
        await online(link, 30_000);
        await pairing.request('pair.verified', {}, { timeoutMs: 30_000 });
        pairing.stop();
        return link;
    } finally {
        socket.destroy();
    }
}

const processAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

const work = mkdtempSync(join(tmpdir(), 'muxr-shell-group-'));
const pidFile = join(work, 'child.pid');
// Absolute interpreter: a mise shim uses argv[0] to pick its tool and does not
// survive being backgrounded, so the payload must name the real binary.
writeFileSync(join(work, 'bg.sh'), '/usr/bin/python3 -c "import time; a=bytearray(64*1024*1024); a[0]=1; time.sleep(600)" &\necho $! > child.pid\necho started\n');

let stack;
let failed = false;
try {
    stack = await startFakeStack({ panes: 4, agents: 2, transport: 'loopback' });
    let link;
    for (let attempt = 0; attempt < 8 && link === undefined; attempt++) {
        try { link = await pair(stack); } catch { await sleep(1500); }
    }
    if (link === undefined) throw new Error('could not pair with the lab host');

    const started = Date.now();
    const frame = await link.request('machine.shell', {
        type: 'machine.shell', requestId: 'shell-group', params: { command: 'sh ./bg.sh', cwd: work },
    }, { timeoutMs: 25_000 });
    const elapsed = Date.now() - started;
    const stdout = String(frame?.data?.stdout ?? frame?.stdout ?? '');
    if (!stdout.includes('started')) throw new Error(`machine.shell did not run the command: ${JSON.stringify(frame)}`);
    if (elapsed > 8_000) throw new Error(`machine.shell reply took ${elapsed} ms; the orphan held the pipe to the timeout`);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('the command did not record its backgrounded child');
    await sleep(500);
    if (processAlive(pid)) throw new Error(`backgrounded child ${pid} survived the request`);
    console.log(`PASS machine.shell replied in ${elapsed} ms and reaped backgrounded child ${pid}`);
} catch (error) {
    failed = true;
    console.error(`FAIL ${error?.message ?? error}`);
} finally {
    try {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) process.kill(pid, 'SIGKILL');
    } catch { /* no child was recorded */ }
    stack?.stop();
    rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
