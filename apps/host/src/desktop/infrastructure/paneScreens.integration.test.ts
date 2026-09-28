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
if (process.argv[2] === '--help') {
    process.stdout.write('USAGE:\\n  desklink-host serve            speak the local control protocol on stdin/stdout\\n  desklink-host keep --display :N   fill that display and report its windows\\n');
    process.exit(0);
}
const windows = [{ id: 1, title: 'Probe - Chromium', class: ['Chromium'], pid: 4321, width: 1280, height: 800 }];
process.stdout.write(JSON.stringify({ windows }) + '\\n');
setInterval(() => {}, 1000);
`;
/** The installed 0.1.1 engine: its own usage lists no keeper mode. */
const NO_KEEPER_STUB = `#!${process.execPath}
process.stdout.write('USAGE:\\n  desklink-host serve            speak the local control protocol on stdin/stdout\\n  desklink-host capabilities     print what this machine can do right now\\n  desklink-host capture-probe [seconds] [display]\\n                                 capture frames and report the stream\\n  desklink-host setup-input      explain the one-time input-access step (changes nothing)\\n  desklink-host version\\n');
process.exit(0);
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
            // The variables that keep a browser off the owner's desktop.
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
            // A tree read after it, without the pane, retires it: no display, no
            // keeper, no socket.
            const socket = join(sockets, `X${screen.display.slice(1)}`);
            screens.releaseMissing(new Set(), Date.now() + 1);
            expect(existsSync(socket)).toBe(false);
            expect(screens.screenFor('w1:p1')).toBeUndefined();
            expect(screens.windowsFor('w1:p1')).toEqual([]);

            // An explicit pane close releases a live bound screen the same way.
            const second = await screens.allocate();
            if (second === undefined) throw new Error('no second screen was allocated');
            const secondSocket = join(sockets, `X${second.display.slice(1)}`);
            screens.bind(second, 'w1:p2');
            expect(existsSync(secondSocket)).toBe(true);
            expect(screens.screenFor('w1:p2')?.display).toBe(second.display);
            screens.release('w1:p2');
            expect(existsSync(secondSocket)).toBe(false);
            expect(screens.screenFor('w1:p2')).toBeUndefined();
            expect(screens.windowsFor('w1:p2')).toEqual([]);

            // The installed 0.1.1 engine lists no keeper mode: no screen, and the
            // one status line, said once however many panes ask.
            const diagnostics: string[] = [];
            const withoutKeeper = new PaneScreens({
                env: { ...process.env, PATH: bin, MUXR_DESKLINK_ENGINE: noKeeper, MUXR_TEST_SOCKET_DIR: sockets },
                socketDirectory: sockets,
                stateDirectory: join(root, 'state2'),
                onDiagnostic: (line) => diagnostics.push(line),
            });
            try {
                expect(await withoutKeeper.allocate()).toBeUndefined();
                expect(await withoutKeeper.allocate()).toBeUndefined();
                expect(diagnostics).toEqual(['pane screens unavailable: installed desktop engine has no keeper']);
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
