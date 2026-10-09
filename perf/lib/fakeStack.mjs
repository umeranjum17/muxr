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
import { spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCommand as run, spawnCommand as spawn, onCommandCleanup, commandSignal, assertCommandActive } from './commands.mjs';
import { androidArgs } from './deviceTarget.mjs';
import { waitForRelay } from '../../scripts/diagnostics/application/waitForRelay.mjs';

const RELAY_ENTRY = 'apps/relay/dist/main.js';
const HOST_ENTRY = 'apps/host/dist/main.js';

async function freePort() {
    // Ask the kernel rather than guessing: the gate must never collide with the
    // relay or host this machine already runs.
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port === 8792 || port === 8793 ? freePort() : port;
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
        ['--empty-panes', options.emptyPanes],
        ['--empty-after-ms', options.emptyAfterMs],
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
            const end = buffered.indexOf('\n');
            if (end < 0) return;
            const line = buffered.slice(0, end);
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
        onExit: (listener) => child.once('exit', listener),
        close: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
    };
}

async function relayHealthy(port) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        assertCommandActive();
        const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: commandSignal() })
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
function childEnv(home, muxrHome, extra, base = process.env) {
    const env = { ...base, ...extra };
    for (const key of ['MUXR_RELAY_URL', 'MUXR_RELAY_TOKEN', 'MUXR_RELAY_AUTH', 'MUXR_MACHINE_ID', 'MUXR_MACHINE_NAME', 'MUXR_DATA_DIR', 'MUXR_MODE']) {
        if (!(key in (extra ?? {}))) delete env[key];
    }
    // A lab shell's HERDR_SESSION would make the host demand that named session from the fake.
    if (!('HERDR_SESSION' in (extra ?? {}))) delete env.HERDR_SESSION;
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
 *   terminalBytesPerSecond?: number, emptyPanes?: number, emptyAfterMs?: number,
 *   transport?: 'adb' | 'loopback' }} [options]
 */
export async function startFakeStack(options = {}) {
    return startStack(options);
}

/** Explicit live boundary: real auth HOME is never a cleanup or socket-write root. */
export async function startLiveStack({ sourceRoot, authHome, socketPath, clientSocketPath, binPath, machineName }) {
    const live = Object.fromEntries(Object.entries({ authHome, socketPath, clientSocketPath, binPath }).map(([key, path]) => {
        if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`Live stack requires absolute ${key}`);
        return [key, realpathSync(path)];
    }));
    if (!statSync(live.authHome).isDirectory()) throw new Error('Live auth HOME must be a directory');
    for (const key of ['socketPath', 'clientSocketPath']) {
        if (!statSync(live[key]).isSocket()) throw new Error(`Live ${key} must be an existing socket`);
    }
    if (!statSync(live.binPath).isFile()) throw new Error('Live Herdr CLI must be a file');
    // Do not inherit relay identity, provider credentials, CODEX_HOME or fixture env.
    live.env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    return startStack({ sourceRoot, setupHome: () => machineName === undefined ? {} : { MUXR_MACHINE_NAME: machineName } }, live);
}

