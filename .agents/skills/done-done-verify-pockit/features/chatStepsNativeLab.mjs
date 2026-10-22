// The chat's tool steps on a native release app: boots an owned emulator, runs
// chatFakeLab.mjs over adb, pairs a lab-id release APK and captures the chat with
// its steps folded, a group opened with an edit's peek, a command's peek and the
// full diff, at 390 and 270 dp, light and dark, through visualCheck.mjs; then
// records open, peek and fold as a frame per step. See chat-view.md. Run from the repo root, inside
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

    // A relaunch reopens the last agent; from Home the composer covers the bottom rows.
    const inChat = async () => {
        const here = nodes();
        if (here.some((node) => matches(node, /Reply to Claude|Reply…/))) return true;
        if (here.some((node) => matches(node, /^Chat view$/))) { await tap(/^Chat view$/); return true; }
        if (here.some((node) => matches(node, /^New pane$/))) { await tap(/^Done$/); return inChat(); }
        return false;
    };
    const openChat = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            sh(`am force-stop ${pkg}`);
            sh(`am start -W -n ${activity}`);
            await sleep(4000);
            if (await inChat()) { await sleep(1500); return; }
            await find(/claude · Claude 1/, 60);
            sh('input swipe 540 1400 540 900 150');
            await sleep(1000);
            const cards = nodes().filter((node) => matches(node, /claude · Claude 1/) && boundsOf(node)[3] < 1700);
            const card = cards[attempt % Math.max(1, cards.length)];
            if (card !== undefined) {
                const [x1, y1, x2, y2] = boundsOf(card);
                sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
                await sleep(3000);
                if (await inChat()) { await sleep(1500); return; }
            }
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
            // Home in the same theme: the chat stays dark in every app theme, Home shows which one is on.
            sh('input keyevent 4'); await sleep(1000);
            sh('input keyevent 4'); await sleep(2000);
            await find(/claude · Claude 1/, 30);
            await shot(`${cell}-home`);
        }
    }

    // One recording at 390 dp dark: open the group, peek an edit, peek the command, fold it all.
    // A frame after each step (screenrecord starts late and drops the first taps).
    sh('wm density 443'); sh('cmd uimode night yes');
    await openChat();
    await toEnd();
    const frames = join(evidence, 'native-frames');
    mkdirSync(frames, { recursive: true });
    let frame = 0;
    const still = (repeat) => { for (let i = 0; i < repeat; i += 1) writeFileSync(join(frames, `f${String(++frame).padStart(3, '0')}.png`), execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })); };
    still(3);
    await tap(/^5 steps\./); await toEnd(); still(3);
    await tap(/^Edited src\/checkout\/shipping\.ts/); await toEnd(); still(4);
    await tap(/^Edited src\/checkout\/shipping\.ts/); await tap(/^Ran yarn test checkout/); await toEnd(); still(4);
    await tap(/^Ran yarn test checkout/); await toEnd(); still(2);
    await tap(/^5 steps\./); await toEnd(); still(3);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', '2', '-i', join(frames, 'f%03d.png'), '-vf', 'scale=540:-2,format=yuv420p', '-c:v', 'libx264', join(evidence, 'native-390-dark-open-peek-fold.mp4')]);
    log('recorded');
    // The step record done-done's judge reads beside the captures.
    const steps = `${JSON.stringify({
        target: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
        start: 'lab-id release APK freshly installed and paired to the chat fake lab, whose Claude log has a read/search reply, an edit+test reply and a five-step reply with two edits, a plan and a failed command',
        steps: ['open the Claude agent in Chat view and scroll to the end', 'tap the five-step row', 'tap the edit of shipping.ts', 'tap the edit again, then the failed command', 'tap the command again, then the edit, then Full diff', 'go back to Home', 'repeat at 390 and 270 dp wide, light and dark'],
        result: 'tool calls as rows with a grey kind icon, the verb and the file name or command; several steps folded into one row that opens in place; an edit peek with numbered changed lines and Full diff; a failed command peek with its output, Exit 1 and Open terminal; a Full diff sheet titled with the file name, dark like the chat it opens over in both app themes, while Home follows the app theme',
    }, null, 2)}\n`;
    writeFileSync(join(evidence, 'steps.json'), steps);
    writeFileSync(join(evidence, 'native', 'steps.json'), steps);
} finally {
    try { sh('wm size reset'); sh('wm density reset'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); } catch { /* emulator gone */ }
    if (lab !== undefined && lab.exitCode === null) {
        lab.kill('SIGTERM');
        await new Promise((resolve) => { lab.once('exit', resolve); setTimeout(resolve, 10_000); });
    }
    await emu.stop?.();
    log(`done; cells with defects: ${defects}`);
}
