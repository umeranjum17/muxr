/**
 * A starved computer comes back by itself (18 Oct: the whole session froze for
 * over five minutes, then resumed with nothing done on the computer).
 * Real lab Herdr, relay and host, and a paired byokit device link:
 *  1. Herdr alone stops answering: the host journals the stall and the recovery.
 *  2. Herdr, host and relay freeze together: the link reopens and a terminal
 *     attaches again with no step but probing.
 * Every PID signalled here is one this run started.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextRequestId, newTerminalChannel } from '@trymuxr/contract';
import { linkHerdrLab } from './linkHerdrLab.mjs';
import { requestLab } from './linkLabClient.mjs';

const FREEZE_MS = 60_000;
const STALL_MS = 20_000;
const RECOVER_MS = 10_000;

const root = mkdtempSync(join(tmpdir(), 'muxr-herdr-stall-'));
const workdir = join(root, 'cwd');
mkdirSync(workdir);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frozen = new Set();
let lab;

async function until(check, label, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function freeze(pids) {
    for (const pid of pids) { process.kill(pid, 'SIGSTOP'); frozen.add(pid); }
}

function thaw() {
    for (const pid of frozen) { try { process.kill(pid, 'SIGCONT'); } catch { /* already gone */ } }
    frozen.clear();
}

/** The lab server is whoever listens on this run's own lab socket. */
function herdrServerPid(socket) {
    const row = execFileSync('ss', ['-xlpn'], { encoding: 'utf8' }).split('\n').find((line) => line.includes(` ${socket} `));
    const pid = Number(row?.match(/pid=(\d+)/)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no listener on the lab Herdr socket ${socket}`);
    return pid;
}

/** One terminal attach, resolved with true once the host answers it ok. */
async function attach(sessionId, timeoutMs = RECOVER_MS) {
    const stream = await lab.link.stream('terminal', { sessionId, channel: newTerminalChannel(), requestId: nextRequestId('lab'), cols: 80, rows: 24 });
    try {
        return await new Promise((resolve) => {
            let partial = '';
            const decoder = new TextDecoder();
            stream.onData = (bytes) => {
                partial += decoder.decode(bytes, { stream: true });
                const lines = partial.split('\n');
                partial = lines.pop() ?? '';
                for (const line of lines) {
                    const frame = JSON.parse(line);
                    if (frame.type === 'result') resolve(frame.ok === true);
                }
            };
            setTimeout(() => resolve(false), timeoutMs);
        });
    } finally {
        try { stream.end(); } catch { /* the host already closed it */ }
    }
}

try {
    lab = await linkHerdrLab(root, 'herdr-stall');
    const socket = JSON.parse(lab.herdr(['status', '--json'])).server.socket;
    const shell = await requestLab(lab.link, 'session.start', { cwd: workdir, kind: 'shell', label: 'stall-e2e' });
    const sessionId = shell.info.id;
    if (!await attach(sessionId)) throw new Error('baseline terminal attach failed');
    process.stdout.write('ok: baseline attach\n');

    // 1. Herdr alone: its socket stays open, so the kit liveness state must
    // make the existing tree report the runtime unavailable without an attach.
    freeze([herdrServerPid(socket)]);
    await until(async () => (await requestLab(lab.link, 'herdr.tree')).connected === false,
        'herdr.tree disconnected within 20s of Herdr stalling', STALL_MS);
    thaw();
    await until(async () => (await requestLab(lab.link, 'herdr.tree')).connected === true,
        'herdr.tree healthy after Herdr resumed', RECOVER_MS);
    if (!await attach(sessionId, RECOVER_MS)) throw new Error('attach failed within 10s after Herdr resumed');
    await until(() => lab.hostOutput().includes('herdr: answering again'), 'host journal: herdr answering again', RECOVER_MS);
    process.stdout.write('ok: host journals a stalled Herdr and its recovery\n');

    // 2. The whole session: longer than the link's two missed pings, so it drops.
    freeze([herdrServerPid(socket), ...lab.pids()]);
    await sleep(FREEZE_MS);
    if (lab.link.status === 'online') throw new Error('link stayed online through a frozen host; the freeze tested nothing');
    thaw();
    const resumed = Date.now();
    await until(() => lab.link.status === 'online', 'link online after the freeze', RECOVER_MS);
    await until(() => attach(sessionId), 'attach after the freeze', RECOVER_MS - (Date.now() - resumed));
    process.stdout.write(`ok: link and terminal back ${((Date.now() - resumed) / 1000).toFixed(1)}s after a ${FREEZE_MS / 1000}s freeze\n`);
    process.stdout.write('PASS e2e: a frozen computer comes back by itself\n');
} catch (error) {
    if (lab !== undefined) process.stderr.write(`host output:\n${lab.hostOutput().split('\n').slice(-30).join('\n')}\n`);
    throw error;
} finally {
    thaw();
    await lab?.stop();
    rmSync(root, { recursive: true, force: true });
}
