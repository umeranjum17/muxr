/**
 * Own one Android emulator for a native perf run.
 *
 * A native matrix needs an emulator that is really up before it adb-reverses a
 * relay port or installs an APK. The scratch launchers that did this by hand
 * got it wrong in three ways worth naming, because each is a way any caller can
 * go wrong:
 *
 * - The AVD and the emulator must agree on one AVD home. `avdmanager` and
 *   `emulator` can resolve different defaults on the same host, and a launcher
 *   that overrides `ANDROID_AVD_HOME` only for the emulator points it at a home
 *   the AVD was never created in: the emulator exits "Unknown AVD name", and a
 *   boot wait on `sys.boot_completed` burns its whole timeout before failing.
 *   Everything here is created and launched with the same explicit AVD home.
 * - A device that never booted is not the same as a device that is missing.
 *   Waiting on `getprop` cannot tell an emulator that exited from one that is
 *   slow, so the wait watches the child too and reports the log the moment it
 *   is gone.
 * - Booting is not the same as ready. `sys.boot_completed=1` is set before the
 *   package manager accepts work, so an install run right after it races. The
 *   wait also requires `pm path android` to answer.
 *
 * The serial is discovered from the emulator's own AVD name rather than pinned
 * to a port, so two callers choosing the same port cannot measure each other's
 * device. Every adb call names the serial; the server is never restarted.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { runCommand as run } from './commands.mjs';
import { setAndroidSerial } from './deviceTarget.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sdkRoot = () => process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? '';
const emulatorBin = () => process.env.MUXR_EMULATOR_BIN ?? join(sdkRoot(), 'emulator', 'emulator');
const avdmanagerBin = () => process.env.MUXR_AVDMANAGER_BIN ?? join(sdkRoot(), 'cmdline-tools', 'latest', 'bin', 'avdmanager');
const DEFAULT_IMAGE = 'system-images;android-35;google_apis;x86_64';

/** Emulators already running on this host. The fleet cap counts every one. */
export async function runningEmulatorCount() {
    try { const { stdout } = await exec('pgrep', ['-c', '^qemu-system']); return Number(stdout.trim()) || 0; } catch { return 0; }
}

async function adbDevices() {
    const { stdout } = await run('adb', ['devices'], { timeout: 15_000 });
    return stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[0]?.startsWith('emulator-')).map((parts) => parts[0]);
}

function tail(text, lines = 6) {
    return text.trim().split('\n').slice(-lines).join('\n');
}

