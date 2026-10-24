// Every pane menu row is reachable on a small phone (see pane-menu.md). Boots a
// task-owned emulator, pairs the release APK to the perf fake stack and, per
// cell (270 and 393 dp, font 1.0 and 2.0, dark and light), opens an agent's
// terminal, opens Pane actions, shoots the menu at rest and scrolled to its end
// through visualCheck.mjs, then scrolls Usage into the menu's view, taps it and
// waits for the Usage screen. With main's evidence folder, a visual lead main's
// run of the same cell does not have is a defect. Exits non-zero on any defect.
// Run from the repo root, inside the emulator lock:
//   node .agents/skills/done-done-verify-pockit/features/paneMenuLab.mjs <apk> <evidenceDir> <avdHome> [main evidenceDir]
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';
import { pairPhone } from '../../../../perf/lib/pairPhone.mjs';

const [apk, evidenceArg, avdHome, refArg] = process.argv.slice(2);
if (!apk || !evidenceArg || !avdHome) throw new Error('usage: paneMenuLab.mjs <apk> <evidenceDir> <avdHome> [main evidenceDir]');
const REF = refArg ? join(resolve(refArg), 'native') : undefined;
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(evidenceArg);
const SHOTS = join(EVIDENCE, 'native');
const CHECK = resolve('.agents/skills/done-done-verify-pockit/features/visualCheck.mjs');
// 1080 px at density 640 is the reference phone's 270 dp; 440 is a 393 dp phone.
const DENSITY = { 270: 640, 393: 440 };
mkdirSync(SHOTS, { recursive: true });
const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (line) => { const out = `${new Date().toISOString()} ${line}`; console.log(out); appendFileSync(join(EVIDENCE, 'journey.log'), `${out}\n`); };
let serial = '';
const adb = async (args, timeout = 60_000) => (await exec('adb', ['-s', serial, ...args], { timeout, maxBuffer: 64 << 20 })).stdout;
const sh = (cmd) => adb(['shell', cmd]);
const screenshot = async (path) => writeFileSync(path, (await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 << 20, timeout: 30_000 })).stdout);

// Each node, with the box of the nearest scroller around it. uiautomator clips a
// row its list cuts to the sliver still shown and leaves out a row wholly out of view.
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
function nodes(xml) {
    const found = [];
    const open = [];
    for (const [tag] of xml.matchAll(/<node\s[^>]*>|<\/node>/g)) {
        if (tag === '</node>') { open.pop(); continue; }
        const get = (key) => unescape(tag.match(new RegExp(` ${key}="([^"]*)"`))?.[1] ?? '');
        const box = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
        found.push({ text: get('text'), desc: get('content-desc'), selected: get('selected') === 'true', box, scroller: open.findLast(Boolean) });
        if (!tag.endsWith('/>')) open.push(get('scrollable') === 'true' ? box : undefined);
    }
    return found;
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
const find = (found, test) => found.find((n) => test(n.text) || test(n.desc));
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
async function tapOn(what, test, seconds = 60) {
    const node = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test);
    say(`tap ${what}`);
    await sh(`input tap ${center(node).join(' ')}`);
    await sleep(1500);
}
// A drag that always moves: `input swipe` sends no move when the app is slow to
// take its down, and a down then an up far away is a tap wherever it lands.
const drag = (x, from, to) => sh([`input motionevent DOWN ${x} ${from}`,
    ...[1, 2, 3].map((step) => `input motionevent MOVE ${x} ${Math.round(from + ((to - from) * step) / 3)}`), `input motionevent UP ${x} ${to}`].join('; '));
// The menu's list: the tall scroller around any of its rows still in the dump
// (the tab row under the terminal is a short one, with its own New tab).
const MENU_ROW = /^(Review changes|Changes|Find in output|Select text|Computers|Conversation history|Files|Git history|Prompt attachments|Shared Artifacts|Usage|Rename agent|Rename tab|New tab|New pane to the right|New pane below|Focus in Herdr|Talk to this session|Terminal controls)\b/;
const tall = (box) => box !== undefined && box[3] - box[1] > (box[2] - box[0]) / 2;
const menuList = (found) => found.find((n) => tall(n.scroller) && (MENU_ROW.test(n.text) || MENU_ROW.test(n.desc)))?.scroller;
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

