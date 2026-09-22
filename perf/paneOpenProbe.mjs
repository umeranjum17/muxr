/**
 * What opening a pane costs on a real device.
 *
 * The release gate measures gestures on surfaces that are already up. This
 * measures the transition itself, because that is where a profile of the app
 * put the thread time and the dropped frames: the herd is idle-cheap and a live
 * terminal is nearly free, while routing into a pane saturates the JS thread
 * long enough to drop frames a person sees. It also measures opening Shared
 * Artifacts, and watches what a pane that cannot start actually says.
 *
 * One run measures ONE installed build and labels it. A before/after is two
 * runs with different labels, which is what lets the same window cover a build
 * that carries more than one branch's changes.
 *
 * It is diagnostic evidence, never release acceptance: every record carries
 * `partial: true` and `acceptance: false`, and a metric nobody could take is
 * reported `unavailable` with a reason rather than as a passing zero.
 *
 *   node perf/paneOpenProbe.mjs --serial <serial> --label before --out <dir>
 *   node perf/paneOpenProbe.mjs --serial <serial> --label after  --out <dir> --opens 5
 *
 * It installs nothing, clears nothing and pairs nothing, so a device already
 * paired to its owner's machine stays paired and keeps its data.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setAndroidSerial } from './lib/deviceTarget.mjs';
import {
    appPid,
    deviceIdentity,
    dumpUiXml,
    gfxSnapshot,
    jsThreadId,
    refreshHz,
    resetGfxWindow,
    screenshot,
    threadBusyTicks,
} from './lib/androidSignals.mjs';
import { tapTimed } from './lib/gestures.mjs';
import { threadBusyShare, transitionFrameSummary } from './lib/paneOpenMetrics.mjs';

const PACKAGE = 'com.trymuxr.app';
/** The terminal surface publishes this name and no internal id; see TerminalView. */
const TERMINAL_SURFACE = 'Terminal surface';
const CONNECTING_PILL = /text="(still connecting|connecting)"/;
const RETRY_PILL = /content-desc="(Reconnect terminal|Use this terminal here)/;
// Every pill TerminalScreen paints over the surface while the pane is not
// live: the two connecting copies, the unconfirmed copy, and the retry pill it
// shows for every other status, including the takeover copy another client's
// attach earns. The terminal surface label sits under all of them, so arrival
// is "surface and no status pill".
const STATUS_PILL = new RegExp(`text="(still connecting|connecting|Connection unconfirmed|Open on another device)|${RETRY_PILL.source}`);
const MAX_SECONDS = 600;

function parseArgs(argv) {
    const args = { opens: 5, artifacts: 3, seconds: MAX_SECONDS, pkg: PACKAGE };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!flag.startsWith('--')) continue;
        const key = flag.slice(2);
        if (key === 'serial' || key === 'label' || key === 'out' || key === 'pkg') { args[key] = value; index += 1; }
        else if (key === 'opens' || key === 'artifacts' || key === 'seconds') { args[key] = Number(value); index += 1; }
    }
    for (const required of ['serial', 'label', 'out']) {
        if (typeof args[required] !== 'string' || args[required] === '') throw new Error(`--${required} is required`);
    }
    if (!(args.seconds > 0 && args.seconds <= MAX_SECONDS)) throw new Error(`--seconds must be within 0..${MAX_SECONDS}`);
    return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounds of the first node whose content-desc starts with `prefix`. Not
 * `viewBounds`: that takes a dump of its own and matches anywhere in the node,
 * and a measured transition can afford exactly one dump and has to be sure it
 * found the control it named rather than something that merely contains it.
 */
async function controlBounds(prefix, xml) {
    const screen = xml ?? await dumpUiXml();
    const node = (screen.match(/<node\b[^>]*>/g) ?? [])
        .find((candidate) => new RegExp(`content-desc="${prefix}`).test(candidate));
    const bounds = node === undefined ? undefined : /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (bounds === undefined) return undefined;
    return { l: +bounds[1], t: +bounds[2], r: +bounds[3], b: +bounds[4] };
}

const centre = (box) => ({ x: (box.l + box.r) / 2, y: (box.t + box.b) / 2 });

