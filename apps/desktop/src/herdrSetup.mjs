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
import { ensureHerdrServer, herdrBin, runHerdrInstaller } from '../../../scripts/setup/infrastructure/herdr.mjs';

const OFFLINE_MESSAGE = "muxr couldn't reach herdr.dev to download Herdr. Check this computer's internet connection, then choose Try again.";
const CHECKSUM_MESSAGE = "The Herdr download didn't match its published checksum, so nothing was installed. Choose Try again.";
const INSTALL_MESSAGE = "Herdr couldn't be installed on this computer. Choose Try again.";
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
        const kept = (env[key] ?? '').split(':').filter((entry) => entry !== '' && !entry.startsWith(appDir));
        if (kept.length > 0) env[key] = kept.join(':');
        else delete env[key];
    }
    return env;
}

function findHerdr() {
    try { return herdrBin(); }
    catch (error) { process.stderr.write(`desktop: herdr lookup: ${detail(error)}\n`); return undefined; }
}

export function createHerdrSetup(onChange) {
    let current = { status: 'ok' };
    const set = (next) => { current = next; onChange(next); };

    async function start(binary) {
        try {
            await ensureHerdrServer(binary, false, true, userEnv());
            set({ status: 'ok' });
        } catch (error) {
            process.stderr.write(`desktop: herdr server: ${detail(error)}\n`);
            set({ status: 'failed', message: START_MESSAGE });
        }
    }

    /** Install and Try again: install when missing, then start the server. */
    async function install() {
        if (current.status === 'installing') return;
        let binary = findHerdr();
        if (binary === undefined) {
            set({ status: 'installing', step: 'Downloading Herdr…' });
            try {
                await runHerdrInstaller();
                binary = findHerdr();
                if (binary === undefined) throw new Error('the installer finished but no herdr binary was found');
            } catch (error) {
                const cause = detail(error);
                process.stderr.write(`desktop: herdr install: ${cause}\n`);
                set({
                    status: 'failed',
                    message: /checksum/i.test(cause) ? CHECKSUM_MESSAGE
                        : /download failed|can't reach|could not resolve|failed to connect/i.test(cause) ? OFFLINE_MESSAGE : INSTALL_MESSAGE,
                });
                return;
            }
        }
        set({ status: 'installing', step: 'Starting Herdr…' });
        await start(binary);
    }

    return {
        get state() { return current; },
        install,
        /** At launch: offer the install when Herdr is missing, else quietly make sure it runs. */
        async check() {
            const binary = findHerdr();
            if (binary === undefined) set({ status: 'missing' });
            else await start(binary);
        },
        /** Herdr installed some other way (a terminal) while the window waited. */
        async recheck() {
            if (current.status === 'missing' && findHerdr() !== undefined) await install();
        },
    };
}
