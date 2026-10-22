// The terminal key row and the quick-actions control's touch targets (see
// terminal-key-targets.md). Boots a task-owned emulator, pairs a release APK to the perf
// fake stack (three tabs, so the tabs row shows), and per cell (width, font, theme) opens
// an agent and captures the terminal screen, then measures every key, the quick-actions
// control and the tabs beside it from the accessibility dump, in dp. Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/keyRowLab.mjs --apk <apk> --evidence <dir> \
//     --avd-home <dir> [--ref <main evidence dir>]
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dismissPrompts, dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';
import { startFakeStack } from '../../../../perf/lib/fakeStack.mjs';
import { pairPhone } from '../../../../perf/lib/pairPhone.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' }, ref: { type: 'string' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home']) throw new Error('--apk, --evidence and --avd-home are required');
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
const CHECK = resolve('.agents/skills/done-done-verify-pockit/features/visualCheck.mjs');
// 1080 px at density 443 is a 390 dp phone; 640 is the reference phone's 270 dp.
const CELLS = [[390, '1.0', 'light'], [390, '1.0', 'dark'], [270, '1.0', 'light'], [270, '1.0', 'dark'], [270, '2.0', 'dark']];
const DENSITY = { 390: 443, 270: 640 };
const TARGET_DP = 48;
const CLEAR_DP = 8;
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
        return { text: get('text'), desc: get('content-desc'), clickable: get('clickable') === 'true', box };
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
    // Tap only once the target holds still across two reads: screens re-lay out as data loads.
    let node = find(await waitFor(what, (found) => find(found, test) !== undefined, seconds), test);
    for (let i = 0; i < 10; i += 1) {
        await sleep(1000);
        const again = find(await screen(), test);
        if (again !== undefined && String(again.box) === String(node.box)) break;
        node = again ?? node;
    }
    say(`tap ${what}`);
    await sh(`input tap ${center(node).join(' ')}`);
}
const atHome = (found) => has('connected')(found) && has('Plan, ask, build…')(found);
async function back() { await sh('input keyevent KEYCODE_BACK'); await sleep(1200); }
async function toHome() {
    for (let i = 0; i < 4; i += 1) {
        if (atHome(await screen())) return;
        await back();
    }
    await waitFor('connected Home', atHome, 30);
}

