import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BACKEND = 'org.freedesktop.impl.portal.desktop.';
const WAIT_SECONDS = 2;

/**
 * The screen-sharing portal backends on the session bus that answer no ping,
 * each with the command that restarts it. A backend is silent only when two
 * pings in a row time out.
 *
 * Measured on a wedged backend (its Ping timed out at 11 s, while a healthy one
 * answered in 11 ms). Inferred for a backend with a share picker open, which
 * serves one request at a time and so answers nothing until it closes. A
 * missing `busctl` or session bus checks nothing, so the open goes ahead as before.
 */
async function answersPing(name: string): Promise<boolean> {
    const started = Date.now();
    try {
        await run('busctl', ['--user', `--timeout=${WAIT_SECONDS}`, 'call', name, '/org/freedesktop/portal/desktop', 'org.freedesktop.DBus.Peer', 'Ping'],
            { timeout: (WAIT_SECONDS + 1) * 1000 });
        return true;
    } catch {
        // Only the wait running out is silence; any quick error is an answer.
        return Date.now() - started < WAIT_SECONDS * 1000;
    }
}

export async function silentPortalBackends(): Promise<Array<{ name: string; restartCommand: string }>> {
    let listed: string;
    try {
        listed = (await run('busctl', ['--user', 'list', '--acquired', '--no-legend', '--no-pager'], { timeout: WAIT_SECONDS * 1000 })).stdout;
    } catch {
        return [];
    }
    // ponytail: pings every backend, not only the one serving ScreenCast; a
    // wedged file chooser also refuses the desktop. Ask the portal's config if
    // that ever refuses a desktop that would have opened.
    const names = listed.split('\n').map((line) => line.split(/\s+/)[0] ?? '').filter((name) => name.startsWith(BACKEND) && /^[a-z0-9_-]{1,40}$/.test(name.slice(BACKEND.length)));
    const silent = await Promise.all(names.map(async (name) => (await answersPing(name)) || (await answersPing(name)) ? undefined : name));
    return silent.filter((name) => name !== undefined).map((name) => ({
        name,
        restartCommand: `systemctl --user restart xdg-desktop-portal-${name.slice(BACKEND.length)}`,
    }));
}
