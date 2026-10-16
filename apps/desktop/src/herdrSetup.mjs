/**
 * Herdr runs the agents, and on a computer with only this app nothing else
 * installs or starts it. This owns that: it says whether Herdr is missing,
 * installs the published release (the same herdr.dev installer `muxr setup`
 * runs, into the user's own folder, no root), and starts its server. The host
 * keeps retrying Herdr's socket, so the phone's agents appear without a restart.
 *
 * Status: 'ok', 'missing', 'installing' (with a step) or 'failed' (with one
 * plain sentence; the raw cause goes to the log).
 */
import { dirname } from 'node:path';
import { ensureHerdrServer, findHerdrBin, runHerdrInstaller } from '../../../scripts/setup/infrastructure/herdr.mjs';

const INSTALL_MESSAGE = "Couldn't install Herdr. Check this computer's internet connection, then press Try again.";
const START_MESSAGE = "Herdr is installed but didn't start. Choose Try again.";

function detail(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The AppImage runtime points PATH, LD_LIBRARY_PATH and XDG_DATA_DIRS into its
 * own mount. Herdr outlives this app and every terminal inherits its
 * environment, so it starts with the user's own. An extracted AppImage's
 * AppRun does not export APPDIR; there the app folder is the binary's own.
 */
function userEnv() {
    const appDir = process.env.APPDIR ?? (process.versions.electron ? dirname(process.execPath) : undefined);
    if (!appDir) return process.env;
    const env = { ...process.env };
    for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[key];
    for (const key of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
        const kept = (env[key] ?? '').split(':').filter((entry) => entry !== '' && entry !== appDir && !entry.startsWith(`${appDir}/`));
        if (kept.length > 0) env[key] = kept.join(':');
        else delete env[key];
    }
    return env;
}

function findHerdr() {
    return findHerdrBin((error) => process.stderr.write(`desktop: herdr lookup: ${detail(error)}\n`));
}

export function createHerdrSetup(onChange) {
    let current = { status: 'ok' };
    const set = (next) => { current = next; onChange(next); };

    // One start at a time: an Install pressed while the online start runs joins it.
    let starting;
    function startServer(binary) {
        starting ??= (async () => {
            try {
                await ensureHerdrServer(binary, false, true, userEnv());
                set({ status: 'ok' });
            } catch (error) {
                process.stderr.write(`desktop: herdr server: ${detail(error)}\n`);
                set({ status: 'failed', message: START_MESSAGE });
            } finally {
                starting = undefined;
            }
        })();
        return starting;
    }

    /** Install and Try again: install when missing, then start the server. */
    async function install() {
        if (current.status === 'installing') return;
        let binary = findHerdr();
        if (binary === undefined) {
            set({ status: 'installing', step: 'Downloading Herdr…' });
            try {
                await runHerdrInstaller(userEnv());
                binary = findHerdr();
                if (binary === undefined) throw new Error('the installer finished but no herdr binary was found');
            } catch (error) {
                process.stderr.write(`desktop: herdr install: ${detail(error)}\n`);
                set({ status: 'failed', message: INSTALL_MESSAGE });
                return;
            }
        }
        set({ status: 'installing', step: 'Starting Herdr…' });
        await startServer(binary);
    }

    return {
        get state() { return current; },
        install,
        /**
         * At launch, before the runtime knows whether this desktop owns the
         * computer: say Herdr is missing, start nothing. A retried start and a
         * failed install keep the state they already showed.
         */
        check() {
            if (current.status === 'ok' && findHerdr() === undefined) set({ status: 'missing' });
        },
        /** Every runtime status goes here. Only 'online' means this desktop owns the computer, so only then is Herdr started. */
        async observeRuntime(event) {
            if (event.phase !== 'online' || current.status === 'installing') return;
            const binary = findHerdr();
            if (binary === undefined) set({ status: 'missing' });
            else await startServer(binary);
        },
    };
}

/**
 * The desktop app's whole Herdr rule, so `main.mjs` and the runtime
 * integration test drive the same code: the launch check says whether Herdr is
 * there, and every MuxrRuntime status event decides what happens next. Nothing
 * starts Herdr before the runtime reports 'online', which is the only status
 * that means this desktop owns the computer.
 */
export function wireHerdrToRuntime(runtime, herdr) {
    runtime.on('status', (event) => { void herdr.observeRuntime(event); });
    herdr.check();
}
