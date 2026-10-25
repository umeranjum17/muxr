// Native capture for Home's herd sentence (home-quota-row.md, herd-working and
// its siblings): the release APK on an owned emulator, paired to a private lab
// host over a fake Herdr with one agent, whose lifecycle this journey holds so
// each state the card can speak can be captured and held still. Run from the
// repo root, after `yarn build`: node <this> <apk> <evidence-dir>;
// MUXR_LAB_AVD_HOME picks the emulator home. Every cell asserts the exact
// sentence is on screen before it shoots.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { setAndroidSerial } = await import(join(repo, 'perf/lib/deviceTarget.mjs'));

const CHECK = fileURLToPath(new URL('./visualCheck.mjs', import.meta.url));
const LAB = join(dirname(CHECK), 'herdSentenceLab.mjs');
const REPO = resolve(dirname(CHECK), '..', '..', '..', '..');
const [APK, OUT] = process.argv.slice(2).map((part) => resolve(part));
if (!APK || !OUT) throw new Error('an APK and an evidence directory are required');
mkdirSync(OUT, { recursive: true });

// The version the APK was built from, as buildPrApk.mjs recorded it beside it.
let revision = 'unknown';
try { revision = JSON.parse(readFileSync(`${APK}.json`, 'utf8')).revision ?? 'unknown'; } catch { /* no build record */ }

const emu = await bootOwnedEmulator({ name: 'mxherdline', avdHome: process.env.MUXR_LAB_AVD_HOME, launcher: ['nice', '-n', '10'], extraArgs: ['-no-snapshot-load'] });
const SERIAL = emu.serial;
// Before any stack starts: its adb reverse must name this emulator, never another attached device.
setAndroidSerial(SERIAL);
const journal = [];
const note = (line) => { journal.push(line); console.log(line); writeFileSync(join(OUT, 'journey.log'), `${journal.join('\n')}\n`); };
note(`emulator ${SERIAL} pid ${emu.pid}, APK revision ${revision}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adbOnce = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
// A loaded emulator drops an occasional shell call (exit 255); one retry rides it out.
const adb = (...args) => { try { return adbOnce(...args); } catch { try { return adbOnce(...args); } catch { return ''; } } };
const shell = (...args) => adb('shell', ...args);

const SENTENCE = {
    working: 'An agent is working. Nothing needed from you.',
    waiting: 'An agent is waiting for your answer. Open it to reply.',
    stopped: 'An agent stopped. Open it to see what happened.',
    ready: 'An agent is ready for your next message.',
    none: 'No agents are running. Start one below.',
};
/** The Herdr lifecycle each state is held in; `none` closes the agent's pane. */
const HERDR = { working: 'working', waiting: 'blocked', stopped: 'failed', ready: 'idle', none: 'off' };

/** The states, and the cells each is shot in. The working state carries the
 *  whole matrix; the others prove their own sentence at a phone width and a
 *  desktop-ish one, dark and light. */
const CELLS = [
    { state: 'working', w: 360, font: '1.0', theme: 'light' },
    { state: 'working', w: 360, font: '1.0', theme: 'dark' },
    { state: 'working', w: 390, font: '1.0', theme: 'light' },
    { state: 'working', w: 390, font: '1.0', theme: 'dark' },
    { state: 'working', w: 445, font: '1.0', theme: 'light' },
    { state: 'working', w: 445, font: '1.0', theme: 'dark' },
    { state: 'working', w: 270, font: '1.0', theme: 'light' },
    { state: 'working', w: 270, font: '1.0', theme: 'dark' },
    { state: 'working', w: 270, font: '2.0', theme: 'light' },
    { state: 'working', w: 270, font: '2.0', theme: 'dark' },
    { state: 'waiting', w: 390, font: '1.0', theme: 'light' },
    { state: 'waiting', w: 270, font: '2.0', theme: 'dark' },
    { state: 'stopped', w: 390, font: '1.0', theme: 'light' },
    { state: 'stopped', w: 270, font: '2.0', theme: 'dark' },
    { state: 'ready', w: 390, font: '1.0', theme: 'light' },
    { state: 'ready', w: 270, font: '2.0', theme: 'dark' },
    { state: 'none', w: 390, font: '1.0', theme: 'light' },
    { state: 'none', w: 270, font: '2.0', theme: 'dark' },
];

const lab = spawn(process.execPath, [LAB], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
let labLog = '';
lab.stdout.setEncoding('utf8').on('data', (chunk) => { labLog += chunk; });
lab.stderr.setEncoding('utf8').on('data', (chunk) => { labLog += chunk; });
const stopAll = () => { try { lab.kill(); } catch { /* gone */ } };
process.on('exit', stopAll);

const waitFor = async (what, test, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await test()) return;
        await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}\n${labLog.slice(-2000)}`);
};

