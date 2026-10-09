/**
 * A lab host never serves the live default Herdr session. HERDR_SESSION marks
 * a lab host: given a socket that is not that session's own it refuses to
 * start, and given only the name it serves the socket Herdr lists for it. Lab
 * pairing refuses a host serving the default session. Two fake Herdrs stand in
 * for the default and the lab session; no real Herdr is touched.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeHerdr } from '../../../perf/fake-herdr/server.mjs';
import { waitForRelay } from './waitForRelay.mjs';
import { linkLabClient, requestLab } from './linkLabClient.mjs';
import { machineIdentity } from '../../setup/index.mjs';

const root = mkdtempSync(join(tmpdir(), 'muxr-lab-guard-'));
const home = join(root, 'muxr');
const lab = 'fm-lab-guard';
const children = [];
const fakes = [];
const env = { ...process.env, HOME: join(root, 'home'), MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1' };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_URL', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH', 'HERDR_SESSION', 'HERDR_SOCKET_PATH']) delete env[key];

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

async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
}

try {
    // Keep the default socket at its implicit HOME path. The named socket is
    // supplied by session list, so flatten its fixture path below the Unix limit.
    const desk = await startFakeHerdr({ dir: join(root, 'home', '.config', 'herdr'), titleChurnHz: 0 });
    const labHerdr = await startFakeHerdr({ dir: join(root, 'l'), titleChurnHz: 0 });
    fakes.push(desk, labHerdr);
    // `session list` is Herdr's own answer; other verbs go to the lab fake.
    env.HERDR_BIN = join(root, 'herdr');
    writeFileSync(env.HERDR_BIN, `#!/bin/sh\nif [ "$1 $2" = "session list" ]; then echo '${JSON.stringify({ sessions: [
        { name: 'default', default: true, running: true, socket_path: desk.socketPath },
        { name: lab, default: false, running: true, socket_path: labHerdr.socketPath },
    ] })}'; exit; fi\nexec ${JSON.stringify(labHerdr.binPath)} "$@"\n`, { mode: 0o700 });

    const relay = launch(['apps/relay/dist/main.js'], {
        MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: join(root, 'relay'), MUXR_RELAY_MDNS: '0',
    });
    const port = await waitForRelay(relay);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, machine: machineIdentity(undefined), relayPort: port,
        relayUrl: `ws://127.0.0.1:${port}`, relayLocation: 'local', relayRole: 'single-machine', connectionMode: 'lan',
        webEnabled: false, mintSecret: JSON.parse(readFileSync(join(root, 'relay', 'mint-secret'), 'utf8')) })}\n`, { mode: 0o600 });
    const start = (name, extra) => launch(['apps/host/dist/main.js'], { MUXR_MODE: 'selfhost', MUXR_DATA_DIR: join(root, name), ...extra });
    const pairSocket = async (name, host) => {
        const path = join(root, name, 'pair.sock');
        await until(() => existsSync(path), `${name} host pairing socket (${host.output()})`);
        return path;
    };

    // The incident: a lab name, but the default socket every Herdr pane exports.
    const leaked = start('leaked', { HERDR_SESSION: lab, HERDR_SOCKET_PATH: desk.socketPath });
    await until(() => leaked.exitCode !== null, 'lab host on the default socket refuses to start');
    if (leaked.exitCode === 0 || !leaked.output().includes('is Herdr session "default", not lab session')) {
        throw new Error(`lab host on the default socket did not refuse: ${leaked.output()}`);
    }

    // A host serving the default session refuses lab pairing.
    const deskHost = start('desk');
    const refused = await linkLabClient(await pairSocket('desk', deskHost)).then(
        (device) => { device.stop(); return undefined; },
        (error) => error.message,
    );
    if (!refused?.includes('refusing lab pairing')) throw new Error(`lab pairing reached a default-session host: ${refused}`);
    await stop(deskHost);

    // The name alone serves the lab session's herd, and lab pairing admits it.
    const labHost = start('lab', { HERDR_SESSION: lab });
    const device = await linkLabClient(await pairSocket('lab', labHost));
    try {
        let listed = [];
        await until(async () => {
            listed = await requestLab(device, 'session.list');
            return listed.length > 0;
        }, 'lab host lists its herd');
        if (!listed.every((session) => session.cwd?.startsWith(labHerdr.world.cwd))) throw new Error(`lab host served another herd: ${JSON.stringify(listed)}`);
    } finally { device.stop(); }
    process.stdout.write('PASS: a lab host refuses the default Herdr session at start and at pairing, and serves its named session\n');
} finally {
    await Promise.all(children.map(stop));
    await Promise.all(fakes.map((fake) => fake.close()));
    rmSync(root, { recursive: true, force: true });
}
