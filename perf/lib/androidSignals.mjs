/**
 * Device signals for the release performance gate, read over adb.
 *
 * Only four signals survive a starved React Native app, and this module is all
 * four:
 *
 * - JS-thread busy time from `/proc/<pid>/task/<tid>/stat`. `adb shell top -H
 *   -n 1` reports a thread's *lifetime* average, which once made a saturating
 *   build and a healthy one measure identically (96% against a real 63%). Only
 *   utime+stime deltas are trustworthy.
 * - `Total frames rendered` from gfxinfo. A frozen UI stops advancing it while
 *   the process still looks alive.
 * - TOTAL PSS from meminfo, for drift across a phase.
 * - `Maximum update depth exceeded` counted in logcat. In-app instrumentation
 *   cannot report this: `console.log` is dropped once the thread saturates, and
 *   the JS runtime is often already dead.
 *
 * Sampling is restart-aware on purpose. A soak that leaves and re-enters the
 * app gets a new process and a new JS thread, so pid and tid are resolved every
 * interval and a restart is counted instead of ending the run.
 */
import { assertCommandActive, runCommand as run } from './commands.mjs';

import { writeFileSync } from 'node:fs';
import { parseFrameStatsDump, parseJankDump, parseUptime } from './gestureMetrics.mjs';

/** Linux clock ticks per second; /proc jiffies are in these units. */
const HZ = 100;
const JS_THREAD = 'mqt_v_js';

