/**
 * The whole muxr stack, isolated, with a fake Herdr underneath it.
 *
 * Our code stays real: this spawns the built relay and the built host, and the
 * phone runs the release APK and pairs over the real E2EE pairing path. Only
 * Herdr is replaced, because it is third party and because a load test that
 * needs the developer's own desk cannot be run before a release.
 *
 * Everything lives in one scratch directory: relay data, machine identity,
 * host state, Herdr sockets. `HOME` is redirected for the children so no
 * service unit, herdr socket or `~/.muxr` on this machine is touched. Ports are
 * picked free, so a running muxr install keeps working while the gate runs.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const RELAY_ENTRY = 'apps/relay/dist/main.js';
const HOST_ENTRY = 'apps/host/dist/main.js';

async function freePort() {
    // Ask the kernel rather than guessing: the gate must never collide with the
    // relay or host this machine already runs.
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

/**
 * Start `perf/fake-herdr` as a child and wait for the line naming its sockets.
 * The world it built comes back on the same line, so the harness and the host
 * agree on what exists without the harness importing it.
 */
async function spawnFakeHerdr(dir, options) {
    const args = ['perf/fake-herdr/server.mjs', '--dir', dir];
    for (const [flag, value] of [
        ['--panes', options.panes],
        ['--agents', options.agents],
        ['--title-churn-hz', options.titleChurnHz],
        ['--terminal-bytes-per-second', options.terminalBytesPerSecond],
        ['--graphics-frame-hz', options.graphicsFrameHz],
    ]) {
        if (value !== undefined) args.push(flag, String(value));
    }
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = [];
    child.stderr.on('data', (chunk) => log.push(String(chunk)));
    const announced = await new Promise((resolve, reject) => {
        let buffered = '';
        const deadline = setTimeout(() => reject(new Error(`the fake Herdr never announced itself: ${log.join('')}`)), 30_000);
        child.stdout.on('data', (chunk) => {
            buffered += String(chunk);
            const line = buffered.split('\n').find((row) => row.trim().startsWith('{'));
            if (line === undefined) return;
            clearTimeout(deadline);
            resolve(JSON.parse(line));
        });
        child.once('exit', (code) => {
            clearTimeout(deadline);
            reject(new Error(`the fake Herdr exited with ${code}: ${log.join('')}`));
        });
    });
    return {
        ...announced,
        pid: child.pid,
        log: () => log.join(''),
        close: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
    };
}

async function relayHealthy(port) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const ok = await fetch(`http://127.0.0.1:${port}/health`)
            .then((response) => response.ok)
            .catch(() => false);
        if (ok) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
}

/**
 * Env for every muxr child. The live install's relay, token and machine id are
 * dropped: inheriting a machine id would retire the user's real host on their
 * real relay the moment ours connects.
 */
function childEnv(home, muxrHome, extra) {
    const env = { ...process.env, ...extra };
    for (const key of ['MUXR_RELAY_URL', 'MUXR_RELAY_TOKEN', 'MUXR_RELAY_AUTH', 'MUXR_MACHINE_ID', 'MUXR_MACHINE_NAME', 'MUXR_DATA_DIR', 'MUXR_MODE']) {
        if (!(key in (extra ?? {}))) delete env[key];
    }
    return {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        MUXR_HOME: muxrHome,
        MUXR_NO_TUI: '1',
        MUXR_NO_SERVICE_COMMANDS: '1',
    };
}

/**
 * @param {{ panes?: number, agents?: number, titleChurnHz?: number,
 *   terminalBytesPerSecond?: number, graphicsFrameHz?: number }} [options]
 */
