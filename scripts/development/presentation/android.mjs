/**
 * Native development client bootstrap: build/install/open the `app.muxr.local.dev`
 * debug APK (label "muxr Dev") on one pinned emulator, then point the Expo dev
 * client at the Metro server started by `yarn dev`.
 *
 * This is the explicit action for native changes (gradle files, native modules,
 * patch-package patches). Pure JS/TS iteration needs none of this: keep `yarn dev`
 * running and Fast Refresh reloads in place.
 *
 * Emulator-only by design: the dev app exposes a synthetic loopback account and
 * cleartext loopback transport. Real phones go through `muxr setup`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const androidDir = join(root, 'apps/mobile/android');
const debugApk = join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk');
const patchGuard = join(root, 'scripts/diagnostics/application/verifyNativePatches.mjs');
const developmentAppId = 'app.muxr.local.dev';
const metroPort = 8081;
const relayPort = 18792;
const hostHttpPort = 18793;
const supportedAbis = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
const devClientUrl = `exp+muxr-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${metroPort}`;

function env(name) {
    return process.env[name]?.trim() || undefined;
}

function usage() {
    process.stdout.write(`
yarn dev:android — build, install, and open the muxr development client on an emulator

Usage: node scripts/development/presentation/android.mjs [--device <serial>] [--no-build]

Options:
  --device <serial>  Emulator serial to use (e.g. emulator-5554).
                     Defaults to ANDROID_SERIAL, then emulator-5554.
                     Physical devices are never accepted here; use \`muxr setup\`.
  --no-build         Skip the gradle build and patch guard. Requires the
                     development app to already be installed on the emulator.
                     Does not verify that the installed APK matches current
                     native sources; rerun the full command after any native change.
  --help             Show this help.

Prerequisite: Metro must already be running via \`yarn dev\` (port ${metroPort}).
`);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
}
let noBuild = false;
let deviceFlag;
const unknown = [];
for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-build') noBuild = true;
    else if (arg === '--device') {
        if (!argv[index + 1]) {
            process.stderr.write('--device requires an emulator serial, e.g. --device emulator-5554\n');
            process.exit(1);
        }
        deviceFlag = argv[index += 1];
    } else unknown.push(arg);
}
if (unknown.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknown.join(' ')}\n\n`);
    usage();
    process.exit(1);
}
const requestedSerial = deviceFlag ?? env('ANDROID_SERIAL') ?? 'emulator-5554';
if (!/^emulator-\d+$/.test(requestedSerial)) {
    process.stderr.write(
        `"${requestedSerial}" is not an emulator serial. This script only drives emulators`
            + ` (serials like emulator-5554); the development app is loopback-only and must`
            + ` not be installed on real devices. Use \`muxr setup\` for a phone.\n`,
    );
    process.exit(1);
}

let buildChild;

function finish(code) {
    if (buildChild?.pid) {
        // The child's exit handler below reports the interruption and exits.
        try {
            process.kill(-buildChild.pid, 'SIGTERM');
        } catch {
            // already gone
        }
        return;
    }
    process.exit(code);
}

process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));

function run(command, args, options = {}) {
    return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function adbArgs(args) {
    return [`-s`, requestedSerial, ...args];
}

function fail(message) {
    process.stderr.write(`\n${message}\n`);
    process.exit(1);
}

function adbExists() {
    for (const candidate of [env('ANDROID_HOME'), env('ANDROID_SDK_ROOT'), join(env('HOME') ?? '', 'Android/Sdk')]) {
        if (candidate && existsSync(join(candidate, 'platform-tools/adb'))) return join(candidate, 'platform-tools/adb');
    }
    const found = run('which', ['adb']);
    return found.status === 0 ? found.stdout.trim() : undefined;
}

function isPortOpen(port) {
    return new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.setTimeout(1500, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

// Only the pinned serial is inspected, so no other attached device (and
// especially no phone) is ever touched.
function assertSelectedEmulator(adb) {
    const state = run(adb, adbArgs(['get-state']));
    if (state.status === 0 && state.stdout.trim() === 'device') return;
    const listing = run(adb, ['devices']);
    const emulators = (listing.stdout ?? '')
        .split('\n')
        .slice(1)
        .map((line) => line.split('\t')[0]?.trim())
        .filter((serial) => /^emulator-\d+$/.test(serial));
    fail(
        `Emulator ${requestedSerial} is not connected`
            + (emulators.length > 0 ? `; running emulators: ${emulators.join(', ')}` : '; no emulators running')
            + `. Start one (e.g. Android Studio > Device Manager) or pass --device <serial>.`,
    );
}

function resolveAbi(adb) {
    const result = run(adb, adbArgs(['shell', 'getprop', 'ro.product.cpu.abi']));
    const abi = result.stdout?.trim();
    if (!supportedAbis.includes(abi)) {
        fail(
            `Emulator ${requestedSerial} reports ABI "${abi || 'unknown'}"; expected one of ${supportedAbis.join(', ')}.`
                + ` The gradle build would produce a native library set that cannot run on it.`,
        );
    }
    return abi;
}

function findVerifyTool() {
    const sdkCandidates = [env('ANDROID_HOME'), env('ANDROID_SDK_ROOT'), join(env('HOME') ?? '', 'Android/Sdk')]
        .filter((candidate) => candidate && existsSync(candidate));
    const candidates = [];
    for (const sdk of sdkCandidates) {
        const buildToolsDir = join(sdk, 'build-tools');
        if (existsSync(buildToolsDir)) {
            for (const version of readdirSync(buildToolsDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse()) {
                for (const tool of ['aapt', 'aapt2']) {
                    const path = join(buildToolsDir, version, tool);
                    if (existsSync(path)) candidates.push({ path, kind: tool });
                }
            }
        }
        for (const cmdTools of ['cmdline-tools/latest/bin', 'tools/bin']) {
            const path = join(sdk, cmdTools, 'apkanalyzer');
            if (existsSync(path)) candidates.push({ path, kind: 'apkanalyzer' });
        }
    }
    for (const dir of (process.env.PATH ?? '').split(':')) {
        for (const tool of ['aapt', 'aapt2', 'apkanalyzer']) {
            const path = join(dir, tool);
            if (existsSync(path)) candidates.push({ path, kind: tool });
        }
    }
    return candidates;
}

function verifyApk(verifier) {
    if (verifier.kind === 'apkanalyzer') {
        const id = run(verifier.path, ['manifest', 'application-id', debugApk]);
        if (id.status !== 0) return undefined;
        const debuggable = run(verifier.path, ['manifest', 'debuggable', debugApk]);
        if (debuggable.status !== 0) return undefined;
        return {
            package: id.stdout.trim(),
            debuggable: debuggable.stdout.trim().toLowerCase() === 'true',
        };
    }
    const badging = run(verifier.path, ['dump', 'badging', debugApk]);
    if (badging.status !== 0) return undefined;
    const packageName = /^package: name='([^']+)'/m.exec(badging.stdout)?.[1];
    if (!packageName) return undefined;
    const manifest = run(verifier.path, ['dump', 'xmltree', debugApk, 'AndroidManifest.xml']);
    if (manifest.status !== 0) return undefined;
    const debuggableRaw = manifest.stdout
        .split('\n')
        .find((line) => line.includes(':debuggable'));
    const debuggable = /0xffffffff|=true\b/.test(debuggableRaw ?? '');
    return { package: packageName, debuggable };
}

async function buildDevelopmentApk(abi) {
    if (!existsSync(join(androidDir, 'gradlew'))) {
        fail(`Missing ${androidDir}/gradlew; the android project is expected to be committed.`);
    }
    const guard = run(process.execPath, [patchGuard], { cwd: root, stdio: 'inherit' });
    if (guard.status !== 0) {
        fail('Native patch guard failed; node_modules do not match patches/. Reinstall dependencies (yarn) before building.');
    }
    process.stdout.write(`\nBuilding the development APK for ${abi} (gradle, no daemon, 4 workers)...\n`);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('-')[0];
    buildChild = spawn('./gradlew', [
        'app:assembleDebug',
        '--no-daemon',
        '--max-workers=4',
        `-PreactNativeArchitectures=${abi}`,
        '-PmuxrDevelopmentApp=true',
        `-PappVersion=${version}`,
    ], {
        cwd: androidDir,
        stdio: 'inherit',
        detached: true,
        env: { ...process.env, APP_ENV: 'development' },
    });
    await new Promise((resolve) => {
        buildChild.on('exit', (code, signal) => {
            if (signal) {
                process.stderr.write(`\nBuild interrupted (${signal}); no APK was installed.\n`);
                process.exit(130);
            }
            if (code !== 0) {
                process.stderr.write(`\nGradle build failed with exit code ${code}. The development APK requires`
                    + ` APP_ENV=development and -PmuxrDevelopmentApp=true; both are set by this script.\n`);
                process.exit(1);
            }
            resolve();
        });
    });
    buildChild = undefined;
}

const adb = adbExists();
if (!adb) {
    fail(
        'adb was not found. Install Android platform-tools and set ANDROID_HOME'
            + ' (e.g. ANDROID_HOME=$HOME/Android/Sdk) or add platform-tools to PATH.',
    );
}

// Fail before any long work when Metro is missing: without it the dev client
// would launch into an error screen or bundle an unexpected fallback.
if (!(await isPortOpen(metroPort))) {
    fail(
        `Metro is not listening on 127.0.0.1:${metroPort}. Start it first with:\n\n`
            + `    yarn dev\n\n`
            + `That also brings up the loopback relay supervisor on ${relayPort}. Re-run this command once Metro reports it is ready.`,
    );
}
if (!(await isPortOpen(relayPort))) {
    process.stderr.write(`Warning: nothing is listening on 127.0.0.1:${relayPort}; the dev app will connect to Metro but not to the relay.\n`);
}

assertSelectedEmulator(adb);
const abi = resolveAbi(adb);

if (noBuild) {
    const installed = run(adb, adbArgs(['shell', 'pm', 'path', developmentAppId]));
    if (installed.status !== 0 || !installed.stdout.includes('.apk')) {
        fail(
            `--no-build expects ${developmentAppId} to already be installed on ${requestedSerial}, but it is not.`
                + ` Run the full command (without --no-build) once to build and install it.`,
        );
    }
    process.stdout.write(`--no-build: reusing the installed ${developmentAppId} APK.`
        + ` This does not check native freshness; after any gradle property, native module, or patches/ change,`
        + ` rerun without --no-build.\n`);
} else {
    await buildDevelopmentApk(abi);

    if (!existsSync(debugApk)) {
        fail(`Expected the built APK at ${debugApk} but it is missing; the gradle build did not produce it.`);
    }

    const verifiers = findVerifyTool();
    if (verifiers.length === 0) {
        fail(
            'Neither aapt/aapt2 (build-tools) nor apkanalyzer (cmdline-tools) was found in'
                + ' ANDROID_HOME, so the APK identity cannot be verified. Install Android build-tools'
                + ' and cmdline-tools, then re-run. No APK was installed.',
        );
    }
    let verified;
    for (const verifier of verifiers) {
        verified = verifyApk(verifier);
        if (verified) break;
    }
    if (!verified) {
        fail('The installed verification tools could not read the APK identity. No APK was installed.');
    }
    if (verified.package !== developmentAppId) {
        fail(
            `APK identity mismatch: built package is ${verified.package}, expected ${developmentAppId}.`
                + ` The build must use APP_ENV=development and -PmuxrDevelopmentApp=true. No APK was installed.`,
        );
    }
    if (!verified.debuggable) {
        fail('The built APK is not debuggable, so the Expo dev client cannot load Metro. No APK was installed.');
    }
    process.stdout.write(`Verified APK: package=${verified.package}, debuggable=true\n`);

    process.stdout.write('Installing development APK (adb install -r)...\n');
    buildChild = spawn(adb, adbArgs(['install', '-r', debugApk]), { stdio: 'inherit', detached: true });
    const install = buildChild;
    await new Promise((resolve) => {
        install.on('exit', (code, signal) => {
            if (signal) {
                process.stderr.write(`\nInstall interrupted (${signal}).\n`);
                process.exit(130);
            }
            resolve();
        });
    });
    buildChild = undefined;
    if (install.exitCode !== 0) {
        fail('adb install failed. If the error mentions signatures, uninstall the stale dev build manually on the emulator (never the production app) and re-run.');
    }
}

for (const port of [metroPort, relayPort, hostHttpPort]) {
    const reverse = run(adb, adbArgs(['reverse', `tcp:${port}`, `tcp:${port}`]));
    if (reverse.status !== 0) {
        fail(`adb reverse tcp:${port} failed: ${reverse.stderr?.trim() || reverse.stdout?.trim() || 'unknown error'}. Is ${requestedSerial} still online?`);
    }
}

const launch = run(adb, adbArgs([
    'shell',
    `am start -a android.intent.action.VIEW -d "${devClientUrl}" -p ${developmentAppId}`,
]));
if (launch.status !== 0) {
    fail(`Failed to open the dev client on ${requestedSerial}: ${launch.stderr?.trim() || launch.stdout?.trim()}`);
}

process.stdout.write(`
muxr Dev (${developmentAppId}) is open on ${requestedSerial}, pointed at Metro
  http://127.0.0.1:${metroPort} via adb reverse, relay via tcp:${relayPort}.

- JS/TS edits: just save; Fast Refresh applies through Metro. No rebuild.
- Native changes (gradle, native modules, patches/): re-run \`yarn dev:android\`.
`);
process.exit(0);
