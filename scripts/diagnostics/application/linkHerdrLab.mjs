import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { machineIdentity } from '../../setup/index.mjs';
import { approveLabOffer, linkLabClient, linkWaitMs } from './linkLabClient.mjs';
import { waitForRelay } from './waitForRelay.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// With `presentOffer`, an external device (an Android app) pairs from the offer it is handed, and the lab answers the computer's approval; the result is `approved`, not a link.
export async function linkHerdrLab(root, label, onEvent, beforeHost, hostEnv = {}, presentOffer) {
    const helper = process.env.HERDR_LAB_HELPER;
    if (!helper) throw new Error('HERDR_LAB_HELPER is not set: point it at a Herdr lab helper script to run the lab link.');
    const session = process.env.HERDR_LAB_SESSION ?? execFileSync(helper, ['name', label], { encoding: 'utf8' }).trim();
    const externallyProvisioned = process.env.HERDR_LAB_PREPROVISIONED === '1';
    if (!externallyProvisioned) execFileSync(helper, ['provision', session]);
    const status = JSON.parse(execFileSync(helper, ['run', session, 'status', '--json'], { encoding: 'utf8' }));
    const wrapper = join(root, 'herdr-lab.sh');
    // The kit starts `herdr terminal` with a narrow env, so the wrapper carries the lab's own state dir itself.
    const keep = ['FM_HERDR_LAB_STATE_DIR', 'TMPDIR'].filter((name) => process.env[name])
        .map((name) => `export ${name}=${JSON.stringify(process.env[name])}\n`).join('');
    writeFileSync(wrapper, `#!/bin/sh\n${keep}exec ${JSON.stringify(helper)} run ${JSON.stringify(session)} "$@"\n`);
    chmodSync(wrapper, 0o700);
    const home = join(root, 'muxr');
    mkdirSync(home, { recursive: true });
    const relayDir = join(root, 'relay');
    const hostDir = join(root, 'host');
    // A home of its own: on the real one the lab host read the person's agent accounts for plan usage.
    const labHome = join(root, 'home');
    mkdirSync(labHome, { recursive: true });
    const env = { ...process.env, HOME: labHome, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1',
        HERDR_BIN: wrapper, HERDR_BIN_PATH: wrapper, HERDR_SOCKET_PATH: status.server.socket,
        HERDR_SESSION: session };
    for (const key of ['MUXR_RELAY_URL', 'MUXR_RELAY_TOKEN', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) delete env[key];
    // Only what the caller hands over on purpose, such as a lab-only sign-in.
    Object.assign(env, hostEnv);
    const children = [];
    const start = (args, extra = {}) => {
        const child = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (part) => { output += part; });
        child.stderr.on('data', (part) => { output += part; });
        child.output = () => output;
        children.push(child);
        return child;
    };
    const stop = async (link) => {
        link?.stop();
        await Promise.all(children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGTERM');
            await exited;
        }));
        if (!externallyProvisioned) execFileSync(helper, ['teardown', session]);
    };
    let link;
    try {
        if (beforeHost !== undefined) beforeHost((args) => execFileSync(wrapper, args, { encoding: 'utf8' }), session);
        const load = loadavg()[0];
        const waitMs = linkWaitMs(load);
        const waited = `${(waitMs / 1000).toFixed(1)}s`;
        console.log(`lab link wait ${waited} (1-min load ${load.toFixed(2)})`);
        const deadline = Date.now() + waitMs;
        // MUXR_LAB_PACKAGE_DIR runs an installed @trymuxr/cli instead of this checkout's build: the release journey drives the exact tarball.
        const packageDir = process.env.MUXR_LAB_PACKAGE_DIR;
        const relay = start([packageDir ? join(packageDir, 'relay.js') : 'apps/relay/dist/main.js'], { MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: relayDir, MUXR_RELAY_MDNS: '0' });
        const port = await waitForRelay(relay, deadline - Date.now());
        // A journey that photographs the phone names the lab's computer for it, so the real hostname stays off every capture.
        const machine = { ...machineIdentity(undefined), ...(process.env.MUXR_LAB_MACHINE_NAME ? { name: process.env.MUXR_LAB_MACHINE_NAME } : {}) };
        const owner = JSON.parse(readFileSync(join(relayDir, 'mint-secret'), 'utf8'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, machine, relayPort: port,
            relayUrl: `ws://${process.env.MUXR_RELAY_HOST ?? '127.0.0.1'}:${port}`, relayLocation: 'local', relayRole: 'single-machine',
            connectionMode: 'lan', webEnabled: false, mintSecret: owner })}\n`, { mode: 0o600 });
        // A relay bound for a device elsewhere on the network is dialled at that address too.
        const host = start([packageDir ? join(packageDir, 'host.js') : 'apps/host/dist/main.js'], { MUXR_MODE: 'selfhost', MUXR_DATA_DIR: hostDir,
            ...(process.env.MUXR_RELAY_HOST ? { MUXR_RELAY_URL: `ws://${process.env.MUXR_RELAY_HOST}:${port}/relay` } : {}) });
        while (!existsSync(join(hostDir, 'pair.sock'))) {
            if (host.exitCode !== null || Date.now() > deadline) throw new Error(`link host did not start within ${waited}: ${host.output()}`);
            await sleep(100);
        }
        // The pairing server listens before the host's own relay link is up, so a
        // device that pairs that early has its socket closed as unreachable. Wait
        // for the host's own online line first; on a loaded machine this is the
        // difference between a proven journey and a flaky refusal.
        while (!host.output().includes('link relay: online')) {
            if (host.exitCode !== null || Date.now() > deadline) throw new Error(`link host never reached the relay within ${waited}: ${host.output()}`);
            await sleep(100);
        }
        const pairSocket = join(hostDir, 'pair.sock');
        const approved = presentOffer === undefined ? undefined : await approveLabOffer(pairSocket, presentOffer);
        link = presentOffer === undefined ? await linkLabClient(pairSocket, onEvent, deadline) : undefined;
        return { link, approved, env, machine, port, session, wrapper,
            // The lab relay and host this call started, for checks that freeze them.
            pids: () => children.map((child) => child.pid), hostOutput: () => host.output(),
            herdr: (args, timeout = 10_000) => execFileSync(wrapper, args, { encoding: 'utf8', timeout }),
            stop: () => stop(link) };
    } catch (error) {
        await stop(link);
        throw error;
    }
}
