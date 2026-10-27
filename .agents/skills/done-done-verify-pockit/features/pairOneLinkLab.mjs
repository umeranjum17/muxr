// One-link pairing on a real install (pair-one-link.md): boots an owned
// emulator. Chrome opens the computer's `muxr link` before muxr is installed,
// which shows the install page. Then it installs the release APK, shoots the
// first screen, and taps Open in muxr on the page. The consent screen appears,
// one Pair tap reaches Home, and nothing is typed. It then revokes this phone,
// and the old link is refused; a new link typed into the first screen pairs
// again. The lab stack (relay on the tailnet address, --fake host) must already
// run under MUXR_HOME. Run from the repo root, inside the emulator lock:
// MUXR_HOME=<lab home> node .agents/skills/done-done-verify-pockit/features/pairOneLinkLab.mjs <apk> <evidenceDir> <avdHome>
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [apk, evidence, avdHome] = process.argv.slice(2);
const repo = process.cwd();
const APP = 'com.trymuxr.app';
const ACTIVITY = `${APP}/.MainActivity`;
const CHROME = 'com.android.chrome/com.google.android.apps.chrome.Main';
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };
const cli = (...args) => execFileSync(process.execPath, ['scripts/cli.mjs', ...args], { cwd: repo, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const currentLink = () => /http:\/\/\S+\/join#[A-Za-z0-9_-]{43}/.exec(cli('link'))[0];

const emu = await bootOwnedEmulator({ name: 'mxpairlink', avdHome, systemImage: 'system-images;android-35;google_apis;x86_64', launcher: ['nice', '-n', '10'] });
const serial = emu.serial;
log(`emulator ${serial}`);
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120_000 });
const sh = (cmd) => adb('shell', cmd);
const nodes = () => {
    for (let attempt = 0; ; attempt += 1) {
        try { sh('uiautomator dump /sdcard/d.xml >/dev/null'); return adb('exec-out', 'cat', '/sdcard/d.xml').match(/<node\s[^>]*>/g) ?? []; } catch (error) { if (attempt === 2) throw error; }
    }
};
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
const tapNode = async (node) => { const [x1, y1, x2, y2] = boundsOf(node); sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`); await sleep(1500); };
const tap = async (re, seconds) => tapNode(await find(re, seconds));
const shot = (name) => { writeFileSync(join(evidence, `${name}.png`), execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })); log(`shot ${name}.png`); };
const theme = async (dark) => { sh(`cmd uimode night ${dark ? 'yes' : 'no'}`); await sleep(2500); };
const size = async (dp) => {
    if (dp === 270) { sh('wm size 1080x2376'); sh('wm density 640'); } else { sh('wm size reset'); sh('wm density reset'); }
    await sleep(2500);
};
// Both themes at the reference 270 dp phone and the AVD's own width, at rest
// and scrolled to the end. The app reads the theme at launch, so each cell
// relaunches the screen through `open`.
const top = () => /ResumedActivity[^\n]*/.exec(sh('dumpsys activity activities'))?.[0].trim() ?? 'none';
const matrix = async (name, open, ready) => {
    for (const dark of [false, true]) for (const dp of [270, 411]) {
        await theme(dark); await size(dp);
        sh(`am force-stop ${APP}`); open(); await find(ready, 90); await sleep(1500);
        const cell = `${name}-${dp}-${dark ? 'dark' : 'light'}`;
        shot(cell);
        sh('input swipe 540 1900 540 500 250'); await sleep(800); sh('input swipe 540 1900 540 500 250'); await sleep(1500);
        shot(`${cell}-end`);
    }
    await theme(false); await size(411);
};
// Chrome's first-run prompts (notifications, sign-in) cover the page on a fresh AVD.
const openInChrome = async (link) => {
    sh(`am start -n ${CHROME} -a android.intent.action.VIEW -d '${link}'`);
    for (let i = 0; i < 30; i += 1) {
        const all = nodes();
        const prompt = all.find((node) => matches(node, /^(No thanks|No, thanks|Not now)$/));
        if (prompt !== undefined) { log('dismissed a Chrome prompt'); await tapNode(prompt); continue; }
        if (all.some((node) => matches(node, /Pair this phone with your computer/))) return;
        await sleep(2000);
    }
    throw new Error('the pairing page never showed in Chrome');
};
const typeLink = async (link) => {
    const field = nodes().find((node) => /class="android.widget.EditText"/.test(node));
    if (field === undefined) throw new Error('no link field on the first screen');
    await tapNode(field);
    sh(`input text '${link}'`);
    await sleep(1500);
    sh('input keyevent 111'); // close the keyboard so Connect is in view
    await tap(/^Connect$/);
};

try {
    sh('cmd connectivity airplane-mode disable');
    // adbd restarts as root; the first try can race the fresh boot.
    for (let i = 0; i < 5; i += 1) { try { adb('root'); break; } catch { await sleep(3000); } }
    await sleep(3000); adb('wait-for-device');
    sh("echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line");
    sh('am set-debug-app --persistent com.android.chrome');
    const link = currentLink();
    log(`link ${link.replace(/#.*/, '#<secret>')}`);

    // 1. A phone without muxr: the link is a web page that says how to install.
    if (sh('pm list packages').includes(`package:${APP}\n`)) sh(`pm uninstall ${APP}`);
    await openInChrome(link);
    shot('emu-chrome-no-app');

    // 2. Install muxr; its first screen offers Paste a link.
    execFileSync('adb', ['-s', serial, 'install', '-r', apk], { encoding: 'utf8', timeout: 600_000 });
    sh(`pm clear ${APP}`);
    await matrix('emu-firstrun', () => sh(`am start -n ${ACTIVITY}`), /Let.s connect/);

    // The consent screen the link opens, in every cell. Nothing is redeemed
    // until Pair is tapped, so reopening it costs nothing.
    const deepLink = `muxr://join?to=${encodeURIComponent(link)}`;
    await matrix('emu-consent', () => sh(`am start -n ${ACTIVITY} -a android.intent.action.VIEW -d '${deepLink}'`), /wants to pair/);
    sh(`am force-stop ${APP}`);

    // 3. Back to the same page: Open in muxr, consent, one Pair tap, Home.
    await openInChrome(link);
    await tap(/^Open in muxr$/, 60);
    await sleep(3000);
    log(`after Open in muxr: ${top()}`);
    shot('emu-after-open-tap');
    for (const node of nodes()) if (matches(node, /^(Open|Continue|Open app)$/) && !matches(node, /muxr/)) { log('chrome asked to leave; confirmed'); await tapNode(node); break; }
    await find(/wants to pair/, 60);
    log(`consent: ${top()}`);
    if (!top().includes(APP)) throw new Error('the consent screen is not muxr in front');
    shot('emu-consent-from-chrome');
    await tap(/^Pair$/);
    await find(/^connected$/, 120);
    log('paired with one Pair tap');
    shot('emu-home-paired');

    // 4. Revoke this phone: its copy of the link no longer pairs.
    writeFileSync(join(evidence, 'cli-devices-revoke.txt'), `$ muxr devices list\n${cli('devices', 'list')}\n$ muxr devices revoke 1\n${cli('devices', 'revoke', '1')}`);
    sh(`pm clear ${APP}`);
    sh(`am start -n ${ACTIVITY}`);
    await find(/^Paste a link$/, 90);
    await typeLink(link);
    await tap(/^Pair$/, 60);
    await find(/no longer works/, 60);
    shot('emu-revoked-link');

    // 5. The new link, typed into the first screen, pairs again.
    const fresh = currentLink();
    if (fresh === link) throw new Error('revoke kept the old link');
    sh(`pm clear ${APP}`);
    sh(`am start -n ${ACTIVITY}`);
    await find(/^Paste a link$/, 90);
    await typeLink(fresh);
    await tap(/^Pair$/, 60);
    await find(/^connected$/, 120);
    shot('emu-home-new-link');
    log('done: all steps passed');
} catch (error) {
    log(`FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    try { log(`front: ${top()}`); shot('emu-failure'); writeFileSync(join(evidence, 'crash.txt'), adb('logcat', '-d', '-b', 'crash')); } catch { /* emulator gone */ }
    process.exitCode = 1;
} finally {
    try { sh('wm size reset'); sh('wm density reset'); sh('cmd uimode night no'); } catch { /* emulator gone */ }
    await emu.stop?.();
}
