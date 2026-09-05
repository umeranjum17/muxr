/**
 * yarn dev — one command for the full local presentation loop:
 *
 *   1. `yarn build` once (workspace tsc outputs + attachment preview bundle).
 *   2. `tsc --build --watch` for incremental workspace recompilation.
 *   3. `yarn up`-style real relay + host under an isolated MUXR_HOME in
 *      `.cache/muxr-dev`, restarted whenever the watcher finishes a clean
 *      (zero-error) recompile. A TS error keeps the last known good
 *      host/relay running.
 *   4. Expo Metro (`expo start --dev-client --localhost`) on port 8081 so the
 *      dev client (`exp+muxr-dev://`) gets Fast Refresh from source.
 *
 * Native (Gradle) changes are NOT rebuilt here — run `yarn dev:android` for
 * that. The offline attachment renderer is watched separately by esbuild.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage: yarn dev

Starts the full local presentation dev loop:
  - one \`yarn build\`, then \`tsc --build --watch\`
  - real relay + host (via scripts/setup/presentation/up.mjs) with an
    isolated MUXR_HOME at .cache/muxr-dev, restarted on each clean recompile
  - Expo Metro (dev client, localhost) with Fast Refresh
  - attachment preview bundle watcher (regenerates its .bin on edits)

Options:
  --help           This text.

Ports are pre-checked: an occupied port fails the command instead of
killing whatever owns it. Ctrl-C stops everything this command started.
Native changes still need \`yarn dev:android\` (explicit APK rebuild).
`);
    process.exit(0);
}
if (args.length > 0) {
    process.stderr.write('Unknown arguments. Use yarn dev --help.\n');
    process.exit(1);
}
const metroPort = 8081;
const relayPort = 18792;
const hostHttpPort = 18793;

// ---------------------------------------------------------------- state

const children = new Map(); // label -> child
let shuttingDown = false;
let exitCode = 0;

// ------------------------------------------------- sanitized environment
// Inherited MUXR_*/EXPO_PUBLIC_MUXR* config (tokens, auth modes, data dirs,
// authority flags) is dropped wholesale so a stray shell can never point the
// dev harness at a real service or leak dev state into the installed
// host/relay. up.mjs re-adds the loopback development defaults it owns; we
// pin the rest explicitly.
const devEnvBase = {};
for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^MUXR_/.test(name) && !/^EXPO_PUBLIC_MUXR/.test(name)) devEnvBase[name] = value;
}
delete devEnvBase.CI;

const muxrHome = join(root, '.cache', 'muxr-dev');

const upEnv = {
    ...devEnvBase,
    MUXR_HOME: muxrHome,
    // relay's defaultDataDir ignores MUXR_HOME; pin both data dirs explicitly.
    MUXR_RELAY_DATA_DIR: join(muxrHome, 'relay'),
    MUXR_DATA_DIR: join(muxrHome, 'host'),
    MUXR_RELAY_HOST: '127.0.0.1',
    MUXR_RELAY_PORT: String(relayPort),
    MUXR_HOST_HTTP_PORT: String(hostHttpPort),
    MUXR_MACHINE_ID: 'devbox',
};

const metroEnv = {
    ...devEnvBase,
    EXPO_NO_DOTENV: '1',
    EXPO_NO_CLIENT_ENV_VARS: '0',
    APP_ENV: 'development',
    EXPO_PUBLIC_MUXR_MODE: 'local',
    EXPO_PUBLIC_MUXR_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    EXPO_PUBLIC_MUXR_MACHINE_ID: 'devbox',
    EXPO_NO_TELEMETRY: '1',
};

// ---------------------------------------------------------------- utils

function prefixOutput(child, label) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    for (const stream of [child.stdout, child.stderr]) {
        let buffered = '';
        stream.on('data', (chunk) => {
            buffered += chunk;
            const lines = buffered.split('\n');
            buffered = lines.pop();
            for (const line of lines) {
                if (line.trim().length > 0) process.stdout.write(`${label} | ${line}\n`);
            }
        });
        stream.on('end', () => {
            if (buffered.trim().length > 0) process.stdout.write(`${label} | ${buffered}\n`);
        });
    }
}

function portInUse(candidate) {
    return new Promise((resolve) => {
        const probe = connect({ port: candidate, host: '127.0.0.1' });
        probe.setTimeout(700);
        const settle = (answer) => { probe.destroy(); resolve(answer); };
        probe.on('connect', () => settle(true));
        probe.on('error', () => settle(false));
        probe.on('timeout', () => settle(false));
    });
}

function groupKill(child, signal) {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
        process.kill(-child.pid, signal); // detached: own process group
    } catch {
        child.kill(signal);
    }
}

function killChildren(signal = 'SIGTERM') {
    for (const child of children.values()) groupKill(child, signal);
}

function exitWhenChildrenDone(code = 0) {
    exitCode = code;
    const pending = [...children.values()].filter((child) => child.exitCode === null);
    if (pending.length === 0) {
        process.exit(exitCode);
        return;
    }
    let left = pending.length;
    for (const child of pending) {
        child.once('exit', () => {
            left -= 1;
            if (left === 0) process.exit(exitCode);
        });
    }
    setTimeout(() => {
        killChildren('SIGKILL');
        process.exit(exitCode);
    }, 3000).unref();
}

function finish(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write('\nShutting down dev supervisor...\n');
    killChildren('SIGTERM');
    exitWhenChildrenDone(code);
}

function onChildExit(label, code, signal) {
    children.delete(label);
    if (shuttingDown) return;
    shuttingDown = true;
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    process.stderr.write(`\n${label} exited (${detail}). Stopping the dev loop.\n`);
    killChildren('SIGTERM');
    exitWhenChildrenDone(code || 1);
}

