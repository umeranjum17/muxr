import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PaneScreens } from './paneScreens.js';

/**
 * The pane-screen lifecycle, through real child processes.
 *
 * Xvfb and the keeper are stubs — a real X server and a compiled engine belong
 * to the lab, not the suite — but the screen is started, waited on, bound, and
 * torn down by the real code every agent pane goes through. What this catches
 * is the part that would be silently wrong: the variables a browser gets, the
 * keeper's report reaching the pane that owns it, and a screen outliving the
 * pane it was made for.
 */
const XVFB_STUB = `#!${process.execPath}
const net = require('node:net');
const number = process.argv[2].replace(':', '');
const server = net.createServer(() => {});
server.listen(process.env.MUXR_TEST_SOCKET_DIR + '/X' + number);
setInterval(() => {}, 1000);
`;
const KEEPER_STUB = `#!${process.execPath}
const windows = [{ id: 1, title: 'Probe - Chromium', class: ['Chromium'], pid: 4321, width: 1280, height: 800 }];
process.stdout.write(JSON.stringify({ windows }) + '\\n');
setInterval(() => {}, 1000);
`;
/** The installed engine without a keeper mode: it exits before it can report a window. */
const NO_KEEPER_STUB = `#!${process.execPath}
process.stderr.write('unknown subcommand\\n');
process.exit(2);
`;

function stub(directory: string, name: string, source: string): string {
    const path = join(directory, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
    return path;
}

describe('a private screen per agent pane', () => {
    it('gives the pane its own display, keeps the keeper report on that pane, and tears it all down', async () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-screens-'));
        const bin = join(root, 'bin');
        const sockets = join(root, 'sockets');
        mkdirSync(bin);
        mkdirSync(sockets);
        stub(bin, 'Xvfb', XVFB_STUB);
        const keeper = stub(bin, 'keeper', KEEPER_STUB);
        const noKeeper = stub(bin, 'no-keeper', NO_KEEPER_STUB);
        const screens = new PaneScreens({
            env: { ...process.env, PATH: bin, MUXR_DESKLINK_ENGINE: keeper, MUXR_TEST_SOCKET_DIR: sockets },
            socketDirectory: sockets,
            stateDirectory: join(root, 'state'),
            onDiagnostic: () => {},
        });
        try {
            const screen = await screens.allocate();
            if (screen === undefined) throw new Error('no screen was allocated');
            // The variables that keep a browser off the owner's desktop (§1.1).
            expect(screen.display).toMatch(/^:\d+$/);
            expect(screen.env).toMatchObject({
                DISPLAY: screen.display,
                WAYLAND_DISPLAY: '',
                XDG_SESSION_TYPE: 'x11',
                AGENT_BROWSER_HEADED: '1',
            });
            expect(screen.env.AGENT_BROWSER_ARGS).toContain('--ozone-platform=x11');
            expect(readFileSync(screen.env.XAUTHORITY!, 'utf8').length).toBeGreaterThan(0);
            expect(statSync(screen.env.XAUTHORITY!).mode & 0o777).toBe(0o600);

            const reported: Array<[string, number]> = [];
            const unsubscribe = screens.onWindows((paneId, windows) => reported.push([paneId, windows.length]));
            screens.bind(screen, 'w1:p1');
            expect(screens.screenFor('w1:p1')?.display).toBe(screen.display);
            await waitFor(() => screens.windowsFor('w1:p1').length > 0);
            expect(screens.windowsFor('w1:p1')[0]).toMatchObject({ title: 'Probe - Chromium', class: ['Chromium'] });
            expect(reported).toEqual([['w1:p1', 1]]);
            unsubscribe();

            // A tree read before the screen was bound is a snapshot still in
            // flight: it cannot name this pane, and must not retire the screen.
            screens.releaseMissing(new Set(), Date.now() - 10_000);
            expect(screens.screenFor('w1:p1')?.display).toBe(screen.display);
            // A tree read after it, without the pane, does retire it.
            screens.releaseMissing(new Set(), Date.now() + 1);
            expect(screens.screenFor('w1:p1')).toBeUndefined();

            screens.bind(screen, 'w1:p1');
            // The pane left Herdr's tree: no display, no keeper, no socket.
            const socket = join(sockets, `X${screen.display.slice(1)}`);
            screens.release('w1:p1');
            expect(existsSync(socket)).toBe(false);
            expect(screens.screenFor('w1:p1')).toBeUndefined();
            expect(screens.windowsFor('w1:p1')).toEqual([]);
            await waitFor(() => !existsSync(socket));

            // An engine without the keeper mode gives the pane today's behaviour.
            const withoutKeeper = new PaneScreens({
                env: { ...process.env, PATH: bin, MUXR_DESKLINK_ENGINE: noKeeper, MUXR_TEST_SOCKET_DIR: sockets },
                socketDirectory: sockets,
                stateDirectory: join(root, 'state2'),
                onDiagnostic: () => {},
            });
            try {
                expect(await withoutKeeper.allocate()).toBeUndefined();
            } finally {
                withoutKeeper.stop();
            }
        } finally {
            screens.stop();
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the screen');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