const defects = [];
// The Visual check's own leads, judged by eye and against main's run (`--ref`), never
// this journey's verdict. The quick-actions target reaching over the terminal's last line
// shows up here as "a control is covered" by design (terminal-key-targets.md).
const leads = [];
async function capture(dir, name) {
    await sleep(3000);
    const args = [CHECK, serial, dir, name];
    if (opts.ref) args.push('--ref', join(resolve(opts.ref), dir.slice(EVIDENCE.length + 1), `${name}.xml`));
    const run = await exec(process.execPath, args, { timeout: 180_000, maxBuffer: 16 << 20 }).then((r) => ({ out: r.stdout }), (e) => ({ out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const lines = run.out.split('\n').filter((line) => line.startsWith('DEFECT'));
    for (const line of lines) leads.push(`${name}: ${line}`);
    say(`shot ${name}: ${lines.length === 0 ? 'clean' : lines.join(' | ')}`);
}

// The row's keys, the control and the tabs beside it, in dp, from the dump. A key is a
// clickable node level with Control and whole on screen (one cut by the screen edge reports
// only its visible part); the tabs row is everything level with the control's target.
function measure(found, density) {
    const dp = (px) => Math.round((px * 160 / density) * 10) / 10;
    const size = (n) => ({ label: n.desc || n.text, left: dp(n.box[0]), right: dp(n.box[2]), width: dp(n.box[2] - n.box[0]), height: dp(n.box[3] - n.box[1]) });
    const ctrl = find(found, (v) => /^Control(, locked)?$/.test(v));
    const control = find(found, is('Terminal quick actions'));
    if (ctrl === undefined) throw new Error('the key row is not on screen');
    const keys = found.filter((n) => n.clickable && n.desc !== '' && n.box[1] === ctrl.box[1] && n.box[2] < 1078 && n.box[2] > n.box[0]).sort((a, b) => a.box[0] - b.box[0]);
    const gaps = keys.slice(1).map((n, i) => dp(n.box[0] - keys[i].box[2]));
    const tabs = control === undefined ? [] : found.filter((n) => /^(Current tab|Open tab|New tab|Jump to latest output)/.test(n.desc)
        && n.box[3] > control.box[1] && n.box[1] < control.box[3] && n.box[2] > n.box[0]);
    const nearestTab = tabs.sort((a, b) => b.box[2] - a.box[2])[0];
    return {
        keys: keys.map(size),
        keyGaps: gaps,
        control: control === undefined ? null : size(control),
        nearestTab: nearestTab === undefined ? null : size(nearestTab),
        controlClearance: control === undefined || nearestTab === undefined ? null : dp(control.box[0] - nearestTab.box[2]),
    };
}
function judge(cell, m) {
    // One px of rounding either way: 48dp at density 443 is 132.9 px.
    const short = (v) => v < TARGET_DP - 0.5;
    for (const key of m.keys) {
        if (short(key.width) || short(key.height)) defects.push(`${cell}: key ${key.label} target ${key.width}x${key.height}dp, under ${TARGET_DP}dp`);
    }
    for (const [i, gap] of m.keyGaps.entries()) if (gap < 0) defects.push(`${cell}: keys ${m.keys[i].label} and ${m.keys[i + 1].label} overlap by ${-gap}dp`);
    if (m.control === null) defects.push(`${cell}: no quick-actions control`);
    else if (short(m.control.width) || short(m.control.height)) defects.push(`${cell}: quick-actions control ${m.control.width}x${m.control.height}dp, under ${TARGET_DP}dp`);
    if (m.controlClearance !== null && m.controlClearance < CLEAR_DP - 0.5) defects.push(`${cell}: quick-actions control ${m.controlClearance}dp from ${m.nearestTab.label}, under ${CLEAR_DP}dp`);
}

let emulator;
let stack;
const metrics = {};
try {
    emulator = await bootOwnedEmulator({ name: 'mxkr', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no');
    stack = await startFakeStack({ panes: 9, agents: 6, titleChurnHz: 0 });
    say(`fake stack relay port ${stack.relayPort}`);
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    await sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`).catch(() => undefined);
    const paired = await pairPhone({ stack, maestro: async (_flow, { PAIR_CODE }) => {
        try {
            await sh(`am start -a android.intent.action.VIEW -d 'muxr://pair#${PAIR_CODE}' ${PKG}`);
            await tapOn('Pair', is('Pair'), 60);
            await waitFor('connected after Pair', has('connected'), 120);
            return { code: 0, output: 'paired through the consent card' };
        } catch (error) {
            return { code: 1, output: String(error?.message ?? error) };
        }
    } });
    if (!paired.ok) throw new Error(`pairing failed: ${paired.why}`);
    await dismissPrompts(['CANCEL', 'Not now', 'Deny', 'Later']);

    for (const [width, font, theme] of CELLS) {
        const cell = `${width}-${font}-${theme}`;
        const dir = join(EVIDENCE, cell);
        mkdirSync(dir, { recursive: true });
        await sh(`wm size 1080x2376; wm density ${DENSITY[width]}; settings put system font_scale ${font}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await sh(`am force-stop ${PKG}`);
        await sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await waitFor('the app', (found) => has('connected')(found) || has('Back')(found), 120);
        await toHome();
        await sleep(2000);

        await tapOn('Home card', (v) => /\. (Idle|Working|Done|Needs you)\b/.test(v));
        await waitFor('key row', (found) => find(found, (v) => /^Control/.test(v)) !== undefined, 60);
        await capture(dir, `terminal-${cell}`);
        metrics[cell] = measure(await screen(), DENSITY[width]);
        judge(cell, metrics[cell]);
        say(`measured ${cell}: keys ${metrics[cell].keys.map((k) => `${k.label} ${k.width}x${k.height}`).join(', ')}; control ${JSON.stringify(metrics[cell].control)}; clearance ${metrics[cell].controlClearance}dp`);
        if (cell === '390-1.0-dark') {
            // Control twice locks it: the pill an armed modifier wears, inside its target.
            await tapOn('Control', (v) => v === 'Control');
            await tapOn('Control', (v) => v === 'Control');
            await waitFor('Control locked', has('Control, locked'), 10);
            await capture(dir, `terminal-ctrl-locked-${cell}`);
            await tapOn('Control', is('Control, locked'));
            // The control still opens the ring from its new target.
            await tapOn('quick actions', is('Terminal quick actions'));
            await waitFor('ring open', has('Close terminal quick actions'), 10);
            await capture(dir, `terminal-ring-${cell}`);
            await back();
        }
        await toHome();
    }
    writeFileSync(join(EVIDENCE, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
    say(`visual check leads: ${leads.length === 0 ? 'none' : `\n${leads.join('\n')}`}`);
    say(`defects: ${defects.length === 0 ? 'none' : `\n${defects.join('\n')}`}`);
    writeFileSync(join(EVIDENCE, 'steps.json'), `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'release APK freshly installed and paired to a private stack whose workspace has three tabs',
        steps: ['open an agent from Home', 'read every key row target and the quick-actions control from the accessibility dump', 'lock Control and open the quick-actions ring at 390 dp dark', 'repeat at 390 and 270 dp wide, light and dark, and at 2x text'],
        result: 'every key and the quick-actions control is a 48 dp target, and the control sits clear of the tabs',
    }, null, 2)}\n`);
    say(defects.length === 0 ? 'RESULT done' : 'RESULT FAIL: defects above');
    if (defects.length > 0) process.exitCode = 1;
} catch (error) {
    say(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (serial) await screenshot(join(EVIDENCE, 'failure.png')).catch(() => undefined);
    writeFileSync(join(EVIDENCE, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
    process.exitCode = 1;
} finally {
    if (serial) await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no').catch(() => undefined);
    stack?.stop();
    await emulator?.stop();
    say('stack and emulator stopped');
}