/** Create the AVD under the home the emulator will search, so they cannot disagree. */
export async function ensureAvd({ name, avdHome, systemImage = DEFAULT_IMAGE, device = 'pixel_6' }) {
    if (typeof name !== 'string' || name.trim() === '' || name.includes('/')) throw new Error('a task-owned AVD name is required');
    if (typeof avdHome !== 'string' || !avdHome.startsWith('/')) throw new Error('an absolute task-owned AVD home is required');
    mkdirSync(avdHome, { recursive: true });
    if (existsSync(join(avdHome, `${name}.ini`))) return;
    // The emulator searches ANDROID_AVD_HOME first; avdmanager honours it too, so
    // setting it here is what makes the create and the launch agree.
    const env = { ...process.env, ANDROID_AVD_HOME: avdHome };
    try {
        await exec(avdmanagerBin(), ['create', 'avd', '-n', name, '-k', systemImage, '-d', device, '--force'],
            { env, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (cause) {
        throw new Error(`avdmanager could not create ${name}: ${tail(String(cause?.stderr ?? cause?.message ?? cause))}`);
    }
    if (!existsSync(join(avdHome, `${name}.ini`))) throw new Error(`avdmanager created no AVD at ${avdHome}`);
}

/**
 * Boot one emulator this run owns and return its serial pinned for adb.
 *
 * @param {{ name: string, avdHome: string, systemImage?: string, device?: string,
 *   bootTimeoutMs?: number, maxEmulators?: number, extraArgs?: string[],
 *   launcher?: string[] }} options
 *   `launcher` is a command prefix the emulator is started through, so a host
 *   can run it under its own memory gate or device lock. Empty means run it
 *   directly.
 * @returns {Promise<{ serial: string, avd: string, pid: number, log: () => string,
 *   stop: () => Promise<void> }>}
 */
export async function bootOwnedEmulator(options) {
    const {
        name, avdHome, systemImage = DEFAULT_IMAGE, device = 'pixel_6',
        bootTimeoutMs = 480_000, maxEmulators = Number(process.env.MUXR_EMULATOR_MAX ?? 3),
        extraArgs = [], launcher = [],
    } = options;
    // With a launcher the launcher owns capacity and may wait for a slot; on its
    // own, refuse rather than push the fleet past its cap.
    const already = await runningEmulatorCount();
    if (launcher.length === 0 && already >= maxEmulators) {
        throw new Error(`refusing to start ${name}: ${already} emulators already run on this host (cap ${maxEmulators})`);
    }
    await ensureAvd({ name, avdHome, systemImage, device });
    const known = new Set(await adbDevices());
    const args = ['-avd', name, '-no-window', '-gpu', 'swiftshader_indirect', '-memory', '2048', '-cores', '2',
        '-no-audio', '-no-boot-anim', '-no-snapshot-save', ...extraArgs];
    const [bin, ...prefix] = launcher.length === 0 ? [emulatorBin()] : launcher;
    const child = spawn(bin, [...prefix, emulatorBin(), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, ANDROID_AVD_HOME: avdHome },
    });
    const log = [];
    child.stdout.on('data', (chunk) => log.push(String(chunk)));
    child.stderr.on('data', (chunk) => log.push(String(chunk)));
    let exited = null;
    child.once('exit', (code, signal) => { exited = { code, signal }; });
    // The child is its own process group, so a launcher that wraps the
    // emulator (timeout, device lock, memory gate) is torn down whole and cannot
    // leave a surviving emulator holding a fleet slot.
    const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } } };
    const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
    const terminate = async () => {
        killGroup('SIGTERM');
        for (let attempt = 0; attempt < 30 && groupAlive(); attempt += 1) await sleep(1000);
        killGroup('SIGKILL');
    };
    const died = () => `the emulator exited before ${name} booted (${exited.signal ?? `code ${exited.code}`}):\n${tail(log.join(''))}`;

    const serial = await (async () => {
        const deadline = Date.now() + bootTimeoutMs;
        while (Date.now() < deadline) {
            if (exited !== null) throw new Error(died());
            for (const candidate of await adbDevices()) {
                if (known.has(candidate)) continue;
                const avd = await run('adb', ['-s', candidate, 'emu', 'avd', 'name'], { timeout: 10_000 }).catch(() => null);
                if (avd !== null && avd.stdout.split('\n')[0].trim() === name) return candidate;
            }
            await sleep(2000);
        }
        // A launcher still waiting (a memory gate holding for a slot) would start
        // an emulator nobody owns after this run has given up on it.
        await terminate();
        throw new Error(`no device for AVD ${name} appeared within ${bootTimeoutMs} ms:\n${tail(log.join(''))}`);
    })();
    setAndroidSerial(serial);

    const stop = async () => {
        await run('adb', ['-s', serial, 'emu', 'kill'], { timeout: 15_000 }).catch(() => undefined);
        await terminate();
    };

    try {
        const deadline = Date.now() + bootTimeoutMs;
        await run('adb', ['-s', serial, 'wait-for-device'], { timeout: Math.min(120_000, bootTimeoutMs) }).catch(() => undefined);
        while (Date.now() < deadline) {
            if (exited !== null) throw new Error(died());
            const boot = await run('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 15_000 })
                .then((r) => r.stdout.trim()).catch(() => '');
            const pm = await run('adb', ['-s', serial, 'shell', 'pm', 'path', 'android'], { timeout: 15_000 })
                .then((r) => r.stdout.trim()).catch(() => '');
            if (boot === '1' && pm.startsWith('package:')) {
                return { serial, avd: name, pid: child.pid, log: () => log.join(''), stop };
            }
            await sleep(3000);
        }
        throw new Error(`AVD ${name} (${serial}) never finished booting (sys.boot_completed and package manager) within ${bootTimeoutMs} ms`);
    } catch (error) {
        await stop();
        throw error;
    }
}
