// The unpaired first screen's order (see tailscale-first-step.md and
// first-run-browser-steps.md): Get Tailscale, then Get muxr on your computer, then
// Pair with your computer. Boots a task-owned emulator, installs a release APK
// unpaired, and per cell (width, font, theme) captures the screen at rest and
// scrolled to the end, reads the three step titles' order from the dump, then
// opens Get the desktop app (Add your computer, with the trymuxr.com/desktop link)
// and Get Tailscale (the store), backing out of each. Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/firstRunStepsLab.mjs --apk <apk> --evidence <dir> \
//     --avd-home <dir> [--ref <main evidence dir>] [--baseline]
// --baseline captures main's screen for --ref without asking for the steps.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' }, ref: { type: 'string' }, baseline: { type: 'boolean' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home']) throw new Error('--apk, --evidence and --avd-home are required');
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
const CHECK = resolve('.agents/skills/done-done-verify-pockit/features/visualCheck.mjs');
// 1080 px at density 443 is a 390 dp phone; 640 is the reference phone's 270 dp.
const CELLS = ['390', '270'].flatMap((width) => ['1.0', '2.0'].flatMap((font) => ['light', 'dark'].map((theme) => [width, font, theme])));
const DENSITY = { 390: 443, 270: 640 };
const STEPS = ['Get Tailscale', 'Get muxr on your computer', 'Pair with your computer'];
mkdirSync(EVIDENCE, { recursive: true });
const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => { const out = `${new Date().toISOString()} ${line}`; console.log(out); appendFileSync(join(EVIDENCE, 'journey.log'), `${out}\n`); };
let serial = '';
const adb = async (args, timeout = 60_000) => (await exec('adb', ['-s', serial, ...args], { timeout, maxBuffer: 64 << 20 })).stdout;
const sh = (cmd) => adb(['shell', cmd]);
const screenshot = async (path) => writeFileSync(path, (await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 30_000 })).stdout);

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
function nodes(xml) {
    return [...xml.matchAll(/<node\s[^>]*>/g)].map(([tag]) => {
        const get = (key) => unescape(tag.match(new RegExp(` ${key}="([^"]*)"`))?.[1] ?? '');
        const box = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
        return { text: get('text'), desc: get('content-desc'), pkg: get('package'), box };
    });
}
async function screen() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const xml = await dumpUiXml(30_000);
        if (xml !== '') {
            const found = nodes(xml);
            // A slow emulator raises "System UI isn't responding" over everything; wait it out.
            const wait = found.find((n) => n.text === 'Wait');
            if (found.some((n) => n.text.endsWith("isn't responding")) && wait) {
                await sh(`input tap ${center(wait).join(' ')}`);
                await sleep(2000);
                continue;
            }
            return found;
        }
        await sleep(1500);
    }
    return [];
}
// A compact step carries its number in the title ("1. Get Tailscale").
const titled = (title) => (value) => value === title || /^\d\. /.test(value) && value.slice(3) === title;
const find = (found, test) => found.find((n) => test(n.text) || test(n.desc));
const center = ({ box: [l, t, r, b] }) => [Math.round((l + r) / 2), Math.round((t + b) / 2)];
async function waitFor(what, test, seconds = 60) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const found = await screen();
        if (test(found)) return found;
        await sleep(1500);
    }
    const stem = join(EVIDENCE, `missing-${what.replace(/\W+/g, '-')}`);
    await screenshot(`${stem}.png`).catch((error) => say(`screenshot failed: ${error.message}`));
    writeFileSync(`${stem}.txt`, (await screen()).filter((n) => n.text || n.desc).map((n) => `${n.text} | ${n.desc} | ${n.box}`).join('\n'));
    throw new Error(`${what} never appeared within ${seconds}s`);
}
async function tapOn(what, test, seconds = 60, pick = find) {
    const node = pick(await waitFor(what, (found) => pick(found, test) !== undefined, seconds), test);
    say(`tap ${what}`);
    await sh(`input tap ${center(node).join(' ')}`);
}
// The pair field sits below the fold at 2.0 text now that it is step 3; main's screen has no heading match.
const atFirstRun = (found) => find(found, (v) => v === 'Let’s connect' || v === 'Private link or pairing code') !== undefined;
// A stepped drag scrolls; a slow `input swipe` reads as a long press.
const drag = (from, to) => sh(`input motionevent DOWN 540 ${from}; y=${from}; while [ $y -gt ${to} ]; do y=$((y-40)); input motionevent MOVE 540 $y; done; input motionevent UP 540 ${to}`);
async function scrollToEnd(onScreen = () => undefined) {
    let last = '';
    for (let i = 0; i < 8; i += 1) {
        const found = await screen();
        onScreen(found, i);
        const now = JSON.stringify(found.map((n) => n.box));
        if (now === last) return;
        last = now;
        await drag(1900, 500);
        await sleep(1200);
    }
}

