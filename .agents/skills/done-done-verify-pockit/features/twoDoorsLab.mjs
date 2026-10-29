// The two-door first run (two-doors-first-run.md): the release app on a task-owned emulator.
// Frames: per cell (360, 390 and 445 dp at text 1.0, 270 dp at text 2.0; light and
// dark) the doors, My computer's Get ready and Pair, and the Boat door's account
// step up to its sign-in gate, each at rest and scrolled, through visualCheck;
// then the doors and the Boat account step on a 1280 dp tablet.
// Then the timed run: a clean install, My computer through Pair (the pairing code
// typed into Private link or pairing code), Pair, Start on Home, and a prompt the
// agent in its terminal answers, read back from the lab Herdr pane. The computer is
// a lab host on an isolated Herdr lab session with a `claude` stand-in, so the
// computer-side installs (Tailscale, muxr) are already done there and not timed.
// --part keeps one emulator hold short: a comma list of widths (360,390,445,270),
// tablet, or timed; without it every part runs. Run from the repo root with
// HERDR_LAB_HELPER set, under the emulator lock:
//   node .agents/skills/done-done-verify-pockit/features/twoDoorsLab.mjs --apk <apk> --evidence <dir> \
//     --avd-home <dir> --root <short lab dir> [--part <parts>]
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';
import { linkHerdrLab } from '../../../../scripts/diagnostics/application/linkHerdrLab.mjs';

const { values: opts } = parseArgs({ options: {
    apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' }, root: { type: 'string' }, part: { type: 'string', default: '360,390,445,270,tablet,timed' },
} });
if (!opts.apk || !opts.evidence || !opts['avd-home'] || (!opts.root && opts.part.includes('timed'))) throw new Error('--apk, --evidence, --avd-home and --root are required');
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
const ROOT = resolve(opts.root ?? '.');
const PARTS = new Set(opts.part.split(','));
const CHECK = resolve('.agents/skills/done-done-verify-pockit/features/visualCheck.mjs');
// 1080 px wide: density 480 is 360 dp, 443 is 390 dp, 388 is 445 dp, 640 the reference phone's 270 dp.
const DENSITY = { 360: 480, 390: 443, 445: 388, 270: 640 };
const CELLS = [['360', '1.0'], ['390', '1.0'], ['445', '1.0'], ['270', '2.0']].filter(([w]) => PARTS.has(w)).flatMap(([w, f]) => ['light', 'dark'].map((t) => [w, f, t]));
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
        return { text: get('text'), desc: get('content-desc'), box };
    });
}
async function screen() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const xml = await dumpUiXml(30_000);
        if (xml !== '') {
            const found = nodes(xml);
            // A slow emulator raises "isn't responding" over everything; Wait keeps going.
            const wait = found.find((n) => n.text === 'Wait');
            if (found.some((n) => n.text.endsWith("isn't responding")) && wait) {
                await sh(`input tap ${center(wait).join(' ')}`);
                await sleep(2000);
                continue;
            }
            // Android asks for notifications on first open; a person answers Allow.
            const allow = found.find((n) => n.text === 'Allow');
            if (found.some((n) => /to send you notifications/.test(n.text)) && allow) {
                await sh(`input tap ${center(allow).join(' ')}`);
                await sleep(1000);
                continue;
            }
            return found;
        }
        await sleep(1500);
    }
    return [];
}
const find = (found, test) => found.find((n) => test(n.text) || test(n.desc));
const center = ({ box: [l, t, r, b] }) => [Math.round((l + r) / 2), Math.round((t + b) / 2)];
async function waitFor(what, test, seconds = 60) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        const found = await screen();
        if (test(found)) return found;
        await sleep(700);
    }
    const stem = join(EVIDENCE, `missing-${what.replace(/\W+/g, '-')}`);
    await screenshot(`${stem}.png`).catch((error) => say(`screenshot failed: ${error.message}`));
    writeFileSync(`${stem}.txt`, (await screen()).filter((n) => n.text || n.desc).map((n) => `${n.text} | ${n.desc} | ${n.box}`).join('\n'));
    throw new Error(`${what} never appeared within ${seconds}s`);
}
const shows = (test) => (found) => find(found, test) !== undefined;
async function tapOn(what, test, seconds = 60) {
    const node = find(await waitFor(what, shows(test), seconds), test);
    say(`tap ${what}`);
    await sh(`input tap ${center(node).join(' ')}`);
}
// A stepped drag scrolls; a slow `input swipe` reads as a long press.
const drag = (from, to) => sh(`input motionevent DOWN 540 ${from}; y=${from}; while [ $y -gt ${to} ]; do y=$((y-40)); input motionevent MOVE 540 $y; done; input motionevent UP 540 ${to}`);
// A narrow window can leave a door below the fold.
async function scrollUntil(what, test) {
    for (let i = 0; i < 6 && !shows(test)(await screen()); i += 1) {
        await drag(1900, 900);
        await sleep(1200);
    }
    await tapOn(what, test);
}
async function scrollToEnd() {
    let last = '';
    for (let i = 0; i < 8; i += 1) {
        const now = JSON.stringify((await screen()).map((n) => n.box));
        if (now === last) return;
        last = now;
        await drag(1900, 500);
        await sleep(1200);
    }
}
const doors = (v) => v === 'Connect a machine';
const myComputer = (v) => v === 'My computer' || v.startsWith('My computer. ');
const cloud = (v) => v.startsWith('Cloud machine · Boat. ');

