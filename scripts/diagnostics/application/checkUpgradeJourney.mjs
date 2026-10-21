// The 0.2.9 to 0.2.10 upgrade journey on the real test phone.
//
// The phone app is updated in place (`adb install -r`, no `pm clear`) and must
// keep what the user set up: the link grant to the computer, the theme and the
// terminal text size. The new build must still open an agent's terminal, and
// it must still pair from a cleared install.
//
// usage: node scripts/diagnostics/application/checkUpgradeJourney.mjs [<evidenceDir> <labRoot>]
// (`done-done run upgrade` sets DONE_DONE_EVIDENCE_ROOT and UPGRADE_ROOT instead)
// env: PHONE_SERIAL (the test phone), UPGRADE_FROM_APK, UPGRADE_TO_APK
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const [evidence, root] = process.argv.length > 2 ? process.argv.slice(2) : [process.env.DONE_DONE_EVIDENCE_ROOT, process.env.UPGRADE_ROOT];
if (!evidence || !root) throw new Error('give an evidence dir and a short scratch dir, or set DONE_DONE_EVIDENCE_ROOT and UPGRADE_ROOT');
const repo = process.cwd();
const serial = process.env.PHONE_SERIAL;
if (serial !== 'a4b93ea2') throw new Error('the upgrade journey runs on the test phone only');
const fromApk = process.env.UPGRADE_FROM_APK;
const toApk = process.env.UPGRADE_TO_APK;
if (!fromApk || !toApk) throw new Error('UPGRADE_FROM_APK and UPGRADE_TO_APK must name the two release APKs');
if (!existsSync(fromApk) || !existsSync(toApk)) throw new Error('both APKs must exist on disk');

process.env.MUXR_LAB_MACHINE_NAME ??= 'Umer lab computer';
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const PKG = 'com.trymuxr.app';
const LAB_AGENT = 'umer-lab';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };

const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 180_000 });
const sh = (cmd) => adb('shell', cmd);
const dump = () => { sh('uiautomator dump /sdcard/d.xml >/dev/null'); const xml = adb('exec-out', 'cat', '/sdcard/d.xml'); sh('rm -f /sdcard/d.xml'); return xml; };
const shot = (name) => { writeFileSync(join(evidence, `${name}.png`), execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 180_000 })); log(`captured ${name}`); };
// The terminal's first rows hold the computer's own shell prompt: black them out.
// Home's header names the computer: black that band out of every shot kept and the video.
const HOME_NAME_BAND = 'drawbox=x=0:y=140:w=720:h=130:color=black:t=fill';
const maskPrompt = (name, filter = 'drawbox=x=0:y=190:w=iw:h=170:color=black:t=fill') => {
    const file = join(evidence, `${name}.png`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', filter, `${file}.tmp.png`]);
    renameSync(`${file}.tmp.png`, file);
};
// Frame windows (ms) in which an agent's terminal is on screen; the video leaves them out.
const terminalWindows = [];
const size = () => { const line = sh('wm size').split('\n').filter(Boolean).pop(); const m = /(\d+)x(\d+)/.exec(line); return { width: Number(m[1]), height: Number(m[2]) }; };
const version = () => sh(`dumpsys package ${PKG} | grep -E "versionName|versionCode" | head -2`).replace(/\s+/g, ' ').trim();

const nodes = (xml) => (xml.match(/<node\s[^>]*>/g) ?? []).map((node) => ({
    text: /text="([^"]*)"/.exec(node)?.[1] ?? '',
    desc: /content-desc="([^"]*)"/.exec(node)?.[1] ?? '',
    cls: /class="([^"]*)"/.exec(node)?.[1] ?? '',
    bounds: (/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)?.slice(1).map(Number) ?? [0, 0, 0, 0]),
}));
const label = (node) => node.text || node.desc;

