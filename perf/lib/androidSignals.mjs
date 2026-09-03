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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** Linux clock ticks per second; /proc jiffies are in these units. */
const HZ = 100;
const JS_THREAD = 'mqt_v_js';

async function adb(args, timeout = 10_000) {
    const { stdout } = await run('adb', args, { timeout, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}

async function quiet(args, timeout = 10_000) {
    try {
        return await adb(args, timeout);
    } catch {
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

export async function resetFrames(pkg) {
    await quiet(['shell', 'dumpsys', 'gfxinfo', pkg, 'reset']);
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
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));
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
    let previousFrames = framesStart;

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
                    if (previousTicks !== undefined) {
                        busyTicks += ticks - previousTicks;
                        busySeconds += (Date.now() - tickStarted + intervalMs) / 1000;
                    }
                    previousTicks = ticks;
                }
            }
            const pss = await totalPssKb(pid);
            if (pss !== undefined) {
                if (firstPss === undefined) firstPss = pss;
                lastPss = pss;
                if (pss > maxPss) maxPss = pss;
            }
        }

        const frames = await framesRendered(pkg);
        if (frames !== undefined && previousFrames !== undefined) {
            const drawn = frames - previousFrames;
            frameStall = drawn > 0 ? 0 : frameStall + intervalMs / 1000;
            if (frameStall > worstFrameStall) worstFrameStall = frameStall;
        }
        if (frames !== undefined) previousFrames = frames;

        if (onTick !== undefined) await onTick();
        const elapsed = Date.now() - tickStarted;
        if (elapsed < intervalMs) await new Promise((resolve) => setTimeout(resolve, intervalMs - elapsed));
    }

    const framesEnd = await framesRendered(pkg);
    const wall = (Date.now() - started) / 1000;
    return {
        seconds: Number(wall.toFixed(1)),
        sampledSeconds: Number(busySeconds.toFixed(1)),
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
