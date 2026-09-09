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
import { appPid, dismissKeyboard, dismissPrompts, dumpUiXml, framesRendered, totalPssKb } from './androidSignals.mjs';
import { herdChromeConnected } from './pairPhone.mjs';
import { TERMINAL_SURFACE } from './gestureMetrics.mjs';

const run = promisify(execFile);

async function adb(args, timeout = 20_000) {
    const { stdout } = await run('adb', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
}

// One file per dump: a read that failed is an empty screen, never the last one.
const currentScreen = () => dumpUiXml(20_000, 16 * 1024 * 1024);

async function openSession(sessionId) {
    // The deep link is the only stable way in. Card positions move as the herd
    // reorders, so a tour that taps coordinates measures the wrong pane.
    await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
        '-d', `muxr:///session/${sessionId.replace(/:/g, '%3A')}`, 'com.trymuxr.app']).catch(() => undefined);
}

async function drag(fromY, toY) {
    await adb(['shell', 'input', 'swipe', '540', String(fromY), '540', String(toY), '120']).catch(() => undefined);
}

/** Leave whatever the visit opened and prove the herd is back on screen. */
async function returnToHerd() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const screen = await currentScreen();
        if (/text="LIVE"/.test(screen) && herdChromeConnected(screen) && !screen.includes(`content-desc="${TERMINAL_SURFACE}"`)) return true;
        await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return false;
}

/**
 * Open every pane in turn, scroll each one hard, and sample memory after each
 * visit. `limit` bounds an enormous herd so the gate stays inside its window.
 *
 * `attached` is asked, per visit, whether the host has seen this pane attach.
 * The terminal is a native surface with no accessibility text, so a substring
 * on the surrounding chrome cannot say which pane arrived; the host's own
 * record can.
 */
export async function tourEverySession(options) {
    const { pkg, sessions, scrolls = 5, limit = 40, settleMs = 3500, attached } = options;
    const panes = sessions.slice(0, limit);
    const visits = [];
    let opened = 0;

    for (const pane of panes) {
        const startedAt = new Date().toISOString();
        await openSession(`shell:${pane.paneId}`);
        // A prompt can land on top of the route the deep link just opened.
        await dismissPrompts();
        // Bounded poll rather than one look after a fixed wait: a slow attach is
        // a longer visit, not a missed pane, and a genuinely missed pane is the
        // one still unmounted when the budget runs out.
        let screen = '';
        let mounted = false;
        const deadline = Date.now() + settleMs * 2;
        do {
            screen = await currentScreen();
            mounted = screen.includes(`content-desc="${TERMINAL_SURFACE}"`)
                && (attached === undefined || await attached(pane.paneId, startedAt));
            if (mounted) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        } while (Date.now() < deadline);
        if (mounted) opened += 1;
        await dismissKeyboard();

        for (let index = 0; index < scrolls; index += 1) {
            await drag(420, 1360);
            await drag(1360, 420);
        }

        // Sample from the herd, never from the pane: a visit measured on its own
        // terminal and the next measured on the herd are not comparable, and the
        // growth across the tour is the whole point of the sample.
        const left = await returnToHerd();
        const pid = await appPid(pkg);
        const pss = pid === undefined ? undefined : await totalPssKb(pid);
        visits.push({
            paneId: pane.paneId,
            agent: pane.agent === undefined ? undefined : String(pane.agent),
            opened: mounted,
            left,
            startedAt,
            sampledAt: new Date().toISOString(),
            pssKb: pss,
            // Enough of the failed screen to tell a missed route from a prompt.
            ...(mounted ? {} : { screenTexts: [...screen.matchAll(/text="([^"]+)"/g)].map((match) => match[1]).slice(0, 12) }),
        });
    }

    const samples = visits.map((visit) => visit.pssKb).filter((value) => value !== undefined);
    // A visit whose memory could not be read is a hole in the tour's account,
    // not a visit that used no memory. Growth is only comparable when both ends
    // of the tour were sampled and nothing between them was missed.
    const missingSamples = visits.filter((visit) => visit.pssKb === undefined).map((visit) => visit.paneId);
    return {
        panes: panes.length,
        pssSamples: samples.length,
        pssMissingSamples: missingSamples,
        opened,
        missed: panes.length - opened,
        missedPanes: visits.filter((visit) => !visit.opened).map((visit) => visit.paneId),
        staleSurfaces: visits.filter((visit) => visit.left === false).map((visit) => visit.paneId),
        visits,
        pssFirstKb: samples[0],
        pssLastKb: samples[samples.length - 1],
        pssMaxKb: samples.length === 0 ? undefined : Math.max(...samples),
        // Growth across the whole tour is the leak signal. One visit's spike is
        // just that pane's scrollback and images. Without both ends there is no
        // growth to report, and reporting zero would read as a build that held.
        pssGrowthKb: samples.length < 2 ? undefined : samples[samples.length - 1] - samples[0],
        framesRendered: await framesRendered(pkg),
    };
}
