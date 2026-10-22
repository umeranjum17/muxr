/**
 * phone-attach: the release journey on the real phone.
 *
 * A user's whole muxr phone experience is: pair this phone to the computer,
 * open an agent, watch it work, close it, come back to it later, type at it.
 * This drives that on the test phone against a private lab host (relay on a
 * kernel-picked port, own MUXR_HOME, own Herdr lab session), with the
 * release APK installed first, and saves the screens and a recording into
 * $DONE_DONE_EVIDENCE_ROOT.
 *
 * It is also the gate for the host fix of 21 Oct (a tree read that never
 * lands wedged every attach for hours): the journey churns agent panes the
 * way a busy computer does, and requires a fresh attach after every round.
 * On the 0.2.9 host the first refused status watch wedges the tree and the
 * attach never comes back; on a fixed host the host restarts its Herdr kit
 * and the next attach lands.
 *
 * Every attach is judged by the host's own log, not by the screen alone: the
 * host logs one line per terminal stream it really attached, and a screen
 * that still shows the last pane says nothing about a new attach.
 *
 * Captures are lab-only. A screen that shows the computer's own shell prompt
 * or path (a raw shell pane, or Home with the person's other agents on it)
 * is never kept: the journey drops those frames and never shoots them.
 *
 * It is the stable release's journey too (scripts/release): with PHONE_PACKAGE
 * set to the release's npm tarball, the lab host and relay run from that
 * tarball installed, not from this checkout, and after typing it scrolls the
 * agent's history back and forth fast, opens Usage and comes back, and counts
 * the hosts alive. It writes `release-build.json`: the version, the sha256 of
 * the APK and tarball it ran, each step's result, the host count, and the
 * attach and scroll times. The release gate reads that file against the
 * budgets in scripts/release/domain/releaseJourney.mjs.
 *
 * Never run against a host that is not a lab: it pairs, closes panes and
 * types. Only the test phone, only this app, never the captain's screens.
 * Usage (inside the phone's keeper lock or the emulator lock, with a Herdr lab helper set):
 *
 *   PHONE_SERIAL=a4b93ea2 DONE_DONE_EVIDENCE_ROOT=<dir> PHONE_ATTACH_ROOT=<short scratch> \
 *     PHONE_APK=<release apk> PHONE_PACKAGE=<release tarball> \
 *     node scripts/diagnostics/application/checkPhoneAttach.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const [evidence, root] = [process.env.DONE_DONE_EVIDENCE_ROOT, process.env.PHONE_ATTACH_ROOT];
if (!evidence || !root) throw new Error('phone-attach needs DONE_DONE_EVIDENCE_ROOT (evidence) and PHONE_ATTACH_ROOT (scratch)');
const repo = process.cwd();
const serial = process.env.PHONE_SERIAL;
if (serial !== 'a4b93ea2' && !/^emulator-\d+$/.test(serial ?? '')) throw new Error('phone-attach runs on the test phone a4b93ea2 under its keeper lock, or on an emulator this run owns');
const apk = process.env.PHONE_APK || undefined;
const tarball = process.env.PHONE_PACKAGE || undefined;
const rounds = Number(process.env.PHONE_ATTACH_ROUNDS ?? 18);
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const PKG = 'com.trymuxr.app';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(evidence, { recursive: true });
const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    process.stdout.write(`${line}\n`);
    appendFileSync(join(evidence, 'journey.log'), `${line}\n`);
};
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120_000 });
const sh = (command) => adb('shell', command);
// The home screen also lists the computer's own agents, so nothing here ever
// keeps a dump of it: a screen is judged by what the journey knows it is.
const dump = () => {
    for (let attempt = 1; ; attempt += 1) {
        try {
            sh('uiautomator dump /sdcard/d.xml >/dev/null');
            const xml = adb('exec-out', 'cat', '/sdcard/d.xml');
            sh('rm -f /sdcard/d.xml');
            return xml;
        } catch (error) {
            if (attempt === 3) throw error;
            log(`ui dump stalled (attempt ${attempt}); retrying`);
        }
    }
};
// A screen that shows the computer's own shell prompt or path is never kept:
// a raw shell pane's title is user@host:/path, and the phone's header shows it.
const LEAK = /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\/|\/home\/[A-Za-z0-9._-]+/;
// The lab host runs on the captain's computer, so it answers to the captain's
// own machine name. The phone shows that name on Home and on the pairing
// screen, and no capture may keep it.
let machineName = '';
const namesComputer = (xml) => machineName !== '' && xml.includes(machineName);
const shot = (name) => {
    const xml = dump();
    if (!xml.includes('Terminal surface')) { log(`skipped ${name}: not a terminal screen`); return; }
    if (namesComputer(xml) || LEAK.test(xml)) { log(`skipped ${name}: the screen shows the computer's own name`); return; }
    // The status bar is cropped off: it shows the phone's own notification icons, which are not part of this journey.
    const raw = join(root, `${name}.raw.png`);
    writeFileSync(raw, execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 120_000 }));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', 'crop=iw:ih-120:0:120', join(evidence, `${name}.png`)]);
    rmSync(raw);
    log(`captured ${name}`);
};
const tapNode = async (pattern, seconds = 90, className, optional = false) => {
    for (let second = 0; second < seconds; second += 2) {
        for (const node of dump().match(/<node\s[^>]*>/g) ?? []) {
            const text = /text="([^"]*)"/.exec(node)?.[1] ?? '';
            const description = /content-desc="([^"]*)"/.exec(node)?.[1] ?? '';
            if (className ? !node.includes(`class="${className}"`) : (!pattern.test(text) && !pattern.test(description))) continue;
            const [, x1, y1, x2, y2] = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).map(Number);
            const [width, height] = /(\d+)x(\d+)/.exec(sh('wm size').split('\n').filter(Boolean).pop()).slice(1).map(Number);
            // A control below the fold (an "already paired" note pushes Pair down) takes no tap: scroll first.
            if (!className && (y2 > height - 120 || y1 < 0)) {
                log(`${pattern} at y ${y1}-${y2} of ${height}; scrolling`);
                sh(`input swipe ${width >> 1} ${Math.round(height * 0.75)} ${width >> 1} ${Math.round(height * 0.3)} 150`);
                await sleep(1500);
                break;
            }
            sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
            log(`tapped ${text || description}`);
            return true;
        }
        await sleep(2000);
    }
    if (optional) { log(`no ${pattern} on screen`); return false; }
    // Only fixed words, never the screen's own names: the phone also holds the computer's agents.
    const xml = dump();
    log(`screen words: ${['Pair', 'Paired', 'Approve', 'New tab', 'Send', 'Terminal surface', 'still connecting', 'connecting'].map((word) => `${word}=${xml.includes(word)}`).join(' ')}`);
    throw new Error(`never saw ${pattern}`);
};

// A recording of the lab screens only. `adb screenrecord` is denied on this
// phone, so the frames are screencaps stitched by ffmpeg afterwards. Frames
// taken while a screen that must not be kept was up are dropped, not shown.
const frames = join(root, 'frames');
mkdirSync(frames, { recursive: true });
const flag = join(root, 'recording.on');
const leakWindows = [];
let recorder;
const recordOn = (why) => {
    writeFileSync(flag, '');
    recorder = spawn('bash', ['-c', `while [ -e ${flag} ]; do timeout 25 adb -s ${serial} exec-out screencap -p > ${frames}/$(date +%s%3N).png || rm -f ${frames}/*.png.tmp; sleep 0.2; done`], { stdio: 'ignore' });
    log(`recording on: ${why}`);
};
const recordOff = async (why) => {
    if (!existsSync(flag)) return;
    rmSync(flag);
    await new Promise((resolve) => recorder.on('exit', resolve));
    log(`recording off: ${why}`);
};
const record = () => {
    let dropped = 0;
    for (const name of readdirSync(frames)) {
        if (!name.endsWith('.png')) continue;
        const at = Number(name.replace('.png', ''));
        if (leakWindows.some(([from, to]) => at >= from && at <= to)) { unlinkSync(join(frames, name)); dropped += 1; }
    }
    const shots = readdirSync(frames).filter((name) => name.endsWith('.png')).sort();
    if (shots.length < 4) return;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '4', '-pattern_type', 'glob', '-i', `${frames}/*.png`,
        '-vf', 'crop=iw:ih-216:0:120,scale=540:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(evidence, 'phone-attach.mp4')], { stdio: 'ignore' });
    log(`video: phone-attach.mp4 from ${shots.length} frames (${dropped} dropped as the computer's own screen)`);
};

// The phone's own state: a terminal surface with nothing wrong on it.
const PILL = /text="[^"]*(?:Connecting|connecting)[^"]*"|content-desc="(?:Reconnect terminal|Use this terminal here)[^"]*"|text="[^"]*Connection unconfirmed[^"]*"|text="[^"]*Could not draw[^"]*"/;
const surface = (xml) => xml.includes('Terminal surface') && !PILL.test(xml);

const work = join(root, 'w');
const bin = join(work, 'bin');
mkdirSync(join(work, 'muxr'), { recursive: true });
mkdirSync(bin, { recursive: true });
// The stand-in agent: it clears the screen it starts in, so the pane never
// shows the computer's own shell prompt, and it echoes what it is sent.
writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '\\033]2;%s\\007' 'Fix the login page'\nsleep 1\nprintf '\\033[3J\\033[2J\\033[H'\necho 'lab agent ready'\nwhile read -r line; do case "$line" in rows) i=1; while [ $i -le 400 ]; do echo "row $i of the lab agent's history"; i=$((i+1)); done ;; *) echo "lab agent got: $line" ;; esac; done\nwhile :; do sleep 3600; done\n`, { mode: 0o755 });

let offering;
let paired = false;
const mintNativePairing = (socketPath) => new Promise((resolve, reject) => {
    const socket = (offering = createConnection(socketPath));
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

let lab;
let verdict = 'not reached';
let installed = 'unknown';
// The host logs one line per terminal stream it really attached.
const attaches = () => (lab?.hostOutput().match(/link: terminal stream attached/g) ?? []).length;

// The phone is attached when its screen shows a terminal and the host logged a
// new terminal stream: a screen that still shows the last pane proves nothing.
// `since` is when the person asked for the agent; the time to attach counts from there.
let attachedMs;
const waitAttached = async (before, since = Date.now(), budget = 90) => {
    for (let second = 0; second < budget; second += 1) {
        const xml = dump();
        if (surface(xml) && attaches() > before) {
            attachedMs = Date.now() - since;
            return `attached in ${(attachedMs / 1000).toFixed(1)}s`;
        }
        // A refused attempt leaves the phone a retry to press; the person presses it.
        if (/content-desc="Reconnect terminal/.test(xml)) await tapNode(/^Reconnect terminal/, 4, undefined, true);
        await sleep(1000);
    }
    return surface(dump())
        ? 'the screen shows a terminal but the host attached no new stream'
        : 'no terminal surface';
};

// Waits until the phone has left the screen that carries the computer's name.
const waitOffHome = async (budget = 40) => {
    for (let second = 0; second < budget; second += 1) {
        if (!namesComputer(dump())) return;
        await sleep(1000);
    }
};

// Opens the lab agent on the phone again. Home is on screen in between, so
// those frames are dropped.
const openAgentAgain = async (what) => {
    const before = attaches();
    const from = Date.now();
    sh('input keyevent KEYCODE_BACK');
    await sleep(2000);
    await tapNode(/umer-lab/, 60);
    await waitOffHome();
    leakWindows.push([from - 500, Date.now()]);
    const verdict = await waitAttached(before, from);
    if (!verdict.startsWith('attached')) log(`${what}: ${verdict}`);
    return verdict;
};

// What the release gate reads: each step's result, the hosts alive at the end, and the timed steps.
const { RELEASE_JOURNEY, RELEASE_STEPS } = await import(join(repo, 'scripts/release/domain/releaseJourney.mjs'));
const steps = Object.fromEntries(RELEASE_STEPS.map((step) => [step, 'not reached']));
const timings = {};
let hosts;
let packageDir;
let apkDigest = null;
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
// The digest of the APK the device actually runs, read on the device: with
// PHONE_USE_INSTALLED it is the only record of which build was driven. A split
// install has no single release APK to compare, so it records none.
const installedApkDigest = () => {
    const paths = sh(`pm path ${PKG}`).trim().split('\n').map((line) => line.trim().replace(/^package:/, '')).filter(Boolean);
    if (paths.length !== 1) return null;
    return /^([0-9a-f]{64})\s/.exec(sh(`sha256sum '${paths[0]}'`))?.[1] ?? null;
};

// Hosts alive: processes in the lab host's own process tree that hold a link to
// the lab relay. 0.2.8's Usage ledger child booted a second host from the
// bundle; that one dials the relay too and counts here.
const hostsAlive = () => {
    const [, hostPid] = lab.pids();
    const table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((row) => row.trim().split(/\s+/).map(Number));
    const tree = new Set([hostPid]);
    for (let grew = true; grew;) {
        grew = false;
        for (const [pid, parent] of table) if (tree.has(parent) && !tree.has(pid)) { tree.add(pid); grew = true; }
    }
    const links = execFileSync('ss', ['-tnpH', 'state', 'established', `dport = :${lab.port}`], { encoding: 'utf8' });
    return new Set([...links.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])).filter((pid) => tree.has(pid))).size;
};

try {
    // The release's npm tarball, installed the way a person installs it; the lab host and relay run from it.
    if (tarball !== undefined) {
        const prefix = join(root, 'pkg');
        execFileSync('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { stdio: 'ignore', timeout: 600_000 });
        packageDir = join(prefix, 'node_modules', '@trymuxr', 'cli');
        process.env.MUXR_LAB_PACKAGE_DIR = packageDir;
        log(`lab host from ${tarball}: @trymuxr/cli ${JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version}`);
    }
    // The journey installs the exact release build, on a fresh app data dir:
    // an install over an existing app would keep a pairing to another computer.
    // PHONE_USE_INSTALLED=1 drives the app already on the phone as it is instead, and installs nothing.
    if (apk === undefined && process.env.PHONE_USE_INSTALLED !== '1') throw new Error('PHONE_APK must point at the release build to install (or PHONE_USE_INSTALLED=1 to drive the installed app)');
    if (apk !== undefined) {
        try { adb('uninstall', PKG); } catch { /* the app was not installed yet */ }
        adb('install', apk);
    }
    const versionText = sh(`dumpsys package ${PKG} | grep versionName`).trim();
    installed = /versionName=([\d.]+)/.exec(versionText)?.[1] ?? 'unknown';
    apkDigest = installedApkDigest();
    if (apk !== undefined && apkDigest !== sha256(apk)) throw new Error(`the device runs APK ${apkDigest} after installing ${apk}`);
    log(`the device runs APK ${apkDigest}`);
    log(`${apk === undefined ? 'driving the installed app' : `installed from ${apk}`}: ${versionText}`);
    const activity = sh(`cmd package resolve-activity --brief ${PKG}`).trim().split('\n').pop();
    mkdirSync(join(root, 'lab'), { recursive: true });
    lab = await linkHerdrLab(join(root, 'lab'), 'attach', undefined, (herdr) => {
        for (const [index, label] of ['login-fix', 'gone-fix'].entries()) {
            herdr(['workspace', 'create', '--cwd', join(work, 'muxr'), '--label', label, '--no-focus']);
            log(`lab agent pane ${index + 1} created`);
        }
    });
    log(`lab host up on relay port ${lab.port}`);
    machineName = lab.machine?.name ?? '';
    log(`the lab host answers to ${machineName}; no capture may keep that name`);
    const panes = JSON.parse(lab.herdr(['pane', 'list'])).result.panes;
    const [keep, doomed] = panes;
    for (const [pane, name] of [[keep, 'umer-lab'], [doomed, 'gone-lab']]) {
        lab.herdr(['pane', 'send-text', pane.pane_id, `${join(bin, 'claude')}\n`]);
        await sleep(1500);
        lab.herdr(['agent', 'rename', pane.pane_id, name]);
    }
    adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
    const reachable = sh(`toybox nc -w 5 127.0.0.1 ${lab.port} </dev/null >/dev/null 2>&1 && echo reachable || echo unreachable`).trim();
    log(`phone -> lab relay 127.0.0.1:${lab.port} (adb reverse): ${reachable}`);
    if (reachable !== 'reachable') throw new Error('the phone cannot reach the lab relay');

    // Pair, the way a person does: the computer offers, the phone consents.
    const offer = await mintNativePairing(join(root, 'lab', 'host', 'pair.sock'));
    sh('input keyevent KEYCODE_WAKEUP');
    sh('wm dismiss-keyguard');
    // A stopped app opens on Home; a running one resumes wherever it was left, and Back from the agent would land there.
    sh(`am force-stop ${PKG}`);
    sh(`am start -n ${activity}`);
    await sleep(6000);
    for (let attempt = 1; ; attempt += 1) {
        try { sh(`am start -a android.intent.action.VIEW -d 'muxr://pair#${offer}' -n ${activity}`); break; }
        catch (error) { if (attempt === 3) throw error; log(`pair intent attempt ${attempt} failed; retrying`); await sleep(3000); }
    }
    await sleep(1500);
    // No recording here: the consent screen names the computer, and the journey's
    // captures are lab-only. The pairing itself is in journey.log and host.log.
    await tapNode(/^Pair$/, 120);
    for (let second = 0; second < 30 && !paired; second += 1) await sleep(1000);
    offering?.destroy();
    if (!paired) throw new Error('the host never saw the pairing approval');
    steps.pair = 'pass';
    await sleep(6000);

    // Open the agent: the terminal has to land, not sit on connecting.
    const beforeOpen = attaches();
    const from = Date.now();
    await recordOn('the lab agent terminal');
    await tapNode(/umer-lab/, 120);
    await waitOffHome();
    leakWindows.push([from - 500, Date.now()]);
    const first = await waitAttached(beforeOpen, from);
    log(`first attach: ${first}; host attached ${attaches() - beforeOpen} stream(s)`);
    if (!first.startsWith('attached')) throw new Error(`the phone never attached: ${first}`);
    timings.attachMs = attachedMs;
    await sleep(3000);
    shot('01-agent-attached');

    // A pane closes under the phone's feet: the tree changes under it, and the
    // phone has to open an agent again on the tree that is left.
    try { lab.herdr(['pane', 'close', doomed.pane_id]); log('closed the second agent pane'); }
    catch { log('the second agent pane was already gone'); }
    await sleep(4000);
    const afterClose = await openAgentAgain('attach after a close');
    log(`attach after the close: ${afterClose}`);
    if (!afterClose.startsWith('attached')) throw new Error(afterClose);
    await sleep(2000);
    shot('02-attach-after-a-close');

    // A busy computer: agent panes come up and go again. After each round the
    // phone must still be able to open one. This is where a 0.2.9 host stops.
    let round = 0;
    for (; round < rounds; round += 1) {
        const churn = JSON.parse(lab.herdr(['workspace', 'create', '--cwd', join(work, 'muxr'), '--label', `churn-${round}`, '--no-focus'])).result.root_pane.pane_id;
        lab.herdr(['pane', 'send-text', churn, `${join(bin, 'claude')}\n`]);
        await sleep(150 + (round % 7) * 60);
        try { lab.herdr(['pane', 'close', churn]); } catch { /* the pane's own agent ended it */ }
        lab.herdr(['workspace', 'create', '--cwd', join(work, 'muxr'), '--label', `trigger-${round}`, '--no-focus']);
        if (round % 3 === 0) {
            const again = await openAgentAgain(`round ${round}`);
            log(`round ${round}: ${again}`);
            if (!again.startsWith('attached')) { verdict = `stuck after ${round + 1} rounds: ${again}`; break; }
        }
    }
    shot(verdict.startsWith('stuck') ? '03-stuck-after-pane-churn' : '03-attached-after-pane-churn');
    if (verdict.startsWith('stuck')) throw new Error(verdict);
    steps.attach = 'pass';
    log(`every attach landed through ${rounds} rounds of agent panes coming and going`);

    // Type at it, and read the answer back out of the pane itself.
    const word = `lab-typed-${Date.now() % 100000}`;
    await tapNode(/^$/, 10, 'android.widget.EditText');
    await sleep(800);
    sh(`input text 'echo ${word}'`);
    await sleep(800);
    await tapNode(/^Send$/, 20);
    let echoed = false;
    for (let tries = 0; tries < 30 && !echoed; tries += 1) {
        await sleep(1000);
        const live = JSON.parse(lab.herdr(['pane', 'list'])).result.panes;
        echoed = live.some((pane) => { try { return lab.herdr(['pane', 'read', pane.pane_id]).split(word).length > 2; } catch { return false; } });
    }
    await sleep(4000);
    shot('04-typed-command-and-output');
    if (!echoed) throw new Error('the typed command never printed');
    if (!surface(dump())) throw new Error('the screen was not clean after typing');
    steps.send = 'pass';
    log(`typed "echo ${word}" and a pane printed it`);

    // Scroll the agent's history back and forward fast, the way a thumb does.
    // Each direction is timed from the first fling until the phone shows it
    // arrived: Latest offered once back in history, gone once at the newest output.
    // The whole input_method dump runs past a megabyte on some phones: only the one flag leaves the device.
    if (sh('dumpsys input_method | grep -q mInputShown=true && echo shown || echo hidden').trim() === 'shown') { sh('input keyevent KEYCODE_BACK'); await sleep(1000); }
    lab.herdr(['pane', 'send-text', keep.pane_id, 'rows\n']);
    await sleep(5000);
    const [width, height] = /(\d+)x(\d+)/.exec(sh('wm size').split('\n').filter(Boolean).pop()).slice(1).map(Number);
    const fling = (from, to) => sh(`input swipe ${width >> 1} ${Math.round(height * from)} ${width >> 1} ${Math.round(height * to)} 60`);
    const LATEST = /content-desc="Jump to latest output/;
    const scrollUntil = async (from, to, arrived) => {
        const since = Date.now();
        for (let burst = 0; burst < 6; burst += 1) {
            for (let flick = 0; flick < 3; flick += 1) fling(from, to);
            for (let look = 0; look < 3; look += 1) if (arrived(dump())) return Date.now() - since;
        }
        return undefined;
    };
    const back = await scrollUntil(0.3, 0.7, (xml) => LATEST.test(xml) && xml.includes('Terminal surface'));
    log(back === undefined ? 'scrolling back never left the newest output' : `scrolled back into history in ${back} ms`);
    if (back === undefined) throw new Error('scrolling back never left the newest output');
    shot('05-scrolled-back');
    const forward = await scrollUntil(0.7, 0.3, (xml) => !LATEST.test(xml) && surface(xml));
    log(forward === undefined ? 'scrolling forward never reached the newest output' : `scrolled forward to the newest output in ${forward} ms`);
    if (forward === undefined) throw new Error('scrolling forward never reached the newest output');
    timings.scrollMs = Math.max(back, forward);
    steps.scroll = 'pass';
    shot('06-scrolled-to-latest');

    // Usage, and back to the agent. The Usage read starts the host's ledger
    // child, which in 0.2.8 booted a second host instead of counting.
    await tapNode(/^Pane actions/, 30);
    await sleep(1000);
    await tapNode(/^Usage$/, 30);
    let onUsage = false;
    for (let second = 0; second < 30 && !onUsage; second += 1) {
        const xml = dump();
        onUsage = !xml.includes('Terminal surface') && /(?:text|content-desc)="Usage"/.test(xml);
        if (!onUsage) await sleep(1000);
    }
    if (!onUsage) throw new Error('Usage never opened');
    log('Usage open');
    await sleep(10_000);
    sh('input keyevent KEYCODE_BACK');
    let backOnAgent = false;
    for (let second = 0; second < 30 && !backOnAgent; second += 1) {
        backOnAgent = surface(dump());
        if (!backOnAgent) await sleep(1000);
    }
    if (!backOnAgent) throw new Error('coming back from Usage never showed the agent again');
    steps.usage = 'pass';
    shot('07-back-from-usage');

    hosts = hostsAlive();
    log(`hosts alive: ${hosts}`);
    if (hosts !== 1) throw new Error(`${hosts} hosts alive after Usage, not exactly one`);
    steps['one-host'] = 'pass';
    verdict = `pass: attached through ${rounds} churn rounds, typed output shown, scrolled back and forward, Usage and back, one host`;
} catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    if (verdict === 'not reached') verdict = `fail: ${cause}`;
    throw error;
} finally {
    await recordOff('journey over');
    record();
    log(`verdict: ${verdict}`);
    let version = installed;
    if (packageDir !== undefined) {
        version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
        if (version !== installed) log(`the app is ${installed} but the host is ${version}`);
    }
    writeFileSync(join(evidence, 'release-build.json'), `${JSON.stringify({
        schema: 1, journey: RELEASE_JOURNEY, version,
        build: { apk: apkDigest, package: tarball === undefined ? null : sha256(tarball) },
        result: verdict.startsWith('pass') && version === installed ? 'pass' : 'fail', steps, hosts: hosts ?? null, timings,
    }, null, 2)}\n`);
    // done-done's step record: what a user did and what they saw, from the verdict this run reached.
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: installed },
        start: `${apk === undefined ? 'the release app already installed on the phone, restarted' : 'the release app freshly installed on the phone'}, with a lab computer running two agent panes that the phone is not yet paired to`,
        steps: ['pair the phone to the lab computer', 'open an agent', 'close agent panes and attach again through pane churn', 'type a command at the agent',
            'scroll its history back and forward fast', 'open Usage and come back', 'count the hosts alive'],
        result: verdict.startsWith('pass') ? 'the phone attached after every round of pane churn, the typed command printed its output on a clean screen, the history scrolled back and forward, Usage opened and closed, and one host stayed alive' : verdict,
    }, null, 2)}\n`);
    if (lab) writeFileSync(join(evidence, 'host.log'), lab.hostOutput()
        .replace(/pairing string[^\n]*/g, '<pairing>').replace(/muxr:\/\/pair#\S*/g, '<offer>'));
    offering?.destroy();
    try { sh(`am force-stop ${PKG}`); sh('input keyevent KEYCODE_HOME'); } catch { /* the phone is gone */ }
    if (lab) { try { adb('reverse', '--remove', `tcp:${lab.port}`); } catch { /* nothing to remove */ } }
    await lab?.stop();
}
