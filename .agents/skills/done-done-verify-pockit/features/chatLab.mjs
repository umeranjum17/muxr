// A private chat lab: a real relay and host over a Herdr lab session (the
// guarded helper owns the session), and one browser pairing link a minute.
// The agents themselves are real `claude` and `pi` panes the proof starts in
// that session; this only runs the stack the PWA pairs with. Run from the repo
// root with HERDR_LAB_HELPER, HERDR_LAB_SESSION (provisioned) and CHAT_LAB_ROOT
// (a short scratch path: it holds sockets) set. CHAT_LAB_CLAUDE_CONFIG and
// CHAT_LAB_PI_DIR name the transcript roots the host reads (lab folders). See
// chat-view.md. SIGUSR1 mints another browser link; SIGTERM stops the stack.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const repo = process.cwd();
const { machineIdentity } = await import(join(repo, 'scripts/setup/index.mjs'));
const { waitForRelay } = await import(join(repo, 'scripts/diagnostics/application/waitForRelay.mjs'));
const { HERDR_LAB_HELPER: helper, HERDR_LAB_SESSION: session, CHAT_LAB_ROOT: root } = process.env;
if (!helper || !session || !root) throw new Error('chatLab needs HERDR_LAB_HELPER, HERDR_LAB_SESSION and CHAT_LAB_ROOT');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const status = JSON.parse(execFileSync(helper, ['run', session, 'status', '--json'], { encoding: 'utf8' }));
const wrapper = join(root, 'herdr-lab.sh');
const keep = ['FM_HERDR_LAB_STATE_DIR', 'TMPDIR'].filter((name) => process.env[name]).map((name) => `export ${name}=${JSON.stringify(process.env[name])}\n`).join('');
mkdirSync(root, { recursive: true });
writeFileSync(wrapper, `#!/bin/sh\n${keep}exec ${JSON.stringify(helper)} run ${JSON.stringify(session)} "$@"\n`);
chmodSync(wrapper, 0o700);
const [home, relayDir, hostDir, labHome] = ['muxr', 'relay', 'host', 'home'].map((name) => join(root, name));
for (const dir of [home, labHome]) mkdirSync(dir, { recursive: true });
const env = { ...process.env, HOME: labHome, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1', MUXR_RELAY_MDNS: '0',
    HERDR_BIN: wrapper, HERDR_BIN_PATH: wrapper, HERDR_SOCKET_PATH: status.server.socket, HERDR_SESSION: session };
if (process.env.CHAT_LAB_CLAUDE_CONFIG) env.CLAUDE_CONFIG_DIR = process.env.CHAT_LAB_CLAUDE_CONFIG;
if (process.env.CHAT_LAB_PI_DIR) env.PI_AGENT_DIR = process.env.CHAT_LAB_PI_DIR;
for (const key of ['MUXR_RELAY_URL', 'MUXR_RELAY_TOKEN', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'PI_CODING_AGENT_DIR']) delete env[key];
const children = [];
const start = (args, extra) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; });
    child.stderr.on('data', (part) => { output += part; });
    child.output = () => output;
    children.push(child);
    return child;
};
const relay = start(['apps/relay/dist/main.js'], { MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: relayDir });
const port = await waitForRelay(relay, 60_000);
const owner = JSON.parse(readFileSync(join(relayDir, 'mint-secret'), 'utf8'));
// A fixed name for the computer, so the real hostname never reaches a capture.
writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, machine: { ...machineIdentity(undefined), name: 'Umer laptop' }, relayPort: port,
    relayUrl: `ws://127.0.0.1:${port}`, relayLocation: 'local', relayRole: 'single-machine', connectionMode: 'lan', webEnabled: false, mintSecret: owner })}\n`, { mode: 0o600 });
const host = start(['apps/host/dist/main.js'], { MUXR_MODE: 'selfhost', MUXR_DATA_DIR: hostDir });
const deadline = Date.now() + 90_000;
while (!existsSync(join(hostDir, 'pair.sock'))) { if (Date.now() > deadline) throw new Error(`host did not start: ${host.output()}`); await sleep(100); }
while (!host.output().includes('link relay: online')) { if (Date.now() > deadline) throw new Error(`host never reached the relay: ${host.output()}`); await sleep(100); }

// A browser link holds for two minutes: mint it when the PWA is ready to pair.
let pairing;
const mint = () => new Promise((resolve, reject) => {
    pairing?.destroy();
    const socket = createConnection(join(hostDir, 'pair.sock'));
    pairing = socket;
    let pending = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind: 'browser', authority: 'control', personal: false } })}\n`));
    socket.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
            const event = JSON.parse(line);
            if (event.offer) resolve(event.offer.text);
            if (event.approval) socket.write('{"yes":true}\n');
            if (event.error) reject(new Error(event.error));
        }
    });
});
const stop = async () => {
    pairing?.destroy();
    for (const child of children) child.kill('SIGTERM');
    await sleep(1_500);
    process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGUSR1', () => void mint().then((link) => console.log(`browser link: ${link}`), (error) => console.error(error)));
console.log(`lab ready: relay port ${port}, pids ${children.map((child) => child.pid).join(',')}, self ${process.pid}`);
console.log(`browser link: ${await mint()}`);
setInterval(() => {}, 1 << 30);
