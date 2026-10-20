/** Refreshing Usage on the shipped host bundle never starts a second host under the machine key. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { waitForRelay } from './waitForRelay.mjs';
import { linkLabClient, requestLab } from './linkLabClient.mjs';
import { machineIdentity } from '../../setup/index.mjs';
import { runtimeDependencies } from '../../release/index.mjs';

// 0.2.8: the bundle spawned itself as the Usage ledger child, and that child
// ran the whole host: it dialled the relay as this machine and replaced the
// real host on every refresh. Only the bundle shows it; the source build runs
// the ledger from its own file.
const repo = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'muxr-usage-host-'));
mkdirSync(join(repo, '.cache'), { recursive: true });
const bundleDir = mkdtempSync(join(repo, '.cache', 'usage-host-'));
const home = join(root, 'muxr');
const children = [];
const env = {
    ...process.env, HOME: join(root, 'home'), MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1',
    CLAUDE_CONFIG_DIR: join(root, 'transcripts'), HERDR_BIN: join(root, 'no-herdr'), HERDR_SOCKET_PATH: join(root, 'no-herdr.sock'),
};
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_URL', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH']) delete env[key];

async function until(check, what, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function launch(args, extra = {}) {
    const child = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; });
    child.stderr.on('data', (part) => { output += part; });
    child.output = () => output;
    children.push(child);
    return child;
}

try {
    // The same bundle the packed CLI ships as host.js.
    const hostBundle = join(bundleDir, 'host.js');
    await build({
        absWorkingDir: join(repo, 'apps', 'host', 'dist'), entryPoints: ['main.js'], outfile: hostBundle,
        define: { 'process.env.MUXR_PACKAGED': '"1"' }, bundle: true, platform: 'node', format: 'esm', target: 'node22',
        preserveSymlinks: true, external: Object.keys(runtimeDependencies(repo)), logLevel: 'warning',
    });
    mkdirSync(env.HOME, { recursive: true });
    // One turn for the ledger child to count: a child that never ran (or ran
    // the host instead) leaves it uncounted.
    const transcripts = join(env.CLAUDE_CONFIG_DIR, 'projects', '-repo');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, 'turn.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'req_1',
        message: { id: 'msg_1', role: 'assistant', model: 'sonnet-lab', usage: { input_tokens: 1000, output_tokens: 2345 } } })}\n`);
    const relay = launch(['apps/relay/dist/main.js'], {
        MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: join(root, 'relay'), MUXR_RELAY_MDNS: '0',
    });
    const port = await waitForRelay(relay);
    const machine = { ...machineIdentity(undefined), name: 'Usage machine' };
    mkdirSync(home, { recursive: true });
    const owner = JSON.parse(readFileSync(join(root, 'relay', 'mint-secret'), 'utf8'));
    writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, machine, relayPort: port,
        relayUrl: `ws://127.0.0.1:${port}`, relayLocation: 'local', relayRole: 'single-machine',
        connectionMode: 'lan', webEnabled: false, mintSecret: owner })}\n`, { mode: 0o600 });
    const host = launch([hostBundle, '--fake'], { MUXR_MODE: 'selfhost', MUXR_DATA_DIR: join(root, 'host') });
    await until(() => host.output().includes('link relay: online'), 'host online');
    const socketPath = join(root, 'host', 'pair.sock');
    await until(() => existsSync(socketPath), 'host pairing socket');
    const device = await linkLabClient(socketPath);
    // A replaced host never answers the refresh in flight: fail on the
    // replacement itself rather than wait on that answer.
    const lost = () => host.output().includes('link relay: replaced') || host.exitCode !== null;
    let finished = false;
    const replaced = until(() => finished || lost(), 'replacement', Infinity).then(() => {
        if (!finished) throw new Error(`a second host replaced this one during Usage refreshes:\n${host.output()}`);
    });
    replaced.catch(() => undefined);
    let report;
    try {
        for (let refresh = 0; refresh < 5; refresh += 1) {
            report = await Promise.race([requestLab(device, 'usage.report', { refresh: true }), replaced]);
            await Promise.race([new Promise((resolve) => setTimeout(resolve, 2000)), replaced]);
        }
    } finally { device.stop(); }
    if (lost()) await replaced;
    finished = true;
    if (!JSON.stringify(report).includes('"model":"sonnet-lab","today":3345')) throw new Error(`the ledger child never counted the seeded turn: ${JSON.stringify(report).slice(0, 2000)}`);
    process.stdout.write(`PASS: five Usage refreshes counted the turn and kept host ${host.pid} as the only host on the relay\n`);
} finally {
    await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
    }));
    rmSync(root, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
}