/** An agent row on the herd names its agent and its task; no internal id is shown. */
async function agentRow(index) {
    const screen = await dumpUiXml();
    const rows = (screen.match(/<node\b[^>]*>/g) ?? [])
        .filter((node) => / task \d+/.test(node) && /content-desc="/.test(node));
    const node = rows[index % Math.max(1, rows.length)];
    const bounds = node === undefined ? undefined : /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (bounds === undefined) return undefined;
    return { box: { l: +bounds[1], t: +bounds[2], r: +bounds[3], b: +bounds[4] }, rows: rows.length };
}

/** Poll the screen until `matches` is happy, and say how long that took. */
async function waitForScreen(matches, budgetMs) {
    const started = Date.now();
    for (;;) {
        const screen = await dumpUiXml();
        if (matches(screen)) return { ms: Date.now() - started, screen };
        if (Date.now() - started > budgetMs) return { ms: -1, screen };
        await sleep(150);
    }
}

/** JS-thread busy share across one window, or why it could not be taken. */
async function jsBusy(pkg) {
    const pid = await appPid(pkg);
    if (pid === undefined) return { unavailable: 'the app is not running' };
    const tid = await jsThreadId(pid);
    if (tid === undefined) return { unavailable: 'no JS thread; the runtime is down' };
    const ticks = await threadBusyTicks(pid, tid);
    if (ticks === undefined) return { unavailable: 'the JS thread vanished mid-read' };
    return { pid, tid, ticks, atMs: Date.now() };
}

async function measureTransition({ pkg, hz, name, act, settled, budgetMs, settleMs }) {
    await resetGfxWindow(pkg, { hz });
    const open = await jsBusy(pkg);
    const tap = await act();
    const reached = await waitForScreen(settled, budgetMs);
    await sleep(settleMs);
    const close = await jsBusy(pkg);
    const snapshot = await gfxSnapshot(pkg, { hz });
    return {
        name,
        // The screen dump that proves arrival costs seconds, so this is time to
        // the first dump that showed content, never a frame-accurate latency.
        timeToContentMs: reached.ms,
        reached: reached.ms >= 0,
        tapT0Seconds: tap?.t0Seconds ?? null,
        jsBusy: threadBusyShare(open, close),
        frames: transitionFrameSummary(snapshot, hz),
    };
}

async function backToHerd() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const back = await controlBounds('Back to');
        if (back !== undefined) { const { x, y } = centre(back); await tapTimed(x, y); }
        const screen = await dumpUiXml();
        if (/ task \d+/.test(screen) && !screen.includes(TERMINAL_SURFACE)) return true;
        await sleep(500);
    }
    return false;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    setAndroidSerial(args.serial);
    const out = resolve(args.out);
    mkdirSync(out, { recursive: true });
    const startedAt = Date.now();
    const deadline = startedAt + args.seconds * 1000;
    const overBudget = () => Date.now() > deadline;

    const device = await deviceIdentity();
    const hz = await refreshHz();
    if (await appPid(args.pkg) === undefined) throw new Error(`${args.pkg} is not running; open it on the device first`);

    const record = {
        version: 1,
        kind: 'muxr.pane-open-probe',
        label: args.label,
        partial: true,
        acceptance: false,
        startedAt: new Date(startedAt).toISOString(),
        device,
        refreshHz: hz,
        paneOpens: [],
        artifactOpens: [],
        stalledConnect: null,
    };

    if (!await backToHerd()) throw new Error('could not reach the herd; leave the app on the herd screen and retry');
    await sleep(15_000); // warm, so the first open is not measuring app start

    for (let index = 0; index < args.opens && !overBudget(); index += 1) {
        const row = await agentRow(index);
        if (row === undefined) { record.paneOpens.push({ name: `open ${index + 1}`, unavailable: 'no agent row on the herd' }); break; }
        const target = centre(row.box);
        record.paneOpens.push(await measureTransition({
            pkg: args.pkg, hz, name: `open ${index + 1}`,
            act: () => tapTimed(target.x, target.y),
            settled: (screen) => screen.includes(TERMINAL_SURFACE) && !STATUS_PILL.test(screen),
            budgetMs: 20_000, settleMs: 2000,
        }));
        await backToHerd();
        await sleep(1500);
    }

    // Shared Artifacts, from a pane that is already open and quiet.
    for (let index = 0; index < args.artifacts && !overBudget(); index += 1) {
        const row = await agentRow(index);
        if (row === undefined) break;
        const target = centre(row.box);
        await tapTimed(target.x, target.y);
        await waitForScreen((screen) => screen.includes(TERMINAL_SURFACE), 20_000);
        await sleep(3000);
        const actions = await controlBounds('Pane actions');
        if (actions === undefined) { record.artifactOpens.push({ name: `artifacts ${index + 1}`, unavailable: 'no Pane actions control' }); await backToHerd(); continue; }
        const actionsAt = centre(actions);
        await tapTimed(actionsAt.x, actionsAt.y);
        const sheet = await waitForScreen((screen) => /content-desc="Shared Artifacts/.test(screen), 10_000);
        const entry = await controlBounds('Shared Artifacts', sheet.screen);
        if (entry === undefined) { record.artifactOpens.push({ name: `artifacts ${index + 1}`, unavailable: 'no Shared Artifacts entry' }); await backToHerd(); continue; }
        const entryAt = centre(entry);
        record.artifactOpens.push(await measureTransition({
            pkg: args.pkg, hz, name: `artifacts ${index + 1}`,
            act: () => tapTimed(entryAt.x, entryAt.y),
            // A row, or the honest empty state; both are the screen having settled.
            settled: (screen) => /content-desc="Download /.test(screen) || /No shared artifacts yet/.test(screen),
            budgetMs: 20_000, settleMs: 4000,
        }));
        await backToHerd();
        await sleep(1500);
    }

    // What a pane that has not started says, and whether it offers a way out.
    if (!overBudget()) {
        const row = await agentRow(0);
        if (row !== undefined) {
            const target = centre(row.box);
            await tapTimed(target.x, target.y);
            const marks = [];
            for (const at of [5, 13, 20]) {
                await sleep(at * 1000 - (marks.at(-1)?.atSeconds ?? 0) * 1000);
                const screen = await dumpUiXml();
                marks.push({
                    atSeconds: at,
                    pill: (CONNECTING_PILL.exec(screen) ?? [])[1] ?? null,
                    retryOffered: RETRY_PILL.test(screen),
                    terminalPresent: screen.includes(TERMINAL_SURFACE),
                });
            }
            record.stalledConnect = marks;
            await screenshot(resolve(out, `${args.label}-pane.png`));
            await backToHerd();
        }
    }

    record.finishedAt = new Date().toISOString();
    record.ranToCompletion = !overBudget();
    const path = resolve(out, `${args.label}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(path);
}

await main();