export async function startFakeStack(options = {}) {
    for (const entry of [RELAY_ENTRY, HOST_ENTRY]) {
        if (!existsSync(entry)) throw new Error(`${entry} is missing; run \`yarn build\` first`);
    }

    const root = mkdtempSync(join(tmpdir(), 'muxr-perf-'));
    const home = join(root, 'home');
    const muxrHome = join(root, 'muxr');
    mkdirSync(join(home, '.config'), { recursive: true });
    mkdirSync(muxrHome, { recursive: true });

    const relayPort = await freePort();
    const hostHttpPort = await freePort();
    const children = [];
    // The fake runs in its own process on purpose. In-process it shares an
    // event loop with the harness, and one blocking call here - a Maestro run,
    // an adb dump - freezes every Herdr answer, which the phone sees as a
    // 15-second stall and reports as "reconnecting".
    const fake = await spawnFakeHerdr(join(root, 'herdr'), options);

    const stop = () => {
        for (const child of children.splice(0)) {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
        fake.close();
        // Only the reverse this run added: --remove-all would cut whatever else
        // on this desk is tunnelling to the emulator.
        spawnSync('adb', ['reverse', '--remove', `tcp:${relayPort}`], { stdio: 'ignore' });
        rmSync(root, { recursive: true, force: true });
    };

    try {
        // The relay this run pairs against. Local authority mints the pairing
        // secret the CLI reads back below; E2EE stays on, as in production. The
        // bind host must be the one `self-host --connection-mode lan` would
        // choose, or the CLI refuses to adopt a relay it did not start.
        const relayLog = [];
        const relay = spawn(process.execPath, [RELAY_ENTRY], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv(home, muxrHome, {
                MUXR_RELAY_PORT: String(relayPort),
                MUXR_RELAY_HOST: '0.0.0.0',
                MUXR_RELAY_DATA_DIR: join(muxrHome, 'relay'),
                MUXR_RELAY_LOCAL_AUTHORITY: '1',
                MUXR_RELAY_MDNS: '0',
                MUXR_HOST_HTTP_URL: `http://127.0.0.1:${hostHttpPort}`,
            }),
        });
        children.push(relay);
        relay.stdout.on('data', (chunk) => relayLog.push(String(chunk)));
        relay.stderr.on('data', (chunk) => relayLog.push(String(chunk)));
        if (!await relayHealthy(relayPort)) {
            throw new Error(`the relay never became healthy: ${relayLog.join('').trim().split('\n').slice(-3).join(' | ')}`);
        }

        // Machine identity and `selfhost.json`, written by the real CLI against
        // the relay above. `--relay-only` is the one path that mints identity
        // without installing or restarting a service unit.
        const identity = await run(process.execPath, [
            'scripts/cli.mjs', 'self-host', '--relay-only',
            '--port', String(relayPort),
            '--advertise', `ws://127.0.0.1:${relayPort}`,
            '--connection-mode', 'lan',
        ], { env: childEnv(home, muxrHome), timeout: 120_000 }).catch((cause) => {
            throw new Error(`self-host identity failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });

        // The host under test, talking to the fake Herdr instead of the desk.
        const hostLog = [];
        const host = spawn(process.execPath, [HOST_ENTRY], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv(home, muxrHome, {
                MUXR_MODE: 'selfhost',
                MUXR_DATA_DIR: join(muxrHome, 'host'),
                MUXR_HOST_HTTP_PORT: String(hostHttpPort),
                MUXR_RELAY_URL: `ws://127.0.0.1:${relayPort}/relay`,
                HERDR_SOCKET_PATH: fake.socketPath,
                HERDR_CLIENT_SOCKET_PATH: fake.clientSocketPath,
                HERDR_BIN: fake.binPath,
            }),
        });
        children.push(host);
        host.stdout.on('data', (chunk) => hostLog.push(String(chunk)));
        host.stderr.on('data', (chunk) => hostLog.push(String(chunk)));

        // The emulator reaches a loopback relay only through adb.
        await run('adb', ['reverse', `tcp:${relayPort}`, `tcp:${relayPort}`], { timeout: 60_000 });

        return {
            root,
            relayPort,
            hostHttpPort,
            dataDir: join(muxrHome, 'host'),
            world: fake.world,
            // The service's own processes, for a memory budget. Terminal shims
            // are children of the host, so a tree walk from these covers them.
            // The stand-in for Herdr is reported apart from our own code.
            pids: { relay: relay.pid, host: host.pid },
            herdrPid: fake.pid,
            identity: (identity.stdout ?? '').trim().split('\n').pop(),
            hostLog: () => hostLog.join(''),
            relayLog: () => relayLog.join(''),
            /**
             * A real pairing string for this throwaway host. The CLI keeps
             * polling until the phone claims it, so the child stays up and the
             * caller releases it once the flow has typed the code.
             */
            mintPairing: async () => {
                const pairing = spawn(process.execPath, ['scripts/cli.mjs', 'pair'], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: childEnv(home, muxrHome),
                });
                children.push(pairing);
                const code = await new Promise((resolve) => {
                    let seen = '';
                    const deadline = setTimeout(() => resolve(undefined), 120_000);
                    const scan = (chunk) => {
                        seen += String(chunk);
                        const match = /(wss?:\/\/\S+\?pair=[A-Z0-9-]+)/.exec(seen);
                        if (match === null) return;
                        clearTimeout(deadline);
                        resolve(match[1]);
                    };
                    pairing.stdout.on('data', scan);
                    pairing.stderr.on('data', scan);
                    pairing.once('exit', () => { clearTimeout(deadline); resolve(undefined); });
                });
                return { code, release: () => { try { pairing.kill('SIGTERM'); } catch { /* gone */ } } };
            },
            stop,
        };
    } catch (cause) {
        stop();
        throw cause;
    }
}
