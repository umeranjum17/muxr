/**
 * A second host for the same machineId retires the first.
 *
 * Two live hosts both answer every request, and the one that did not create a
 * session replies "unknown session" — which is what the client surfaces.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForRelay } from './waitForRelay.mjs';

// A live deployment exports these. Inherited, they point the throwaway relay
// and the hosts spawned here at real credentials, and the relay refuses them.
const env = { ...process.env };
for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_E2EE_SHARED_KEY', 'MUXR_RELAY_URL', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH']) {
    delete env[key];
}

const PORT = process.env.MUXR_RELAY_PORT ?? '8813';
const dataDir = mkdtempSync(join(tmpdir(), 'muxr-takeover-'));
const children = [];
const done = (code, msg) => {
    process.stdout.write(msg);
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
};

const relay = spawn('node', ['apps/relay/dist/main.js'], {
    env: { ...env, MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT, MUXR_RELAY_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`));
children.push(relay);
await waitForRelay(PORT);

const startHost = () => {
    const host = spawn('node', ['apps/host/dist/main.js', '--fake'], {
        env: {
            ...env,
            MUXR_MODE: 'local',
            MUXR_RELAY_URL: `ws://127.0.0.1:${PORT}`,
            MUXR_MACHINE_ID: 'takeover-machine',
            MUXR_DATA_DIR: join(dataDir, `host-${children.length}`),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    host.exitCode = null;
    host.on('exit', (code) => { host.observedExit = code; });
    children.push(host);
    return host;
};

const first = startHost();
await delay(1500);
const second = startHost();
await delay(1500);

if (first.observedExit !== 0) {
    done(1, `FAIL: the retired host should exit cleanly, got ${first.observedExit}\n`);
}
if (second.observedExit !== undefined) {
    done(1, `FAIL: the newer host must keep running, exited ${second.observedExit}\n`);
}

const metrics = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).json();
if (metrics.connectedMachines !== 1) {
    done(1, `FAIL: connectedMachines=${metrics.connectedMachines}, expected 1\n`);
}

done(0, 'PASS: second host retires the first (single host per machineId)\n');
