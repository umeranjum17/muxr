// The chat's tool steps on a native release app: boots an owned emulator, runs
// chatFakeLab.mjs over adb, pairs a lab-id release APK and captures the chat with
// its steps folded, a group opened with an edit's peek, a command's peek and the
// full diff, at 390 and 270 dp, light and dark, through visualCheck.mjs; then
// records open, peek and fold. See chat-view.md. Run from the repo root, inside
// the emulator lock: node .agents/skills/done-done-verify-pockit/features/chatStepsNativeLab.mjs <apk> <evidenceDir> <avdHome>
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [apk, evidence, avdHome] = process.argv.slice(2);
const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };

const emu = await bootOwnedEmulator({ name: 'mxchat', avdHome, systemImage: 'system-images;android-35;google_apis;x86_64', launcher: ['nice', '-n', '10'] });
const serial = emu.serial;
log(`emulator ${serial}`);
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120_000 });
const sh = (cmd) => adb('shell', cmd);
const nodes = () => { sh('uiautomator dump /sdcard/d.xml >/dev/null'); return adb('exec-out', 'cat', '/sdcard/d.xml').match(/<node\s[^>]*>/g) ?? []; };
const labelsOf = (node) => [/text="([^"]*)"/.exec(node)?.[1] ?? '', /content-desc="([^"]*)"/.exec(node)?.[1] ?? ''];
const matches = (node, re) => labelsOf(node).some((label) => re.test(label));
const boundsOf = (node) => /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).slice(1).map(Number);
const find = async (re, seconds = 30) => {
    for (let i = 0; i < seconds; i += 2) {
        const hits = nodes().filter((node) => matches(node, re));
        if (hits.length > 0) return hits.at(-1);
        await sleep(2000);
    }
    throw new Error(`never saw ${re}`);
};
const tap = async (re, seconds) => {
    const [x1, y1, x2, y2] = boundsOf(await find(re, seconds));
    sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
    await sleep(1200);
};
// A fast swipe scrolls; a slow one starts a text selection.
const toEnd = async () => { for (let i = 0; i < 4; i += 1) { sh('input swipe 540 1700 540 700 120'); await sleep(400); } await sleep(800); };

