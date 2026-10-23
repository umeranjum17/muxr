// Boat sign-in stand-in for the phone: byokit's fake Boat server behind a proxy on a fixed port,
// so a lab APK built with EXPO_PUBLIC_MUXR_BOAT_API=http://127.0.0.1:<port>/api/v1 can link an
// account with no real Boat claim. Token polls answer `authorization_pending` until the phone
// opens the sign-in page (the person approving); BOAT_LAB_APPROVE=never keeps them pending.
// Accepts the email umer@example.com and code 123456.
// BOAT_LAB_SSH=<root> also stands in for the new computer behind Boat (cloudMachineLab.mjs, under that root, with the
// Herdr lab session HERDR_LAB_HELPER/HERDR_LAB_SESSION): Boat's SSH key route lets the phone's key into its sshd and
// answers its loopback port (BOAT_LAB_SSH_PORT on stdout, for `adb reverse`), holds each set-up step BOAT_LAB_STEP_MS (8 s) so each is captured, and the app's `muxr self-host` and
// `muxr pair --handoff` run this checkout's CLI there; a configured machine starts `muxr up` as its service would.
// Usage: node boatSignInLab.mjs <port>
// (run from the repo root after `yarn install`) -> prints "boat lab listening on <port>".
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { startFakeSandboxServer } from '@byokit/cloud/testing';
import { MACHINE_USER, startCloudMachine } from './cloudMachineLab.mjs';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) throw new Error('usage: node boatSignInLab.mjs <port>');
// The machine API takes the key the sign-in hands out, so a linked lab account can create a computer.
const fake = await startFakeSandboxServer({ claimInterval: 2, key: 'boat-claimed-key' });
const fakeOrigin = new URL(fake.url).origin;
const ownOrigin = `http://127.0.0.1:${port}`;
let approved = false;

let cloud;
const commands = new Map();
let commandSeq = 900_000;
if (process.env.BOAT_LAB_SSH) {
    const helper = process.env.HERDR_LAB_HELPER;
    const session = process.env.HERDR_LAB_SESSION;
    if (!helper || !session) throw new Error('BOAT_LAB_SSH needs a provisioned Herdr lab: HERDR_LAB_HELPER and HERDR_LAB_SESSION');
    const socket = JSON.parse(execFileSync(helper, ['run', session, 'status', '--json'], { encoding: 'utf8' })).server.socket;
    cloud = await startCloudMachine(process.env.BOAT_LAB_SSH, { helper, session, socket });
    console.log(`BOAT_LAB_SSH_PORT=${cloud.sshPort} machine pid ${cloud.pid}`);
    // The kit reads the handoff's offer from, and delivers the words into, the fake machine; the real CLI uses its own work dir.
    const kitBox = '/home/user/muxr/.byokit';
    setInterval(() => {
        const outbox = join(cloud.workDir, '.byokit/outbox');
        const real = new Set();
        try {
            for (const name of readdirSync(outbox)) { real.add(name); fake.machine.writeFile(`${kitBox}/outbox/${name}`, readFileSync(join(outbox, name)), 0o600, 'user'); }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error; // no offer written yet
        }
        for (const path of [...fake.machine.files.keys()]) {
            if (path.startsWith(`${kitBox}/outbox/`) && !real.has(path.slice(kitBox.length + 8))) fake.machine.files.delete(path);
            if (!path.startsWith(`${kitBox}/inbox/`)) continue;
            mkdirSync(join(cloud.workDir, '.byokit/inbox'), { recursive: true, mode: 0o700 });
            writeFileSync(join(cloud.workDir, '.byokit/inbox', path.slice(kitBox.length + 7)), fake.machine.files.get(path).bytes, { mode: 0o600 });
            fake.machine.files.delete(path);
            console.log('words delivered to the machine');
        }
    }, 300).unref();
}

/** The app's own muxr command, as the kit quotes it: what follows the CLI path, unquoted. */
function muxrArgs(command) {
    const cli = "/npm/bin/muxr'";
    const at = command.indexOf(cli);
    if (at < 0) return undefined;
    return [...command.slice(at + cli.length).matchAll(/'((?:[^']|'\\'')*)'/g)].map(([, arg]) => arg.replaceAll("'\\''", "'"));
}