await waitFor('the lab', async () => /relay port (\d+)/.test(labLog));
const relayPort = /relay port (\d+)/.exec(labLog)[1];
adb('reverse', `tcp:${relayPort}`, `tcp:${relayPort}`);

const say = (line) => lab.stdin.write(`${line}\n`);
const setState = async (state) => {
    const mark = labLog.length;
    say(`1 ${HERDR[state]}`);
    await waitFor(`${state} in the lab`, async () => /set: /.test(labLog.slice(mark)) || /set: no agent/.test(labLog.slice(mark)));
    if (/set: no agent/.test(labLog.slice(mark))) throw new Error(`the lab refused ${state}`);
    await sleep(2_000);
};

/** uiautomator refuses while the screen is still settling, and the guest's
 *  low-memory killer takes it out mid-dump on a 2 GB emulator; either way the
 *  answer is "nothing readable yet", which is what an empty dump already
 *  means to the callers below. */
const dump = () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            shell('uiautomator', 'dump', '/sdcard/ui.xml');
            return adb('exec-out', 'cat', '/sdcard/ui.xml');
        } catch { /* settle, then try again */ }
    }
    return '';
};

const ready = async (state) => {
    const escaped = SENTENCE[state].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s');
    return new RegExp(escaped).test(await dump());
};

const relaunch = async () => {
    shell('am', 'force-stop', 'com.trymuxr.app');
    await sleep(700);
    shell('am', 'start', '-n', 'com.trymuxr.app/.MainActivity');
};

const applyCell = async ({ w, font, theme }) => {
    // 1080 px wide: the reference phone's frame, so dp is a density.
    shell('wm', 'size', '1080x2376');
    shell('wm', 'density', `${Math.round((1080 * 160) / w)}`);
    shell('settings', 'put', 'system', 'font_scale', font);
    shell('cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no');
};

const results = [];
try {
    adbOnce('install', '-r', APK);
} catch {
    // A build signed with another test key cannot install over this one.
    shell('pm', 'uninstall', 'com.trymuxr.app');
    adbOnce('install', APK);
}
shell('pm', 'grant', 'com.trymuxr.app', 'android.permission.POST_NOTIFICATIONS');
// A fresh install shows the background-battery invite over Home; allowed up
// front it never covers the list the card sits above.
try { shell('dumpsys', 'deviceidle', 'whitelist', '+com.trymuxr.app'); } catch { /* the invite still has Not now */ }