// Always Claude 1, so every cell (and main's run of it) shows the same agent's menu.
// A relaunch can restore the agent it left, or open on Home, where its card opens it.
const AGENT = /Claude 1/;
async function openTerminal() {
    await sh(`am force-stop ${PKG}`);
    await sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const found = await screen();
        const menu = find(found, (v) => /^Pane actions/.test(v));
        if (menu !== undefined && find(found, (v) => /Open panes$/.test(v) && AGENT.test(v)) === undefined) await back();
        else if (menu !== undefined) {
            const terminal = find(found, is('Terminal view'));
            if (terminal !== undefined && !terminal.selected) await sh(`input tap ${center(terminal).join(' ')}`);
            await sleep(2500);
            // A tap that landed on the composer while the screen settled leaves the keyboard up.
            if ((await sh('dumpsys input_method | grep -q mInputShown=true && echo shown || echo hidden')).trim() === 'shown') await back();
            return;
        } else {
            const card = find(found, (v) => /\. (Idle|Working|Done|Needs you)\b/.test(v) && AGENT.test(v));
            if (card !== undefined) await sh(`input tap ${center(card).join(' ')}`);
        }
        await sleep(2000);
    }
    await waitFor('Claude 1', (found) => find(found, (v) => /^Pane actions/.test(v)) !== undefined, 5);
}
// A tap on ⋮ while the screen settles can go unanswered: tap until the menu shows.
async function openMenu() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await tapOn('Pane actions', (v) => /^Pane actions/.test(v), 30);
        if (await waitFor('the pane menu', (found) => menuList(found) !== undefined, 10).then(() => true, () => false)) return;
    }
    await waitFor('the pane menu', (found) => menuList(found) !== undefined, 10);
}

