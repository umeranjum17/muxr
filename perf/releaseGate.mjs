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
import { pairPhone } from './lib/pairPhone.mjs';
import {
    appPid,
    avdName,
    clearLogcat,
    deviceIdentity,
    deviceReady,
    dismissPrompts,
    frameStats,
    framesRendered,
    jankReport,
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
import { fling, scrollBout, stripBout, tap, drag } from './lib/gestures.mjs';
import {
    cropRaw,
    decodeUiAttribute,
    firstGutterLine,
    firstStripLabel,
    mergeFrameStats,
    parseRedactedTrail,
    pixelsMoved,
    reduceFrameStats,
    reduceJank,
    reduceMovement,
    reducePipelineNotches,
    reduceZoom,
    scrollableBounds,
    verdict,
} from './lib/gestureMetrics.mjs';

const run = promisify(execFile);

const PKG = 'com.trymuxr.app';
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
    /** Scroll sent -> next graphics frame written, from the phone's trail. */
    scrollToFrameP95Ms: 400,
    accidentalOwners: 0,
    terminalScrollClamped: 0,
    graphicsRowsPerSecond: 9,
    zoomResizeCount: 1,
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
    terminalScrollP95Ms: 250,
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
    terminalScrollP95Ms: 200,
    terminalRowsPerSecond: 60,
};

const LOAD = {
    panes: 100,
    agents: 30,
    titleChurnHz: 2,
    terminalBytesPerSecond: 4096,
    graphicsFrameHz: 4,
};

const PHASES = [
    { name: 'idle on the herd', seconds: 120, flow: undefined },
    { name: 'herd strip and tree soak', seconds: 120, flow: 'herdSoak.yaml' },
    { name: 'agent terminal and plugin navigation', seconds: 120, flow: 'herdNavigate.yaml' },
    { name: 'herd tree fling', seconds: 30, drive: 'treeFling' },
    { name: 'herd strip paging', seconds: 20, drive: 'stripPaging' },
    { name: 'document scroll and swipe', seconds: 30, flow: 'openDocument.yaml', drive: 'documentScrollSwipe' },
    { name: 'terminal text fling', seconds: 30, drive: 'terminalTextFling' },
    { name: 'graphics pane scroll', seconds: 90, flow: 'graphicsScroll.yaml', drive: 'graphicsScroll' },
    { name: 'zoom tap navigate', seconds: 60, drive: 'zoomTapNavigate' },
];

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

const ok = (message) => process.stdout.write(`ok: ${message}\n`);
const fail = (message) => {
    failures.push(message);
    process.stdout.write(`FAIL: ${message}\n`);
};

function finish(code) {
    if (stack !== undefined && !keepLoad) stack.stop();
    report.finishedAt = new Date().toISOString();
    report.failures = failures;
    report.passed = failures.length === 0;
    if (recordPath !== undefined) {
        mkdirSync(dirname(recordPath), { recursive: true });
        writeFileSync(recordPath, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`\nevidence: ${recordPath}\n`);
    }
    process.stdout.write(failures.length === 0
        ? '\nPASS: release performance gate\n'
        : `\nFAILED: ${failures.length} gate(s): ${failures.join('; ')}\n`);
    process.exit(code);
}

process.once('SIGINT', () => finish(130));
process.once('SIGTERM', () => finish(143));

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
    try {
        return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    } catch {
        return [];
    }
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
        const dump = await dumpUi();
        if (/text="LIVE"/.test(dump) && !/Type a prompt/.test(dump)) return true;
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