async function adb(args, timeout = 10_000) {
    const { stdout } = await run('adb', args, { timeout, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}

async function quiet(args, timeout = 10_000) {
    assertCommandActive();
    try {
        return await adb(args, timeout);
    } catch {
        assertCommandActive();
        return '';
    }
}

/**
 * Android and the app both raise one-off prompts - background activity, live
 * updates, notifications - and they queue, one appearing as the last is
 * dismissed. None of them are what the gate measures, and the app's own alert
 * ignores BACK, so each button is tapped at the bounds the accessibility tree
 * reports until two consecutive looks find none.
 */
export async function dismissPrompts(labels = ['CANCEL', 'Not now', 'Deny', 'Later', 'Allow']) {
    let dismissed = 0;
    let quietLooks = 0;
    for (let attempt = 0; attempt < 8 && quietLooks < 2; attempt += 1) {
        await quiet(['shell', 'uiautomator', 'dump', '/sdcard/perf-prompt.xml'], 20_000);
        const screen = await quiet(['shell', 'cat', '/sdcard/perf-prompt.xml'], 20_000);
        const hit = [...screen.matchAll(/text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
            .find(([, text]) => labels.some((label) => text.toLowerCase() === label.toLowerCase()));
        if (hit === undefined) {
            quietLooks += 1;
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
        }
        quietLooks = 0;
        const x = Math.round((Number(hit[2]) + Number(hit[4])) / 2);
        const y = Math.round((Number(hit[3]) + Number(hit[5])) / 2);
        await quiet(['shell', 'input', 'tap', String(x), String(y)]);
        dismissed += 1;
        await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return dismissed;
}

export async function deviceReady() {
    const state = (await quiet(['get-state'])).trim();
    return state === 'device';
}

export async function avdName() {
    return (await quiet(['emu', 'avd', 'name'])).split('\n')[0]?.trim() ?? '';
}

export async function appPid(pkg) {
    const pid = (await quiet(['shell', 'pidof', pkg])).trim().split(/\s+/)[0];
    return pid === undefined || pid === '' ? undefined : pid;
}

/** The RN JS thread, or undefined when the runtime is down. */
export async function jsThreadId(pid) {
    const script = `for t in $(ls /proc/${pid}/task 2>/dev/null); do `
        + `[ "$(cat /proc/${pid}/task/$t/comm 2>/dev/null)" = ${JS_THREAD} ] && echo $t; done; true`;
    const found = (await quiet(['shell', script])).trim().split('\n')[0]?.trim();
    return found === undefined || found === '' ? undefined : found;
}

async function threadBusyTicks(pid, tid) {
    const stat = (await quiet(['shell', `cat /proc/${pid}/task/${tid}/stat 2>/dev/null`])).trim();
    if (stat === '') return undefined;
    const fields = stat.split(/\s+/);
    // utime and stime are fields 14 and 15 of /proc stat, 1-based.
    const busy = Number(fields[13]) + Number(fields[14]);
    return Number.isFinite(busy) ? busy : undefined;
}

export async function framesRendered(pkg) {
    const dump = await quiet(['shell', 'dumpsys', 'gfxinfo', pkg]);
    const match = /Total frames rendered:\s*(\d+)/.exec(dump);
    return match === null ? undefined : Number(match[1]);
}

export async function resetGfx(pkg) {
    await quiet(['shell', 'dumpsys', 'gfxinfo', pkg, 'reset']);
}

/**
 * Reset gfxinfo and wait until the dump actually shows zero frames. A
 * dumpsys that is still flushing the previous window would make the bout
 * look empty, or copy the 4950 ms empty-histogram sentinel into p95.
 */
export async function resetGfxWindow(pkg, { hz } = {}) {
    let report;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        await resetGfx(pkg);
        report = await jankReport(pkg, { hz });
        if ((report.frames ?? 0) === 0) return report;
        await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return report ?? await jankReport(pkg, { hz });
}

export async function resetFrames(pkg) {
    await resetGfx(pkg);
}

/**
 * What the frame pipeline did, not how many frames it drew. A gesture is judged
 * on the frames it misses: `gfxinfo` counts a janky frame against the display's
 * own deadline, so this is the one signal that means the same thing on a
 * software-rendered emulator and on a 120 Hz phone.
 *
 * Call `resetGfx` first; these are cumulative since the reset. `hz` is the
 * display's refresh; one frame is `round(1000 / hz)` ms, never a hard-coded 16.
 */
export async function jankReport(pkg, { hz } = {}) {
    const dump = await quiet(['shell', 'dumpsys', 'gfxinfo', pkg], 20_000);
    return parseJankDump(dump, { hz: hz ?? await refreshHz() });
}

/** Last 120 frames as objects keyed by the PROFILEDATA header names. */
export async function frameStats(pkg) {
    const dump = await quiet(['shell', 'dumpsys', 'gfxinfo', pkg, 'framestats'], 20_000);
    return parseFrameStatsDump(dump);
}

/** Display refresh from SurfaceFlinger, falling back to 60. */
export async function refreshHz() {
    const dump = await quiet(['shell', 'dumpsys', 'display'], 20_000);
    const match = /renderFrameRate=([0-9.]+)/.exec(dump);
    const hz = match === null ? undefined : Number(match[1]);
    return Number.isFinite(hz) && hz > 0 ? hz : 60;
}

/** First field of `/proc/uptime`. */
export async function deviceMonotonicSeconds() {
    return parseUptime(await quiet(['shell', 'cat', '/proc/uptime']));
}

/**
 * Raw framebuffer: 16-byte header (width, height, format, colorspace as
 * little-endian u32) then RGBA8888. No PNG, no decoder.
 */
export async function screencapRaw(path) {
    const { stdout: bytes } = await run('adb', ['exec-out', 'screencap'], { encoding: null, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
    if (path !== undefined) writeFileSync(path, bytes);
    if (bytes.length < 16) return { width: 0, height: 0, format: 0, colorspace: 0, bytes };
    return {
        width: bytes.readUInt32LE(0),
        height: bytes.readUInt32LE(4),
        format: bytes.readUInt32LE(8),
        colorspace: bytes.readUInt32LE(12),
        bytes,
    };
}

/**
 * Bounds of the first node whose `content-desc` or `class` matches `pattern`.
 * Reuses the same uiautomator dump dismissPrompts already writes.
 */
export async function viewBounds(pattern) {
    await quiet(['shell', 'uiautomator', 'dump', '/sdcard/perf-prompt.xml'], 20_000);
    const screen = await quiet(['shell', 'cat', '/sdcard/perf-prompt.xml'], 20_000);
    const nodes = screen.match(/<node\b[^>]*>/g) ?? [];
    const hit = nodes.find((node) => node.includes(pattern));
    const bounds = hit === undefined ? undefined : /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(hit);
    if (bounds === undefined) return undefined;
    return {
        l: Number(bounds[1]),
        t: Number(bounds[2]),
        r: Number(bounds[3]),
        b: Number(bounds[4]),
    };
}

/** Model, sdk, refresh, density, renderer, and the physical pixel size. */
export async function deviceIdentity() {
    const model = (await quiet(['shell', 'getprop', 'ro.product.model'])).trim();
    const sdk = Number((await quiet(['shell', 'getprop', 'ro.build.version.sdk'])).trim());
    const hz = await refreshHz();
    const densityDump = await quiet(['shell', 'wm', 'density']);
    const density = Number(
        (/Override density:\s*(\d+)/.exec(densityDump) ?? /Physical density:\s*(\d+)/.exec(densityDump))?.[1],
    );
    const renderer = (await quiet(['shell', 'getprop', 'ro.hardware.egl'])).trim()
        || (await quiet(['shell', 'getprop', 'ro.hwui.renderer'])).trim()
        || 'unknown';
    const sizeDump = await quiet(['shell', 'wm', 'size']);
    const size = (/Override size:\s*(\d+)x(\d+)/.exec(sizeDump) ?? /Physical size:\s*(\d+)x(\d+)/.exec(sizeDump));
    return {
        model,
        sdk: Number.isFinite(sdk) ? sdk : undefined,
        refreshHz: hz,
        density: Number.isFinite(density) ? density : undefined,
        renderer,
        width: size === null ? undefined : Number(size[1]),
        height: size === null ? undefined : Number(size[2]),
    };
}


export async function totalPssKb(pid) {
    const dump = await quiet(['shell', 'dumpsys', 'meminfo', pid], 20_000);
    const match = /TOTAL PSS:\s*(\d+)/.exec(dump);
    return match === null ? undefined : Number(match[1]);
}

export async function clearLogcat() {
    await quiet(['logcat', '-c']);
}

export async function updateDepthErrors() {
    const log = await quiet(['logcat', '-d'], 30_000);
    return (log.match(/Maximum update depth exceeded/g) ?? []).length;
}

export async function screenshot(path) {
    const { stdout } = await run('adb', ['exec-out', 'screencap', '-p'], { encoding: null, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 });
    writeFileSync(path, stdout);
}

/**
 * Sample one phase. Returns busy share of the JS thread, frame rate, PSS drift,
 * the longest stretch with no frames drawn, and how often the app restarted.
 *
 * `onTick` runs after every sample so a caller can drive the device in parallel
 * without a second sampler.
 */
export async function samplePhase(options) {
    const { pkg, seconds, intervalMs = 5000, onTick } = options;
    const started = Date.now();
    const deadline = started + seconds * 1000;

    let pid;
    let tid;
    let previousTicks;
    let previousTickAt;
    const samples = [];
    const pssSamples = [];
    let missingPss = 0;
    const frameSamples = [];
    let missingFrames = 0;
    let busyTicks = 0;
    let busySeconds = 0;
    let restarts = 0;
    let gaps = 0;
    let frameStall = 0;
    let worstFrameStall = 0;
    let firstPss;
    let lastPss;
    let maxPss = 0;
    const framesStart = await framesRendered(pkg);
    if (framesStart === undefined) missingFrames += 1;
    let previousFrames = framesStart;
    let previousFramesAt = performance.now();

    while (Date.now() < deadline) {
        const tickStarted = Date.now();
        const currentPid = await appPid(pkg);
        if (currentPid === undefined) {
            gaps += 1;
            previousTicks = undefined;
            pid = undefined;
            tid = undefined;
        } else {
            if (currentPid !== pid) {
                if (pid !== undefined) restarts += 1;
                pid = currentPid;
                tid = undefined;
                previousTicks = undefined;
            }
            if (tid === undefined) tid = await jsThreadId(pid);
            if (tid === undefined) {
                gaps += 1;
                previousTicks = undefined;
            } else {
                const ticks = await threadBusyTicks(pid, tid);
                if (ticks === undefined) {
                    // The thread vanished mid-phase: a dead runtime, or a restart
                    // the next sample will attribute.
                    gaps += 1;
                    tid = undefined;
                    previousTicks = undefined;
                } else {
                    const sampledAt = performance.now();
                    if (previousTicks !== undefined) {
                        busyTicks += ticks - previousTicks;
                        busySeconds += (sampledAt - previousTickAt) / 1000;
                    }
                    previousTicks = ticks;
                    previousTickAt = sampledAt;
                    samples.push({ atMs: sampledAt, pid, tid, ticks });
                }
            }
            const pss = await totalPssKb(pid);
            if (pss !== undefined) {
                pssSamples.push({ atMs: performance.now(), pid, pssKb: pss });
                if (firstPss === undefined) firstPss = pss;
                lastPss = pss;
                if (pss > maxPss) maxPss = pss;
            } else missingPss += 1;
        }

        const frames = await framesRendered(pkg);
        const framesAt = performance.now();
        frameSamples.push({ atMs: framesAt, frames: frames ?? null });
        if (frames === undefined) missingFrames += 1;
        if (frames !== undefined && previousFrames !== undefined) {
            const drawn = frames - previousFrames;
            frameStall = drawn > 0 ? 0 : frameStall + (framesAt - previousFramesAt) / 1000;
            if (frameStall > worstFrameStall) worstFrameStall = frameStall;
        }
        if (frames !== undefined) previousFrames = frames;
        previousFramesAt = framesAt;

        if (onTick !== undefined) await onTick();
        const elapsed = Date.now() - tickStarted;
        if (elapsed < intervalMs) await new Promise((resolve) => setTimeout(resolve, intervalMs - elapsed));
    }

    const framesEnd = await framesRendered(pkg);
    if (framesEnd === undefined) missingFrames += 1;
    const wall = (Date.now() - started) / 1000;
    return {
        seconds: Number(wall.toFixed(1)),
        sampledSeconds: Number(busySeconds.toFixed(1)),
        samples,
        pssSamples,
        frameSamples,
        missingFrames,
        missingPss,
        pssSampledSeconds: pssSamples.length < 2 ? 0 : (pssSamples.at(-1).atMs - pssSamples[0].atMs) / 1000,
        jsBusyPercent: busySeconds > 0 ? Number((busyTicks / HZ / busySeconds * 100).toFixed(1)) : undefined,
        // A restart resets gfxinfo's counter, so an end below the start means
        // "not comparable", never a negative frame rate.
        fps: framesStart !== undefined && framesEnd !== undefined && framesEnd >= framesStart
            ? Number(((framesEnd - framesStart) / wall).toFixed(1))
            : undefined,
        frameStallSeconds: Number(worstFrameStall.toFixed(1)),
        pssFirstKb: firstPss,
        pssLastKb: lastPss,
        pssMaxKb: maxPss === 0 ? undefined : maxPss,
        pssDriftKb: firstPss !== undefined && lastPss !== undefined ? lastPss - firstPss : undefined,
        restarts,
        gaps,
    };
}