async function startStack(options, live) {
    // An emulator is its own network namespace and reaches a loopback relay
    // only through adb. A simulator shares this machine's loopback, so asking
    // for adb there would fail on a desk that has no Android tooling at all.
    // Checked before anything is created, so a typo leaks no scratch root.
    const transport = options.transport ?? 'adb';
    if (transport !== 'adb' && transport !== 'loopback') throw new Error(`Unknown stack transport ${transport}`);
    const sourceRoot = resolve(options.sourceRoot ?? '.');
    for (const entry of [RELAY_ENTRY, HOST_ENTRY]) {
        if (!existsSync(join(sourceRoot, entry))) throw new Error(`${entry} is missing; run \`yarn build\` first`);
    }

    const root = mkdtempSync(join(tmpdir(), 'muxr-perf-'));
    onCommandCleanup(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const muxrHome = join(root, 'muxr');
    mkdirSync(join(home, '.config'), { recursive: true });
    mkdirSync(muxrHome, { recursive: true });
    const fixtureEnv = options.setupHome?.(home) ?? {};
    // Seed an owner-only journal before the host starts. HostDiagnosticsJournal
    // refuses a world-readable diagnostics.json and then logs nothing; the gate
    // would pair against a live herd and later read an empty file.
    const hostDataDir = join(muxrHome, 'host');
    mkdirSync(hostDataDir, { recursive: true, mode: 0o700 });
    chmodSync(hostDataDir, 0o700);
    const journalPath = join(hostDataDir, 'diagnostics.json');
    const startedAt = new Date().toISOString();
    writeFileSync(journalPath, `${JSON.stringify({
        version: 1,
        current: {
            hostVersion: 'gate',
            startedAt,
            updatedAt: startedAt,
            relayState: 'connecting',
            recentClientWindowMinutes: 15,
            recentClients: { local: 0, native: 0, browser: 0, peer: 0, unknown: 0 },
            relationships: { pending: 0, connected: 0, 'repair-needed': 0, disconnecting: 0, revoked: 0 },
        },
        events: [],
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(journalPath, 0o600);

    let relayPort;
    const hostHttpPort = await freePort();
    const children = [];
    // Which of our processes died, and whether we killed it. A gate that failed
    // because the host exited reads the same as one that timed out unless the
    // exit is recorded before cleanup takes it away. Names and numbers only:
    // logs carry pairing strings and paths.
    const health = [];
    let stopping = false;
    const track = (name, child) => {
        children.push(child);
        const entry = { name, pid: child.pid, exitCode: null, signal: null, deliberateCleanup: false };
        if (health.length < 16) health.push(entry);
        child.once('exit', (code, signal) => {
            entry.exitCode = code ?? null;
            entry.signal = signal ?? null;
            entry.deliberateCleanup = stopping;
        });
        return child;
    };
    let reversed = false;
    // The fake runs in its own process on purpose. In-process it shares an
    // event loop with the harness, and one blocking call here - a Maestro run,
    // an adb dump - freezes every Herdr answer, which the phone sees as a
    // 15-second stall and reports as "reconnecting".
    const fake = live ? { ...live, close() {} } : await spawnFakeHerdr(join(root, 'herdr'), options);
    if (fake.onExit !== undefined) {
        const entry = { name: 'herdr', pid: fake.pid, exitCode: null, signal: null, deliberateCleanup: false };
        health.push(entry);
        fake.onExit((code, signal) => {
            entry.exitCode = code ?? null;
            entry.signal = signal ?? null;
            entry.deliberateCleanup = stopping;
        });
    }
    // Older host heads resolve the default HOME socket instead of the env override.
    // Keep both paths inside this run's isolated infrastructure.
    if (!live) {
        mkdirSync(join(home, '.config/herdr'), { recursive: true });
        symlinkSync(fake.socketPath, join(home, '.config/herdr/herdr.sock'));
    }

    const stop = () => {
        stopping = true;
        for (const child of children.splice(0)) {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
        fake.close();
        // Only the reverse this run added: --remove-all would cut whatever else
        // on this desk is tunnelling to the emulator, and a run that never made
        // one -- loopback, or a failure before it -- must not reach for adb.
        if (reversed) {
            reversed = false;
            spawnSync('adb', androidArgs(['reverse', '--remove', `tcp:${relayPort}`]), { stdio: 'ignore', timeout: 10_000 });
        }
        rmSync(root, { recursive: true, force: true });
    };
    onCommandCleanup(stop);

    try {
        // The relay this run pairs against. Local authority mints the pairing
        // secret the CLI reads back below; E2EE stays on, as in production. The
        // bind host must be the one `self-host --connection-mode lan` would
        // choose, or the CLI refuses to adopt a relay it did not start.
        const relayLog = [];
        const relay = spawn(process.execPath, [join(sourceRoot, RELAY_ENTRY)], {
            cwd: sourceRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv(home, muxrHome, {
                MUXR_RELAY_PORT: '0',
                MUXR_RELAY_HOST: '127.0.0.1',
                MUXR_RELAY_DATA_DIR: join(muxrHome, 'relay'),
                MUXR_RELAY_LOCAL_AUTHORITY: '1',
                MUXR_RELAY_MDNS: '0',
                MUXR_HOST_HTTP_URL: `http://127.0.0.1:${hostHttpPort}`,
            }, live?.env),
        });
        track('relay', relay);
        relay.stdout.on('data', (chunk) => relayLog.push(String(chunk)));
        relay.stderr.on('data', (chunk) => relayLog.push(String(chunk)));
        relayPort = await waitForRelay(relay);
        if (relayPort === 8792 || relayPort === 8793) throw new Error('Lab relay bound a reserved port');
        if (!await relayHealthy(relayPort)) {
            throw new Error(`the relay never became healthy: ${relayLog.join('').trim().split('\n').slice(-3).join(' | ')}`);
        }

        // Machine identity and `selfhost.json`, written by the real CLI against
        // the relay above. `--relay-only` is the one path that mints identity
        // without installing or restarting a service unit.
        const identity = await run(process.execPath, [
            join(sourceRoot, 'scripts/cli.mjs'), 'self-host', '--relay-only',
            '--port', String(relayPort),
            '--advertise', `ws://127.0.0.1:${relayPort}`,
            '--connection-mode', 'lan',
            '--bind-loopback',
        ], { cwd: sourceRoot, env: childEnv(home, muxrHome, undefined, live?.env), timeout: 120_000 }).catch((cause) => {
            throw new Error(`self-host identity failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        });

        // Only an explicitly requested live probe connects to the real desk.
        const hostLog = [];
        const host = spawn(process.execPath, [join(sourceRoot, HOST_ENTRY)], {
            cwd: sourceRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv(live?.authHome ?? home, muxrHome, {
                MUXR_MODE: 'selfhost',
                MUXR_DATA_DIR: join(muxrHome, 'host'),
                MUXR_HOST_HTTP_PORT: String(hostHttpPort),
                MUXR_RELAY_URL: `ws://127.0.0.1:${relayPort}/relay`,
                HERDR_SOCKET_PATH: fake.socketPath,
                HERDR_CLIENT_SOCKET_PATH: fake.clientSocketPath,
                HERDR_BIN: fake.binPath,
                ...fixtureEnv,
            }, live?.env),
        });
        track('host', host);
        host.stdout.on('data', (chunk) => hostLog.push(String(chunk)));
        host.stderr.on('data', (chunk) => hostLog.push(String(chunk)));

        if (transport === 'adb') {
            await run('adb', androidArgs(['reverse', `tcp:${relayPort}`, `tcp:${relayPort}`]), { timeout: 60_000 });
            reversed = true;
        }

        return {
            root,
            transport,
            relayPort,
            hostHttpPort,
            dataDir: hostDataDir,
            journalPath,
            world: fake.world,
            // The panes a phase may name. Nothing else is a measurable surface:
            // a card position is whatever the churning herd left under it.
            fixturePanes: fake.fixturePanes,
            attachJsonl: fake.attachJsonl,
            inputJsonl: fake.inputJsonl,
            worldIdentityPath: fake.worldIdentityPath,
            // The service's own processes, for a memory budget. Terminal shims
            // are children of the host, so a tree walk from these covers them.
            // The stand-in for Herdr is reported apart from our own code.
            pids: { relay: relay.pid, host: host.pid },
            herdrPid: fake.pid,
            identity: (identity.stdout ?? '').trim().split('\n').pop(),
            hostLog: () => hostLog.join(''),
            /** Bounded, credential-free lifecycle of everything this run spawned. */
            childHealth: () => health.map((entry) => ({ ...entry })),
            relayLog: () => relayLog.join(''),
            /** The attach and re-grid records a measuring phase reads back. */
            cellMetricsJsonl: `${fake.socketPath}.cell-metrics.jsonl`,
            /** Consent only on the owner-only socket of this throwaway host. */
            mintPairing: async () => {
                const path = join(hostDataDir, 'pair.sock');
                for (let attempt = 0; attempt < 100 && !existsSync(path); attempt += 1) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
                if (!existsSync(path)) throw new Error('lab host pairing socket did not start');
                const socket = createConnection(path);
                let pending = '';
                let consentWords;
                const code = await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('lab pairing offer timed out')), 20_000);
                    const fail = (error) => { clearTimeout(timeout); reject(error); };
                    socket.on('error', fail);
                    socket.on('close', () => fail(new Error('lab pairing socket closed')));
                    socket.on('connect', () => socket.write('{"intent":{"kind":"native","authority":"control","personal":false}}\n'));
                    socket.on('data', (chunk) => {
                        pending += String(chunk);
                        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
                            let event;
                            try { event = JSON.parse(pending.slice(0, end)); } catch (error) { fail(error); return; }
                            pending = pending.slice(end + 1);
                            if (event.offer) { clearTimeout(timeout); resolve(event.offer.text); }
                            if (event.approval) {
                                consentWords = event.approval.words;
                                socket.write('{"yes":true}\n');
                            }
                            if (event.error) fail(new Error(event.error));
                        }
                    });
                });
                return { code, get consentWords() { return consentWords; }, release: () => socket.destroy() };
            },
            stop,
        };
    } catch (cause) {
        stop();
        throw cause;
    }
}
