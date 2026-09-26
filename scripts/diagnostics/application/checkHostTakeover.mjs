/** A second link host under the same machine key retires the first. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostId } from '@byokit/link';
import { waitForRelay } from './waitForRelay.mjs';
import { machineIdentity } from '../../setup/index.mjs';

const root = mkdtempSync(join(tmpdir(), 'muxr-link-takeover-'));
const home = join(root, 'muxr');
const children = [];
const env = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1' };
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
    const relay = launch(['apps/relay/dist/main.js'], {
        MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: join(root, 'relay'), MUXR_RELAY_MDNS: '0',
    });
    const port = await waitForRelay(relay);
    const machine = { ...machineIdentity(undefined), name: 'Takeover machine' };
    mkdirSync(home, { recursive: true });
    const owner = JSON.parse(readFileSync(join(root, 'relay', 'mint-secret'), 'utf8'));
    writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, machine, relayPort: port,
        relayUrl: `ws://127.0.0.1:${port}`, relayLocation: 'local', relayRole: 'single-machine',
        connectionMode: 'lan', webEnabled: false, mintSecret: owner })}\n`, { mode: 0o600 });
    const start = (name) => launch(['apps/host/dist/main.js', '--fake'], {
        MUXR_MODE: 'selfhost', MUXR_DATA_DIR: join(root, name),
    });
    const first = start('first');
    await until(() => first.output().includes('link relay: online'), 'first link host online');
    const second = start('second');
    await until(() => second.output().includes('link relay: online'), 'second link host online');
    await until(() => first.exitCode !== null, 'retired link host exit');
    if (first.exitCode !== 0) throw new Error(`retired host exited ${first.exitCode}: ${first.output()}`);
    if (second.exitCode !== null) throw new Error(`newer host exited ${second.exitCode}: ${second.output()}`);
    const hosts = await fetch(`http://127.0.0.1:${port}/relay/v1/hosts`, { headers: { authorization: `Bearer ${owner}` } }).then((response) => response.json());
    const id = hostId(Buffer.from(machine.crypto.boxPublicKey, 'base64'));
    if (hosts.hosts?.filter((host) => host.id === id && host.online).length !== 1) throw new Error('relay has no single online link host');
    process.stdout.write('PASS: second link host retires the first\n');
} finally {
    await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
    }));
    rmSync(root, { recursive: true, force: true });
}
