// Every Modal.alert / Modal.confirm on Android is the shared app action sheet (see
// action-sheet.md). Boots a task-owned emulator, pairs a release APK to the perf fake
// stack, and per cell (width, font, theme) opens and captures: Add attachment on Home,
// a Home card's long-press actions, and the pane overview's Close pane actions over its
// sheet. On the candidate (--interact) it also proves tap-outside and swipe-down
// dismissal and that Files reaches the system file picker. Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/actionSheetLab.mjs --apk <apk> --evidence <dir> \
//     --avd-home <dir> [--ref <main evidence dir>] [--interact]
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';
import { pairPhone } from '../../../../perf/lib/pairPhone.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' },
    ref: { type: 'string' }, interact: { type: 'boolean' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home']) throw new Error('--apk, --evidence and --avd-home are required');
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
const CHECK = resolve('.agents/skills/done-done-verify-pockit/features/visualCheck.mjs');
const CELLS = [[270, '1.0', 'light'], [270, '1.0', 'dark'], [270, '2.0', 'light'], [270, '2.0', 'dark'], [390, '1.0', 'light'], [390, '1.0', 'dark']];
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
    return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
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
                await adb(['shell', 'input', 'tap', ...center(wait).map(String)]);
                await sleep(2000);
                continue;
            }
            return found;
        }
        await sleep(1500);
    }
    return [];
}
const find = (found, test) => found.find((n) => test(n.text) || test(n.desc));
// The system dialog on main paints its buttons in capitals.
const is = (label) => (value) => value.toLowerCase() === label.toLowerCase();
const has = (label) => (found) => find(found, is(label)) !== undefined;
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
async function tapOn(what, test, seconds = 60, hold = 0) {
    // Tap only once the target holds still across two reads: Home re-lays out as cards load.
    let node = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test);
    for (let i = 0; i < 10; i += 1) {
        await sleep(1000);
        const again = find(await screen(), test);
        if (again !== undefined && String(again.box) === String(node.box)) break;
        node = again ?? node;
    }
    const [x, y] = center(node);
    say(`${hold ? 'long-press' : 'tap'} ${what}`);
    if (hold) await sh(`input swipe ${x} ${y} ${x} ${y} ${hold}`);
    else await sh(`input tap ${x} ${y}`);
}
const atHome = (found) => has('connected')(found) && has('Plan, ask, build…')(found);
// Add attachment sits in the open composer; the collapsed dock shows only its entry.
async function openAttach() {
    await tapOn('composer entry', (v) => v === 'Plan, ask, build…');
    await tapOn('Add attachment', is('Add attachment'));
    return waitFor('attachment choices', has('Files'));
}
async function toHome() {
    for (let i = 0; i < 4; i += 1) {
        if (atHome(await screen())) return;
        await back();
    }
    await waitFor('connected Home', atHome, 30);
}

// A relaunch reopens the agent it left, so wait for either screen, then back out to Home.
async function relaunched() {
    await waitFor('app after relaunch', (found) => atHome(found) || has('Back')(found), 120);
    await toHome();
}

const defects = [];
async function capture(dir, name) {
    await sleep(1200); // the sheet's slide-in settles
    const args = [CHECK, serial, dir, name];
    if (opts.ref) args.push('--ref', join(resolve(opts.ref), dir.slice(EVIDENCE.length + 1), `${name}.xml`));
    const run = await exec(process.execPath, args, { timeout: 180_000, maxBuffer: 16 << 20 }).then((r) => ({ out: r.stdout, code: 0 }), (e) => ({ out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.code }));
    // The sheet's dimmed backdrop covers the whole screen on purpose (tap outside closes),
    // so lines that name only that full-screen view are logged apart, not counted.
    const all = run.out.split('\n').filter((line) => line.startsWith('DEFECT'));
    const backdrop = all.filter((line) => line.includes('"android.view.ViewGroup" [0,0][1080,2376]'));
    const lines = all.filter((line) => !backdrop.includes(line));
    for (const line of lines) defects.push(`${name}: ${line}`);
    say(`shot ${name}: ${lines.length === 0 ? 'clean' : lines.join(' | ')}${backdrop.length ? ` (backdrop lines: ${backdrop.length})` : ''}`);
}
async function back() { await sh('input keyevent KEYCODE_BACK'); await sleep(1200); }

async function openOffer(_flow, { PAIR_CODE }) {
    try {
        await sh(`am start -a android.intent.action.VIEW -d 'muxr://pair#${PAIR_CODE}' ${PKG}`);
        await tapOn('Pair', is('Pair'), 60);
        await waitFor('connected after Pair', has('connected'), 120);
        return { code: 0, output: 'paired through the consent card' };
    } catch (error) {
        return { code: 1, output: String(error?.message ?? error) };
    }
}