let lab;
let defects = 0;
try {
    adb('install', '-r', apk);
    const pkg = sh('pm list packages').split('\n').map((line) => line.replace('package:', '').trim()).find((name) => name.includes('chatsteps'));
    if (pkg === undefined) throw new Error('the lab-id app did not install');
    const activity = sh(`cmd package resolve-activity --brief ${pkg}`).trim().split('\n').pop();
    sh(`pm clear ${pkg}`);

    lab = spawn(process.execPath, ['--input-type=module', '-e', readFileSync(join(repo, '.agents/skills/done-done-verify-pockit/features/chatFakeLab.mjs'), 'utf8')],
        { cwd: repo, env: { ...process.env, CHAT_LAB_SERIAL: serial }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    lab.stdout.on('data', (chunk) => { out += String(chunk); });
    lab.stderr.on('data', (chunk) => { out += String(chunk); });
    const line = async (re) => { for (let i = 0; i < 120; i += 1) { const hit = re.exec(out); if (hit) return hit[1]; await sleep(500); } throw new Error(`lab never said ${re}:\n${out}`); };
    await line(/lab ready: (.*)/);
    lab.kill('SIGUSR2');
    const link = await line(/native link: (\S+)/);
    log('lab ready, native link minted');

    sh('wm size 1080x2376'); sh('wm density 443'); sh('settings put system font_scale 1.0'); sh('cmd uimode night yes');
    sh(`am start -W -n ${activity}`);
    await sleep(4000);
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr-dev://pair#${link}' -n ${activity}`);
    await tap(/^Pair$/, 60);
    await find(/Claude 1/, 90);
    log('paired');

    const openChat = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            sh(`am force-stop ${pkg}`);
            sh(`am start -W -n ${activity}`);
            await sleep(3000);
            await find(/claude · Claude 1/, 60);
            // The Home composer covers the bottom rows: bring the agent up before tapping it.
            sh('input swipe 540 1400 540 900 150');
            await sleep(1000);
            const cards = nodes().filter((node) => matches(node, /claude · Claude 1/) && boundsOf(node)[3] < 1700);
            const card = cards[attempt % Math.max(1, cards.length)];
            if (card === undefined) continue;
            const [x1, y1, x2, y2] = boundsOf(card);
            sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
            await sleep(3000);
            const here = nodes();
            if (here.some((node) => matches(node, /Reply to Claude|Reply…/))) { await sleep(1500); return; }
            if (here.some((node) => matches(node, /^Chat view$/))) { await tap(/^Chat view$/); await sleep(1500); return; }
            writeFileSync(join(evidence, `open-miss-${attempt}.png`), execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p']));
            log(`open attempt ${attempt} missed the chat`);
        }
        throw new Error('could not open the Claude chat');
    };
    const shot = async (name, end = false) => {
        const dir = join(evidence, 'native');
        mkdirSync(dir, { recursive: true });
        try {
            writeFileSync(join(dir, `${name}.check.txt`), execFileSync('node',
                [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), serial, dir, name, ...(end ? ['--end'] : [])], { encoding: 'utf8' }));
        } catch (cause) {
            defects += 1;
            writeFileSync(join(dir, `${name}.check.txt`), `${cause.stdout ?? ''}${cause.stderr ?? ''}`);
        }
        log(`captured ${name}`);
    };

    for (const [width, density] of [['390', 443], ['270', 640]]) {
        for (const theme of ['dark', 'light']) {
            sh(`wm density ${density}`);
            sh(`cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
            const cell = `chat-${width}-1.0-${theme}`;
            await openChat();
            await toEnd();
            await shot(`${cell}-collapsed`, true);
            await tap(/^5 steps\./);
            await tap(/^Edited src\/checkout\/shipping\.ts/);
            await toEnd();
            await shot(`${cell}-group-edit-peek`);
            await tap(/^Edited src\/checkout\/shipping\.ts/);
            await tap(/^Ran yarn test checkout/);
            await toEnd();
            await shot(`${cell}-run-peek`);
            await tap(/^Ran yarn test checkout/);
            await tap(/^Edited src\/checkout\/shipping\.ts/);
            await tap(/Full diff/);
            await sleep(1200);
            await shot(`${cell}-full-diff`);
        }
    }

    // One recording at 390 dp dark: open the group, peek an edit, peek the command, fold it all.
    sh('wm density 443'); sh('cmd uimode night yes');
    await openChat();
    await toEnd();
    const recorder = spawn('adb', ['-s', serial, 'shell', 'screenrecord', '--time-limit', '40', '/sdcard/steps.mp4'], { stdio: 'ignore' });
    await sleep(1500);
    await tap(/^5 steps\./); await toEnd(); await sleep(800);
    await tap(/^Edited src\/checkout\/shipping\.ts/); await toEnd(); await sleep(1200);
    await tap(/^Edited src\/checkout\/shipping\.ts/); await tap(/^Ran yarn test checkout/); await toEnd(); await sleep(1200);
    await tap(/^Ran yarn test checkout/); await tap(/^5 steps\./); await sleep(1500);
    sh('pkill -INT screenrecord');
    await new Promise((resolve) => { recorder.once('exit', resolve); setTimeout(resolve, 8000); });
    await sleep(1500);
    adb('pull', '/sdcard/steps.mp4', join(evidence, 'native-390-dark-open-peek-fold.mp4'));
    log('recorded');
} finally {
    try { sh('wm size reset'); sh('wm density reset'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); } catch { /* emulator gone */ }
    if (lab !== undefined && lab.exitCode === null) {
        lab.kill('SIGTERM');
        await new Promise((resolve) => { lab.once('exit', resolve); setTimeout(resolve, 10_000); });
    }
    await emu.stop?.();
    log(`done; cells with defects: ${defects}`);
}