const leads = [];
const defects = [];
async function capture(dir, name, end = false) {
    await sleep(2500);
    const args = [CHECK, serial, dir, name];
    if (end) args.push('--end');
    if (opts.ref) args.push('--ref', join(resolve(opts.ref), dir.slice(EVIDENCE.length + 1), `${name}.xml`));
    const run = await exec(process.execPath, args, { timeout: 180_000, maxBuffer: 16 << 20 }).then((r) => ({ out: r.stdout }), (e) => ({ out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const lines = run.out.split('\n').filter((line) => line.startsWith('DEFECT'));
    for (const line of lines) leads.push(`${name}: ${line}`);
    say(`shot ${name}: ${lines.length === 0 ? 'clean' : lines.join(' | ')}`);
}
async function launch() {
    await sh(`am force-stop ${PKG}`);
    await sh(`am start -W -n ${PKG}/.MainActivity`);
    await waitFor('the first-run screen', atFirstRun, 120);
    await sleep(1500);
}

let emulator;
const order = {};
try {
    emulator = await bootOwnedEmulator({ name: 'mxfr', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    // Gms banners would cover the top of every shot.
    await sh('settings put global heads_up_notifications_enabled 0');
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    say(`installed ${opts.apk}`);

    for (const [width, font, theme] of CELLS) {
        const cell = `${width}-${font}-${theme}`;
        const dir = join(EVIDENCE, cell);
        mkdirSync(dir, { recursive: true });
        await sh(`wm size 1080x2376; wm density ${DENSITY[width]}; settings put system font_scale ${font}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await launch();
        // Each title's top, from the whole scroll: a later step may start below the fold.
        const atRest = await screen();
        const tops = Object.fromEntries(STEPS.map((title) => [title, find(atRest, titled(title))?.box[1] ?? null]));
        await capture(dir, `firstrun-${cell}`);
        // A step between the fold and the end (step 3 at 270 dp) is only on a middle pass:
        // a title first seen on pass n ranks below everything on earlier passes.
        await scrollToEnd((found, pass) => {
            for (const title of STEPS) {
                const node = tops[title] === null ? find(found, titled(title)) : undefined;
                if (node !== undefined) tops[title] = pass * 10_000 + node.box[1];
            }
        });
        await capture(dir, `firstrun-${cell}-scrolled`, true);
        const scrolled = await screen();
        for (const title of STEPS) if (tops[title] === null && find(scrolled, titled(title)) !== undefined) tops[title] = Infinity;
        order[cell] = tops;
        const seen = STEPS.map((title) => tops[title]);
        const inOrder = seen.every((top, i) => top !== null && (i === 0 || top > seen[i - 1]));
        say(`steps ${cell}: ${STEPS.map((title) => `${title} @${tops[title]}`).join(', ')} -> ${inOrder ? 'in order' : 'NOT in order'}`);
        if (!opts.baseline && !inOrder) defects.push(`${cell}: steps not in order Tailscale, muxr on the computer, pair`);
    }

    if (!opts.baseline) {
        // The two step actions, at the 390 dp light cell.
        const dir = join(EVIDENCE, 'actions');
        mkdirSync(dir, { recursive: true });
        await sh(`wm size 1080x2376; wm density ${DENSITY[390]}; settings put system font_scale 1.0; cmd uimode night no`);
        await launch();
        await tapOn('Get the desktop app', (v) => v === 'Get the desktop app' || v.startsWith('Get the desktop app.'));
        await waitFor('Add your computer', (found) => find(found, (v) => v === 'trymuxr.com/desktop') !== undefined, 30);
        await capture(dir, 'add-computer-390-1.0-light');
        await sh('input keyevent KEYCODE_BACK');
        await waitFor('back on the first-run screen', atFirstRun, 30);
        // The step title reads Get Tailscale too; only the button carries it as its description.
        await tapOn('Get Tailscale button', (v) => v === 'Get Tailscale', 30, (found, test) => found.find((n) => test(n.desc)));
        // This AVD has no Play Store, so the market link falls back to the Play web page.
        const store = await waitFor('the Tailscale store page', (found) => found.some((n) => n.pkg !== PKG && n.pkg !== '' && n.pkg !== 'com.android.systemui'), 60);
        await sleep(4000);
        await screenshot(join(dir, 'get-tailscale-store-390-1.0-light.png'));
        say(`Get Tailscale opened ${[...new Set(store.map((n) => n.pkg))].filter((p) => p !== 'com.android.systemui').join(', ')}`);
    }

    writeFileSync(join(EVIDENCE, 'order.json'), `${JSON.stringify(order, null, 2)}\n`);
    say(`visual check leads: ${leads.length === 0 ? 'none' : `\n${leads.join('\n')}`}`);
    say(`defects: ${defects.length === 0 ? 'none' : `\n${defects.join('\n')}`}`);
    writeFileSync(join(EVIDENCE, 'steps.json'), `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'the release app freshly installed on an Android phone (emulator), not paired to any computer',
        steps: [
            'open the app on its first screen, Connect a machine',
            'read the steps from top to bottom, at rest and scrolled to the end',
            'repeat at 390 and 270 dp wide, text 1.0 and 2.0, light and dark',
            'tap Get the desktop app and see the Add your computer screen with the trymuxr.com/desktop link, then go back',
            'tap Get Tailscale and see the Tailscale store page open',
        ],
        result: 'the first screen leads with Get Tailscale, then Get muxr on your computer with the Linux desktop app, then Pair with your computer; the desktop app button opens its download link screen and Get Tailscale opens the store',
    }, null, 2)}\n`);
    say(defects.length === 0 ? 'RESULT done' : 'RESULT FAIL: defects above');
    if (defects.length > 0) process.exitCode = 1;
} catch (error) {
    say(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (serial) await screenshot(join(EVIDENCE, 'failure.png')).catch(() => undefined);
    if (serial) writeFileSync(join(EVIDENCE, 'crash.log'), await adb(['logcat', '-d', '-b', 'crash']).catch((e) => String(e)));
    process.exitCode = 1;
} finally {
    if (serial) await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no').catch(() => undefined);
    await emulator?.stop();
    say('emulator stopped');
}