async function onMachine(args) {
    // Herdr is the lab's own; the real machine fetches the pinned one.
    const result = await cloud.muxr(args.filter((arg) => arg !== '--install-herdr'));
    console.log(`machine: muxr ${args[0]} ${args[1] ?? ''} exited ${result.code}`);
    if (args[0] === 'self-host' && result.code === 0) console.log(`machine: muxr up ${(await cloud.muxr(['up'], true)).stdout}`);
    return result;
}

createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const path = req.url ?? '/';
    console.log(`${req.method} ${path.split('?')[0]}`);
    if (req.method === 'GET' && path.startsWith('/api/boat/agent/identity/claim')) {
        approved = process.env.BOAT_LAB_APPROVE !== 'never';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:20px sans-serif;padding:24px">'
            + '<h1>Boat (lab)</h1><p>Code 123456 accepted. muxr can use your Boat account.</p><p>Go back to muxr.</p></body>');
        return;
    }
    if (req.method === 'POST' && path === '/api/boat/agent/identity') approved = false; // each new sign-in waits for its own approval
    // A real machine spends minutes on each set-up step; the stand-in holds each for a moment so every step is seen.
    const command = cloud && req.method === 'POST' && /\/commands$/.test(path) ? String(JSON.parse(body.toString()).command) : '';
    if (cloud && req.method === 'POST' && (path === '/api/v1/sandboxes' || /\/sshkey$/.test(path) || command.includes("'npm' 'install'") || command.includes("'self-host'"))) {
        await new Promise((done) => setTimeout(done, Number(process.env.BOAT_LAB_STEP_MS ?? 8000)));
    }
    if (cloud && req.method === 'POST' && /^\/api\/v1\/sandboxes\/[^/]+\/sshkey$/.test(path)) {
        cloud.authorize(JSON.parse(body.toString()).key);
        console.log('machine: the phone key is authorized');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hostKey: cloud.hostKey, sshEndpoint: `127.0.0.1:${cloud.sshPort}`, sshUser: MACHINE_USER }));
        return;
    }
    const args = cloud && req.method === 'POST' && /^\/api\/v1\/sandboxes\/[^/]+\/commands$/.test(path) ? muxrArgs(JSON.parse(body.toString()).command) : undefined;
    if (args && ['self-host', 'pair'].includes(args[0])) {
        const finished = (r) => ({ ok: true, type: 'command.finished', success: r.code === 0, status: 'exited', exitCode: r.code, signal: null, stdout: r.stdout, stderr: r.stderr, timedOut: false });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (JSON.parse(body.toString()).detached !== true) { res.end(JSON.stringify(finished(await onMachine(args)))); return; }
        const pid = ++commandSeq;
        commands.set(String(pid), null);
        void onMachine(args).then((r) => commands.set(String(pid), r));
        res.end(JSON.stringify({ ok: true, type: 'command.started', success: true, processId: pid, pid }));
        return;
    }
    const polled = cloud && /^\/api\/v1\/sandboxes\/[^/]+\/commands\/(\d+)$/.exec(path)?.[1];
    if (polled && commands.has(polled)) {
        const r = commands.get(polled);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r === null ? { ok: true, type: 'command.status', running: true, status: 'running', exitCode: null }
            : { ok: true, type: 'command.status', success: true, running: false, status: 'exited', exitCode: r.code, signal: null, stdout: r.stdout, stderr: r.stderr }));
        return;
    }
    if (!approved && path === '/api/boat/oauth2/token' && body.toString().includes('grant-type%3Aclaim')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'authorization_pending' }));
        return;
    }
    const answer = await fetch(`${fakeOrigin}${path}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? '', authorization: req.headers.authorization ?? '' }, body: req.method === 'GET' ? undefined : body });
    // The fake names its own address in metadata and links; the phone only reaches this proxy.
    const text = (await answer.text()).replaceAll(fakeOrigin, ownOrigin);
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
    res.end(text);
}).listen(port, '127.0.0.1', () => console.log(`boat lab listening on ${port}`));
process.on('SIGTERM', async () => {
    await cloud?.stop();
    if (process.env.BOAT_LAB_SSH) rmSync(join(process.env.BOAT_LAB_SSH, 'ready'), { force: true });
    process.exit(0);
});
