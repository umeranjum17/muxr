/**
 * Release performance gate. One command, one exit code, real device.
 *
 * `yarn check` proves logic on any dev box. This proves the phone survives a
 * real herd, which is the only place the failures we shipped could be seen: a
 * release build whose JS thread saturated, threw `Maximum update depth
 * exceeded`, lost its runtime and showed a blank screen while every process
 * still looked alive.
 *
 * It is deliberately not in `runSuite`: it needs adb, an emulator and Maestro,
 * and it runs for about fifteen minutes.
 *
 * Relay, host and app are the real builds. Herdr is third party, so it is faked
 * at its own sockets: the load is a world this repo owns and sizes, the gate
 * needs no desk of its own, and nothing on this machine is touched. Real-Herdr
 * conformance is `yarn check`'s job (`checkHerdrE2E.mjs`).
 *
 * The app pairs freshly against the host started for the run every time. A
 * pre-paired emulator snapshot rots the first time a grant or key changes, and
 * a local-mode build would measure a bundle we do not ship.
 *
 *   yarn perf                            build, install, pair, load, measure
 *   yarn perf --apk <path>               measure an existing release APK
 *   yarn perf --record docs/perf/x.json  write evidence for the release input
 *   yarn perf --profile emulator|device  pick the LIMITS column
 *   yarn perf --keep-load                leave the stack up for inspection
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { startFakeStack } from './lib/fakeStack.mjs';
import { tourEverySession } from './lib/deviceTour.mjs';
import { herdChromeConnected, pairPhone } from './lib/pairPhone.mjs';
import { usagePlugins } from './fixtures/usageHome.mjs';
import {
    appPid,
    avdName,
    clearLogcat,
    deviceIdentity,
    deviceMonotonicSeconds,
    deviceReady,
    dismissKeyboard,
    dismissPrompts,
    framesRendered,
    gfxSnapshot,
    jankReport,
    newAttempt,
    jsThreadId,
    refreshHz,
    resetFrames,
    resetGfxWindow,
    samplePhase,
    screenshot,
    screencapRaw,
    updateDepthErrors,
    viewBounds,
} from './lib/androidSignals.mjs';
import { fling, scrollBout, stripBout, tap, tapTimed, drag } from './lib/gestures.mjs';
import {
    continuesFrom,
    cropRaw,
    decodeUiAttribute,
    firstDocumentMarker,
    freshFrameRows,
    mergeFrameStats,
    parseJsonlStrict,
    parseUiNodes,
    phaseMetrics,
    parseRedactedTrail,
    pixelsMoved,
    reduceFrameStats,
    reduceGridTransitions,
    reduceJank,
    reduceMagnification,
    reduceMovement,
    reducePipelineNotches,
    documentPosition,
    documentViewport,
    scrollableBounds,
    stripPosition,
    stripScroller,
    verticalScrollers,
    trailSince,
    verdict,
} from './lib/gestureMetrics.mjs';

const run = promisify(execFile);

const PKG = 'com.trymuxr.app';
// Raw framestats rows kept per gesture. The ring holds ~120; the cap bounds a
// pathological read and reports what it left out rather than trimming silently.
const RAW_FRAME_ROW_CAP = 200;
const AVD = 'muxr_sandbox';
const FLOWS = 'perf/flows';
const MAESTRO = ['mise', ['x', 'maestro@cli-2.7.0', '--', 'maestro']];

/**
 * Healthy after the current fixes is 20-26% JS thread, 58 fps, memory flat
 * within 20 MB. Failing was 96-100%, a dead runtime inside twenty seconds and
 * zero frames. The hard lines sit in that gap, wide enough that emulator noise
 * cannot cross them. Frame rate is still reported, never gated: under
 * swiftshader it measures the host. Gesture jank is gated — that is the
 * point of the second column.
 */
const SHARED_LIMITS = {
    pssDriftKb: 100 * 1024,
    frameStallSeconds: 30,
    updateDepthErrors: 0,
    /** Growth across a full tour of every pane; one pane's images are not a leak. */
    tourGrowthKb: 150 * 1024,
    /** A herd nobody can see yet is a herd nobody can use. */
    herdVisibleMs: 90_000,
    /** A Herdr call the host waits on; anything near seconds is a stall. */
    hostRequestMs: 5_000,
    /** First admitted byte of a graphics frame -> written to the phone channel. */
    graphicsPipelineP95Ms: 250,
    /** Bytes of the terminal.frame payload written to the phone. */
    graphicsBytesP95: 800 * 1024,
    accidentalOwners: 0,
    terminalScrollClamped: 0,
    graphicsRowsPerSecond: 9,
    /** One tap on `Zoom in` is one font step, and one re-grid on the wire. */
    zoomResizeCount: 1,
    /** `GRAPHICS_ZOOM_STEPS[1]`: the first step a graphics pane magnifies by. */
    graphicsZoomStep: 1.25,
};

const EMULATOR_LIMITS = {
    ...SHARED_LIMITS,
    jsBusyPercent: 60,
    gestureJankPercent: 20,
    gestureP95Ms: 100,
    gestureP99Ms: 250,
    gestureOverFourFramesPercent: 3,
    gestureDroppedPercent: 12,
    missedVsyncPerFling: 3,
    inputToFrameP95Ms: 120,
    jsBusyDeltaNative: 15,
    jsBusyDeltaTerminal: 25,
    terminalRowsPerSecond: 40,
};

const DEVICE_LIMITS = {
    ...SHARED_LIMITS,
    jsBusyPercent: 45,
    gestureJankPercent: 3,
    gestureP95Ms: 17,
    gestureP99Ms: 34,
    gestureOverFourFramesPercent: 0,
    gestureDroppedPercent: 3,
    missedVsyncPerFling: 1,
    inputToFrameP95Ms: 60,
    jsBusyDeltaNative: 10,
    jsBusyDeltaTerminal: 20,
    terminalRowsPerSecond: 60,
};

const LOAD = {
    panes: 100,
    agents: 30,
    titleChurnHz: 2,
    terminalBytesPerSecond: 4096,
    graphicsFrameHz: 4,
};

/**
 * `flow` is the load itself and runs while the phase is sampled. `nav` is a
 * prerequisite: it runs to completion, and its screen is asserted, before any
 * counter is reset or any number is read.
 */
const PHASES = [
    { name: 'idle on the herd', seconds: 120, flow: undefined },
    { name: 'herd strip and tree soak', seconds: 120, flow: 'herdSoak.yaml' },
    { name: 'agent terminal and plugin navigation', seconds: 120, flow: 'herdNavigate.yaml' },
    { name: 'herd tree fling', seconds: 30, drive: 'treeFling' },
    { name: 'herd strip paging', seconds: 20, drive: 'stripPaging', oneWayMovement: true },
    { name: 'document scroll', seconds: 30, nav: 'openDocument.yaml', drive: 'documentScroll', oneWayMovement: true },
    // `surfaceKind` is the pane this phase claims to measure. It is read off the
    // app's own controls before the bout, so a graphics pane cannot be judged
    // against the text terminal's latency contract or the other way round.
    // `fixture` is the pane the phase is routed to by identity. `text` is a pane
    // no graphics producer serves; `graphics` is the pane the checkerboard is
    // pinned to. Opening "the first live card" left which pane answered up to
    // whatever the churning herd had under the tap.
    { name: 'terminal text fling', seconds: 30, drive: 'terminalTextFling', surfaceKind: 'text', fixture: 'text' },
    { name: 'graphics pane scroll', seconds: 90, drive: 'graphicsScroll', surfaceKind: 'graphics', fixture: 'graphics', oneWayMovement: true },
    // One zoom phase per surface, each routed to its own fixture. A single
    // phase had to discover which pane it had landed on and then grade itself
    // by that, so the surface it happened to get was the only one covered.
    { name: 'text zoom tap', seconds: 60, drive: 'zoomTapNavigate', surfaceKind: 'text', fixture: 'text' },
    { name: 'graphics zoom tap', seconds: 60, drive: 'zoomTapNavigate', surfaceKind: 'graphics', fixture: 'graphics' },
];

/** Paints the fixture's identifiable checkerboard instead of a flat fill. */
const GRAPHICS_PROOF_FILE = '/tmp/muxr-perf-graphics-proof';

/** 240 numbered lines: the file plugin's preview cap, and enough to scroll. */
const DOCUMENT_FIXTURE = 'perf-document.md';
const documentFixture = () => Array.from(
    { length: 240 },
    (_, index) => `PERF_LINE_${String(index + 1).padStart(4, '0')} deterministic release-gate reading content with a long tail so the surface has somewhere to go.`,
).join('\n');

const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
};
const apkArg = flag('--apk');
const recordPath = flag('--record');
const profileName = flag('--profile') === 'device' ? 'device' : 'emulator';
const LIMITS = profileName === 'device' ? DEVICE_LIMITS : EMULATOR_LIMITS;
const keepLoad = args.includes('--keep-load');

const failures = [];
const report = {
    startedAt: new Date().toISOString(),
    phases: [],
    limits: LIMITS,
    load: LOAD,
    profile: profileName,
};

let stack;
let journalAcc = emptyJournalAcc();

const ok = (message) => process.stdout.write(`ok: ${message}\n`);
const fail = (message) => {
    failures.push(message);
    process.stdout.write(`FAIL: ${message}\n`);
};

/**
 * What the run leaves behind, taken before cleanup removes it. The host's
 * journal lives in the scratch root `stop()` deletes, and a child's exit code
 * is gone the moment the process table forgets it; an interrupted or aborted
 * run is exactly when both are worth having. Names, pids and numbers only --
 * logs, prompts and pairing strings are not evidence, they are leaks.
 */
function snapshotEvidence() {
    if (stack === undefined) return;
    if (typeof stack.childHealth === 'function') report.childHealth = stack.childHealth();
    const path = stack.journalPath ?? (stack.dataDir === undefined ? undefined : join(stack.dataDir, 'diagnostics.json'));
    if (path === undefined) return;
    ingestHostJournal(journalAcc, path);
    report.journalAtFinish = {
        reads: journalAcc.reads,
        events: journalAcc.events.length,
        eventCounts: journalEventCounts(journalAcc.events),
        unreadable: journalAcc.lastError !== undefined,
    };
}

