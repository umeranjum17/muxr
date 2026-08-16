/**
 * e2e: worktree sessions, the parallel-agents unlock.
 *
 * Spawns its own relay + host against the live herdr server, starts a session
 * with worktree:true inside a throwaway git repo, and proves the agent lands in
 * herdr's worktree checkout (not the repo root), then stops it.
 */
import WebSocket from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { encodePayload, decodePayload, nextRequestId } from '@muxr/contract';
import { waitForRelay } from './waitForRelay.mjs';

const repo = mkdtempSync(join(tmpdir(), 'pph-wt-repo-'));
const branch = `pph-e2e-${process.pid}`;
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

const PORT = String(8940 + Math.floor(Math.random() * 40));
const machineId = `wt-check-${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-wt-'));
const children = [];
const env = { ...process.env };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_E2EE_SHARED_KEY', 'MUXR_RELAY_AUTH']) {
    delete env[key];
}
Object.assign(env, {
    MUXR_MODE: 'local',
    MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT,
    MUXR_RELAY_URL: `ws://127.0.0.1:${PORT}`,
    MUXR_MACHINE_ID: machineId,
    MUXR_DATA_DIR: dataDir,
    MUXR_RELAY_DATA_DIR: join(dataDir, 'relay'),
});
const start = (name, args) => {
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`      [${name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`      [${name}] ${d}`));
    children.push(child);
};

let ws;
let createdWorkspaceId;
let createdCheckoutRoot;
let finishing = false;
let seq = 0;
const pending = new Map();
const send = (frame) => {
    seq++;
    ws.send(JSON.stringify({ header: { machineId, seq, at: Date.now() }, payload: encodePayload(frame) }));
};
const request = (type, params) =>
    new Promise((res, rej) => {
        const requestId = nextRequestId();
        pending.set(requestId, { res, rej });
        send({ type, requestId, params });
        setTimeout(() => rej(new Error('timeout ' + type)), 60000);
    });

const done = (code, msg) => {
    if (finishing) return;
    finishing = true;
    console.log(msg);
    for (const child of children) child.kill();
    const herdr = process.env.HERDR_BIN || 'herdr';
    if (createdWorkspaceId !== undefined) {
        try {
            execFileSync(herdr, ['worktree', 'remove', '--workspace', createdWorkspaceId, '--force'], { stdio: 'ignore' });
        } catch {
            try {
                execFileSync(herdr, ['workspace', 'close', createdWorkspaceId], { stdio: 'ignore' });
            } catch { /* best effort after a failed live server */ }
        }
    }
    // worktree.create may also register the source repository as a workspace.
    // It is not the returned checkout workspace, so remove it separately.
    try {
        const listed = JSON.parse(execFileSync(herdr, ['workspace', 'list'], { encoding: 'utf8' }));
        const workspaces = listed?.result?.workspaces ?? [];
        for (const workspace of workspaces) {
            if (workspace?.worktree?.checkout_path === repo && typeof workspace.workspace_id === 'string') {
                execFileSync(herdr, ['workspace', 'close', workspace.workspace_id], { stdio: 'ignore' });
            }
        }
    } catch { /* best effort after a failed live server */ }
    if (createdCheckoutRoot !== undefined) rmSync(createdCheckoutRoot, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(code);
};

process.once('SIGINT', () => done(130, 'INTERRUPTED e2e: worktree session'));
process.once('SIGTERM', () => done(143, 'TERMINATED e2e: worktree session'));

function onMessage(raw) {
    const f = decodePayload(JSON.parse(String(raw)).payload);
    if (f.type === 'result') {
        const p = pending.get(f.requestId);
        if (p) {
            pending.delete(f.requestId);
            f.ok ? p.res(f.data) : p.rej(new Error(f.error));
        }
    }
}

start('relay', ['apps/relay/dist/main.js']);
await waitForRelay(Number(PORT));
start('host', ['apps/host/dist/main.js']);
await new Promise((r) => setTimeout(r, 1500));

ws = new WebSocket(`ws://127.0.0.1:${PORT}?role=client&machineId=${machineId}`);
ws.on('message', onMessage);
ws.on('open', async () => {
    try {
        send({ type: 'client.hello', clientId: 'wt-e2e' });
        const snap = await request('session.start', {
            cwd: repo,
            kind: 'pi',
            label: 'wt-test',
            worktree: { branch },
        });
        const id = snap?.info?.id;
        createdWorkspaceId = snap?.info?.workspaceId;
        const startCwd = snap?.info?.cwd;
        if (typeof startCwd === 'string') createdCheckoutRoot = dirname(startCwd);
        if (typeof startCwd !== 'string' || !startCwd.includes(branch)) {
            done(1, `FAIL: session cwd is not the worktree checkout: ${startCwd}`);
        }
        console.log(`ok: session.start cwd = ${startCwd}`);
        await new Promise((r) => setTimeout(r, 20000));
        const list = await request('session.list', {});
        const mine = list.find((s) => s.id === id);
        if (mine?.cwd !== startCwd) done(1, `FAIL: detected cwd drifted: ${mine?.cwd}`);
        console.log(`ok: herdr detected the agent inside the worktree (${mine.paneId})`);
        await request('session.stop', { sessionId: id });
        done(0, 'PASS e2e: worktree session');
    } catch (e) {
        done(1, `FAIL: ${e.message}`);
    }
});
