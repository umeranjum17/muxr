import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BACKEND = 'org.freedesktop.impl.portal.desktop.';
const WAIT_SECONDS = 2;

/**
 * The screen-sharing portal backends on the session bus that do not answer a
 * ping, each with the command that restarts it.
 *
 * A backend serves one request at a time: while its share picker is open, or
 * hung without a window, it answers nothing, and a portal open behind it waits
 * out the whole consent window for an answer that cannot come. A missing
 * `busctl` or session bus checks nothing, so the open goes ahead as before.
 */
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
    const silent = await Promise.all(names.map(async (name) => {
        const started = Date.now();
        try {
            await run('busctl', ['--user', `--timeout=${WAIT_SECONDS}`, 'call', name, '/org/freedesktop/portal/desktop', 'org.freedesktop.DBus.Peer', 'Ping'],
                { timeout: (WAIT_SECONDS + 1) * 1000 });
            return undefined;
        } catch {
            // Only the wait running out is silence; any quick error is an answer.
            return Date.now() - started >= WAIT_SECONDS * 1000 ? name : undefined;
        }
    }));
    return silent.filter((name) => name !== undefined).map((name) => ({
        name,
        restartCommand: `systemctl --user restart xdg-desktop-portal-${name.slice(BACKEND.length)}`,
    }));
}