const leads = [];
async function capture(dir, name, end = false) {
    await sleep(2500);
    const args = [CHECK, serial, dir, name];
    if (end) args.push('--end');
    const run = await exec(process.execPath, args, { timeout: 180_000, maxBuffer: 16 << 20 }).then((r) => ({ out: r.stdout }), (e) => ({ out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const lines = run.out.split('\n').filter((line) => line.startsWith('DEFECT'));
    for (const line of lines) leads.push(`${name}: ${line}`);
    say(`shot ${name}: ${lines.length === 0 ? 'clean' : lines.join(' | ')}`);
}
async function both(dir, name) {
    await capture(dir, name);
    await scrollToEnd();
    await capture(dir, `${name}-scrolled`, true);
}
async function launchFresh() {
    await sh(`am force-stop ${PKG}; pm clear ${PKG}`);
    await sh(`am start -W -n ${PKG}/.MainActivity`);
    await waitFor('the two doors', shows(doors), 120);
}

// What the person types: the computer's pairing code, minted the way `muxr link` mints one.
let offering;
const mintNativePairing = (path) => new Promise((done, fail) => {
    const socket = offering = createConnection(path);
    let pending = '';
    socket.on('error', fail);
    socket.on('connect', () => socket.write('{"intent":{"kind":"native","authority":"control","personal":false}}\n'));
    socket.on('data', (chunk) => {
        pending += String(chunk);
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const event = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            if (event.offer) done(event.offer.text);
            // Approving on the computer, once its two words match the phone's.
            if (event.approval) socket.write('{"yes":true}\n');
            if (event.error) fail(new Error(event.error));
        }
    });
});

// The coding agent on the lab computer: signed in, and it answers each line it is sent.
const STAND_IN = `#!/bin/sh
if [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","email":"lab@example.com","subscriptionType":"max"}'; exit 0; fi
if [ "$1" = --version ]; then echo '2.1.0 (Claude Code)'; exit 0; fi
printf '\\033]2;%s\\007' 'Lab agent'
echo 'Lab agent ready. Send a prompt.'
while IFS= read -r line; do echo "lab agent heard: $line"; done
`;

let emulator;
let lab;
const timing = { steps: [] };
async function timedRun() {
    // The timed run, on a 390 dp phone at text 1.0, light.
    mkdirSync(join(ROOT, 'lab'), { recursive: true });
    await sh(`wm size 1080x2376; wm density ${DENSITY[390]}; settings put system font_scale 1.0; cmd uimode night no`);
    const bin = join(ROOT, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), STAND_IN, { mode: 0o755 });
    // The lab host and its Herdr panes find the stand-in first; nothing reaches a real sign-in.
    for (const key of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC|CODEX|OPENAI)/.test(key)) delete process.env[key];
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.MUXR_LAB_MACHINE_NAME = 'Lab computer';
    lab = await linkHerdrLab(join(ROOT, 'lab'), 'twodoors', undefined, undefined, { PATH: process.env.PATH });
    say(`lab host up: relay port ${lab.port}, herdr session ${lab.session}`);
    await adb(['reverse', `tcp:${lab.port}`, `tcp:${lab.port}`]);
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    const installAt = Date.now();
    await adb(['install', opts.apk], 300_000);
    timing.installMs = Date.now() - installAt;
    say(`clean install in ${timing.installMs} ms`);

    const dir = join(EVIDENCE, 'timed-mycomputer');
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    let last = t0;
    let index = 0;
    const step = async (name) => {
        const now = Date.now();
        timing.steps.push({ step: name, ms: now - last, atMs: now - t0 });
        last = now;
        index += 1;
        await screenshot(join(dir, `${String(index).padStart(2, '0')}-${name.replace(/\W+/g, '-').toLowerCase()}.png`));
        say(`step ${name}: ${(timing.steps.at(-1).ms / 1000).toFixed(1)} s (at ${((now - t0) / 1000).toFixed(1)} s)`);
    };
    await sh(`am start -W -n ${PKG}/.MainActivity`);
    await waitFor('the two doors', shows(doors), 120);
    await step('open the app on the two doors');
    await tapOn('My computer', myComputer);
    await waitFor('Get ready', shows((v) => v === 'Get ready'));
    await step('My computer door to Get ready');
    await tapOn('Next: pair', (v) => v === 'Next: pair');
    const field = (v) => v === 'Private link or pairing code';
    await waitFor('the pairing field', shows(field));
    await step('Next: pair to Pair with your computer');
    const code = await mintNativePairing(join(ROOT, 'lab', 'host', 'pair.sock'));
    // A person pastes the code; the lab types it, in chunks a busy emulator keeps, and reads the field back.
    const typedAt = Date.now();
    for (let attempt = 0; ; attempt += 1) {
        const input = (await screen()).find((n) => n.desc === 'Private link or pairing code' && n.text !== 'Private link or pairing code');
        await sh(`input tap ${center(input).join(' ')}`);
        await sleep(500);
        await sh(`input keyevent KEYCODE_MOVE_END ${'KEYCODE_DEL '.repeat(code.length + 10)}`);
        for (const chunk of code.match(/.{1,12}/g)) await sh(`input text '${chunk}'`);
        if (find(await screen(), (v) => v === code)) break;
        if (attempt === 2) throw new Error('the pairing field never held the whole code');
        say('the pairing field lost keys; typing it again');
    }
    timing.typingMs = Date.now() - typedAt;
    await sh('input keyevent KEYCODE_BACK');
    await tapOn('Connect', (v) => v === 'Connect');
    await waitFor('the Pair button', shows((v) => v === 'Pair'), 90);
    await step('paste the pairing code and Connect to the review');
    await tapOn('Pair', (v) => v === 'Pair');
    await waitFor('Start Claude Code on Home', shows((v) => v === 'Start Claude Code'), 180);
    await step('Pair to Home, Step 3 of 3, Start Claude Code');
    await tapOn('Start Claude Code', (v) => v === 'Start Claude Code');
    await waitFor('the agent composer', shows((v) => v.startsWith('Prompt')), 180);
    await step('Start Claude Code to the agent terminal');
    const composer = find(await screen(), (v) => v.startsWith('Prompt'));
    await sh(`input tap ${center(composer).join(' ')}`);
    await sleep(800);
    // One short word: a busy emulator drops keys from a longer `input text`.
    await sh("input text 'hello'");
    const send = find(await screen(), (v) => /^Send/.test(v));
    if (send) await sh(`input tap ${center(send).join(' ')}`);
    else await sh('input keyevent KEYCODE_ENTER');
    // The answer is drawn in the native terminal; Herdr's pane is where it is read.
    let paneText = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !paneText.includes('lab agent heard: hello')) {
        await sleep(1000);
        paneText = JSON.parse(lab.herdr(['pane', 'list'])).result.panes
            .map((pane) => lab.herdr(['pane', 'read', pane.pane_id, '--source', 'visible'])).join('\n');
    }
    await sh('input keyevent KEYCODE_BACK').catch(() => undefined);
    await sleep(500);
    if (!paneText.includes('lab agent heard: hello')) throw new Error('the agent never answered the prompt in its terminal');
    await step('send a prompt and the agent answers in its terminal');
    writeFileSync(join(dir, 'agent-pane.txt'), paneText);
    timing.totalMs = Date.now() - t0;
    timing.slowest = timing.steps.reduce((a, b) => (b.ms > a.ms ? b : a));
    writeFileSync(join(EVIDENCE, 'timing.json'), `${JSON.stringify(timing, null, 2)}\n`);
    say(`My computer, clean install to a working agent terminal: ${(timing.totalMs / 1000).toFixed(1)} s; slowest step: ${timing.slowest.step} (${(timing.slowest.ms / 1000).toFixed(1)} s)`);

}