async function pullPhoneTrail() {
    await run('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'muxr:///settings', PKG], { timeout: 20_000 }).catch(() => undefined);
    await sleep(1200);
    await tapBounds('text="Redacted diagnostics"');
    await sleep(800);
    const dump = await dumpUi();
    const texts = [...dump.matchAll(/text="([^"]*)"/g)].map((match) => decodeUiAttribute(match[1]));
    await run('adb', ['shell', 'input', 'keyevent', 'BACK'], { timeout: 10_000 }).catch(() => undefined);
    await run('adb', ['shell', 'input', 'keyevent', 'BACK'], { timeout: 10_000 }).catch(() => undefined);
    await sleep(500);
    return texts.join('\n');
}

async function captureSurface(surface, screen) {
    const dump = await dumpUi();
    const bounds = scrollableBounds(surface, dump, screen);
    const raw = await screencapRaw().catch(() => undefined);
    const crop = raw === undefined ? undefined : cropRaw(raw, bounds);
    return {
        dump,
        bounds,
        crop,
        gutterLine: firstGutterLine(dump),
        stripLabel: firstStripLabel(dump),
    };
}

async function measureBout(run, hz, { surface, screen, phase } = {}) {
    const beforeSurface = surface === undefined ? undefined : await captureSurface(surface, screen);
    const before = await resetGfxWindow(PKG, { hz });
    const parts = [];
    let bout = { gestures: 0, flings: 0, medianVelocityPxPerSecond: 0 };
    try {
        bout = await run({
            onGesture: async (gesture) => {
                if (gesture.profile !== 'fling') return;
                const rows = await frameStats(PKG);
                parts.push(reduceFrameStats(rows, {
                    frameNs: 1e9 / hz,
                    t0Ns: (gesture.t0Seconds ?? 0) * 1e9,
                }));
            },
        });
    } catch (error) {
        if (!(error instanceof Error && error.message === 'device could not inject')) throw error;
        bout = { ...bout, injectFailed: true };
    }
    const after = await jankReport(PKG, { hz });
    const afterSurface = surface === undefined ? undefined : await captureSurface(surface, screen);
    const injectFailed = bout.injectFailed === true;
    const movement = beforeSurface === undefined ? undefined : reduceMovement(phase ?? surface, {
        before: beforeSurface,
        after: afterSurface,
        pixels: pixelsMoved(beforeSurface.crop, afterSurface?.crop),
    });
    return {
        bout,
        injectFailed,
        jank: reduceJank(before, after, { hz }),
        frameStats: mergeFrameStats(parts),
        movement,
        beforeSurface,
        afterSurface,
    };
}

function withTrailMovement(measured, phase, terminal) {
    if (measured.beforeSurface === undefined) {
        return { ...measured, terminal, movement: measured.movement };
    }
    return {
        ...measured,
        terminal,
        movement: reduceMovement(phase, {
            before: measured.beforeSurface,
            after: measured.afterSurface,
            terminal,
            pixels: pixelsMoved(measured.beforeSurface.crop, measured.afterSurface?.crop),
        }),
    };
}

async function drivePhase(phase, screen, hz) {
    const { width, height } = screen;
    const seconds = phase.seconds;
    if (phase.drive === 'treeFling') {
        await returnToHerd();
        return measureBout((opts) => scrollBout({ width, height, seconds, ...opts }), hz, { surface: 'tree', screen, phase });
    }
    if (phase.drive === 'stripPaging') {
        await returnToHerd();
        return measureBout((opts) => stripBout({ width, height, seconds, ...opts }), hz, { surface: 'strip', screen, phase });
    }
    if (phase.drive === 'documentScrollSwipe') {
        const vertical = await measureBout((opts) => scrollBout({ width, height, seconds: 20, ...opts }), hz, { surface: 'document', screen, phase });
        for (let index = 0; index < 6; index += 1) {
            const left = index % 2 === 0;
            await drag({
                from: { x: width * (left ? 0.8 : 0.2), y: height * 0.5 },
                to: { x: width * (left ? 0.2 : 0.8), y: height * 0.5 },
            });
            await sleep(400);
        }
        const trail = parseRedactedTrail(await pullPhoneTrail().catch(() => ''));
        return {
            ...vertical,
            documentNavigate: trail.documentNavigate,
            documentNavigateDuringVertical: 0,
        };
    }
    if (phase.drive === 'terminalTextFling') {
        await returnToHerd();
        await tap(width * 0.3, height * 0.33);
        await sleep(2500);
        await dismissPrompts();
        const measured = await measureBout((opts) => scrollBout({ width, height, seconds, ...opts }), hz, { surface: 'terminal', screen, phase });
        const trail = parseRedactedTrail(await pullPhoneTrail().catch(() => ''));
        const terminal = {
            scrollRequests: trail.scrollRequests || trail.scrollLatencies.length,
            scrollLatencyP50Ms: trail.scrollLatencyP50Ms,
            scrollLatencyP95Ms: trail.scrollLatencyP95Ms,
            rowsRequested: trail.rowsRequested,
            rowsSent: trail.rowsRequested,
            rowsPerSecond: seconds > 0 ? Number((trail.rowsRequested / seconds).toFixed(1)) : 0,
            clamped: trail.clamped,
            agentPages: trail.agentPages,
        };
        return withTrailMovement(measured, phase, terminal);
    }
    if (phase.drive === 'graphicsScroll') {
        ingestHostJournal(journalAcc, stack.journalPath ?? join(stack.dataDir, 'diagnostics.json'));
        const startedAt = new Date().toISOString();
        const measured = await measureBout((opts) => scrollBout({ width, height, seconds, ...opts }), hz, { surface: 'graphics', screen, phase });
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
        const before = await resetGfxWindow(PKG, { hz });
        const attachBefore = stack === undefined ? [] : readJsonl(stack.attachJsonl);
        const baseline = attachBefore.at(-1);
        const zoomedIn = await tapBounds('content-desc="Zoom in"');
        await sleep(450);
        const attachAfterIn = stack === undefined ? [] : readJsonl(stack.attachJsonl);
        const afterIn = attachAfterIn.at(-1);
        const zoomIn = reduceZoom([baseline, afterIn].filter((record) => record !== undefined
            && Number(record.cols) > 0 && Number(record.rows) > 0));
        await tapBounds('content-desc="Zoom out"');
        await sleep(450);
        await tapBounds('content-desc="Reset zoom"');
        await sleep(450);
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
        }
        const after = await jankReport(PKG, { hz });
        const trail = parseRedactedTrail(await pullPhoneTrail().catch(() => ''));
        const attaches = stack === undefined ? [] : readJsonl(stack.attachJsonl);
        const trailZoom = reduceZoom(trail.resizeEvents);
        // Image pane: cell changed, grid held. Text pane: grid changed.
        // Either shape is one countable zoom step; this phase sits on the
        // graphics pane the previous flow opened, so cell-only is the hit.
        const zoomResizeCount = zoomIn.cellOnly || zoomIn.gridChanged
            || (trailZoom.cellOnly > 0 ? 1 : 0)
            || (trailZoom.gridChanged > 0 ? 1 : 0);
        return {
            bout: { gestures: 1, flings: 1, medianVelocityPxPerSecond: 0 },
            injectFailed: false,
            jank: reduceJank(before, after, { hz }),
            frameStats: mergeFrameStats([]),
            zoomResizeCount,
            zoomTapped: zoomedIn,
            zoom: {
                ...trailZoom,
                zoomIn,
                attachBefore: baseline,
                attachAfterIn: afterIn,
            },
            attachRecords: attaches.length,
            terminal: {
                scrollRequests: trail.scrollRequests || trail.scrollLatencies.length,
                scrollLatencyP50Ms: trail.scrollLatencyP50Ms,
                scrollLatencyP95Ms: trail.scrollLatencyP95Ms,
                rowsRequested: trail.rowsRequested,
                rowsSent: trail.rowsRequested,
                rowsPerSecond: 0,
                clamped: trail.clamped,
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
        frameStats: driven.frameStats ?? { frames: 0, dropped: 0, droppedPercent: 0, worstMs: 0, inputToFrameMs: { p50: 0, p95: 0 } },
        movement: driven.movement,
        injectFailed: driven.injectFailed === true,
        zoomResizeCount: driven.zoomResizeCount,
        zoomTapped: driven.zoomTapped,
        zoom: driven.zoom,
        notchesSent: driven.terminal?.notchesSent,
        notchesDropped: driven.terminal?.notchesDropped,
        jsBusyIdlePercent: idleJs,
        jsBusyDeltaPoints,
        accidentalOwners: driven.terminal?.agentPages ?? driven.documentNavigateDuringVertical ?? 0,
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
let journalAcc = emptyJournalAcc();
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
    stack = await startFakeStack(LOAD);
} catch (cause) {
    fail(`could not start the stack: ${cause instanceof Error ? cause.message : String(cause)}`);
    finish(1);
}
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
    const driving = (async () => {
        if (phase.flow !== undefined) {
            flowRun = await maestro(phase.flow);
        }
        if (phase.drive !== undefined) {
            driven = await drivePhase(phase, screen, hz);
        }
    })();
    const measured = await samplePhase({ pkg: PKG, seconds: phase.seconds });
    await driving;
    if (phase.name === 'idle on the herd') idleJs = measured.jsBusyPercent;
    if (driven !== undefined) driven.jsBusyPercent = measured.jsBusyPercent;
    const gesture = gestureEvidence(driven, idleJs);
    const judged = driven === undefined
        ? { pass: true, failures: [] }
        : verdict(phase, {
            jank: driven.jank,
            frameStats: driven.frameStats,
            jsBusyDeltaPoints: gesture?.jsBusyDeltaPoints,
            accidentalOwners: gesture?.accidentalOwners,
            documentNavigate: driven.documentNavigate,
            documentNavigateDuringVertical: driven.documentNavigateDuringVertical,
            terminal: driven.terminal,
            graphicsRowsPerSecond: driven.graphicsRowsPerSecond,
            zoomResizeCount: driven.zoomResizeCount,
            injectFailed: driven.injectFailed,
            movement: driven.movement,
        }, LIMITS);
    const entry = {
        ...phase,
        ...measured,
        flowExit: flowRun?.code,
        ...(gesture === undefined ? {} : { gesture }),
        ...(driven?.terminal === undefined ? {} : { terminal: driven.terminal }),
        ...(driven?.documentNavigate === undefined ? {} : { documentNavigate: driven.documentNavigate }),
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
            + `  dropped ${gesture.frameStats.droppedPercent}%`
            + (notches === undefined ? '' : ` notchesDropped ${notches}`)
            + `  v ${gesture.medianVelocityPxPerSecond}px/s`
            + (moved === undefined ? '' : `  moved ${moved ? 'yes' : 'no'}`)
            + (gesture.zoomResizeCount === undefined ? '' : ` zoom ${gesture.zoomResizeCount}`)
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
    if ((measured.pssDriftKb ?? 0) > LIMITS.pssDriftKb) {
        fail(`${phase.name}: memory grew ${Math.round(measured.pssDriftKb / 1024)} MB`);
    }
    if (phase.flow !== undefined && flowRun?.code !== 0) {
        fail(`${phase.name}: ${phase.flow} did not complete`);
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
if (tour.opened === 0) fail('the tour could not open a single terminal');
else ok(`toured ${tour.opened}/${tour.panes} panes`);
if (tour.pssGrowthKb > LIMITS.tourGrowthKb) {
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
const attachRecords = stack?.attachJsonl === undefined ? [] : readJsonl(stack.attachJsonl);
report.hostJournal = {
    path: journalAcc.path,
    reads: journalAcc.reads,
    events: events.length,
    eventCounts: journalEventCounts(events),
    attachJsonl: attachRecords.length,
};
if (attachRecords.length > 0 && requests.filter((event) => event.request === 'terminal.attach').length === 0) {
    fail(`fake-herdr recorded ${attachRecords.length} pane.read attach(es) but the host journal has no terminal.attach`);
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
