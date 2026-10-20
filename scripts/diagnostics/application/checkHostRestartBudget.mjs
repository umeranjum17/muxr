/** `muxr up` exits non-zero once the host's restart budget is spent, so systemd restarts the unit. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 0.2.8: a host that kept exiting 0 used up the budget and the supervisor then
// exited 0 too. muxr.service restarts only on failure, so the computer stayed
// hostless until someone started it by hand.
const root = mkdtempSync(join(tmpdir(), 'muxr-restart-budget-'));
let up;
try {
    const port = await new Promise((resolve) => {
        const probe = createServer().listen(0, '127.0.0.1', () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
    });
    const home = join(root, 'muxr');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, 'home'), { recursive: true });
    writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, relayPort: port, bindHost: '127.0.0.1', relayLocation: 'local' })}\n`, { mode: 0o600 });
    const env = {
        ...process.env, HOME: join(root, 'home'), MUXR_HOME: home, MUXR_MODE: 'selfhost', MUXR_NO_SERVICE_COMMANDS: '1',
        MUXR_HOST_RESTART_DELAYS: '0,0', HERDR_BIN: join(root, 'no-herdr'), HERDR_SOCKET_PATH: join(root, 'no-herdr.sock'),
    };
    for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_URL', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH', 'MUXR_RELAY_PORT']) delete env[key];
    // `--help` reaches the host, which prints its usage and exits 0 every time.
    up = spawn(process.execPath, ['scripts/setup/presentation/hostUp.mjs', 'up', '--help'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    up.stdout.on('data', (part) => { output += part; });
    up.stderr.on('data', (part) => { output += part; });
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`muxr up never exited:\n${output}`)), 60_000);
        up.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    if (!output.includes('attempt 2/2') || !output.includes('restart budget exhausted')) throw new Error(`the host was not restarted until the budget ran out:\n${output}`);
    if (code === 0) throw new Error(`muxr up exited 0 with no host left, so systemd will not restart it:\n${output}`);
    process.stdout.write(`PASS: muxr up exits ${code} once the host restart budget is spent\n`);
} finally {
    if (up !== undefined && up.exitCode === null && up.signalCode === null) up.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
}