function runOnce(label, command, cmdArgs, env, cwd) {
    return new Promise((resolve) => {
        const child = spawn(command, cmdArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        children.set(label, child);
        prefixOutput(child, label);
        child.on('error', (error) => { children.delete(label); process.stderr.write(`${label}: ${error.message}\n`); finish(1); });
        child.on('exit', (code, signal) => { children.delete(label); resolve(signal ? 1 : (code ?? 1)); });
    });
}

function startChild(label, command, cmdArgs, env, cwd) {
    // detached + negative-pid kills let us take relay/host grandchildren with
    // the `up` supervisor, and metro/watch trees on interrupt.
    const child = spawn(command, cmdArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.set(label, child);
    prefixOutput(child, label);
    child.on('error', (error) => { children.delete(label); process.stderr.write(`${label}: ${error.message}\n`); finish(1); });
    child.on('exit', (code, signal) => {
        // A replaced child (e.g. the previous `up` during a restart) must not
        // be mistaken for the current one shutting the whole loop down.
        if (children.get(label) !== child) return;
        onChildExit(label, code, signal);
    });
    return child;
}

const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const expoBin = join(root, 'node_modules', '.bin', 'expo');

// ---------------------------------------------------------------- restartable up supervisor

let upChild = null;
let upStarting = false;

async function restartUp() {
    if (shuttingDown || upStarting) return;
    upStarting = true;
    if (upChild !== null && upChild.exitCode === null) {
        const old = upChild;
        // Unregister BEFORE killing so the old child's exit event cannot be
        // mistaken for the current supervisor dying (it exits 0 on SIGTERM).
        if (children.get('up') === old) children.delete('up');
        groupKill(old, 'SIGTERM');
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                groupKill(old, 'SIGKILL');
                resolve();
            }, 5000).unref();
            old.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
    if (shuttingDown) { upStarting = false; return; }
    process.stdout.write('dev | starting relay + host (isolated MUXR_HOME: .cache/muxr-dev)\n');
    upChild = startChild('up', process.execPath, [join(root, 'scripts', 'setup', 'presentation', 'up.mjs'), '--quiet'], upEnv, root);
    upStarting = false;
}

// ---------------------------------------------------------------- preflight

for (const [name, port] of [['metro', metroPort], ['relay', relayPort], ['downloads', hostHttpPort]]) {
    if (await portInUse(port)) {
        process.stderr.write(
            `Port ${port} (${name}) is already in use. Stop the existing process first;\n`
            + `this command never kills processes it did not start.\n`,
        );
        process.exit(1);
    }
}

process.on('SIGINT', () => { process.stdout.write('\n'); finish(0); });
process.on('SIGTERM', () => finish(0));

mkdirSync(muxrHome, { recursive: true });

// ---------------------------------------------------------------- initial build

process.stdout.write('dev | initial yarn build (workspace outputs + attachment preview bundle)\n');
if ((await runOnce('build', 'yarn', ['build'], devEnvBase, root)) !== 0) {
    process.stderr.write('dev | initial build failed; fix the errors and rerun `yarn dev`.\n');
    process.exit(1);
}

// ---------------------------------------------------------------- watchers

// Metro stays up for the whole session and sees compiled workspace updates.
// Expo binds "localhost"; prefer IPv4 so adb reverse and the printed URL agree.
startChild('metro', process.execPath, ['--dns-result-order=ipv4first', expoBin, 'start', '--dev-client', '--localhost', '--scheme', 'exp+muxr-dev', '--port', String(metroPort)], metroEnv, join(root, 'apps', 'mobile'));

// Regenerates sources/components/attachment/preview.bundle.bin on source
// edits so Metro picks up attachment preview changes without a full build.
startChild('preview', process.execPath, [join(root, 'apps', 'mobile', 'scripts', 'buildAttachmentPreview.mjs'), '--watch'], devEnvBase, root);

const tsc = startChild('tsc', process.execPath, [tscBin, '--build', '--watch', '--pretty', 'false', '--preserveWatchOutput'], devEnvBase, root);
createInterface({ input: tsc.stdout }).on('line', (line) => {
    const pass = /Found (\d+) errors?\. Watching for file changes\./.exec(line);
    if (!pass) return;
    if (Number(pass[1]) !== 0) {
        process.stdout.write(`dev | compile finished with ${pass[1]} error(s); keeping last known good host/relay\n`);
        return;
    }
    process.stdout.write('dev | clean compile; starting/restarting host/relay on fresh outputs\n');
    void restartUp().catch((error) => { process.stderr.write(`${error.message}\n`); finish(1); });
});

// ---------------------------------------------------------------- banner

const readyDeadline = Date.now() + 90_000;
// The host's download listener starts lazily when the first client connects.
while (!(await Promise.all([metroPort, relayPort].map(portInUse))).every(Boolean)) {
    if (Date.now() > readyDeadline) {
        process.stderr.write('Dev services did not become ready; inspect the process logs above.\n');
        finish(1);
        await new Promise(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
}

process.stdout.write(`
muxr dev supervisor
  Metro (dev client):  http://localhost:${metroPort}   (exp+muxr-dev://)
  Relay:               ws://127.0.0.1:${relayPort}      (loopback only)
  Attachment downloads: http://127.0.0.1:${hostHttpPort}
  Host machine:        devbox   (MUXR_HOME=.cache/muxr-dev)
  Native rebuild:      NOT automatic — run \`yarn dev:android\` after Gradle/
                       native changes. Attachment preview bundle is watched.
  Stop:                Ctrl-C (kills metro, watcher, relay, host).

muxr dev: READY — open the muxr Dev app on the emulator (exp+muxr-dev://)
`);


await new Promise(() => {});