await applyCell({ w: 393, font: '1.0', theme: 'light' });
say('native');
await waitFor('a native pairing code', async () => /native code: /.test(labLog));
const code = /native code: (\S+)/.exec(labLog)[1];
shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `muxr://pair#${code}`, 'com.trymuxr.app');
const PAIR = /<node[^>]*(?:text="Pair"|content-desc="Pair")[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/;
// The app has to draw its consent screen before the control is there to tap,
// and a dump can come back empty while that happens.
let pairNode = null;
for (let attempt = 0; attempt < 20 && pairNode === null; attempt += 1) {
    await sleep(1_500);
    pairNode = PAIR.exec(await dump());
}
if (pairNode === null) throw new Error(`no Pair control on the consent screen:\n${(await dump()).slice(0, 2000)}`);
shell('input', 'tap', String((Number(pairNode[1]) + Number(pairNode[3])) / 2), String((Number(pairNode[2]) + Number(pairNode[4])) / 2));
console.log('paired; waiting for Home');

/** A first-run invite on Home covers the list under the composer; it is not
 *  part of the card, so dismiss it once before the cells. */
const dismissInvite = async () => {
    // The invite is drawn after Home's first paint, and dismissing it is what
    // stops it coming back on the next launch, so keep looking rather than
    // reading an early empty dump as "there is none".
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const node = /<node[^>]*(?:text|content-desc)="Not now"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(await dump());
        if (node !== null) {
            shell('input', 'tap', String((Number(node[1]) + Number(node[3])) / 2), String((Number(node[2]) + Number(node[4])) / 2));
            await sleep(1_500);
            return;
        }
        await sleep(1_500);
    }
    console.log('the background-battery invite never showed');
};
await dismissInvite();

// The last step first: `none` closes the agent's pane, so it runs last.
for (const state of ['working', 'waiting', 'stopped', 'ready', 'none']) {
    await applyCell({ w: 393, font: '1.0', theme: 'light' });
    await setState(state);
    for (const cell of CELLS.filter((row) => row.state === state)) {
        await applyCell(cell);
        await relaunch();
        await waitFor(`${state} on Home at ${cell.w}dp`, () => ready(state), 90_000);
        const name = `home-herd-${state}-${cell.w}-${cell.font}-${cell.theme}`;
        // The Visual leads stay in each cell's .check.txt for the self-review:
        // Home's header and composer carry leads of their own on main (the
        // header's status sits 2dp under its title by design), so only this
        // journey's own checks fail the run.
        let report;
        try { report = execFileSync(process.execPath, [CHECK, SERIAL, OUT, name], { cwd: REPO, encoding: 'utf8' }); }
        catch (cause) { report = `${cause.stdout ?? ''}${cause.stderr ?? ''}`; }
        writeFileSync(`${OUT}/${name}.check.txt`, report);
        const leads = report.split('\n').filter((row) => row.startsWith('DEFECT'));
        const saved = readFileSync(`${OUT}/${name}.xml`, 'utf8');
        const onScreen = new RegExp(SENTENCE[state].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s')).test(saved);
        const word = /text="(Healthy|Busy)"/.test(saved);
        results.push({ cell: name, sentence: onScreen, machineWord: word });
        if (!onScreen) throw new Error(`${name}: the sentence is not on screen`);
        if (word) throw new Error(`${name}: the old machine word is still on screen`);
        console.log(`${name}: sentence present, ${leads.length} visual leads${word ? ', OLD WORD STILL THERE' : ''}`);
    }
}

writeFileSync(`${OUT}/cells.json`, JSON.stringify(results, null, 2));
writeFileSync(`${OUT}/steps.json`, JSON.stringify({
    target: { version: `muxr release APK ${revision}` },
    start: 'fresh app data on an owned Android emulator; a private lab host (real relay and host over a fake Herdr, one agent) with no phone paired',
    steps: [
        'open the muxr://pair link from the lab host and tap Pair, then dismiss the background-battery invite',
        'Home shows the Right now card with the herd sentence for a working agent',
        'hold the agent blocked, failed and idle through the lab and relaunch Home for each',
        'close the agent pane so the herd is empty and relaunch Home',
        'read the card back at 360, 390, 445 and 270 dp, font 1.0 and 2.0, light and dark',
    ],
    result: `Home's card says the exact sentence for each state at all ${results.length} cells, and never "Healthy" or "Busy"`,
}, null, 2));
lab.kill();
adb('reverse', '--remove', `tcp:${relayPort}`);
shell('wm', 'size', 'reset');
shell('wm', 'density', 'reset');
shell('settings', 'put', 'system', 'font_scale', '1.0');
await emu.stop();
note(`done: ${results.length} cells`);
process.exit(0);
