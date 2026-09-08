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

/**
 * One tap, one spawn, with `/proc/uptime` sampled in the same shell -- the same
 * way `swipeOnce` times a fling.
 *
 * The coordinates have to be resolved already. Finding a control costs a
 * UIAutomator dump, which takes seconds, and a t0 taken before one puts the
 * whole dump inside the frame window: the first frame the touch drove then
 * looks seconds late against a limit meant for the touch alone.
 */
export async function tapTimed(x, y) {
    const { stdout } = await run(
        'adb',
        ['shell', `t0=$(cut -d' ' -f1 /proc/uptime); input tap ${Math.round(x)} ${Math.round(y)}; echo $t0`],
        { timeout: 20_000 },
    );
    const t0 = Number(String(stdout).trim().split(/\s+/).pop());
    return { tapped: true, t0Seconds: Number.isFinite(t0) ? t0 : undefined };
}

/** Short linear swipe: ~800 px in 120 ms, about 6600 px/s. */
export async function fling(from, to) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    return swipeOnce(from, to, durationFor(distance, FLING_PX_PER_SECOND), 'fling');
}

const median = (values) => values.slice().sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

/**
 * One profile's own account. A bout mixes ~6600 px/s flings with ~1100 px/s
 * drags, so a median over both lands between the two populations and describes
 * neither: it selects the slowest fling and calls it typical.
 */
function summarizeProfile(gestures) {
    return {
        gestures: gestures.length,
        medianVelocityPxPerSecond: median(gestures.map((gesture) => gesture.velocityPxPerSecond)),
        intendedMedianVelocityPxPerSecond: median(gestures.map((gesture) => gesture.intendedVelocityPxPerSecond)),
    };
}

function profileInjectOk(profile) {
    const intended = profile.intendedMedianVelocityPxPerSecond;
    return intended === 0 || profile.medianVelocityPxPerSecond >= 0.7 * intended;
}

export function summarize(gestures) {
    const profiles = [...new Set(gestures.map((gesture) => gesture.profile))];
    const byProfile = Object.fromEntries(profiles
        .map((name) => [name, summarizeProfile(gestures.filter((gesture) => gesture.profile === name))]));
    const flings = byProfile.fling ?? summarizeProfile([]);
    return {
        gestures: gestures.length,
        flings: flings.gestures,
        // The headline pair is the fling's, which is what the gate's limits were
        // written against; every profile is kept beside it.
        medianVelocityPxPerSecond: flings.medianVelocityPxPerSecond,
        intendedMedianVelocityPxPerSecond: flings.intendedMedianVelocityPxPerSecond,
        byProfile,
        slowProfiles: profiles.filter((name) => !profileInjectOk(byProfile[name])),
        profiles,
        samples: gestures,
    };
}

/** Every profile of this bout met its own 70% guard. */
function injectOk(summary) {
    return summary.slowProfiles.length === 0;
}

/**
 * One complete attempt, reported as it happened.
 *
 * There is no silent retry. A second bout has its own counter baseline, its own
 * sampler window and its own surface, while the caller accumulates all three
 * against the first: combining them produced CPU, frame and movement numbers
 * that described no single attempt.
 */
async function oneAttempt(runOnce) {
    const summary = summarize(await runOnce());
    return { ...summary, injectFailed: !injectOk(summary) };
}

/**
 * A repeatable gesture bout: alternating flings and controlled drags over the
 * middle of the screen, which is where every scrollable surface in this app
 * lives. Returns the bout so a phase can report the input it actually applied.
 *
 * A bout is one attempt. If any profile's own median velocity is under 70% of
 * intended it fails as "device could not inject" — the numbers would not be
 * comparable.
 */
export async function scrollBout(options) {
    const { width = 1080, height = 1920, bounds, seconds = 30, settleMs = 350, onGesture } = options ?? {};
    // The surface the phase resolved, or the screen when it has none. Travel
    // stays the same fraction of it, so the commanded speeds do not change.
    const box = bounds ?? { l: 0, t: 0, r: width, b: height };
    const span = box.b - box.t;
    const midX = Math.round((box.l + box.r) / 2);
    const top = Math.round(box.t + span * 0.28);
    const bottom = Math.round(box.t + span * 0.72);
    // The window a phase measures a gesture over ends after the gesture has
    // settled, so the frames the fling was still drawing belong to the fling
    // and not to whatever came next.
    const settled = async (gesture, gestures) => {
        gestures.push(gesture);
        await sleep(settleMs);
        if (onGesture !== undefined) await onGesture(gesture);
    };
    const once = async () => {
        const deadline = Date.now() + seconds * 1000;
        const gestures = [];
        while (Date.now() < deadline) {
            await settled(await fling({ x: midX, y: bottom }, { x: midX, y: top }), gestures);
            if (Date.now() >= deadline) break;
            await settled(await fling({ x: midX, y: top }, { x: midX, y: bottom }), gestures);
            if (Date.now() >= deadline) break;
            await settled(await drag({ from: { x: midX, y: bottom }, to: { x: midX, y: top } }), gestures);
            if (Date.now() >= deadline) break;
            await settled(await drag({ from: { x: midX, y: top }, to: { x: midX, y: bottom } }), gestures);
        }
        return gestures;
    };
    return oneAttempt(once);
}

/**
 * Horizontal paging on the live-terminal strip: down the middle of the strip's
 * own scroller, travel 60% of its width, flings only. The caller resolves those
 * bounds from the hierarchy, because a screen percentage lands in the plugin
 * navigation instead. Same per-profile inject guard as `scrollBout`.
 */
export async function stripBout(options) {
    const { bounds, seconds = 20, settleMs = 350, onGesture } = options ?? {};
    if (bounds === undefined) throw new Error('stripBout needs the strip scroller bounds');
    const y = Math.round((bounds.t + bounds.b) / 2);
    const travel = (bounds.r - bounds.l) * 0.6;
    const midX = (bounds.l + bounds.r) / 2;
    const left = Math.round(midX - travel / 2);
    const right = Math.round(midX + travel / 2);
    const settled = async (gesture, gestures) => {
        gestures.push(gesture);
        await sleep(settleMs);
        if (onGesture !== undefined) await onGesture(gesture);
    };
    const once = async () => {
        const deadline = Date.now() + seconds * 1000;
        const gestures = [];
        while (Date.now() < deadline) {
            await settled(await fling({ x: right, y }, { x: left, y }), gestures);
            if (Date.now() >= deadline) break;
            await settled(await fling({ x: left, y }, { x: right, y }), gestures);
        }
        return gestures;
    };
    return oneAttempt(once);
}