function finish(code, forceStopLoad = false, interruptedBy = undefined) {
    snapshotEvidence();
    if (stack !== undefined && (!keepLoad || forceStopLoad)) stack.stop();
    report.finishedAt = new Date().toISOString();
    // A run that stopped early measured nothing about the phases it never
    // reached, so it can never report a pass: the phases it did not run are
    // named, and the exit code has to be a success as well.
    const ran = new Set(report.phases.map((phase) => phase.name));
    const notRun = PHASES.filter((phase) => !ran.has(phase.name)).map((phase) => phase.name);
    if (interruptedBy !== undefined) {
        report.interruptedBy = interruptedBy;
        failures.push(`the run was interrupted by ${interruptedBy}`);
    }
    if (notRun.length > 0) {
        report.phasesNotRun = notRun;
        failures.push(`${notRun.length} phase(s) not run: ${notRun.join(', ')}`);
    }
    report.failures = failures;
    report.passed = failures.length === 0 && code === 0 && notRun.length === 0 && interruptedBy === undefined;
    if (recordPath !== undefined) {
        mkdirSync(dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`\nevidence: ${recordPath}\n`);
    }
    process.stdout.write(report.passed
        ? '\nPASS: release performance gate\n'
        : `\nFAILED: ${failures.length} gate(s): ${failures.join('; ')}\n`);
    process.exit(report.passed ? code : (code === 0 ? 1 : code));
}

/**
 * A phase whose screen or workload is invalid ends the run where the invalidity
 * is detected, with the load stopped even under `--keep-load`: continuing would
 * only collect plausible numbers from whatever screen the phone drifted onto.
 */
function abortPhase(phase, why, details = {}) {
    report.phases.push({ ...phase, ...details, valid: false, navigation: { ok: false, why } });
    report.abortedAtPhase = phase.name;
    fail(`${phase.name}: ${why}`);
    finish(1, true);
}

process.once('SIGINT', () => finish(130, false, 'SIGINT'));
process.once('SIGTERM', () => finish(143, false, 'SIGTERM'));

/**
 * A flow run must never block this process: the sampler and the fake Herdr are
 * both driven from here, and a synchronous child would freeze the measurement
 * and every Herdr answer for the length of the flow.
 */
