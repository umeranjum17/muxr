/**
 * Visit every session the herd currently has, one at a time, and watch what
 * that does to memory.
 *
 * Nothing here is pinned to a card position or a session count: the caller
 * hands over every session the herd is serving, and the tour opens each one by
 * deep link, drags its scrollback, and records memory after every visit. A
 * build that leaks a terminal, a write pump or a decoded image shows up as a
 * rising floor across the tour, which no single-screen soak can see.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appPid, dismissPrompts, framesRendered, totalPssKb } from './androidSignals.mjs';

const run = promisify(execFile);

async function adb(args, timeout = 20_000) {
    const { stdout } = await run('adb', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
}

async function currentScreen() {
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/perf-tour.xml']).catch(() => undefined);
    return adb(['shell', 'cat', '/sdcard/perf-tour.xml']).catch(() => '');
}

async function openSession(sessionId) {
    // The deep link is the only stable way in. Card positions move as the herd
    // reorders, so a tour that taps coordinates measures the wrong pane.
    await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
        '-d', `muxr:///session/${sessionId.replace(/:/g, '%3A')}`, 'com.trymuxr.app']).catch(() => undefined);
}

async function drag(fromY, toY) {
    await adb(['shell', 'input', 'swipe', '540', String(fromY), '540', String(toY), '120']).catch(() => undefined);
}

/**
 * Open every pane in turn, scroll each one hard, and sample memory after each
 * visit. `limit` bounds an enormous herd so the gate stays inside its window.
 */
export async function tourEverySession(options) {
    const { pkg, sessions, scrolls = 5, limit = 40, settleMs = 3500 } = options;
    const panes = sessions.slice(0, limit);
    const visits = [];
    let opened = 0;

    for (const pane of panes) {
        await openSession(`shell:${pane.paneId}`);
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        // A prompt can land on top of the route the deep link just opened.
        await dismissPrompts();
        // The terminal itself is a native surface with no accessibility text, so
        // the screen's own furniture is the evidence that the route mounted: the
        // key bar on a live terminal, otherwise the terminal screen's tab.
        const screen = await currentScreen();
        const mounted = screen.includes('ctrl') || screen.includes('Terminal');
        if (mounted) opened += 1;

        for (let index = 0; index < scrolls; index += 1) {
            await drag(420, 1360);
            await drag(1360, 420);
        }

        const pid = await appPid(pkg);
        const pss = pid === undefined ? undefined : await totalPssKb(pid);
        visits.push({
            paneId: pane.paneId,
            agent: pane.agent === undefined ? undefined : String(pane.agent),
            opened: mounted,
            pssKb: pss,
        });
        await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 600));
    }

    const samples = visits.map((visit) => visit.pssKb).filter((value) => value !== undefined);
    return {
        panes: panes.length,
        opened,
        missed: panes.length - opened,
        visits,
        pssFirstKb: samples[0],
        pssLastKb: samples[samples.length - 1],
        pssMaxKb: samples.length === 0 ? undefined : Math.max(...samples),
        // Growth across the whole tour is the leak signal. One visit's spike is
        // just that pane's scrollback and images.
        pssGrowthKb: samples.length < 2 ? 0 : samples[samples.length - 1] - samples[0],
        framesRendered: await framesRendered(pkg),
    };
}
