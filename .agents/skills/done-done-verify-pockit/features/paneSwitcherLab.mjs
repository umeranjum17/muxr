// The pane switcher (see pane-switcher.md). Boots a task-owned emulator, pairs a release
// APK to the perf fake stack (three tabs: four panes, four panes, one), gives every pane
// a few lines of real shell output, and per cell (width, font, theme) opens an agent,
// opens the switcher from the header's pane counter and captures it, then the
// one-pane tab. Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/paneSwitcherLab.mjs --apk <apk> --evidence <dir> \
//     --avd-home <dir> [--ref <main evidence dir>]
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
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
const CELLS = [[390, '1.0', 'light'], [390, '1.0', 'dark'], [270, '1.0', 'dark'], [270, '2.0', 'light']];
const DENSITY = { 390: 443, 270: 640 };
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
        return { text: get('text'), desc: get('content-desc'), box };
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
async function capture(dir, name) {
    await sleep(4000); // the sheet's slide-in settles and the previews answer their first read
    const args = [CHECK, serial, dir, name];
    if (opts.ref) args.push('--ref', join(resolve(opts.ref), dir.slice(EVIDENCE.length + 1), `${name}.xml`));
    const run = await exec(process.execPath, args, { timeout: 180_000, maxBuffer: 16 << 20 }).then((r) => ({ out: r.stdout }), (e) => ({ out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const lines = run.out.split('\n').filter((line) => line.startsWith('DEFECT'));
    for (const line of lines) defects.push(`${name}: ${line}`);
    say(`shot ${name}: ${lines.length === 0 ? 'clean' : lines.join(' | ')}`);
}

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

// One request on the fake Herdr's own socket, the way the host talks to it.
function herdr(socketPath, method, params) {
    return new Promise((done, fail) => {
        const socket = createConnection(socketPath);
        let buffered = '';
        socket.on('error', fail);
        socket.on('connect', () => socket.write(`${JSON.stringify({ id: '1', method, params })}\n`));
        socket.on('data', (chunk) => {
            buffered += String(chunk);
            if (!buffered.includes('\n')) return;
            socket.destroy();
            done(JSON.parse(buffered.slice(0, buffered.indexOf('\n'))));
        });
    });
}

// What each pane prints, so a preview has a screen to show: plain demo work, no paths or ids.
const SCRIPT = [
    'Reading the brief for Umer',
    '  checked 12 files, 3 need changes',
    'Running the tests',
    '  PASS 41  FAIL 0',
    'Writing the summary',
    'Done. Waiting for the next step.',
];

let emulator;
let stack;
try {
    emulator = await bootOwnedEmulator({ name: 'mxts', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    // A reused AVD keeps the last run's display and text size; pair at the defaults.
    await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no');
    stack = await startFakeStack({ panes: 9, agents: 6, titleChurnHz: 0 });
    say(`fake stack relay port ${stack.relayPort}`);
    const socketPath = join(stack.root, 'herdr', 'herdr.sock');
    for (const pane of stack.world.panes) {
        await herdr(socketPath, 'pane.send_text', { pane_id: pane.pane_id, text: `${SCRIPT.map((line) => `echo '${line}'`).join('; ')}\n` });
    }
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
        await sh(`wm size 1080x2376; wm density ${DENSITY[width]}; settings put system font_scale ${font}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await sh(`am force-stop ${PKG}`);
        await sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        // A relaunch can restore the agent screen it left; back out to Home from there.
        await waitFor('the app', (found) => has('connected')(found) || has('Back')(found), 120);
        await toHome();
        await sleep(2000);

        await tapOn('Home card', (v) => /\. (Idle|Working|Done|Needs you)\b/.test(v));
        await tapOn('pane count', (v) => /^Pane \d+ of \d+\. Open panes\.$/.test(v), 90);
        await waitFor('switcher', has('Done'), 20);
        await capture(dir, `switcher-${cell}`);
        // The one-pane tab: the case the captain saw as one huge empty card.
        await tapOn('third tab', (v) => /^(Tab 3|shell), 1 pane/.test(v), 20);
        await capture(dir, `switcher-one-pane-${cell}`);
        await toHome();
    }
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