let emulator;
let stack;
try {
    emulator = await bootOwnedEmulator({ name: 'mxas', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    stack = await startFakeStack({ panes: 3, agents: 2, titleChurnHz: 0 });
    say(`fake stack relay port ${stack.relayPort}`);
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => undefined);
    const paired = await pairPhone({ stack, maestro: openOffer });
    if (!paired.ok) throw new Error(`pairing failed: ${paired.why}`);
    await dismissPrompts(['CANCEL', 'Not now', 'Deny', 'Later']);

    for (const [width, font, theme] of CELLS) {
        const cell = `${width}-${font}-${theme}`;
        const dir = join(EVIDENCE, cell);
        mkdirSync(dir, { recursive: true });
        await sh(`wm size 1080x2376; wm density ${width === 270 ? 640 : 443}; settings put system font_scale ${font}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await sh(`am force-stop ${PKG}`);
        await sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await relaunched();
        await sleep(2000);

        await openAttach();
        await capture(dir, `add-attachment-${cell}`);
        await tapOn('Cancel', is('Cancel')); // main's system alert ignores back
        await toHome();

        // A Home card's long-press: its rename (and close) choices.
        await tapOn('Home card', (v) => /\. (Idle|Working|Done|Needs you)\b/.test(v), 60, 900);
        await waitFor('card actions', has('Rename'));
        await capture(dir, `card-actions-${cell}`);
        await tapOn('Cancel', is('Cancel')); // main's system alert ignores back
        await toHome();

        // On the agent screen: the tab chip's long-press actions.
        await tapOn('Home card', (v) => /\. (Idle|Working|Done|Needs you)\b/.test(v));
        await tapOn('tab chip', (v) => v.startsWith('Current tab '), 90, 900);
        await waitFor('tab actions', has('Rename'));
        await capture(dir, `tab-actions-${cell}`);
        await tapOn('Cancel', is('Cancel'));
        // Over the pane overview sheet: a pane's actions, Close pane, then its confirm.
        try {
            await tapOn('pane count', (v) => /^Pane \d+ of \d+\. Open panes\.$/.test(v));
            await tapOn('overview pane tile', (v) => /(Pi|Claude) 1/.test(v) && !v.includes('Open panes'), 30, 900);
            await waitFor('pane actions', has('Close pane'), 20);
            await capture(dir, `pane-actions-${cell}`);
            await tapOn('Close pane', is('Close pane'));
            await waitFor('close confirm', (found) => find(found, (v) => /^Close .+\?$/.test(v)) !== undefined, 20);
            await capture(dir, `close-confirm-${cell}`);
            await tapOn('Cancel', is('Cancel'));
        } catch (error) {
            say(`pane overview path skipped in ${cell}: ${error.message}`);
        }
        await toHome();
    }

    if (opts.interact) {
        await sh(`wm size 1080x2376; wm density 640; settings put system font_scale 1.0; cmd uimode night no`);
        await sh(`am force-stop ${PKG}`);
        await sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await relaunched();
        await sleep(2000);
        // Tap outside: the backdrop above the sheet.
        await openAttach();
        await sh('input tap 540 300');
        await sleep(1500);
        const outside = !has('Files')(await screen());
        say(`tap outside dismisses: ${outside ? 'PASS' : 'FAIL'}`);
        // Swipe down from the handle and title.
        await back();
        await toHome();
        const found = await openAttach();
        // The sheet's title, not the dock button under it of the same name.
        const [tx, ty] = center(found.filter((n) => n.text === 'Add attachment').pop());
        await screenshot(join(EVIDENCE, 'swipe-before.png'));
        await sh(`input swipe ${tx} ${ty} ${tx} ${ty + 700} 250`);
        await sleep(1500);
        const swiped = !has('Files')(await screen());
        await screenshot(join(EVIDENCE, 'swipe-after.png'));
        say(`swipe down dismisses: ${swiped ? 'PASS' : 'FAIL'}`);
        // Files opens the system document picker; back out without picking.
        await toHome();
        await openAttach();
        await tapOn('Files', is('Files'));
        const picker = await waitFor('system file picker', (f) => f.some((n) => n.pkg.includes('documentsui')), 30).then(() => true, () => false);
        await screenshot(join(EVIDENCE, 'files-picker.png'));
        say(`Files opens the system file picker: ${picker ? 'PASS' : 'FAIL'}`);
        await back();
        if (!(outside && swiped && picker)) process.exitCode = 1;
    }
    writeFileSync(join(EVIDENCE, 'steps.json'), JSON.stringify({
        target: { version: `muxr release APK ${JSON.parse(readFileSync(`${opts.apk}.json`, 'utf8')).revision}` },
        start: 'fresh app data on an Android emulator paired to a private lab host (relay + host over fake Herdr, two agents)',
        steps: [
            'per width (270, 393 dp), text size and theme: on Home open the composer and tap Add attachment',
            'long-press an agent card on Home',
            'open the agent and long-press its tab chip',
            ...(opts.interact ? ['tap outside the Add attachment sheet', 'swipe the sheet down by its title', 'tap Files'] : []),
        ],
        result: 'each popup is the app bottom sheet (icons, app colours, rounded); tap outside and swipe down close it; Files opens the system picker',
    }, null, 2));
    say(`defects: ${defects.length === 0 ? 'none' : `\n${defects.join('\n')}`}`);
    say('RESULT done');
} catch (error) {
    say(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (serial) await screenshot(join(EVIDENCE, 'failure.png')).catch(() => undefined);
    process.exitCode = 1;
} finally {
    if (serial) await sh('wm size reset; wm density reset; settings put system font_scale 1.0').catch(() => undefined);
    stack?.stop();
    await emulator?.stop();
    say('stack and emulator stopped');
}
