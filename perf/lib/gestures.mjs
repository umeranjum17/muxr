/**
 * Gestures the device performs the same way every run.
 *
 * Section 4.2 asked for `input motionevent` so a fling could be an ease-out
 * that lifts while the finger is still moving. On this emulator one
 * `adb shell input motionevent` costs ~49 ms of round trip — each call
 * spawns a shell and a JVM on the device — so a ten-step fling takes about
 * half a second whatever `stepMs` says, the achieved velocity is a fraction
 * of intended, and the 70% inject guard correctly refuses the numbers.
 *
 * Measured gestures therefore use one spawn: `adb shell input swipe x1 y1
 * x2 y2 <ms>`. The injector interpolates on-device at kernel timing, the
 * duration is honoured, and the tail of the stream carries velocity so a
 * short duration really does fling. A 120 ms swipe was 177 ms wall here
 * (one spawn of overhead, not ten). That costs the ease-out profile: a
 * fling is a short linear swipe (~800 px in 120 ms, ~6600 px/s) and a drag
 * is a long one (~800 px in 700 ms, ~1100 px/s). Achieved rate is distance
 * over the duration the device actually took. `motionevent` stays only for
 * taps and for a press-hold-then-drag where the hold matters.
 *
 * Maestro's `swipe` is still not used for measurement: it re-reads the view
 * hierarchy first, so two runs of the same flow deliver different motion.
 *
 * Every helper returns what it actually did, because a device under load
 * delivers events slower than asked and a phase must report the gesture it
 * got rather than the one it wanted.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Target on-device speeds. Duration scales with travel so a short pane still flings. */
const FLING_PX_PER_SECOND = 800 / 0.120;
const DRAG_PX_PER_SECOND = 800 / 0.700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function motion(action, x, y) {
    await run(
        'adb',
        ['shell', 'input', 'motionevent', action, String(Math.round(x)), String(Math.round(y))],
        { timeout: 10_000 },
    );
}

function durationFor(distance, pxPerSecond) {
    return Math.max(50, Math.round(distance / pxPerSecond * 1000));
}

function parseUptimePair(stdout) {
    const match = /([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)/.exec(String(stdout));
    if (match === null) return { t0: undefined, t1: undefined };
    return { t0: Number(match[1]), t1: Number(match[2]) };
}

/**
 * One swipe, one spawn. `/proc/uptime` is sampled in the same shell so t0 is
 * the moment the injector started, not a second round trip later.
 */
async function swipeOnce(from, to, durationMs, profile) {
    const x1 = Math.round(from.x);
    const y1 = Math.round(from.y);
    const x2 = Math.round(to.x);
    const y2 = Math.round(to.y);
    const duration = Math.max(1, Math.round(durationMs));
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const started = Date.now();
    const { stdout } = await run(
        'adb',
        ['shell', `t0=$(cut -d' ' -f1 /proc/uptime); input swipe ${x1} ${y1} ${x2} ${y2} ${duration}; t1=$(cut -d' ' -f1 /proc/uptime); echo $t0 $t1`],
        { timeout: 20_000 },
    );
    const wallMs = Date.now() - started;
    const { t0, t1 } = parseUptimePair(stdout);
    const deviceMs = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, Math.round((t1 - t0) * 1000)) : 0;
    // Prefer on-device elapsed when /proc/uptime actually ticked. Wall time
    // includes the spawn (~50 ms) and would trip the 70% guard on a 120 ms fling.
    const elapsedMs = deviceMs >= duration * 0.5
        ? deviceMs
        : Math.max(1, wallMs || deviceMs);
    return {
        elapsedMs,
        wallMs,
        deviceMs,
        distancePx: Math.round(distance),
        velocityPxPerSecond: Math.round(distance / (elapsedMs / 1000)),
        intendedVelocityPxPerSecond: Math.round(distance / (duration / 1000)),
        durationMs: duration,
        profile,
        t0Seconds: t0,
    };
}

/**
 * One touch from `from` to `to`. Default is a long linear swipe (~1100 px/s).
 * `holdMs` keeps the slow `motionevent` path: the hold is the point of that
 * gesture, and swipe cannot pause at the origin.
 */
export async function drag(options) {
    const { from, to, profile = 'linear', holdMs = 0, durationMs } = options;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const duration = durationMs ?? durationFor(distance, DRAG_PX_PER_SECOND);
    if (!(holdMs > 0)) return swipeOnce(from, to, duration, profile);

    const started = Date.now();
    const { stdout } = await run(
        'adb',
        ['shell', `t0=$(cut -d' ' -f1 /proc/uptime); echo $t0; input motionevent DOWN ${Math.round(from.x)} ${Math.round(from.y)}`],
        { timeout: 10_000 },
    );
    const t0 = Number(String(stdout).trim().split(/\s+/)[0]);
    await sleep(holdMs);
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        await motion('MOVE', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    }
    await motion('UP', to.x, to.y);
    const elapsed = Date.now() - started;
    return {
        elapsedMs: elapsed,
        wallMs: elapsed,
        distancePx: Math.round(distance),
        velocityPxPerSecond: elapsed === 0 ? 0 : Math.round(distance / (elapsed / 1000)),
        intendedVelocityPxPerSecond: Math.round(distance / ((holdMs + duration) / 1000)),
        durationMs: duration,
        profile,
        t0Seconds: Number.isFinite(t0) ? t0 : undefined,
    };
}