try {
    emulator = await bootOwnedEmulator({ name: 'mxtd', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    await sh('settings put global heads_up_notifications_enabled 0');
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    say(`installed ${opts.apk}`);

    {
        for (const [width, font, theme] of CELLS) {
            const cell = `${width}-${font}-${theme}`;
            const dir = join(EVIDENCE, 'frames', cell);
            mkdirSync(dir, { recursive: true });
            await sh(`wm size 1080x2376; wm density ${DENSITY[width]}; settings put system font_scale ${font}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
            await launchFresh();
            await both(dir, `doors-${cell}`);
            // Scrolled to the end, a narrow window has the My computer door off screen.
            await launchFresh();
            await tapOn('My computer', myComputer);
            await waitFor('Get ready', shows((v) => v === 'Get ready'));
            await both(dir, `mycomputer-1-ready-${cell}`);
            await tapOn('Next: pair', (v) => v === 'Next: pair');
            await waitFor('Pair with your computer', shows((v) => v === 'Pair with your computer'));
            await both(dir, `mycomputer-2-pair-${cell}`);
            await launchFresh();
            await scrollUntil('Cloud machine · Boat', cloud);
            await waitFor('Connect your Boat account', shows((v) => v === 'Connect your Boat account'));
            await both(dir, `boat-1-account-${cell}`);
        }
        // At 1280 the Boat steps are the tablet app: a browser only says to set up from the phone app.
        for (const theme of PARTS.has('tablet') ? ['light', 'dark'] : []) {
            const cell = `tablet-1280-1.0-${theme}`;
            const dir = join(EVIDENCE, 'frames', cell);
            mkdirSync(dir, { recursive: true });
            await sh(`wm size 2560x1600; wm density 320; settings put system font_scale 1.0; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
            await launchFresh();
            await capture(dir, `doors-${cell}`);
            await scrollUntil('Cloud machine · Boat', cloud);
            await waitFor('Connect your Boat account', shows((v) => v === 'Connect your Boat account'));
            await capture(dir, `boat-1-account-${cell}`);
        }
    }

    if (PARTS.has('timed')) await timedRun();
    say(`visual check leads: ${leads.length === 0 ? 'none' : `\n${leads.join('\n')}`}`);
    writeFileSync(join(EVIDENCE, 'steps.json'), `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'the release app freshly installed on an Android phone (emulator), not paired to any computer',
        steps: [
            'open the app on Connect a machine and see the two doors, My computer and Cloud machine · Boat, with SSH as a small link',
            'open My computer: Get ready, then Next: pair to Pair with your computer; open Cloud machine · Boat to Connect your Boat account',
            'repeat at 360, 390 and 445 dp at text 1.0 and 270 dp at text 2.0, light and dark, at rest and scrolled to the end',
            'install the app clean, take the My computer door, type the computer pairing code, Connect, Pair, Start Claude Code on Home',
            'send a prompt from the agent screen and read the agent answer in its Herdr terminal',
        ],
        result: `each door shows what it is, its time and what it needs or costs, every step screen shows its own time${timing.totalMs === undefined ? '' : `, and My computer reached a working agent terminal in ${(timing.totalMs / 1000).toFixed(0)} s from a clean install`}`,
    }, null, 2)}\n`);
    say('RESULT done');
} catch (error) {
    say(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (serial) await screenshot(join(EVIDENCE, 'failure.png')).catch(() => undefined);
    if (serial) writeFileSync(join(EVIDENCE, 'crash.log'), await adb(['logcat', '-d', '-b', 'crash']).catch((e) => String(e)));
    if (lab) writeFileSync(join(EVIDENCE, 'host.log'), lab.hostOutput());
    process.exitCode = 1;
} finally {
    offering?.destroy();
    await lab?.stop().catch((error) => say(`lab stop failed: ${error.message}`));
    if (serial) await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no').catch(() => undefined);
    await emulator?.stop();
    say('lab and emulator stopped');
}
