import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineIdentity } from '../../setup/index.mjs';
import { linkLabClient } from './linkLabClient.mjs';
import { waitForRelay } from './waitForRelay.mjs';

const helper = process.env.HERDR_LAB_HELPER || '/home/umer/firstmate/bin/fm-herdr-lab.sh';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function linkHerdrLab(root, label, onEvent, beforeHost) {
    const session = execFileSync(helper, ['name', label], { encoding: 'utf8' }).trim();
    execFileSync(helper, ['provision', session]);
    const status = JSON.parse(execFileSync(helper, ['run', session, 'status', '--json'], { encoding: 'utf8' }));
    const wrapper = join(root, 'herdr-lab.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(helper)} run ${JSON.stringify(session)} "$@"\n`);
    chmodSync(wrapper, 0o700);
    const home = join(root, 'muxr');
    mkdirSync(home, { recursive: true });
    const relayDir = join(root, 'relay');
    const hostDir = join(root, 'host');
    const env = { ...process.env, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1',
        HERDR_BIN: wrapper, HERDR_BIN_PATH: wrapper, HERDR_SOCKET_PATH: status.server.socket,
        HERDR_SESSION: session };
    for (const key of ['MUXR_RELAY_URL', 'MUXR_RELAY_TOKEN', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH']) delete env[key];
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
        execFileSync(helper, ['teardown', session]);
    };
    let link;
    try {
        if (beforeHost !== undefined) beforeHost((args) => execFileSync(wrapper, args, { encoding: 'utf8' }));
        const relay = start(['apps/relay/dist/main.js'], { MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: relayDir, MUXR_RELAY_MDNS: '0' });
        const port = await waitForRelay(relay);
        const machine = machineIdentity(undefined);
        const owner = JSON.parse(readFileSync(join(relayDir, 'mint-secret'), 'utf8'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, machine, relayPort: port,
            relayUrl: `ws://127.0.0.1:${port}`, relayLocation: 'local', relayRole: 'single-machine',
            connectionMode: 'lan', webEnabled: false, mintSecret: owner })}\n`, { mode: 0o600 });
        const host = start(['apps/host/dist/main.js'], { MUXR_MODE: 'selfhost', MUXR_DATA_DIR: hostDir });
        const deadline = Date.now() + 25_000;
        while (!existsSync(join(hostDir, 'pair.sock'))) {
            if (host.exitCode !== null || Date.now() > deadline) throw new Error(`link host did not start: ${host.output()}`);
            await sleep(100);
        }
        link = await linkLabClient(join(hostDir, 'pair.sock'), onEvent);
        return { link, env, machine, port, session, wrapper,
            herdr: (args, timeout = 10_000) => execFileSync(wrapper, args, { encoding: 'utf8', timeout }),
            stop: () => stop(link) };
    } catch (error) {
        await stop(link);
        throw error;
    }
}
