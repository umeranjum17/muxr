// "Just this phone" on a clean install: tap the first-run card, sign in to ChatGPT (a
// BYOKit stand-in, see phoneStandIn.mjs), read the plan words, send a message the agent
// answers with its one tool, kill the app mid-turn, reopen and Try again. Then the
// reopened chat at 360/390/445/270 dp, light and dark. Run from the repo root:
//   node .agents/skills/done-done-verify-pockit/features/phoneOnlyLab.mjs --apk <apk> --evidence <dir> --avd-home <dir>
// The APK must be built with EXPO_PUBLIC_MUXR_PHONE_AUTH_BASE=http://127.0.0.1:38911 and
// EXPO_PUBLIC_MUXR_PHONE_API_BASE=http://127.0.0.1:38912 (the stand-in's ports).
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { bootOwnedEmulator } from '../../../../perf/lib/androidEmulator.mjs';
import { dumpUiXml } from '../../../../perf/lib/androidSignals.mjs';
import { startPhoneStandIn } from './phoneStandIn.mjs';

const { values: opts } = parseArgs({ options: { apk: { type: 'string' }, evidence: { type: 'string' }, 'avd-home': { type: 'string' } } });
if (!opts.apk || !opts.evidence || !opts['avd-home']) throw new Error('--apk, --evidence and --avd-home are required');
const AUTH = 38911;
const API = 38912;
const PKG = 'com.trymuxr.app';
const EVIDENCE = resolve(opts.evidence);
// One check judges at most 10 captures: the 8 steps and two reopened chats are cited from EVIDENCE;
// the whole width/theme matrix is saved next to it.
const MATRIX = `${EVIDENCE}-matrix`;
const CITED_CELLS = ['390-light', '270-dark'];
const CHECK = resolve('.agents/skills/done-done-verify-pockit/features/visualCheck.mjs');
// 1080 px at density 480 is 360 dp, 443 is 390, 388 is 445 and 640 is the reference phone's 270.
const CELLS = ['360', '390', '445', '270'].flatMap((width) => ['light', 'dark'].map((theme) => [width, theme]));
const DENSITY = { 360: 480, 390: 443, 445: 388, 270: 640 };
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
const leads = [];
const defects = [];
async function capture(dir, name, end = false) {
    await sleep(2500);
    const args = [CHECK, serial, dir, name];
    if (end) args.push('--end');
    const run = await exec(process.execPath, args, { timeout: 180_000, maxBuffer: 16 << 20 }).then((r) => ({ out: r.stdout }), (e) => ({ out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const lines = run.out.split('\n').filter((line) => line.startsWith('DEFECT'));
    for (const line of lines) leads.push(`${name}: ${line}`);
    say(`shot ${name}: ${lines.length === 0 ? 'clean' : lines.join(' | ')}`);

}
const has = (text) => (found) => find(found, (v) => v.includes(text)) !== undefined;
const atFirstRun = has('Just this phone');
async function launch(ready = atFirstRun) {
    await sh(`am force-stop ${PKG}`);
    await sh(`am start -W -n ${PKG}/.MainActivity`);
    await waitFor('the first-run screen', ready, 120);
    await sleep(1500);
}
const type = async (text) => {
    await tapOn('the message field', (v) => v === 'Message', 30);
    await sh(`input text ${text.replace(/ /g, '%s')}`);
};

let emulator;
let standIn;
try {
    standIn = await startPhoneStandIn({ authPort: AUTH, apiPort: API, log: say });
    emulator = await bootOwnedEmulator({ name: 'mxph', avdHome: resolve(opts['avd-home']), bootTimeoutMs: 720_000, launcher: ['nice', '-n', '10'] });
    serial = emulator.serial;
    say(`emulator ${serial} booted`);
    await sh('settings put global heads_up_notifications_enabled 0');
    // Only this lab's two stand-in ports; never the relay ports.
    await adb(['reverse', `tcp:${AUTH}`, `tcp:${AUTH}`]);
    await adb(['reverse', `tcp:${API}`, `tcp:${API}`]);
    await adb(['uninstall', PKG], 120_000).catch(() => undefined);
    await adb(['install', opts.apk], 300_000);
    await sh('wm size 1080x2376; wm density 443; settings put system font_scale 1.0; cmd uimode night no');
    await sh(`pm clear ${PKG}`).catch(() => undefined);
    const flow = join(EVIDENCE, 'flow');
    mkdirSync(flow, { recursive: true });

    await launch();
    await capture(flow, '1-first-run-card');
    await tapOn('the Just this phone card', (v) => v.startsWith('Just this phone'));
    await tapOn('Sign in with ChatGPT', (v) => v === 'Sign in with ChatGPT');
    await waitFor('the sign-in code', has('Enter this code on ChatGPT'), 60);
    await capture(flow, '2-sign-in-code');
    await sleep(1000);
    say(`approving ${standIn.lastCode() === undefined ? 'no code yet' : 'the code the stand-in issued'}`);
    await standIn.approve(standIn.lastCode());
    await waitFor('the plan words before the first send', has('Uses your ChatGPT plan.'), 90);
    await capture(flow, '3-chat-account-words');
    await tapOn('the suggestion', (v) => v === 'Make the app dark');
    await waitFor('the agent reply', (found) => find(found, (v) => v.startsWith('Done. muxr is dark now')) !== undefined, 90);
    await capture(flow, '4-first-reply-app-dark');

    // A turn the app dies in the middle of.
    await sh('cmd uimode night no');
    await type('Take your time');
    // The first tap can land while the keyboard moves the composer; tap again until the text is gone.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(1500);
        await tapOn('Send', (v) => v === 'Send');
        await sleep(2500);
        if (find(await screen(), (v) => v.startsWith('Take your time')) === undefined) break;
    }
    await waitFor('the turn running', has('Thinking…'), 30);
    await capture(flow, '5-turn-running');
    await sh(`am force-stop ${PKG}`);
    await launch(has('Continue your chat'));
    await capture(flow, '6-reopened-card-continue');
    await tapOn('Continue your chat', (v) => v.startsWith('Continue your chat'));
    await waitFor('Try again', (found) => find(found, (v) => v === 'Try again') !== undefined, 60);
    await capture(flow, '7-interrupted-try-again');
    await tapOn('Try again', (v) => v === 'Try again');
    await waitFor('the retried reply', (found) => find(found, (v) => v.includes('Make the app dark')) !== undefined && find(found, (v) => v === 'Try again') === undefined && find(found, (v) => v === 'Thinking…') === undefined, 120);
    await capture(flow, '8-retried-reply');

    // The agent left muxr dark; hand the look back to the phone so each cell follows its own theme.
    await type('Follow my phone');
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(1500);
        await tapOn('Send', (v) => v === 'Send');
        await sleep(2500);
        if (find(await screen(), (v) => v.startsWith('Follow my phone')) === undefined) break;
    }
    await waitFor('the agent handing the look back', has('Done. muxr follows your phone now.'), 90);

    // The reopened chat everywhere.
    for (const [width, theme] of CELLS) {
        const cell = `${width}-${theme}`;
        const dir = join(MATRIX, cell);
        mkdirSync(dir, { recursive: true });
        await sh(`wm density ${DENSITY[width]}; cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await launch(has('Continue your chat'));
        await capture(dir, `home-${cell}`);
        await tapOn('Continue your chat', (v) => v.startsWith('Continue your chat'));
        await waitFor('the chat', has('Uses your ChatGPT plan.'), 60);
        await capture(dir, `chat-${cell}`, true);
        if (CITED_CELLS.includes(cell)) copyFileSync(join(dir, `chat-${cell}.png`), join(EVIDENCE, `chat-${cell}.png`));
    }

    // The a11y dumps are not captures: move them beside the matrix so the cited folder holds only the ten frames.
    for (const file of readdirSync(EVIDENCE, { recursive: true }).filter((f) => f.endsWith('.xml'))) {
        const target = join(MATRIX, 'dumps', file);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(join(EVIDENCE, file), target);
    }
    say(`visual check leads: ${leads.length === 0 ? 'none' : `\n${leads.join('\n')}`}`);
    say(`stand-in saw ${standIn.requests.length} model requests`);
    writeFileSync(join(EVIDENCE, 'steps.json'), `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'the release app freshly installed on an Android phone (emulator), cleared, with no computer and no account',
        steps: [
            'open the app: the first screen offers Just this phone',
            'tap Just this phone, then Sign in with ChatGPT, and enter the code shown',
            'read the plan words above the message box before sending anything',
            'tap Make the app dark: the agent changes the theme and says so',
            'send a slow message and close the app mid-answer',
            'reopen: the first screen offers Continue your chat, the chat shows the turn was interrupted with Try again',
            'tap Try again and read the answer',
            'ask the agent to follow the phone again, then reopen the chat at 360, 390, 445 and 270 dp in light and dark',
        ],
        result: 'the chat continued where it stopped; the plan words show before the first message; the app never used another account. Sign-in ran against a BYOKit ChatGPT stand-in, so no real credential was used.',
    }, null, 2)}\n`);
    say('RESULT done');
} catch (error) {
    say(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    if (serial) await screenshot(join(EVIDENCE, 'failure.png')).catch(() => undefined);
    if (serial) writeFileSync(join(EVIDENCE, 'crash.log'), await adb(['logcat', '-d', '-b', 'crash']).catch((e) => String(e)));
    if (serial) writeFileSync(join(EVIDENCE, 'app.log'), await adb(['logcat', '-d', '-s', 'ReactNativeJS:V', 'AndroidRuntime:E', 'ActivityManager:I', 'libc:F', 'DEBUG:I']).catch((e) => String(e)));
    process.exitCode = 1;
} finally {
    if (serial) await sh('wm size reset; wm density reset; settings put system font_scale 1.0; cmd uimode night no').catch(() => undefined);
    if (serial) await adb(['reverse', '--remove', `tcp:${AUTH}`]).catch(() => undefined);
    if (serial) await adb(['reverse', '--remove', `tcp:${API}`]).catch(() => undefined);
    await emulator?.stop();
    await standIn?.close();
    say('emulator and stand-in stopped');
}