function maestro(flow, variables = {}) {
    const [bin, prefix] = MAESTRO;
    // Flow variables must be passed with -e; Maestro does not read them from
    // the process environment.
    const declared = Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return new Promise((resolve) => {
        const child = spawn(bin, [...prefix, '--device', 'emulator-5554', 'test', ...declared, join(FLOWS, flow)], {
            env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME ?? join(process.env.HOME, 'Android/Sdk') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = [];
        child.stdout.on('data', (chunk) => output.push(String(chunk)));
        child.stderr.on('data', (chunk) => output.push(String(chunk)));
        const deadline = setTimeout(() => child.kill('SIGTERM'), 600_000);
        child.once('close', (code) => {
            clearTimeout(deadline);
            resolve({ code: code ?? 1, output: output.join('') });
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJsonl(path) {
    const read = readJsonlStrict(path);
    return read.ok ? read.rows : [];
}

/**
 * One JSONL read that is allowed to say it failed.
 *
 * `readJsonl` folds a missing file, an unreadable one, a malformed record and a
 * half-written last line into an empty array, and downstream that reads as "the
 * pane declared nothing" -- the one answer a gate must never infer from
 * evidence it could not collect. A JSONL record is only complete on its
 * newline, so anything after the last one is a writer caught mid-append, not an
 * absent record.
 */
function readJsonlStrict(path) {
    if (path === undefined) return { ok: false, why: 'no path' };
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        return { ok: false, why: `unreadable (${error.code ?? error.message})` };
    }
    return parseJsonlStrict(text);
}

async function dumpUi() {
    await run('adb', ['shell', 'uiautomator', 'dump', '/sdcard/perf-prompt.xml'], { timeout: 20_000 }).catch(() => undefined);
    return run('adb', ['shell', 'cat', '/sdcard/perf-prompt.xml'], { timeout: 20_000 })
        .then((result) => result.stdout)
        .catch(() => '');
}

async function returnToHerd() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        await dismissPrompts();
        // An open IME eats the BACK that was meant to leave the route.
        await dismissKeyboard();
        const dump = await dumpUi();
        if (/text="LIVE"/.test(dump) && herdChromeConnected(dump)
            && !/GhosttyTerminalView/.test(dump) && !/Type a prompt/.test(dump)) return true;
        await run('adb', ['shell', 'input', 'keyevent', 'BACK'], { timeout: 10_000 }).catch(() => undefined);
        await sleep(700);
    }
    return false;
}

async function tapBounds(pattern) {
    const bounds = await viewBounds(pattern);
    if (bounds === undefined) return false;
    await tap((bounds.l + bounds.r) / 2, (bounds.t + bounds.b) / 2);
    return true;
}

/**
 * The phone's own account of the run, read off the accessibility tree of
 * Settings -> Connection -> Show diagnostics.
 *
 * Never returns a trail it did not read. A missing diagnostics screen parses
 * as zero rows and zero latency, which is indistinguishable from a terminal
 * that scrolled nothing, so an unreadable trail is reported as unavailable and
 * the phase that needed it fails rather than passing on invented numbers.
 */
async function pullPhoneTrail() {
    await run('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'muxr:///settings/connection', PKG], { timeout: 20_000 }).catch(() => undefined);
    await sleep(1500);
    const fail = async (why) => ({ ok: false, why, returned: await returnToHerd() });

    let dump = await dumpUi();
    if (!/text="Connection &amp;(?:amp;)? updates"|text="Connection & updates"/.test(dump)) {
        return await fail('the Connection & updates route never opened');
    }
    // A node the page is not showing cannot be tapped: uiautomator keeps rows
    // that scrolled off, and a zero-area or offscreen box would send the tap
    // wherever those coordinates happen to land.
    const onScreen = (current, label) => {
        const page = verticalScrollers(current)[0];
        if (page === undefined) return undefined;
        return parseUiNodes(current).find((node) => node.text === label
            && node.r > node.l && node.b > node.t
            && node.t >= page.t && node.b <= page.b && node.l >= page.l && node.r <= page.r);
    };
    // One page scroll, reporting whether the page still had anywhere to go.
    const scrollPage = async (current) => {
        const page = verticalScrollers(current)[0];
        if (page === undefined) return { why: 'the page has no vertical scroller' };
        const x = Math.round((page.l + page.r) / 2);
        await drag({
            from: { x, y: Math.round(page.t + (page.b - page.t) * 0.75) },
            to: { x, y: Math.round(page.t + (page.b - page.t) * 0.25) },
        });
        await sleep(500);
        const next = await dumpUi();
        return { dump: next, moved: next !== current };
    };
    // Troubleshooting sits below the hosted status, the version rows and the
    // update rows, so the control starts off screen on this display.
    let control = onScreen(dump, 'Show diagnostics');
    for (let attempt = 0; attempt < 10 && control === undefined; attempt += 1) {
        const scrolled = await scrollPage(dump);
        if (scrolled.dump === undefined) return await fail(scrolled.why);
        dump = scrolled.dump;
        control = onScreen(dump, 'Show diagnostics');
        if (!scrolled.moved) break;
    }
    if (control === undefined) return await fail('Show diagnostics was never visible on /settings/connection');
    await tap((control.l + control.r) / 2, (control.t + control.b) / 2);
    await sleep(1000);
    dump = await dumpUi();

    // The report is a single block between the control and Copy diagnostics, and
    // it is taller than the page. Read down it until that closing control is on
    // screen: only then is the whole report accounted for, and only then can a
    // missing summary line mean the phone really recorded nothing.
    const lines = [];
    const seen = new Set();
    const readVisible = (current) => {
        for (const match of current.matchAll(/text="([^"]*)"/g)) {
            const line = decodeUiAttribute(match[1]);
            if (line === '' || seen.has(line)) continue;
            seen.add(line);
            lines.push(line);
        }
    };
    readVisible(dump);
    let complete = onScreen(dump, 'Copy diagnostics') !== undefined || onScreen(dump, 'Diagnostics copied') !== undefined;
    for (let attempt = 0; attempt < 10 && !complete; attempt += 1) {
        const scrolled = await scrollPage(dump);
        if (scrolled.dump === undefined) return await fail(scrolled.why);
        dump = scrolled.dump;
        readVisible(dump);
        complete = onScreen(dump, 'Copy diagnostics') !== undefined || onScreen(dump, 'Diagnostics copied') !== undefined;
        if (!scrolled.moved) break;
    }
    const text = lines.join('\n');
    if (!/Redacted:|No phone transport events yet/.test(text)) {
        return await fail('the diagnostics report never rendered');
    }
    if (!complete) return await fail('the diagnostics report never reached its end');
    if (!await returnToHerd()) return { ok: false, why: 'the herd never came back after the diagnostics report', returned: false };
    return { ok: true, text, trail: parseRedactedTrail(text) };
}

async function captureSurface(surface, screen) {
    const dump = await dumpUi();
    const bounds = scrollableBounds(surface, dump, screen);
    const raw = await screencapRaw().catch(() => undefined);
    // No bounds is no crop. Falling back to the whole screen would compare a
    // surface this phase never measured and call the difference movement.
    const crop = raw === undefined || bounds === undefined ? undefined : cropRaw(raw, bounds);
    return {
        dump,
        bounds,
        crop,
        documentMarker: firstDocumentMarker(dump),
        documentPosition: documentPosition(dump),
        stripPosition: stripPosition(dump),
    };
}

/**
 * The screen a phase is about to measure, and its counters zeroed on it. Split
 * out of `measureBout` so the reset lands after navigation has succeeded and
 * before the sampler starts: a reset taken while `samplePhase` is reading the
 * same gfxinfo counters shows up as a frame stall that never happened.
 */
async function prepareBout(surface, screen, hz) {
    const beforeSurface = surface === undefined ? undefined : await captureSurface(surface, screen);
    return { beforeSurface, attempt: newAttempt(), before: await resetGfxWindow(PKG, { hz }) };
}

async function measureBout(run, hz, { surface, screen, phase, prepared } = {}) {
    const { beforeSurface, before } = prepared ?? await prepareBout(surface, screen, hz);
    const parts = [];
    // A bout flings up and then back down. On a surface whose content repeats,
    // the end of the bout can land on the same picture the start had, so the
    // travel is sampled once while it is still one-way and the movement is
    // judged on whichever comparison saw the most.
    let oneWaySurface;
    // framestats is a rolling ring re-read after every fling; without this the
    // same frame is counted once per remaining read of the bout.
    const counted = new Set();
    // Per-gesture timing beside the rows it was reduced from: without them the
    // phase p95 is a number nobody can take apart again.
    const gestureFrames = [];
    // gfxinfo's own counters at the last collection. Their growth over one
    // gesture is that gesture's window; the accumulated total is the bout's and
    // says nothing about any single fling.
    let counters = before;
    // Every gesture is collected once it has settled, drags included: a drag's
    // frames are real work, and a fling's settling frames belong to the fling
    // that caused them rather than to whatever ran next.
    //
    // `rendered` counts the frames gfxinfo says were drawn inside those windows
    // and `retained` the rows kept from the ring. A gap means the 120-frame ring
    // wrapped while a window was open, so that window's account is incomplete.
    let rendered = 0;
    let retained = 0;
    let coverageBroken = false;
    // One window: every frame gfxinfo drew since the last snapshot, closed by
    // this snapshot. `gesture` names what the window was opened for -- a real
    // gesture, or the hierarchy dump and screenshot an observation costs, which
    // is work of its own and must not be charged to the fling that follows it.
    const collect = async (window) => {
        const openedAt = Date.now();
        const snapshot = await gfxSnapshot(PKG, { hz });
        const fresh = freshFrameRows(snapshot.rows, counted);
        // No clock, no latency. Substituting the frame's own duration answers
        // "how late was the touch" with a number that never saw a touch.
        const t0Ns = Number.isFinite(window.t0Seconds) ? window.t0Seconds * 1e9 : undefined;
        const reduced = reduceFrameStats(fresh, { frameNs: 1e9 / hz, t0Ns });
        parts.push(reduced);
        // A counter that could not be read, or one that went backwards because
        // something reset the window, is not a delta. It is a hole, and a hole
        // that reduces to zero passes the per-fling limit on nothing.
        const was = counters?.missedVsync;
        const now = snapshot.jank.missedVsync;
        const missedVsync = was === undefined || now === undefined || now < was ? undefined : now - was;
        const grew = (snapshot.jank.frames ?? NaN) - (counters?.frames ?? NaN);
        if (Number.isFinite(grew) && grew >= 0) {
            rendered += grew;
            retained += fresh.length;
        } else coverageBroken = true;
        counters = snapshot.jank;
        gestureFrames.push({
            profile: window.profile,
            // A window opened by a touch is graded on that touch's origin; the
            // dumps and screenshots between gestures never had one to lose.
            input: window.input === true,
            openedAtMs: openedAt,
            closedAtMs: Date.now(),
            t0Seconds: window.t0Seconds,
            durationMs: window.durationMs,
            elapsedMs: window.elapsedMs,
            frames: reduced.frames,
            dropped: reduced.dropped,
            worstMs: reduced.worstMs,
            inputToFrameMs: reduced.inputToFrameMs,
            ...(window.input === true && t0Ns === undefined ? { clockUnavailable: true } : {}),
            missedVsync,
            rows: fresh.slice(0, RAW_FRAME_ROW_CAP),
            ...(fresh.length > RAW_FRAME_ROW_CAP ? { rowsOmitted: fresh.length - RAW_FRAME_ROW_CAP } : {}),
        });
        return snapshot;
    };
    let bout = { gestures: 0, flings: 0, medianVelocityPxPerSecond: 0 };
    try {
        bout = await run({
            onGesture: async (gesture) => {
                // Frames first: the hierarchy dump and screenshot below cost
                // seconds, and the 120-frame ring evicts this gesture's own
                // input frames while they are being taken.
                await collect({ ...gesture, input: true });
                if (gesture.profile !== 'fling') return;
                if (phase?.oneWayMovement === true && oneWaySurface === undefined && surface !== undefined) {
                    oneWaySurface = await captureSurface(surface, screen);
                    // The dump and the screenshot drew frames of their own. They
                    // close in their own window, not in the next fling's.
                    await collect({ profile: 'observation' });
                }
            },
        });
    } catch (error) {
        if (!(error instanceof Error && error.message === 'device could not inject')) throw error;
        bout = { ...bout, injectFailed: true };
    }
    // The bout's own tail, then the closing observation, then the snapshot that
    // closes both. Coverage is reconciled through this last snapshot, so the
    // frames drawn after the final gesture are inside the account rather than
    // arriving in a jank report nothing was compared against.
    await collect({ profile: 'bout close' });
    const afterSurface = surface === undefined ? undefined : await captureSurface(surface, screen);
    const closing = await collect({ profile: 'observation' });
    const after = closing.jank;
    // The attempt ends on its own last observation, and the sampler's closing
    // CPU, PSS and frame samples are taken before this returns. Anything after
    // it -- a diagnostics pull, the next phase's navigation -- is not measured.
    await prepared?.attempt?.close();
    const injectFailed = bout.injectFailed === true;
    const observed = beforeSurface === undefined
        ? undefined
        : bestObservation(beforeSurface, afterSurface, oneWaySurface);
    const movement = beforeSurface === undefined ? undefined : reduceMovement(phase ?? surface, {
        before: beforeSurface,
        after: observed.sample,
        pixels: observed.pixels,
    });
    return {
        bout,
        injectFailed,
        jank: reduceJank(before, after, { hz }),
        frameStats: mergeFrameStats(parts),
        gestureFrames,
        frameCoverage: coverageBroken ? undefined : { rendered, retained },
        missedVsyncPerFling: worstMissedVsyncPerFling(gestureFrames),
        movement,
        beforeSurface,
        afterSurface,
        oneWaySurface,
    };
}

/**
 * The worst single fling window, never a total divided by a fling count: the
 * limit is written per fling, so only a fling's own window can breach it.
 */
function worstMissedVsyncPerFling(gestureFrames) {
    const flings = gestureFrames.filter((row) => row.profile === 'fling');
    // One unreadable window is one fling nobody can answer for, so the phase
    // has no per-fling result at all rather than the best of what survived.
    if (flings.length === 0 || flings.some((row) => !Number.isFinite(row.missedVsync))) return undefined;
    return Math.max(...flings.map((row) => row.missedVsync));
}

/**
 * The observation of this bout that saw the most movement against its start --
 * pixels and the surface they were measured on together, so the labels a phase
 * grades come from the same capture as its pixels and not from a later screen.
 */
function bestObservation(beforeSurface, afterSurface, oneWaySurface) {
    const samples = [afterSurface, oneWaySurface].filter((sample) => sample !== undefined);
    if (samples.length === 0) return { sample: afterSurface, pixels: pixelsMoved(beforeSurface.crop, undefined) };
    return samples
        .map((sample) => ({ sample, pixels: pixelsMoved(beforeSurface.crop, sample.crop) }))
        .reduce((best, next) => (next.pixels.meanAbs > best.pixels.meanAbs ? next : best));
}

function withTrailMovement(measured, phase, terminal) {
    if (measured.beforeSurface === undefined) {
        return { ...measured, terminal, movement: measured.movement };
    }
    const observed = bestObservation(measured.beforeSurface, measured.afterSurface, measured.oneWaySurface);
    return {
        ...measured,
        terminal,
        movement: reduceMovement(phase, {
            before: measured.beforeSurface,
            after: observed.sample,
            terminal,
            pixels: observed.pixels,
        }),
    };
}

/**
 * The route that reaches one named pane, and nothing else.
 *
 * An agent pane is reached through the host's own persisted session binding --
 * the identity the app resolves for itself -- and a shell pane through its
 * plain deep link. Neither depends on where the pane's card currently sits.
 */
function fixtureRoute(paneId) {
    const agent = stack.world.agents.find((row) => row.pane_id === paneId);
    if (agent === undefined) return `muxr:///session/${encodeURIComponent(`shell:${paneId}`)}`;
    const routes = JSON.parse(readFileSync(join(stack.dataDir, 'herdr-routes.json'), 'utf8')).bindings;
    const binding = routes.find((row) => ['source', 'agent', 'kind', 'value']
        .every((key) => row.agentSession?.[key] === agent.agent_session[key]));
    if (binding?.route === undefined) return undefined;
    return `muxr://session/${encodeURIComponent(binding.route)}`;
}

/**
 * Open the pane this phase names and prove that pane arrived: the surface has
 * to be mounted and the host has to have recorded an attach for that exact id
 * since the route was opened. A mounted terminal alone says only that some
 * pane is on screen.
 */
async function openFixturePane(paneId) {
    if (paneId === undefined) return 'the herd published no fixture pane for this phase';
    if (!await returnToHerd()) return 'the herd never came back on screen';
    const url = fixtureRoute(paneId);
    if (url === undefined) return `no host session route resolves pane ${paneId}`;
    const openedAt = new Date().toISOString();
    await run('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, PKG], { timeout: 20_000 })
        .catch(() => undefined);
    await dismissPrompts();
    const deadline = Date.now() + 15_000;
    do {
        await sleep(700);
        // A control attach for this exact pane since the route opened. Cell
        // pixels are not required here: a software-rendered emulator never
        // declares them, and the question this answers is which pane the phone
        // took over, not how it draws.
        if (await viewBounds('GhosttyTerminalView') !== undefined
            && paneAttaches(paneId, openedAt).length > 0) {
            await dismissKeyboard();
            return undefined;
        }
    } while (Date.now() < deadline);
    return `pane ${paneId} never attached on the surface this phase measures`;
}

/**
 * Navigation, surface assertion, trail baseline, counter reset — in that order,
 * and all of it before a single number is read. A phase whose prerequisite
 * failed is reported as a failed prerequisite; its gesture metrics would
 * describe some other screen.
 */
async function preparePhase(phase, screen, hz) {
    if (phase.drive === undefined) {
        return await returnToHerd() ? { ok: true } : { ok: false, why: 'the herd never came back on screen' };
    }
    const surface = { treeFling: 'tree', stripPaging: 'strip', documentScroll: 'document', terminalTextFling: 'terminal', graphicsScroll: 'graphics', zoomTapNavigate: 'terminal' }[phase.drive];
    // Only the phases graded on the phone's own counters pay for a baseline
    // pull; it costs a round trip through Settings and back.
    const wantsTrail = phase.drive === 'terminalTextFling' || phase.drive === 'zoomTapNavigate';
    let flowExit;
    let trailBefore;
    let documentBounds;

    if (wantsTrail) {
        // Pulled from the herd, before entering the surface: the pull leaves the
        // route, so it cannot be taken once the phase is standing on its screen.
        if (!await returnToHerd()) return { ok: false, why: 'the herd never came back on screen' };
        const mark = await pullPhoneTrail();
        if (!mark.ok) return { ok: false, why: `the phone trail is unavailable (${mark.why})` };
        trailBefore = mark.trail;
    }

    if (phase.nav !== undefined) {
        const flow = await maestro(phase.nav);
        flowExit = flow.code;
        if (flow.code !== 0) {
            return { ok: false, flowExit, why: `${phase.nav} did not complete`, flowOutput: flow.output.split('\n').slice(-25).join('\n') };
        }
    }

    // Everything the host records for this phase is stamped after this mark, so
    // a pane another phase opened cannot be read as this one's evidence.
    const enteredAt = new Date().toISOString();

    if (phase.drive === 'treeFling' || phase.drive === 'stripPaging') {
        if (!await returnToHerd()) return { ok: false, why: 'the herd never came back on screen' };
    } else if (phase.drive === 'documentScroll') {
        await dismissKeyboard();
        const dump = await dumpUi();
        // Two separate questions: is the fixture the one on screen, and can this
        // phase see where the surface is standing. Either missing is unavailable
        // evidence, so neither is inferred from the other.
        if (firstDocumentMarker(dump) === undefined) return { ok: false, flowExit, why: 'the document fixture is not on the reading surface' };
        const viewport = documentViewport(dump);
        if (viewport.bounds === undefined) return { ok: false, flowExit, why: `the document viewport is unavailable (${viewport.why})` };
        documentBounds = viewport.bounds;
    } else {
        // Every terminal phase names its pane. Nothing else is a measurable
        // surface: a card position is whatever the churning herd left there.
        const why = await openFixturePane(stack.fixturePanes?.[phase.fixture]);
        if (why !== undefined) return { ok: false, flowExit, why };
    }

    // A phase that names its surface has to be standing on that surface. A
    // graphics pane judged against the text terminal's latency contract passes
    // it on numbers that describe something else entirely.
    let surfaceKind;
    if (phase.surfaceKind !== undefined) {
        const probed = await probeSurfaceKind();
        if (probed.kind === undefined) return { ok: false, flowExit, why: `the surface could not be identified (${probed.why})` };
        if (probed.kind !== phase.surfaceKind) {
            return { ok: false, flowExit, why: `this phase measures a ${phase.surfaceKind} pane but the surface is ${probed.kind}` };
        }
        surfaceKind = probed.kind;
    }

    // The strip is driven on the scroller the hierarchy publishes, so the
    // bounds are resolved -- and refused when missing or ambiguous -- before the
    // counters are zeroed and before a single gesture is injected.
    let stripBounds;
    if (phase.drive === 'stripPaging') {
        const resolved = stripScroller(await dumpUi());
        if (resolved.bounds === undefined) return { ok: false, flowExit, why: `the live strip is unavailable (${resolved.why})` };
        stripBounds = resolved.bounds;
    }

    return {
        ok: true,
        flowExit,
        trailBefore,
        enteredAt,
        surfaceKind,
        stripBounds,
        documentBounds,
        paneId: phase.fixture === undefined ? undefined : stack.fixturePanes?.[phase.fixture],
        prepared: await prepareBout(surface, screen, hz),
    };
}

/** `enabled` on the panel control the app published, or `undefined` if absent. */
function controlEnabled(dump, label) {
    const node = (String(dump).match(/<node\b[^>]*>/g) ?? []).find((row) => row.includes(`content-desc="${label}"`));
    return node === undefined ? undefined : /enabled="true"/.test(node);
}

/**
 * The control attaches this phase opened on one exact pane.
 *
 * `pane.read` is a read-only thumbnail of whatever pane the herd screen happens
 * to be showing; it says nothing about which pane the phone took over. A
 * control attach is the terminal session the phone drives, so that is the only
 * record that proves this phase is standing on the pane it names. The timestamp
 * keeps an earlier phase's attach out of it.
 */
function paneAttaches(paneId, since) {
    if (stack?.cellMetricsJsonl === undefined) return [];
    return readJsonl(stack.cellMetricsJsonl).filter((record) => record.source === 'terminal.attach'
        && record.mode === 'control'
        && (paneId === undefined || String(record.pane_id) === paneId)
        && String(record.at) >= since
        && [record.cols, record.rows].every((value) => Number(value) > 0));
}

/**
 * The geometry the phone actually declared on the wire, from the attach and
 * terminal.resize records the fake herd writes beside its socket. This is the
 * source a zoom step changes: a text pane re-grids, a graphics pane holds the
 * grid and moves its cell pixels. Reads are phase-local and pinned to one pane,
 * so an earlier phase's pane can never supply this phase's before-and-after.
 *
 * The attach record carries the grid but no cell pixels, and it is the only
 * geometry a pane the phone never re-gridded has. Requiring cell pixels here
 * discarded exactly that baseline, so the grid is what makes a record usable
 * and the cell is carried when the phone sent it.
 */
function paneGeometry(paneId, since) {
    if (stack?.cellMetricsJsonl === undefined) return [];
    return readJsonl(stack.cellMetricsJsonl).filter((record) => (paneId === undefined || String(record.pane_id) === paneId)
        && String(record.at) >= since
        && [record.cols, record.rows].every((value) => Number(value) > 0));
}

/** One tap's work has to have reached the host inside this window. */
const ZOOM_SETTLE_MS = 1500;

/**
 * Drain the pane's geometry to quiet and hand back the series it settled on.
 *
 * Every read has to succeed: a file that went missing, could not be parsed or
 * was caught half-written mid-drain is an unavailable baseline, never a quiet
 * one. A pane still re-gridding when the window closes has not settled either,
 * and a step read against it would be counting somebody else's change.
 */
async function settleGeometry(read, { quietMs = 900, timeoutMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = read();
    if (!last.ok) return last;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
        await sleep(300);
        const now = read();
        if (!now.ok) return now;
        if (now.rows.length !== last.rows.length) {
            last = now;
            quietSince = Date.now();
            continue;
        }
        if (Date.now() - quietSince >= quietMs) return { ok: true, rows: now.rows };
    }
    return { ok: false, why: 'the pane never stopped re-gridding' };
}

/**
 * Text or graphics, from the state the app publishes on the controls panel
 * before anything is tapped: a text pane opens in the middle of its font ladder,
 * so `Zoom out` is live; a graphics pane opens at scale 1, its smallest, so it
 * is not.
 */
async function probeSurfaceKind() {
    if (!await tapBounds('content-desc="Show terminal controls"')) return { why: 'the terminal controls never opened' };
    await sleep(600);
    const panel = await dumpUi();
    const zoomOutAtRest = controlEnabled(panel, 'Zoom out');
    const zoomInPresent = controlEnabled(panel, 'Zoom in');
    await tapBounds('content-desc="Close terminal controls"');
    await sleep(400);
    if (zoomInPresent === undefined || zoomOutAtRest === undefined) return { why: 'the panel published no zoom controls' };
    return { kind: zoomOutAtRest ? 'text' : 'graphics', zoomOutAtRest };
}

async function drivePhase(phase, screen, hz, ready) {
    const { width, height } = screen;
    const seconds = phase.seconds;
    const prepared = ready.prepared;
    const sinceEntry = async () => {
        // Leaving for Settings ends the measurement. The closing samples are
        // taken and acknowledged before this route moves anywhere.
        await prepared?.attempt?.close();
        const mark = await pullPhoneTrail();
        if (!mark.ok) return { ok: false, why: mark.why };
        return trailSince(mark.trail, ready.trailBefore);
    };
    if (phase.drive === 'treeFling') {
        return measureBout((opts) => scrollBout({ width, height, seconds, ...opts }), hz, { surface: 'tree', screen, phase, prepared });
    }
    if (phase.drive === 'stripPaging') {
        return measureBout((opts) => stripBout({ bounds: ready.stripBounds, seconds, ...opts }), hz, { surface: 'strip', screen, phase, prepared });
    }
    if (phase.drive === 'documentScroll') {
        // Reading, and only reading: the viewer reached from the herd carries no
        // file navigator, so it has no `File n of m` to move and a horizontal
        // swipe there proves nothing. What the long fixture can prove is that
        // its own numbered lines travelled under the finger.
        return measureBout((opts) => scrollBout({ width, height, bounds: ready.documentBounds, seconds, ...opts }), hz, { surface: 'document', screen, phase, prepared });
    }
    if (phase.drive === 'terminalTextFling') {
        const measured = await measureBout((opts) => scrollBout({ width, height, seconds, ...opts }), hz, { surface: 'terminal', screen, phase, prepared });
        const trail = await sinceEntry();
        if (!trail.ok) return { ...measured, trailUnavailable: trail.why };
        const terminal = {
            scrollRequests: trail.scrollRequests,
            rowsRequested: trail.rowsRequested,
            rowsSent: trail.rowsRequested,
            rowsPerSecond: seconds > 0 ? Number((trail.rowsRequested / seconds).toFixed(1)) : 0,
            clamped: trail.clamped,
            timedOut: trail.timedOut,
            agentPages: trail.agentPages,
        };
        return { ...withTrailMovement(measured, phase, terminal), surfaceKind: ready.surfaceKind };
    }
    if (phase.drive === 'graphicsScroll') {
        ingestHostJournal(journalAcc, stack.journalPath ?? join(stack.dataDir, 'diagnostics.json'));
        const startedAt = new Date().toISOString();
        const measured = await measureBout((opts) => scrollBout({ width, height, seconds, ...opts }), hz, { surface: 'graphics', screen, phase, prepared });
        // The host flushes graphics.pipeline every 15 s. Give the last window
        // a chance to land so notchesDropped is this bout, not a later phase.
        const deadline = Date.now() + 16_000;
        let pipeline = { notchesSent: 0, notchesDropped: 0, frames: 0 };
        do {
            await sleep(1000);
            ingestHostJournal(journalAcc, stack.journalPath ?? join(stack.dataDir, 'diagnostics.json'));
            pipeline = reducePipelineNotches(
                journalAcc.events.filter((event) => event.event === 'graphics.pipeline' && event.at >= startedAt),
            );
            if (pipeline.notchesSent > 0 || pipeline.notchesDropped > 0) break;
        } while (Date.now() < deadline);
        const rowsPerSecond = seconds > 0 ? Number((3 * pipeline.notchesSent / seconds).toFixed(1)) : 0;
        return {
            ...measured,
            terminal: {
                notchesSent: pipeline.notchesSent,
                notchesDropped: pipeline.notchesDropped,
                rowsPerSecond,
            },
            graphicsRowsPerSecond: rowsPerSecond,
        };
    }
    if (phase.drive === 'zoomTapNavigate') {
        const before = prepared.before;
        // Everything this phase reads is stamped after it entered its surface,
        // so a pane an earlier phase opened can never supply this one's step.
        const entered = ready.enteredAt;
        const paneId = ready.paneId;
        if (paneId === undefined) return { zoomEvidenceUnavailable: 'this phase named no fixture pane' };
        const unavailable = (why) => ({
            zoomEvidenceUnavailable: why,
            jank: reduceJank(before, before, { hz }),
            frameStats: mergeFrameStats([]),
            bout: { gestures: 1, flings: 1, medianVelocityPxPerSecond: 0 },
            injectFailed: false,
        });
        // One fail-closed reading of the pane's own geometry series. The
        // baseline may be the grid the pane attached with: a pane the phone
        // never re-gridded still declared a grid, and requiring a prior resize
        // discarded exactly that baseline.
        const geometry = () => {
            const read = readJsonlStrict(stack?.cellMetricsJsonl);
            if (!read.ok) return read;
            return {
                ok: true,
                rows: read.rows.filter((record) => String(record.pane_id) === paneId
                    && String(record.at) >= entered
                    && [record.cols, record.rows].every((value) => Number(value) > 0)),
            };
        };
        const attachRead = () => {
            const read = readJsonlStrict(stack?.cellMetricsJsonl);
            if (!read.ok) return read;
            return {
                ok: true,
                rows: read.rows.filter((record) => record.source === 'terminal.attach'
                    && record.mode === 'control'
                    && String(record.pane_id) === paneId
                    && String(record.at) >= entered),
            };
        };
        const attaches = attachRead();
        if (!attaches.ok) return unavailable(`the pane's attach evidence is unavailable (${attaches.why})`);

        // The zoom buttons live behind the controls key; they do not exist until
        // the panel is open, so a tap that misses is a harness miss, not a
        // missing feature.
        const opened = await tapBounds('content-desc="Show terminal controls"');
        await sleep(600);
        // The surface is told apart by the state the app itself publishes before
        // anything is tapped: a text pane opens in the middle of its font
        // ladder, so `Zoom out` is live; a graphics pane opens at scale 1, its
        // smallest, so it is not. `Reset zoom` disabled is the app's own report
        // that the pane is still at its untouched default.
        const panel = await dumpUi();
        const zoomOutAtRest = controlEnabled(panel, 'Zoom out');
        const zoomSurface = controlEnabled(panel, 'Zoom in') === undefined || zoomOutAtRest === undefined
            ? undefined
            : zoomOutAtRest ? 'text' : 'graphics';
        const atRestDefault = controlEnabled(panel, 'Reset zoom') === false;

        // Drain and validate the baseline, then take the cursor immediately
        // before the tap. Opening the pane and the panel both re-grid, and a
        // cursor taken while those were still arriving would count them as the
        // tap's own work.
        const baseline = await settleGeometry(geometry);
        if (!baseline.ok) return unavailable(`the baseline geometry is unavailable (${baseline.why})`);
        if (baseline.rows.length === 0) return unavailable('the pane declared no geometry at all');
        const cursor = baseline.rows.length;

        // Resolve and validate the control before anything is timed. Finding it
        // costs a UIAutomator dump of seconds, and a timing origin taken before
        // that dump would put the whole dump inside the frame window -- the
        // first frame the tap drove would then look seconds late against a
        // limit meant for the tap alone.
        const zoomInBounds = opened && zoomSurface !== undefined
            ? await viewBounds('content-desc="Zoom in"')
            : undefined;
        if (zoomInBounds === undefined) return unavailable('the Zoom in control is not on the panel');
        if (!(zoomInBounds.r > zoomInBounds.l && zoomInBounds.b > zoomInBounds.t)) {
            return unavailable('the Zoom in control has no tappable bounds');
        }

        // Origin and injection in one spawn, the way a fling is timed: the
        // device samples `/proc/uptime` in the same shell that injects the tap,
        // so t0 is the moment the injector started rather than a round trip
        // earlier. The counters are never reset here -- the phase's jank is
        // differenced against a baseline taken before it started, and zeroing
        // them midway would make that delta describe nothing.
        // The counters immediately before the tap. The phase's own jank spans
        // preparation, the second step, zoom out and reset; only this pair
        // brackets the window the frames below are cut to.
        const vsyncBefore = await gfxSnapshot(PKG, { hz });
        const injected = await tapTimed(
            (zoomInBounds.l + zoomInBounds.r) / 2,
            (zoomInBounds.t + zoomInBounds.b) / 2,
        ).catch(() => ({ tapped: false }));
        if (injected.tapped !== true) return unavailable('the Zoom in tap could not be injected');
        if (!Number.isFinite(injected.t0Seconds)) return unavailable('the device monotonic clock did not read with the tap');
        const t0Ns = injected.t0Seconds * 1e9;

        // Confirm the app itself moved -- `Reset zoom` goes live once a step
        // landed -- then keep observing through the bounded settle. Records that
        // arrive while these dumps are being read are still inside the window:
        // it closes on the read below, not on the confirmation.
        let steppedIn = false;
        const confirmBy = Date.now() + ZOOM_SETTLE_MS;
        do {
            await sleep(300);
            steppedIn = controlEnabled(await dumpUi(), 'Reset zoom') === true;
        } while (!steppedIn && Date.now() < confirmBy);
        await sleep(ZOOM_SETTLE_MS);

        // Close the frame window on the device's own clock too, so the ring is
        // bounded at both ends by the tap and its settle rather than by
        // everything that happened to be drawn afterwards.
        const t1Seconds = await deviceMonotonicSeconds().catch(() => undefined);
        if (!Number.isFinite(t1Seconds)) return unavailable('the device monotonic clock did not read at the close');
        const t1Ns = t1Seconds * 1e9;

        // The closing read, before any other action is driven, and it has to be
        // the same append-only series the baseline came from. A read that lost
        // records, or that changed one the baseline already held, is a different
        // file -- a rotation, a re-entered pane, two panes on one path -- and a
        // window sliced out of it would read this pane's step off other records.
        const closing = geometry();
        if (!closing.ok) return unavailable(`the closing geometry read is unavailable (${closing.why})`);
        const continuity = continuesFrom(baseline.rows, closing.rows);
        if (!continuity.ok) return unavailable(`the closing geometry is not continuous (${continuity.why})`);
        const observed = closing.rows.slice(cursor - 1);
        const transitions = reduceGridTransitions(observed);
        // The ring bounded to this tap and its settle, so the frames, the drops
        // and the input-to-frame all describe the same window the grid did.
        const vsyncAfter = await gfxSnapshot(PKG, { hz });
        // Coverage is the snapshot pair, exactly what the counters below span:
        // frames drawn before the tap and while it settled are part of that
        // window, so cutting the rows to the injector's interval would report
        // them as lost. The injector's interval still bounds what the tap is
        // graded on, which is latency and the frames the touch itself drove.
        const sinceBaseline = freshFrameRows(vsyncAfter.rows, new Set(vsyncBefore.rows.map((row) => Number(row.IntendedVsync))));
        const windowRows = vsyncAfter.rows.filter((row) => {
            const completed = Number(row.FrameCompleted);
            return completed >= t0Ns && completed <= t1Ns;
        });
        const zoomFrames = reduceFrameStats(windowRows, { frameNs: 1e9 / hz, t0Ns });
        // The same window, graded on the same allowance as any other gesture: a
        // counter that could not be read or that went backwards is a hole, and
        // more frames drawn than the ring gave back is an incomplete account.
        const wasMissed = vsyncBefore.jank.missedVsync;
        const nowMissed = vsyncAfter.jank.missedVsync;
        if (wasMissed === undefined || nowMissed === undefined || nowMissed < wasMissed) {
            return unavailable('the missed-vsync counter did not read across the zoom window');
        }
        const drewInWindow = (vsyncAfter.jank.frames ?? NaN) - (vsyncBefore.jank.frames ?? NaN);
        if (!Number.isFinite(drewInWindow) || drewInWindow < 0) {
            return unavailable('the frame counter did not read across the zoom window');
        }
        const zoomCoverage = { rendered: drewInWindow, retained: sinceBaseline.length };

        // Only now may anything else be driven. The pixels below are this
        // phase's own pane after its own step: on a graphics surface they are
        // both the magnification and the proof that a frame was delivered, so
        // no aggregate host publication count stands in for either.
        await tapBounds('content-desc="Close terminal controls"');
        await sleep(400);
        const magnified = zoomSurface !== 'graphics' ? undefined : reduceMagnification(
            prepared.beforeSurface?.crop,
            cropRaw(await screencapRaw().catch(() => undefined) ?? {}, prepared.beforeSurface?.bounds),
            { expected: LIMITS.graphicsZoomStep },
        );
        // Back down the same ladder. `Reset zoom` is the surface's own report of
        // where it stands, so a step that returned it to the default disables
        // that control again; a tap the app ignored leaves it live.
        const atDefaultAfter = async (label) => {
            if (!await tapBounds(`content-desc="${label}"`)) return false;
            await sleep(600);
            return controlEnabled(await dumpUi(), 'Reset zoom') === false;
        };
        await tapBounds('content-desc="Show terminal controls"');
        await sleep(500);
        const zoomedOut = steppedIn && await atDefaultAfter('Zoom out');
        // `Reset zoom` returning to disabled only proves anything if a step
        // landed first, so the second `Zoom in` has to be seen to do something.
        await tapBounds('content-desc="Zoom in"');
        await sleep(500);
        const steppedInAgain = controlEnabled(await dumpUi(), 'Reset zoom') === true;
        const zoomReset = steppedInAgain && await atDefaultAfter('Reset zoom');
        await tapBounds('content-desc="Close terminal controls"');
        await sleep(300);
        const ghostty = await viewBounds('GhosttyTerminalView');
        if (ghostty !== undefined) {
            const cx = (ghostty.l + ghostty.r) / 2;
            const cy = (ghostty.t + ghostty.b) / 2;
            await tap(cx, cy);
            await sleep(500);
            await tap(ghostty.l + (ghostty.r - ghostty.l) * 0.25, ghostty.t + (ghostty.b - ghostty.t) * 0.5);
            await sleep(300);
            await fling({ x: cx, y: cy + 200 }, { x: cx, y: cy - 200 });
            await sleep(400);
            await drag({
                from: { x: cx, y: cy },
                to: { x: cx - 200, y: cy },
            });
            await screencapRaw('/tmp/muxr-zoom-pane.raw').catch(() => undefined);
            // Tapping the grid raises the IME by design; the trail pull below
            // must not be typed into a keyboard covering the screen.
            await dismissKeyboard();
        }
        const after = await jankReport(PKG, { hz });
        const trail = await sinceEntry();
        if (!trail.ok) return { trailUnavailable: trail.why, jank: reduceJank(before, after, { hz }), frameStats: zoomFrames, bout: { gestures: 1, flings: 1, medianVelocityPxPerSecond: 0 }, injectFailed: false };
        return {
            bout: { gestures: 1, flings: 1, medianVelocityPxPerSecond: 0 },
            injectFailed: false,
            // The whole phase, kept as the diagnostic it is. What the tap is
            // graded on is the bracketed window below, never this.
            jank: reduceJank(before, after, { hz }),
            missedVsyncPerFling: nowMissed - wasMissed,
            frameCoverage: zoomCoverage,
            // The tap and its settle, held to the same framestats account as any
            // other gesture: a window with no ring, or none the touch drove,
            // measured nothing rather than measuring a perfect zero.
            frameStats: zoomFrames,
            surfaceKind: ready.surfaceKind,
            zoomSurface,
            zoomControlsOpened: opened,
            zoomAtRestDefault: atRestDefault,
            zoomTransitions: transitions.count,
            zoomShrankOnce: transitions.shrankOnce,
            // Every read of the window succeeded, so the series below is the
            // pane's own account rather than one nobody could collect.
            zoomWindow: true,
            zoomTapped: steppedIn,
            steppedInAgain,
            zoomMagnified: magnified,
            zoomedOut,
            zoomReset,
            zoom: {
                paneId,
                surface: zoomSurface,
                zoomOutAtRest,
                atRestDefault,
                steppedIn,
                cursor,
                baselineRecords: baseline.rows.length,
                observed,
                transitions: transitions.transitions,
                magnified,
            },
            attachRecords: attaches.rows.length,
            geometryRecords: closing.rows.length,
            terminal: {
                scrollRequests: trail.scrollRequests,
                rowsRequested: trail.rowsRequested,
                rowsSent: trail.rowsRequested,
                rowsPerSecond: 0,
                clamped: trail.clamped,
                timedOut: trail.timedOut,
            },
        };
    }
    return undefined;
}


function buildTool(name) {
    const home = process.env.ANDROID_HOME ?? join(homedir(), 'Android/Sdk');
    const root = join(home, 'build-tools');
    if (!existsSync(root)) return undefined;
    for (const version of readdirSync(root).sort().reverse()) {
        const bin = join(root, version, name);
        if (existsSync(bin)) return bin;
    }
    return undefined;
}

function inspectApk(apk) {
    const aapt = buildTool('aapt') ?? buildTool('aapt2');
    const apksigner = buildTool('apksigner');
    let versionCode;
    let versionName;
    let abi;
    if (aapt !== undefined) {
        const dump = spawnSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8', timeout: 30_000 });
        const text = `${dump.stdout ?? ''}\n${dump.stderr ?? ''}`;
        versionCode = Number(/versionCode='(\d+)'/.exec(text)?.[1]);
        versionName = /versionName='([^']+)'/.exec(text)?.[1];
        abi = /native-code:\s+'([^']+)'/.exec(text)?.[1]?.trim().split(/\s+/)[0];
    }
    let signerDigest;
    if (apksigner !== undefined) {
        const verify = spawnSync(apksigner, ['verify', '--print-certs', apk], { encoding: 'utf8', timeout: 30_000 });
        const text = `${verify.stdout ?? ''}\n${verify.stderr ?? ''}`;
        signerDigest = /SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(text)?.[1]
            ?? /SHA256[:\s]+([0-9a-fA-F:]+)/.exec(text)?.[1];
    }
    return {
        versionCode: Number.isFinite(versionCode) ? versionCode : undefined,
        versionName,
        abi: abi || 'x86_64',
        signerDigest,
    };
}

function versionedApkPath(apk, identity) {
    const dest = `/tmp/muxr-${identity.versionName ?? 'unknown'}-vc${identity.versionCode ?? 'unknown'}-${identity.abi ?? 'x86_64'}.apk`;
    if (apk !== dest) copyFileSync(apk, dest);
    return dest;
}

function emptyJournalAcc() {
    return { seen: new Set(), events: [], path: undefined, reads: 0, lastError: undefined };
}

function ingestHostJournal(acc, path) {
    acc.reads += 1;
    acc.path = path;
    try {
        const journal = JSON.parse(readFileSync(path, 'utf8'));
        for (const event of journal.events ?? []) {
            const key = [event.at, event.event, event.request, event.outcome, event.durationMs, event.frames, event.p95Ms, event.notchesSent].join('|');
            if (acc.seen.has(key)) continue;
            acc.seen.add(key);
            acc.events.push(event);
        }
        acc.lastError = undefined;
        return journal;
    } catch (cause) {
        acc.lastError = cause instanceof Error ? cause.message : String(cause);
        return undefined;
    }
}

function journalEventCounts(events) {
    const counts = {};
    for (const event of events) {
        const key = event.event ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}

function gestureEvidence(driven, idleJs) {
    if (driven === undefined) return undefined;
    const jsBusyDeltaPoints = idleJs === undefined || driven.jsBusyPercent === undefined
        ? undefined
        : Number((driven.jsBusyPercent - idleJs).toFixed(1));
    return {
        gestures: driven.bout?.gestures ?? 0,
        flings: driven.bout?.flings ?? 0,
        profiles: driven.bout?.profiles ?? [],
        medianVelocityPxPerSecond: driven.bout?.medianVelocityPxPerSecond ?? 0,
        intendedMedianVelocityPxPerSecond: driven.bout?.intendedMedianVelocityPxPerSecond ?? 0,
        byProfile: driven.bout?.byProfile,
        slowProfiles: driven.bout?.slowProfiles,
        samples: driven.bout?.samples,
        frameCoverage: driven.frameCoverage,
        jank: {
            frames: driven.jank?.frames ?? 0,
            jankyPercent: driven.jank?.jankyPercent,
            p50Ms: driven.jank?.p50Ms,
            p90Ms: driven.jank?.p90Ms,
            p95Ms: driven.jank?.p95Ms,
            p99Ms: driven.jank?.p99Ms,
            missedVsync: driven.jank?.missedVsync ?? 0,
            highInputLatency: driven.jank?.highInputLatency ?? 0,
            deadlineMissed: driven.jank?.deadlineMissed ?? 0,
            overOneFramePercent: driven.jank?.overOneFramePercent ?? 0,
            overFourFramesPercent: driven.jank?.overFourFramesPercent ?? 0,
            histogram: driven.jank?.histogram ?? '',
        },
        frameStats: driven.frameStats ?? { frames: 0, dropped: 0, worstMs: 0, inputToFrameMs: {} },
        gestureFrames: driven.gestureFrames,
        missedVsyncPerFling: driven.missedVsyncPerFling,
        movement: driven.movement,
        injectFailed: driven.injectFailed === true,
        zoomSurface: driven.zoomSurface,
        zoomTransitions: driven.zoomTransitions,
        zoomShrankOnce: driven.zoomShrankOnce,
        zoomAtRestDefault: driven.zoomAtRestDefault,
        zoomWindow: driven.zoomWindow,
        attachRecords: driven.attachRecords,
        geometryRecords: driven.geometryRecords,
        zoomTapped: driven.zoomTapped,
        zoomMagnified: driven.zoomMagnified,
        zoomedOut: driven.zoomedOut,
        zoomReset: driven.zoomReset,
        zoomControlsOpened: driven.zoomControlsOpened,
        zoom: driven.zoom,
        notchesSent: driven.terminal?.notchesSent,
        notchesDropped: driven.terminal?.notchesDropped,
        jsBusyIdlePercent: idleJs,
        jsBusyDeltaPoints,
        accidentalOwners: driven.terminal?.agentPages ?? 0,
    };
}


// 1. Preflight. Every missing prerequisite is a named failure, never a timeout.
process.stdout.write('\n=== MUXR RELEASE PERF GATE ===\n\n');
if (!await deviceReady()) fail('no adb device; start the emulator first');
const avd = await avdName();
if (avd !== '' && avd !== AVD) process.stdout.write(`note: measuring on AVD ${avd}, not ${AVD}\n`);
const maestroVersion = spawnSync(MAESTRO[0], [...MAESTRO[1], '--version'], { encoding: 'utf8', timeout: 120_000 });
if ((maestroVersion.status ?? 1) !== 0) fail('maestro is unavailable');
if (failures.length > 0) finish(1);
report.avd = avd;
report.maestro = (maestroVersion.stdout ?? '').trim().split('\n').pop();
ok(`preflight: device ${avd || 'unknown'}, maestro ${report.maestro}`);
const device = await deviceIdentity();
const hz = device.refreshHz ?? await refreshHz();
report.device = {
    model: device.model,
    sdk: device.sdk,
    refreshHz: hz,
    density: device.density,
    renderer: device.renderer,
};
const screen = {
    width: device.width ?? 1080,
    height: device.height ?? 1920,
};
ok(`display ${screen.width}x${screen.height} @ ${hz} Hz density ${device.density ?? '?'} renderer ${device.renderer}`);


// 2. The APK under test. A release build, because the dev bundle's overhead
// hides the threshold the shipped app actually crosses.
let apk = apkArg;
if (apk === undefined) {
    process.stdout.write('building release APK (this takes a few minutes)...\n');
    const build = spawnSync('./gradlew', ['app:assembleRelease', '--no-daemon'], {
        cwd: 'apps/mobile/android',
        encoding: 'utf8',
        timeout: 1_800_000,
    });
    if ((build.status ?? 1) !== 0) {
        fail('release build failed; pass --apk <path> or set the signing env (ORG_GRADLE_PROJECT_release*)');
        finish(1);
    }
    apk = 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk';
}
const apkInfo = inspectApk(apk);
apk = versionedApkPath(apk, apkInfo);
report.apk = apk;
report.device.versionCode = apkInfo.versionCode;
report.device.versionName = apkInfo.versionName;
report.device.signerDigest = apkInfo.signerDigest;
try {
    await run('adb', ['install', '-r', apk], { timeout: 600_000 });
} catch (cause) {
    fail(`adb install failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    finish(1);
}
// A cold app every run: pairing, catalog and caches all start from nothing.
await run('adb', ['shell', 'pm', 'clear', PKG], { timeout: 120_000 }).catch(() => undefined);
ok(`installed ${apk} vc ${apkInfo.versionCode ?? '?'} ${apkInfo.signerDigest ?? ''}` + ' and cleared app state');

// 3. The stack the phone talks to: a relay and a host of this run's own, in a
// scratch directory, with a faked Herdr underneath them. Nothing on this
// machine is touched and the load is the same every time.
try {
    // The plugin fixtures the PR gate already owns: without them the fake herd
    // advertises no plugins at all, `Files` never renders, and the document
    // phase measures a herd screen it never left.
    // The proof board is the fixture's identifiable frame: a flat fill looks
    // the same at every magnification, so the zoom phase could never show a
    // graphics pane really magnified. The file is written first, because it
    // also gates painting and the load must start at full rate.
    writeFileSync(GRAPHICS_PROOF_FILE, 'enabled');
    stack = await startFakeStack({
        ...LOAD,
        graphicsEnableFile: GRAPHICS_PROOF_FILE,
        // The board paints one named pane for the whole run. Without the pin,
        // the first wheel notch on any pane pulled the producer onto it, so the
        // phase that measures a text terminal made one out of it mid-bout.
        pinGraphicsPane: true,
        setupPlugins: usagePlugins(process.cwd()),
    });
} catch (cause) {
    fail(`could not start the stack: ${cause instanceof Error ? cause.message : String(cause)}`);
    finish(1);
}
// The file plugin lists a repository, and the reading surface needs a document
// with somewhere to scroll: the fake herd's own README is three lines long.
try {
    writeFileSync(join(stack.world.cwd, DOCUMENT_FIXTURE), `${documentFixture()}\n`);
    const git = (args) => run('git', ['-C', stack.world.cwd, ...args], { timeout: 20_000 });
    await run('git', ['init', '-q', '-b', 'main', stack.world.cwd], { timeout: 20_000 });
    await git(['add', '.']);
    await git(['-c', 'user.name=Perf Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Release gate document fixture']);
    report.fixtures = { document: DOCUMENT_FIXTURE, plugins: ['code', 'status', 'terminal-keys', 'attachments'] };
} catch (cause) {
    fail(`could not seed the document fixture: ${cause instanceof Error ? cause.message : String(cause)}`);
    finish(1);
}
report.fixturePanes = stack.fixturePanes;
if (stack.fixturePanes?.text === undefined || stack.fixturePanes?.graphics === undefined) {
    fail('the herd published no text/graphics fixture panes to route the phases to');
    finish(1);
}
ok(`fixture panes: text ${stack.fixturePanes.text}, graphics ${stack.fixturePanes.graphics}`);
ok(`herd up on relay :${stack.relayPort}: ${stack.world.panes.length} panes`
    + `, ${stack.world.agents.length} agents, titles at ${LOAD.titleChurnHz} Hz, graphics ${LOAD.graphicsFrameHz} Hz`);

// 4. Pair with a code minted for this run, then wait for the herd to actually
// be on screen. First-run prompts and a cold catalog make one attempt flaky in
// a way that says nothing about the build, so the helper retries once.
const paired = await pairPhone({ stack, maestro });
if (!paired.ok) {
    fail(paired.why);
    finish(1);
}
report.herdVisibleMs = paired.herdVisibleMs;
ok(`paired and the herd screen is visible after ${Math.round(paired.herdVisibleMs / 1000)}s`
    + `${paired.attempt > 1 ? ` (attempt ${paired.attempt})` : ''}`);
if (paired.herdVisibleMs > LIMITS.herdVisibleMs) fail(`the herd took ${Math.round(paired.herdVisibleMs / 1000)}s to reach the phone`);
ingestHostJournal(journalAcc, stack.journalPath ?? join(stack.dataDir, 'diagnostics.json'));

// 5. Warm up, then measure. Warmup keeps first-launch bundle work and the
// catalog's first full sync out of the sampled windows.
await new Promise((resolve) => setTimeout(resolve, 30_000));
await clearLogcat();
await resetFrames(PKG);

let idleJs;
for (const phase of PHASES) {
    let flowRun;
    let driven;
    // Prerequisite first, and nothing is measured if it fails: a gesture bout on
    // the wrong screen still produces a full set of plausible numbers.
    const ready = await preparePhase(phase, screen, hz);
    if (!ready.ok) abortPhase(phase, ready.why, { flowExit: ready.flowExit, flowOutput: ready.flowOutput });
    // The sampler opens before anything is injected and stays open while the
    // attempt is: a bout that overruns its commanded seconds is still sampled to
    // its last settle, instead of being described by a window that closed first.
    let samplerOpen;
    const opened = new Promise((resolve) => { samplerOpen = resolve; });
    let drivingSettled = false;
    const driving = (async () => {
        await opened;
        if (phase.flow !== undefined) {
            flowRun = await maestro(phase.flow);
            // The flow is the phase's workload: once it has failed every later
            // number describes a screen the phone was pushed off, so the churn
            // stops here rather than at the end of the run.
            if (flowRun.code !== 0) {
                abortPhase(phase, `${phase.flow} did not complete`, {
                    flowExit: flowRun.code,
                    flowOutput: flowRun.output.split('\n').slice(-25).join('\n'),
                });
            }
        }
        if (phase.drive !== undefined) {
            driven = await drivePhase(phase, screen, hz, ready);
        }
    })().finally(() => { drivingSettled = true; });
    const measured = await samplePhase({
        pkg: PKG,
        seconds: phase.seconds,
        onOpen: samplerOpen,
        attempt: ready.prepared?.attempt,
        active: () => !drivingSettled,
    });
    await driving;
    if (driven?.zoomEvidenceUnavailable !== undefined) abortPhase(phase, `the zoom evidence is unavailable (${driven.zoomEvidenceUnavailable})`);
    if (driven?.trailUnavailable !== undefined) abortPhase(phase, `the phone trail is unavailable after the bout (${driven.trailUnavailable})`);
    if (phase.name === 'idle on the herd') idleJs = measured.jsBusyPercent;
    if (driven !== undefined) driven.jsBusyPercent = measured.jsBusyPercent;
    const gesture = gestureEvidence(driven, idleJs);
    const judged = driven === undefined
        ? { pass: true, failures: [] }
        : verdict(phase, phaseMetrics(driven, {
            jsBusyDeltaPoints: gesture?.jsBusyDeltaPoints,
            accidentalOwners: gesture?.accidentalOwners,
            surfaceKind: ready.surfaceKind,
        }), LIMITS);
    const entry = {
        ...phase,
        ...measured,
        navigation: { ok: ready.ok, ...(ready.surfaceKind === undefined ? {} : { surfaceKind: ready.surfaceKind }), ...(ready.ok ? {} : { why: ready.why, flowOutput: ready.flowOutput }) },
        flowExit: flowRun?.code ?? ready.flowExit,
        ...(gesture === undefined ? {} : { gesture }),
        ...(driven?.terminal === undefined ? {} : { terminal: driven.terminal }),
    };
    report.phases.push(entry);
    ingestHostJournal(journalAcc, stack.journalPath ?? join(stack.dataDir, 'diagnostics.json'));

    const busy = measured.jsBusyPercent;
    process.stdout.write(`\nphase "${phase.name}": js ${busy ?? 'not sampled'}%`
        + `  fps ${measured.fps ?? '-'}  pss ${measured.pssFirstKb ?? '-'} -> ${measured.pssLastKb ?? '-'} kB`
        + `  restarts ${measured.restarts}  stall ${measured.frameStallSeconds}s`);
    if (gesture !== undefined) {
        const moved = gesture.movement?.proven;
        const notches = gesture.notchesDropped;
        process.stdout.write(`  jank ${gesture.jank.jankyPercent}% p95 ${gesture.jank.p95Ms}ms`
            + `  dropped ${gesture.frameStats.droppedPercent ?? 'unmeasured'}%`
            + (notches === undefined ? '' : ` notchesDropped ${notches}`)
            + `  v ${gesture.medianVelocityPxPerSecond}px/s`
            + (moved === undefined ? '' : `  moved ${moved ? 'yes' : 'no'}`)
            + (gesture.zoomTransitions === undefined ? '' : ` zoom ${gesture.zoomTransitions}`)
            + '\n');
    } else {
        process.stdout.write('\n');
    }

    if (busy === undefined) fail(`${phase.name}: the JS thread never sampled, the runtime was down`);
    else if (busy > LIMITS.jsBusyPercent) fail(`${phase.name}: JS thread ${busy}% over ${LIMITS.jsBusyPercent}%`);
    else ok(`${phase.name}: JS thread ${busy}%`);

    if (measured.frameStallSeconds >= LIMITS.frameStallSeconds) {
        fail(`${phase.name}: no frames drawn for ${measured.frameStallSeconds}s`);
    }
    // A process that came back is a different process: nothing across the break
    // is comparable, and a sample the phase never took is not a healthy one.
    if (measured.restarts > 0) fail(`${phase.name}: the app restarted ${measured.restarts} time(s) during the phase`);
    if (measured.gaps > 0) fail(`${phase.name}: the JS thread was unreadable in ${measured.gaps} sample(s)`);
    if (measured.missingFrames > 0) fail(`${phase.name}: the frame counter did not read in ${measured.missingFrames} sample(s)`);
    // Memory is judged only where there are two comparable samples to difference.
    if (measured.pssDriftKb === undefined || measured.pssSamples.length < 2) {
        fail(`${phase.name}: memory drift is unmeasured (${measured.pssSamples.length} comparable sample(s), ${measured.missingPss} missed)`);
    } else if (measured.missingPss > 0) {
        fail(`${phase.name}: memory did not read in ${measured.missingPss} sample(s), so the drift is not the phase's`);
    } else if (measured.pssDriftKb > LIMITS.pssDriftKb) {
        fail(`${phase.name}: memory grew ${Math.round(measured.pssDriftKb / 1024)} MB`);
    }
    if (driven?.injectFailed === true) fail(`${phase.name}: device could not inject`);
    for (const key of judged.failures) {
        if (key === 'device could not inject') continue;
        fail(`${phase.name}: ${key}`);
    }
}

// Every session the herd serves, opened and scrolled in turn. The list comes
// from the herd itself, never a hardcoded set, so a bigger world means a longer
// tour rather than a stale test.
const agentPanes = new Set(stack.world.agents.map((agent) => agent.pane_id));
const tour = await tourEverySession({
    pkg: PKG,
    // Which pane actually arrived. A visit is opened when the herd started a
    // control terminal session for the pane we asked for, not when some pane's
    // chrome happened to contain the word "Terminal".
    attached: async (paneId, since) => paneAttaches(paneId, since).length > 0,
    // Shell panes only: an agent's session id is minted by the host and is not
    // something a deep link can guess. Agent terminals are the navigate flow's
    // job, which reaches them the way a person does.
    sessions: stack.world.panes
        .filter((pane) => !agentPanes.has(pane.pane_id))
        .map((pane) => ({ paneId: pane.pane_id })),
});
report.tour = tour;
process.stdout.write(`\ntour: ${tour.panes} panes, ${tour.opened} opened`
    + `  pss ${tour.pssFirstKb ?? '-'} -> ${tour.pssLastKb ?? '-'} kB (max ${tour.pssMaxKb ?? '-'})\n`);
if (tour.missed > 0) fail(`the tour never attached ${tour.missed}/${tour.panes} pane(s): ${tour.missedPanes.slice(0, 6).join(', ')}`);
else ok(`toured ${tour.opened}/${tour.panes} panes`);
if (tour.staleSurfaces.length > 0) {
    // A memory sample taken on a terminal and the next taken on the herd are
    // not comparable, so say so rather than reporting the difference as growth.
    fail(`the tour could not leave ${tour.staleSurfaces.length} pane(s), so its memory samples are not comparable`);
}
if (tour.pssMissingSamples.length > 0) {
    // A pane whose memory never read is a gap in the account. Differencing the
    // samples that did land would report the tour as flat on evidence the run
    // never collected.
    fail(`the tour could not sample memory on ${tour.pssMissingSamples.length}/${tour.panes} pane(s):`
        + ` ${tour.pssMissingSamples.slice(0, 6).join(', ')}`);
} else if (tour.pssGrowthKb === undefined) {
    fail(`the tour has ${tour.pssSamples} comparable memory sample(s); growth across it is unmeasured`);
} else if (tour.pssGrowthKb > LIMITS.tourGrowthKb) {
    fail(`memory grew ${Math.round(tour.pssGrowthKb / 1024)} MB across the tour`);
} else {
    ok(`memory held across the tour (${Math.round(tour.pssGrowthKb / 1024)} MB)`);
}

// 6. Signals that only make sense across the whole run.
const depthErrors = await updateDepthErrors();
report.updateDepthErrors = depthErrors;
if (depthErrors > LIMITS.updateDepthErrors) fail(`React threw "Maximum update depth exceeded" ${depthErrors} time(s)`);
else ok('no React update-depth errors');

// The host's own account of what the phone asked for. This is the honest proof
// that terminals really attached, and it is where a stalled Herdr call shows up
// as a request that took seconds instead of milliseconds.
ingestHostJournal(journalAcc, stack.journalPath ?? join(stack.dataDir, 'diagnostics.json'));
if (journalAcc.events.length === 0 && journalAcc.lastError !== undefined) {
    fail(`the host wrote no diagnostics journal: ${journalAcc.lastError}`);
}
const events = journalAcc.events;
const requests = events.filter((event) => event.event === 'client.request');
const graphicsEvents = events.filter((event) => event.event === 'graphics.pipeline');
const controlAttaches = paneAttaches(undefined, '');
report.hostJournal = {
    path: journalAcc.path,
    reads: journalAcc.reads,
    events: events.length,
    eventCounts: journalEventCounts(events),
    controlAttaches: controlAttaches.length,
};
if (controlAttaches.length > 0 && requests.filter((event) => event.request === 'terminal.attach').length === 0) {
    fail(`fake-herdr started ${controlAttaches.length} control terminal session(s) but the host journal has no terminal.attach`);
}
const attaches = requests.filter((event) => event.request === 'terminal.attach');
const rejected = requests.filter((event) => event.outcome !== 'ok');
const slowest = requests.reduce((peak, event) => Math.max(peak, event.durationMs ?? 0), 0);
report.hostRequests = {
    total: requests.length,
    attaches: attaches.length,
    rejected: rejected.map((event) => ({ request: event.request, outcome: event.outcome, code: event.code, durationMs: event.durationMs })),
    slowestMs: slowest,
};
process.stdout.write(`\nhost requests: ${requests.length} (${attaches.length} terminal attaches), slowest ${slowest} ms\n`);
if (attaches.filter((event) => event.outcome === 'ok').length === 0) fail('no terminal ever attached on the host');
else ok(`${attaches.filter((event) => event.outcome === 'ok').length} terminal attach(es) succeeded`);
if (rejected.length > 0) fail(`the host rejected ${rejected.length} request(s): ${rejected.map((event) => `${event.request}/${event.code ?? event.outcome}`).join(', ')}`);
else ok('the host rejected nothing');
if (slowest > LIMITS.hostRequestMs) fail(`a host request took ${slowest} ms`);

const asInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
};
const graphics = graphicsEvents.reduce((acc, event) => ({
    frames: acc.frames + asInt(event.frames),
    superseded: acc.superseded + asInt(event.superseded),
    p50Ms: Math.max(acc.p50Ms, asInt(event.p50Ms)),
    p95Ms: Math.max(acc.p95Ms, asInt(event.p95Ms)),
    bytesP95: Math.max(acc.bytesP95, asInt(event.bytesP95)),
    pixelsP95: Math.max(acc.pixelsP95, asInt(event.pixelsP95)),
    notchesSent: acc.notchesSent + asInt(event.notchesSent),
    notchesDropped: acc.notchesDropped + asInt(event.notchesDropped),
}), { frames: 0, superseded: 0, p50Ms: 0, p95Ms: 0, bytesP95: 0, pixelsP95: 0, notchesSent: 0, notchesDropped: 0 });
report.graphics = graphics;
process.stdout.write(`\ngraphics: frames ${graphics.frames} superseded ${graphics.superseded}`
    + `  p50 ${graphics.p50Ms} ms  p95 ${graphics.p95Ms} ms`
    + `  bytes p95 ${graphics.bytesP95}  pixels p95 ${graphics.pixelsP95}`
    + `  notches sent ${graphics.notchesSent} dropped ${graphics.notchesDropped}\n`);
if (graphicsEvents.length === 0) {
    // Two very different runs look the same here, so say which one this was.
    // A phone that never declared cell pixels never got a graphics bridge at
    // all -- true of a software-rendered emulator -- and a run that had one and
    // produced no account is a real regression.
    const asked = stack?.phoneDeclaredCellMetrics() === true;
    report.graphicsAsked = asked;
    if (asked) fail('a phone declared cell metrics but the host wrote no graphics.pipeline account');
    else process.stdout.write('note: no phone declared cell pixels, so no graphics bridge opened; graphics cost unmeasured this run\n');
    const graphicsLog = (stack?.hostLog() ?? '')
        .split('\n')
        .filter((line) => /graphics/i.test(line))
        .slice(-6);
    for (const line of graphicsLog) process.stdout.write(`  host: ${line.trim()}\n`);
    report.graphicsHostLog = graphicsLog;
} else {
    if (graphics.p95Ms > LIMITS.graphicsPipelineP95Ms) fail(`graphics pipeline p95 ${graphics.p95Ms} ms`);
    else ok(`graphics pipeline p95 ${graphics.p95Ms} ms`);
    if (graphics.bytesP95 > LIMITS.graphicsBytesP95) fail(`graphics frame ${graphics.bytesP95} bytes`);
    else ok(`graphics frame p95 ${graphics.bytesP95} bytes`);
    ok(`graphics notches sent ${graphics.notchesSent} dropped ${graphics.notchesDropped}`);
    // Superseded frames are reported, never gated: measured against the real
    // producer the pipeline answers in 6 ms p50, so a burst is delivered rather
    // than dropped, and a run that never had to drop anything is the good case.
    // What proves newest-wins is the p95 above, plus the host flow test.
    ok(`graphics superseded ${graphics.superseded}`);
}

const pid = await appPid(PKG);
const tid = pid === undefined ? undefined : await jsThreadId(pid);
report.runtimeAlive = tid !== undefined;
if (tid === undefined) fail('the JS runtime is not alive at the end of the run');
else ok('the JS runtime survived the run');

const frames = await framesRendered(PKG);
report.framesRendered = frames;
if ((frames ?? 0) <= 0) fail('the app rendered no frames at all');

const shot = recordPath === undefined ? '/tmp/muxr-perf-final.png' : `${recordPath.replace(/\.json$/, '')}.png`;
await screenshot(shot).catch(() => undefined);
report.screenshot = shot;
report.commit = (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();

finish(failures.length === 0 ? 0 : 1);