const defects = [];
const results = [];
function check(name, ...flags) {
    return exec(process.execPath, [CHECK, serial, SHOTS, name, ...flags], { timeout: 180_000, maxBuffer: 16 << 20 })
        .then((r) => r.stdout, (e) => `${e.stdout ?? ''}${e.stderr ?? ''}`)
        .then((out) => {
            writeFileSync(join(SHOTS, `${name}.check.txt`), out);
            // The open menu and its backdrop (Close pane actions) cover the agent's screen on purpose,
            // so most leads are that screen under them: a lead is a defect only when main's run of
            // the same cell does not have it. Without that run, this is main's run: it records.
            // Leads are compared without bounds or the lab's random folder name, which differ by run.
            const plain = (row) => row.replace(/\[\d+,\d+\]\[\d+,\d+\]/g, '[]').replace(/ painted as "[^"]*"/, '').replace(/muxr-perf-\w+/g, 'muxr-perf-');
            // The header's folder line is the fake stack's own /tmp folder, cut by design and read
            // differently by OCR each run: lab data, not this menu.
            const leads = out.split('\n').filter((row) => row.startsWith('DEFECT') && !/ellipsis cuts the text: "\/tmp\/muxr-perf-/.test(row));
            const main = REF === undefined ? undefined : new Set(readFileSync(join(REF, `${name}.check.txt`), 'utf8').split('\n').map(plain));
            const fresh = main === undefined ? [] : leads.filter((row) => !main.has(plain(row)));
            for (const lead of fresh) defects.push(`${name}: ${lead}`);
            say(`shot ${name}: ${leads.length} leads${main === undefined ? ' (main, recorded)' : `, ${fresh.length} not on main${fresh.length === 0 ? '' : `: ${fresh.join(' | ')}`}`}`);
        });
}

let emulator;
let stack;
try {
    emulator = await bootOwnedEmulator({ name: 'mxpanemenu', avdHome: resolve(avdHome), memoryMb: 4096, bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    // A reused AVD keeps the last run's display and text size; pair at the defaults.
    await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no; settings put global heads_up_notifications_enabled 0');
    stack = await startFakeStack({ panes: 2, agents: 2, titleChurnHz: 0 });
    say(`fake stack relay port ${stack.relayPort}`);
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', apk], 600_000);
    await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => undefined);
    const paired = await pairPhone({ stack, maestro: openOffer });
    if (!paired.ok) throw new Error(`pairing failed: ${paired.why}`);
    await dismissPrompts(['CANCEL', 'Not now', 'Deny', 'Later']);
    say('paired');

    for (const width of [270, 393]) for (const font of ['1.0', '2.0']) for (const theme of ['dark', 'light']) {
        const name = `menu-${width}-${font}-${theme}`;
        await sh(`wm size 1080x2376; wm density ${DENSITY[width]}; settings put system font_scale ${font}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await openTerminal();
        await openMenu();
        await sleep(1500);
        await check(name);
        // Scrolled to its end: drag the list until its rows stop moving.
        let before = '';
        for (let flick = 0; flick < 10; flick += 1) {
            const found = await screen();
            const list = menuList(found);
            const now = found.filter((n) => n.scroller === list).map((n) => n.box.join(',')).join(' ');
            if (list === undefined || now === before) break;
            before = now;
            const [left, top, right, bottom] = list;
            await drag((left + right) >> 1, Math.round(top + (bottom - top) * 0.8), Math.round(top + (bottom - top) * 0.2));
            await sleep(1200);
        }
        await check(`${name}-scrolled`, '--end');
        // From the top again, reach Usage the way a person does: scroll its row into the list's view, tap it.
        await back();
        await openMenu();
        let opened = false;
        let held;
        for (let step = 0; step < 12; step += 1) {
            const found = await screen();
            // A row wholly out of the list's view is not in the dump at all.
            const usage = find(found, is('Usage'));
            const list = usage?.scroller ?? menuList(found);
            if (list === undefined) throw new Error(`${name}: the pane menu closed`);
            const [left, top, right, bottom] = list;
            // A row touching the list's edge is cut there (at 270 dp main can show 1.5 dp of Usage),
            // and a list still moving takes a tap as a stop: tap once the whole row held still.
            const shown = usage !== undefined && usage.box[1] > top && usage.box[3] < bottom;
            say(`${name}: Usage ${usage === undefined ? 'not in the dump' : `at y ${usage.box[1]}-${usage.box[3]}`}, list ${top}-${bottom}`);
            if (shown) {
                if (String(usage.box) !== held) { held = String(usage.box); await sleep(1000); continue; }
                await sh(`input tap ${center(usage).join(' ')}`);
                opened = await waitFor('Usage', (now) => has('Usage')(now) && find(now, is('Find in output')) === undefined && find(now, is('Terminal surface')) === undefined, 20).then(() => true, () => false);
                break;
            }
            // Short drags, the way the row lies: a long one flings the list past it.
            const [from, to] = usage !== undefined && usage.box[1] <= top ? [0.4, 0.6] : [0.6, 0.4];
            await drag((left + right) >> 1, Math.round(top + (bottom - top) * from), Math.round(top + (bottom - top) * to));
            await sleep(1500);
        }
        if (opened) await screenshot(join(SHOTS, `usage-from-${name}.png`));
        const verdict = opened ? `${name}: Usage opened from the pane menu` : `DEFECT ${name}: tapping Usage in the pane menu never opened Usage`;
        if (!opened) defects.push(verdict);
        results.push(verdict);
        say(verdict);
        await back();
    }
    say(`defects: ${defects.length === 0 ? 'none' : `\n${defects.join('\n')}`}`);
    writeFileSync(join(EVIDENCE, 'steps.json'), `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'the release APK freshly installed and paired to a private fake stack with two agents',
        steps: ['open an agent in terminal view at 270 and 393 dp, font 1.0 and 2.0, dark and light', 'open Pane actions', 'scroll the menu to its end', 'open Pane actions again, scroll Usage into view and tap it'],
        result: defects.length === 0 ? `in all ${results.length} cells Usage opened from the pane menu, and no shot showed a defect` : defects.join('; '),
    }, null, 2)}\n`);
} finally {
    try { await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no'); } catch { /* emulator gone */ }
    stack?.stop();
    try { await adb(['emu', 'kill']); } catch { /* already gone */ }
    await emulator?.stop();
    process.exitCode = defects.length > 0 ? 1 : process.exitCode;
}