/** A tap, for opening what a gesture phase is about to scroll. */
export async function tap(x, y) {
    await run('adb', ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], { timeout: 10_000 });
}

/** Short linear swipe: ~800 px in 120 ms, about 6600 px/s. */
export async function fling(from, to) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    return swipeOnce(from, to, durationFor(distance, FLING_PX_PER_SECOND), 'fling');
}

function summarize(gestures) {
    const velocities = gestures.map((gesture) => gesture.velocityPxPerSecond).sort((left, right) => left - right);
    const intended = gestures.map((gesture) => gesture.intendedVelocityPxPerSecond).sort((left, right) => left - right);
    const profiles = [...new Set(gestures.map((gesture) => gesture.profile))];
    return {
        gestures: gestures.length,
        flings: gestures.filter((gesture) => gesture.profile === 'fling').length,
        medianVelocityPxPerSecond: velocities[Math.floor(velocities.length / 2)] ?? 0,
        intendedMedianVelocityPxPerSecond: intended[Math.floor(intended.length / 2)] ?? 0,
        profiles,
        samples: gestures,
    };
}

function injectOk(summary) {
    const intended = summary.intendedMedianVelocityPxPerSecond;
    return intended === 0 || summary.medianVelocityPxPerSecond >= 0.7 * intended;
}

async function withInjectRetry(runOnce) {
    let summary = summarize(await runOnce());
    if (!injectOk(summary)) summary = summarize(await runOnce());
    return { ...summary, injectFailed: !injectOk(summary) };
}

/**
 * A repeatable gesture bout: alternating flings and controlled drags over the
 * middle of the screen, which is where every scrollable surface in this app
 * lives. Returns the bout so a phase can report the input it actually applied.
 *
 * A bout whose median velocity is under 70% of intended is retried once, then
 * fails as "device could not inject" — the numbers would not be comparable.
 */
export async function scrollBout(options) {
    const { width = 1080, height = 1920, seconds = 30, settleMs = 350, onGesture } = options ?? {};
    const midX = Math.round(width / 2);
    const top = Math.round(height * 0.28);
    const bottom = Math.round(height * 0.72);
    const once = async () => {
        const deadline = Date.now() + seconds * 1000;
        const gestures = [];
        while (Date.now() < deadline) {
            const up = await fling({ x: midX, y: bottom }, { x: midX, y: top });
            gestures.push(up);
            if (onGesture !== undefined) await onGesture(up);
            await sleep(settleMs);
            if (Date.now() >= deadline) break;
            const down = await fling({ x: midX, y: top }, { x: midX, y: bottom });
            gestures.push(down);
            if (onGesture !== undefined) await onGesture(down);
            await sleep(settleMs);
            if (Date.now() >= deadline) break;
            const dragUp = await drag({ from: { x: midX, y: bottom }, to: { x: midX, y: top } });
            gestures.push(dragUp);
            if (onGesture !== undefined) await onGesture(dragUp);
            await sleep(settleMs);
            if (Date.now() >= deadline) break;
            const dragDown = await drag({ from: { x: midX, y: top }, to: { x: midX, y: bottom } });
            gestures.push(dragDown);
            if (onGesture !== undefined) await onGesture(dragDown);
            await sleep(settleMs);
        }
        return gestures;
    };
    return withInjectRetry(once);
}

/**
 * Horizontal paging on the live-terminal strip: y = 33% of height, travel 60%
 * of width, flings only. Same inject-retry rule as `scrollBout`.
 */
export async function stripBout(options) {
    const { width = 1080, height = 1920, seconds = 20, settleMs = 350, onGesture } = options ?? {};
    const y = Math.round(height * 0.33);
    const travel = width * 0.6;
    const midX = width / 2;
    const left = Math.round(midX - travel / 2);
    const right = Math.round(midX + travel / 2);
    const once = async () => {
        const deadline = Date.now() + seconds * 1000;
        const gestures = [];
        while (Date.now() < deadline) {
            const inward = await fling({ x: right, y }, { x: left, y });
            gestures.push(inward);
            if (onGesture !== undefined) await onGesture(inward);
            await sleep(settleMs);
            if (Date.now() >= deadline) break;
            const back = await fling({ x: left, y }, { x: right, y });
            gestures.push(back);
            if (onGesture !== undefined) await onGesture(back);
            await sleep(settleMs);
        }
        return gestures;
    };
    return withInjectRetry(once);
}
