import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWrite, ensurePrivateDir, error, executable, print, stateDir } from '../infrastructure/runtime.mjs';

/** Long enough for a person to find and answer the prompt; the host waits as long. */
const APPROVAL_WAIT_MS = 120_000;

/** One command asks once: setup that also pairs a browser must not ask twice. */
let asked = false;

/**
 * The host keeps its grant beside its data directory, which `MUXR_DATA_DIR`
 * or `config.json` may move (the same precedence as the host's own config).
 */
const grantDirectory = () => {
    let configured;
    try { configured = JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf8')).dataDir; } catch { /* absent or unreadable: the host would refuse to start on a malformed one */ }
    const dataDir = process.env.MUXR_DATA_DIR?.trim() || (typeof configured === 'string' && configured.trim()) || join(stateDir(), 'host');
    return join(dirname(dataDir), 'desktop');
};
/** The host's own grant file: it sends this token with the next desktop open. */
const grantPath = () => join(grantDirectory(), 'portal-restore-token');

/**
 * Only the portal asks before sharing a screen: a Wayland desktop, or a host
 * told to use it. X11 and a server without a screen share without a prompt,
 * so they have nothing to approve. Detection matches the host's own.
 */
function asksBeforeSharing(env = process.env) {
    const source = env.MUXR_DESKTOP_SOURCE?.trim();
    if (process.platform !== 'linux' || source === 'x11') return false;
    // Any other explicit source is the portal, the one that asks.
    if (source) return true;
    if (env.WAYLAND_DISPLAY?.trim() || env.XDG_SESSION_TYPE?.trim() === 'wayland') return true;
    const uid = process.getuid?.();
    const runtime = env.XDG_RUNTIME_DIR?.trim() || (uid === undefined ? undefined : `/run/user/${uid}`);
    if (runtime === undefined) return false;
    try {
        return readdirSync(runtime).some((name) => {
            if (!/^wayland-\d+$/.test(name)) return false;
            try { return statSync(join(runtime, name)).isSocket(); } catch { return false; }
        });
    } catch {
        return false;
    }
}

/**
 * The portal files an approval under the id of the app that asked, read from
 * its systemd unit: a terminal the desktop launched runs in an `app-…` unit and
 * carries the terminal's id, while the muxr service carries none. Asking from
 * a scope of our own files the approval where the service will look for it.
 */
function engineCommand(resolved) {
    let cgroup = '';
    try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch { /* not systemd */ }
    if (!cgroup.split('/').some((unit) => unit.startsWith('app-')) || !executable('systemd-run')) return resolved;
    return { command: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', '--', resolved.command, ...resolved.args] };
}

/**
 * The one-time screen-sharing approval, done at the computer.
 *
 * A Wayland desktop shows a prompt before the first capture. Answered here,
 * during setup, it saves a grant the host sends with every later open, so the
 * phone opens this computer without anyone at the screen. `force` asks again
 * even when a grant is saved, for one the desktop stopped honouring.
 */
export async function approveScreenSharing({ force = false } = {}) {
    if (!asksBeforeSharing()) {
        if (force) print('This computer shares its screen without asking, so there is nothing to approve.');
        return 0;
    }
    if (!force && (asked || existsSync(grantPath()))) return 0;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        if (force) error('Run this from a terminal on the computer: it shows a prompt there.');
        return force ? 1 : 0;
    }
    const { EngineClient, resolveEngine } = await import('@desklink/host');
    const resolved = resolveEngine();
    if (resolved === null) {
        if (force) error('The desktop engine is not installed, so there is nothing to approve yet.');
        return force ? 1 : 0;
    }

    asked = true;
    print('');
    print('Screen sharing');
    print('  Your phone can show and control this computer. Approve screen sharing once');
    print('  here, and it opens from your phone without asking again.');
    print('  Choose the screen in the prompt. If it offers to remember the choice, keep that on.');
    let token;
    let client;
    let failure;
    let shared = false;
    try {
        const { command, args } = engineCommand(resolved);
        client = await EngineClient.start(command, args, {
            onEvent: (event) => {
                if (event.event === 'session.restoreToken' && typeof event.params.token === 'string' && event.params.token !== '') token = event.params.token;
            },
        });
        const opened = await client.openSession({ permissions: ['view'] }, APPROVAL_WAIT_MS);
        shared = true;
        await client.closeSession(opened.sessionId).catch(() => undefined);
    } catch (cause) {
        failure = cause;
    } finally {
        await client?.stop().catch(() => undefined);
    }
    if (token === undefined && shared) {
        print('  Approved, but this desktop did not let muxr remember it, so it will ask on each open.');
        return force ? 1 : 0;
    }
    if (token === undefined) {
        const reason = failure?.code === 'consent-timeout' ? 'nobody answered the prompt' : 'it was not approved';
        print(`  Skipped: ${reason}. Run \`muxr desktop setup\` to try again.`);
        return force ? 1 : 0;
    }
    ensurePrivateDir(grantDirectory());
    atomicWrite(grantPath(), token);
    print('  Approved. Your phone opens this computer without asking.');
    return 0;
}