// Finds a node whose text or accessibility label matches, and taps it.
// A node below the fold is scrolled into view first.
const tapNode = async (re, seconds = 30, { cls } = {}) => {
    const { width, height } = size();
    for (let i = 0; i < seconds; i += 1) {
        const found = nodes(dump()).find((n) => (cls ? n.cls === cls : true) && (re.test(n.text) || re.test(n.desc)));
        if (found) {
            const [x1, y1, x2, y2] = found.bounds;
            if (y1 < 0 || y2 > height - 60) {
                log(`${re} at y ${y1}-${y2} of ${height}; scrolling`);
                sh(`input swipe ${width >> 1} ${Math.round(height * 0.75)} ${width >> 1} ${Math.round(height * 0.35)} 200`);
                await sleep(1200);
                continue;
            }
            sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
            log(`tapped ${re} ("${label(found)}") at y ${y1}-${y2} of ${height}`);
            return label(found);
        }
        // The row may sit below the fold: scroll down and look again.
        sh(`input swipe ${width >> 1} ${Math.round(height * 0.75)} ${width >> 1} ${Math.round(height * 0.35)} 200`);
        await sleep(1200);
    }
    const xml = dump();
    log(`screen words: ${['Pair', 'Paired', 'Approve', 'Computers', 'Home', 'Settings', 'Appearance', 'Theme', 'Text size', 'Dark'].map((w) => `${w}=${xml.includes(w)}`).join(' ')}`);
    shot(`stuck-${Date.now()}`);
    throw new Error(`never saw ${re}`);
};

// Reads the value under a settings row: the node right below the row title.
const rowValue = (titleRe, valueRe) => {
    const all = nodes(dump());
    const title = all.find((n) => titleRe.test(n.text) || titleRe.test(n.desc));
    if (!title) return undefined;
    const values = all.filter((n) => valueRe.test(n.text) || valueRe.test(n.desc));
    const below = values.filter((n) => n.bounds[1] >= title.bounds[3] - 8 && n.bounds[1] <= title.bounds[3] + 200);
    return (below[0] ?? values[0]) && label(below[0] ?? values[0]);
};

// Frames of the whole journey: screenrecord is denied on this phone.
const frames = join(root, 'frames');
mkdirSync(frames, { recursive: true });
const flag = join(root, 'rec.on');
let recorder;
const recOn = (why) => {
    writeFileSync(flag, '');
    recorder = spawn('bash', ['-c', `while [ -e ${flag} ]; do t=$(date +%s%3N); timeout 20 adb -s ${serial} exec-out screencap -p > ${frames}/$t.png || rm -f ${frames}/$t.png; done`], { stdio: 'ignore' });
    log(`recording on: ${why}`);
};
const recOff = async (why) => {
    if (!existsSync(flag)) return;
    rmSync(flag);
    await new Promise((r) => recorder.on('exit', r));
    log(`recording off: ${why}`);
    let dropped = 0;
    for (const name of readdirSync(frames)) {
        const at = Number(name.replace('.png', ''));
        if (terminalWindows.some(([from, to]) => at >= from && at <= to)) { unlinkSync(join(frames, name)); dropped += 1; }
    }
    const kept = readdirSync(frames).filter((name) => name.endsWith('.png')).sort();
    if (kept.length < 4) return;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '2', '-pattern_type', 'glob', '-i', `${frames}/*.png`,
        '-vf', `${HOME_NAME_BAND},crop=iw:ih-96:0:0,scale=540:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(evidence, 'upgrade.mp4')], { stdio: 'ignore' });
    log(`video: upgrade.mp4 from ${kept.length} frames (${dropped} dropped while a terminal was on screen)`);
};

// The phone screen must be awake and unlocked before the app is started.
const wake = async () => {
    sh('input keyevent KEYCODE_WAKEUP');
    await sleep(1200);
    const focus = sh('dumpsys window | grep -E "mCurrentFocus"').trim();
    if (/Keyguard|systemui/i.test(focus)) {
        const { width, height } = size();
        sh(`input swipe ${width >> 1} ${Math.round(height * 0.85)} ${width >> 1} ${Math.round(height * 0.2)} 200`);
        await sleep(1500);
        log(`unlocked with a swipe; focus now ${sh('dumpsys window | grep -E "mCurrentFocus"').trim()}`);
    }
};

// The Home header gear, the only way into the app's settings.
const atHome = () => dump().includes('content-desc="Settings"');
const backToHome = async () => {
    for (let i = 0; i < 3; i += 1) {
        if (atHome()) return;
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    }
    if (!atHome()) throw new Error('never came back to Home');
};

const attached = async (since, what) => {
    let result = 'no terminal surface';
    for (let second = 0; second < 90; second += 1) {
        const xml = dump();
        const surface = xml.includes('Terminal surface');
        const pill = /text="(still connecting|connecting|Connection unconfirmed)"/.exec(xml)?.[1];
        if (surface && !pill) return `attached in ${((Date.now() - since) / 1000).toFixed(1)}s`;
        result = surface ? `stuck: ${pill}` : 'no terminal surface';
        await sleep(1000);
    }
    log(`${what}: ${result}`);
    return result;
};

let offering;
let paired = false;
const mintNativePairing = (path) => new Promise((resolve, reject) => {
    const socket = offering = createConnection(path);
    let pending = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write('{"intent":{"kind":"native","authority":"control","personal":false}}\n'));
    socket.on('data', (chunk) => {
        pending += String(chunk);
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const event = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            if (event.offer) resolve(event.offer.text);
            if (event.approval) { socket.write('{"yes":true}\n'); paired = true; log('device paired'); }
            if (event.error) reject(new Error(event.error));
        }
    });
});

const work = join(root, 'w');
const bin = join(work, 'bin');
mkdirSync(join(work, 'muxr'), { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '\\033]2;%s\\007' 'Fix the login page'\necho 'Umer lab agent ready'\nwhile read l; do echo "lab agent got: $l"; done; while :; do sleep 3600; done\n`, { mode: 0o755 });

let lab;
let verdict = 'not reached';
const steps = [];
const step = (name, ok, detail) => { steps.push({ name, ok, detail }); log(`${ok ? 'pass' : 'FAIL'} ${name}: ${detail}`); };
try {
    // 1. A clean install of the old release, so the pairing is only ever the lab's.
    // An uninstall takes the app's stored state with it; `pm clear` is refused
    // on this phone (its shell holds no CLEAR_APP_USER_DATA).
    sh(`pm uninstall ${PKG}`).trim();
    log(`installing the old release ${fromApk}`);
    adb('install', '-r', fromApk);
    const fromVersion = version();
    log(`old release installed: ${fromVersion}`);
    step('old release installed', /versionCode=392|versionCode":392/.test(fromVersion), fromVersion);
    await wake();
    const activity = sh(`cmd package resolve-activity --brief ${PKG}`).trim().split('\n').pop();

    // 2. The lab host the phone pairs with.
    mkdirSync(join(root, 'lab'), { recursive: true });
    lab = await linkHerdrLab(join(root, 'lab'), 'upg', undefined, (herdr) => {
        herdr(['workspace', 'create', '--cwd', join(work, 'muxr'), '--label', 'upgrade', '--no-focus']);
    });
    log(`lab host up on relay port ${lab.port}`);
    const panes = JSON.parse(lab.herdr(['pane', 'list'])).result.panes;
    const pane = panes[0];
    lab.herdr(['pane', 'send-text', pane.pane_id, `${join(bin, 'claude')}\n`]);
    await sleep(1500);
    lab.herdr(['agent', 'rename', pane.pane_id, LAB_AGENT]);
    adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
    const health = sh(`toybox nc -w 5 127.0.0.1 ${lab.port} </dev/null >/dev/null 2>&1 && echo reachable || echo unreachable`).trim();
    log(`phone -> lab relay 127.0.0.1:${lab.port} (adb reverse): ${health}`);
    step('phone reaches the lab relay', health === 'reachable', health);
    if (health !== 'reachable') throw new Error('the phone cannot reach the lab relay');

    // 3. Pair the old release with the lab host.
    const offer = await mintNativePairing(join(root, 'lab', 'host', 'pair.sock'));
    sh(`am start -n ${activity}`);
    await sleep(4000);
    sh(`am start -a android.intent.action.VIEW -d 'muxr://pair#${offer}' -n ${activity}`);
    await sleep(1500);
    recOn('the old release pairs with the lab host');
    await tapNode(/^Pair$/, 120);
    for (let second = 0; second < 40 && !paired; second += 1) await sleep(1000);
    log(paired ? 'the host approved the pairing' : 'the host never saw the pairing approval');
    step('old release pairs with the lab host', paired, paired ? 'approved' : 'no approval');
    offering?.destroy();
    await sleep(6000);

    // 4. The settings the user changed on the old build.
    await backToHome();
    await tapNode(/^Settings$/, 60);
    await sleep(2000);
    await tapNode(/^Appearance$/, 60);
    await sleep(2000);
    shot('01-old-release-appearance');
    await tapNode(/^Theme$/, 60);
    await sleep(1500);
    await tapNode(/^Dark$/, 60);
    await sleep(1500);
    await tapNode(/^Text size$/, 60);
    await sleep(1500);
    await tapNode(/^20 pt$/, 60);
    await sleep(1500);
    const oldTheme = rowValue(/^Theme$/, /^(Automatic|Light|Dark)$/);
    const oldSize = rowValue(/^Text size$/, /^\d+ pt$/);
    log(`old release settings: theme=${oldTheme} text size=${oldSize}`);
    shot('02-old-release-settings');
    step('old release carries the user settings', oldTheme === 'Dark' && oldSize === '20 pt', `theme=${oldTheme} size=${oldSize}`);

    // 5. The upgrade itself: in place, no pm clear.
    log(`installing the new release ${toApk} over the old one`);
    adb('install', '-r', toApk);
    const toVersion = version();
    log(`new release installed: ${toVersion}`);
    step('new release installed in place', /versionCode=393|versionCode":393/.test(toVersion), toVersion);
    await sleep(2000);
    await wake();

    // 6. The new build still opens an agent's terminal.
    sh(`am start -n ${activity}`);
    await sleep(6000);
    const tapped = Date.now();
    const terminalFrom = tapped;
    await tapNode(new RegExp(LAB_AGENT), 90);
    const attach = await attached(tapped, 'the new release');
    step('new release opens the agent terminal', attach.startsWith('attached'), attach);
    shot('03-new-release-terminal');
    maskPrompt('03-new-release-terminal');
    await sleep(2000);

    // 7. The settings and the pairing survived the upgrade.
    await backToHome();
    terminalWindows.push([terminalFrom, Date.now()]);
    await tapNode(/^Settings$/, 60);
    await sleep(2000);
    await tapNode(/^Appearance$/, 60);
    await sleep(2000);
    const newTheme = rowValue(/^Theme$/, /^(Automatic|Light|Dark)$/);
    const newSize = rowValue(/^Text size$/, /^\d+ pt$/);
    log(`new release settings: theme=${newTheme} text size=${newSize}`);
    shot('04-new-release-appearance');
    step('settings survived the upgrade', newTheme === oldTheme && newSize === oldSize, `theme=${newTheme} size=${newSize}`);

    // 8. A clean install still pairs: the new build is not only an upgrade.
    sh(`pm uninstall ${PKG}`).trim();
    adb('install', '-r', toApk);
    await sleep(2000);
    sh(`am start -n ${activity}`);
    await sleep(4000);
    paired = false;
    const offer2 = await mintNativePairing(join(root, 'lab', 'host', 'pair.sock'));
    sh(`am start -a android.intent.action.VIEW -d 'muxr://pair#${offer2}' -n ${activity}`);
    await sleep(1500);
    await tapNode(/^Pair$/, 120);
    for (let second = 0; second < 40 && !paired; second += 1) await sleep(1000);
    step('new release pairs from a cleared install', paired, paired ? 'approved' : 'no approval');
    offering?.destroy();
    await sleep(6000);
    // 0.2.10 asks for notifications after a pairing; the system dialog covers Home until answered.
    if (/permissioncontroller/.test(dump())) {
        shot('05a-notification-prompt');
        maskPrompt('05a-notification-prompt', HOME_NAME_BAND);
        await tapNode(/^Don.t allow$/i, 10);
        await sleep(2000);
    }
    const tapped2 = Date.now();
    terminalWindows.push([tapped2, Number.MAX_SAFE_INTEGER]);
    await tapNode(new RegExp(LAB_AGENT), 90);
    const attach2 = await attached(tapped2, 'the new release, fresh pair');
    step('new release opens the agent terminal after a fresh pair', attach2.startsWith('attached'), attach2);
    shot('05-new-release-fresh-pair');
    maskPrompt('05-new-release-fresh-pair');

    const failed = steps.filter((s) => !s.ok);
    verdict = failed.length === 0
        ? `pass: upgrade kept the pairing and the settings, and the new build pairs and opens a terminal`
        : `fail: ${failed.map((f) => `${f.name} (${f.detail})`).join('; ')}`;
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({ steps, verdict }, null, 2)}\n`);
} catch (error) {
    verdict = `fail: ${error.message}`;
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({ steps, verdict }, null, 2)}\n`);
    throw error;
} finally {
    await recOff('journey over');
    log(`verdict: ${verdict}`);
    if (lab) writeFileSync(join(evidence, 'host.log'), lab.hostOutput().replace(/pairing string[^\n]*/g, '<pairing>').replace(/muxr:\/\/pair#\S*/g, '<offer>'));
    offering?.destroy();
    try { sh(`am force-stop ${PKG}`); sh('input keyevent KEYCODE_HOME'); } catch { /* gone */ }
    if (lab) { try { adb('reverse', '--remove', `tcp:${lab.port}`); } catch { /* none */ } }
    await lab?.stop();
}
