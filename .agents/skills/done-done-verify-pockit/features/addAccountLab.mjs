// Add a Claude account from the phone on a real (lab) Herdr and host: Accounts › Add a Claude
// account › Open Claude sign-in, the code typed into the sign-in tab's composer, and the flow
// ends on "Name this account" and the account in the Accounts list, with the sign-in tab closed. See add-account.md.
// Run from the repo root with HERDR_LAB_HELPER set:
//   node .agents/skills/done-done-verify-pockit/features/addAccountLab.mjs <apk> <evidenceDir> <labRoot>
// With `-` for <apk> it sends the code through session.prompt from the lab link, with no phone.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';

const [apk, evidence, root] = process.argv.slice(2);
const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const { requestLab } = await import(join(repo, 'scripts/diagnostics/application/linkLabClient.mjs'));
const PKG = 'com.trymuxr.app';
// Short enough for one `adb input text`; a stand-in code, never a real one.
const CODE = 'umerlabcode0123#labstate';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };

// Stand-in `claude`, shaped like the real 2.1.x `auth login --claudeai`: it waits for a pasted
// `code#state` line, says "Login successful.", and keeps its prompt open for a few seconds after,
// where any further line prints "Invalid code..." as the real one does. It notes every line it
// reads so the journey can tell one send from two. Never a real account.
const work = join(root, 'w');
const bin = join(work, 'bin');
mkdirSync(bin, { recursive: true });
rmSync(join(work, 'lines.log'), { force: true });
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env python3
import os, select, sys, time
lab = ${JSON.stringify(work)}
folder = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
account = os.path.join(folder, 'lab-account.json')
args = sys.argv[1:]
if args[:2] == ['auth', 'status']:
    if os.path.exists(account): print(open(account).read()); sys.exit(0)
    print('{"loggedIn":false,"authMethod":"none"}'); sys.exit(1)
if args[:2] != ['auth', 'login']: time.sleep(86400); sys.exit(0)
def line():
    text = sys.stdin.readline()
    with open(os.path.join(lab, 'lines.log'), 'a') as seen: seen.write('%r\\n' % text)
    return text.strip()
print('Opening browser to sign in...')
print('If the browser did not open, visit: https://claude.example/lab-sign-in')
while True:
    sys.stdout.write('Paste code here if prompted > '); sys.stdout.flush()
    if '#' in line(): break
    print('Invalid code. Please make sure the full code was copied.')
os.makedirs(folder, exist_ok=True)
with open(account, 'w') as out: out.write('{"loggedIn":true,"authMethod":"claude.ai","email":"umer.work@example.com","subscriptionType":"max"}\\n')
print('Login successful.')
end = time.time() + 4
while time.time() < end:
    if select.select([sys.stdin], [], [], max(0, end - time.time()))[0]:
        line(); print('Invalid code. Please make sure the full code was copied.')
`, { mode: 0o755, flag: 'wx' });
// The lab Herdr, its panes and the host find only the stand-in, never an installed Claude.
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.HOME ?? '', 'Android/Sdk');
process.env.PATH = [bin, dirname(process.execPath), join(sdk, 'platform-tools'), join(sdk, 'emulator'), '/usr/bin', '/bin'].join(':');

let offering;
const mintPairing = (path) => new Promise((resolve, reject) => {
    const socket = offering = createConnection(path);
    let pending = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind: 'native', authority: 'control', personal: false } })}\n`));
    socket.on('data', (chunk) => {
        pending += String(chunk);
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const event = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            if (event.offer) resolve(event.offer.text);
            if (event.approval) { socket.write('{"yes":true}\n'); log('device paired'); }
            if (event.error) reject(new Error(event.error));
        }
    });
});

let lab;
let emu;
let recorder;
let failed = false;
const herdr = (...args) => lab.herdr(args, 30_000);
const ask = (type, params) => requestLab(lab.link, type, params);
const panes = () => JSON.parse(herdr('pane', 'list')).result.panes;
const linesRead = () => (existsSync(join(work, 'lines.log')) ? readFileSync(join(work, 'lines.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
// The host's account row, once the add has finished.
const added = async () => {
    const claude = (await ask('plans.list', {})).providers?.find((entry) => entry.provider === 'claude');
    return claude?.accounts.find((account) => account.email === 'umer.work@example.com' && account.signedIn);
};
// After the add: one line reached the sign-in, and its tab is gone from Herdr.
const checkHost = (signInPane) => {
    const lines = linesRead();
    writeFileSync(join(evidence, 'sign-in-lines.txt'), `${lines.join('\n')}\n`);
    if (lines.length !== 1) throw new Error(`the sign-in read ${lines.length} lines for one send`);
    if (panes().some((pane) => pane.pane_id === signInPane)) throw new Error('the sign-in tab is still open');
    log('the sign-in read exactly one line, and its tab is closed');
};
try {
    mkdirSync(join(root, 'lab'), { recursive: true });
    lab = await linkHerdrLab(join(root, 'lab'), 'aa', undefined, (run, session) => {
        // plans.add installs Herdr's Claude hook through Herdr, and the guarded helper pins every
        // Herdr call's CLAUDE_CONFIG_DIR to its own home: that folder has to exist for the install.
        const state = process.env.FM_HERDR_LAB_STATE_DIR ?? join(process.env.TMPDIR ?? '/tmp', `fm-herdr-lab-${process.getuid()}`);
        mkdirSync(join(readFileSync(join(state, `${session}.xdg-root`), 'utf8').trim(), 'home', '.claude'), { recursive: true });
        run(['workspace', 'create', '--cwd', work, '--label', 'lab', '--no-focus']);
    });
    log(`lab host up on relay port ${lab.port}`);

    if (apk === '-') {
        const started = await ask('plans.add', { provider: 'claude' });
        const signInPane = started.sessionId.replace(/^shell:/, '');
        let route;
        for (const deadline = Date.now() + 30_000; route === undefined; await sleep(1000)) {
            if (Date.now() > deadline) throw new Error('Herdr never saw Claude in the sign-in tab');
            const tree = await ask('herdr.tree', {});
            route = tree.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.paneId === signInPane && p.agentKind === 'claude')?.sessionId;
        }
        await sleep(2000);
        await ask('session.prompt', { sessionId: route, text: CODE });
        log('sent the code as the phone composer does');
        for (const deadline = Date.now() + 60_000; ; await sleep(2000)) {
            const status = await ask('plans.status', { accountId: started.accountId });
            if (status.account.signedIn) break;
            if (status.failure !== undefined) throw new Error(status.failure);
            if (Date.now() > deadline) throw new Error('the account never signed in');
        }
        checkHost(signInPane);
        log('PASS: account added (host only)');
        throw Object.assign(new Error('host-only run finished'), { done: true });
    }

    emu = await bootOwnedEmulator({
        name: 'mxaa', avdHome: process.env.AVD_HOME ?? join(root, 'avd'),
        systemImage: 'system-images;android-35;google_apis;x86_64', launcher: ['nice', '-n', '10'],
    });
    const serial = emu.serial;
    log(`emulator ${serial}`);
    const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120_000 });
    const sh = (cmd) => adb('shell', cmd);
    const dump = () => { sh('uiautomator dump /sdcard/d.xml >/dev/null'); return adb('exec-out', 'cat', '/sdcard/d.xml'); };
    const waitFor = async (re, seconds = 60) => {
        for (let i = 0; i < seconds; i += 2) { const xml = dump(); if (re.test(xml)) return xml; await sleep(2000); }
        throw new Error(`never saw ${re}`);
    };
    const tapText = async (re, seconds = 60) => {
        for (let i = 0; i < seconds; i += 2) {
            for (const node of dump().match(/<node\s[^>]*>/g) ?? []) {
                const text = /text="([^"]*)"/.exec(node)?.[1] ?? '';
                const desc = /content-desc="([^"]*)"/.exec(node)?.[1] ?? '';
                if (!re.test(text) && !re.test(desc)) continue;
                const [, x1, y1, x2, y2] = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).map(Number);
                sh(`input tap ${(x1 + x2) >> 1} ${(y1 + y2) >> 1}`);
                return;
            }
            await sleep(2000);
        }
        throw new Error(`never saw ${re}`);
    };
    const shot = (name) => { writeFileSync(join(evidence, `${name}.png`), execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'])); log(`captured ${name}`); };

    // Under load the package service answers well after boot completes, and a release APK
    // outlasts the usual adb bound.
    for (let attempt = 1; ; attempt++) {
        try {
            for (const deadline = Date.now() + 300_000; !/package:/.test(adb('shell', 'pm', 'path', 'android')); await sleep(5000)) {
                if (Date.now() > deadline) throw new Error('package service never answered');
            }
            execFileSync('adb', ['-s', serial, 'install', '-r', apk], { encoding: 'utf8', timeout: 180_000 });
            break;
        }
        catch (error) { if (attempt === 4) throw error; log(`install retry ${attempt}`); await sleep(30_000); }
    }
    log('installed');
    const activity = sh(`cmd package resolve-activity --brief ${PKG}`).trim().split('\n').pop();
    sh(`pm clear ${PKG}`);
    adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
    sh('wm size 1080x2376'); sh('wm density 440'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no');
    const offer = await mintPairing(join(root, 'lab', 'host', 'pair.sock'));
    sh(`am start -W -n ${activity}`);
    await sleep(4000);
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr://pair#${offer}' -n ${activity}`);
    await tapText(/^Pair$/, 180);
    log('pairing');
    // The Accounts screen lists Claude only once the paired host answers.
    await sleep(5000);
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr:///settings/accounts' -n ${activity}`);
    await waitFor(/text="Add a Claude account"/, 90);
    offering?.destroy();
    recorder = spawn('adb', ['-s', serial, 'shell', 'screenrecord', '--time-limit', '170', '/sdcard/add.mp4'], { stdio: 'ignore' });
    await tapText(/^Add a Claude account$/);
    await waitFor(/text="Open Claude sign-in"/);
    shot('1-add-sheet');
    await tapText(/^Open Claude sign-in$/);
    // The sign-in tab, once Herdr sees Claude in it. Its "Signing in…" banner is recorded, not
    // required: the add must still end on "Name this account" below.
    const tab = await waitFor(/text="Sign in · Claude"/, 90);
    log(`sign-in banner ${/Signing in your Claude account/.test(tab) ? 'shown' : 'not shown'}`);
    const signInPane = panes().find((pane) => pane.agent === 'claude')?.pane_id;
    if (signInPane === undefined) throw new Error('no sign-in tab in Herdr');
    await sleep(3000);
    shot('2-sign-in-tab');
    // The code goes in as a person pastes it: into the composer, then Send.
    await tapText(/^Prompt$/);
    sh(`input text '${CODE}'`);
    await sleep(1000);
    shot('3-code-in-composer');
    await tapText(/^Send$/);
    log('sent the code from the composer');
    // The add ends on naming the account. If it stalls, find out whether the phone still holds
    // the pending sign-in: with one pending, opening another sign-in says it is already open.
    try {
        await waitFor(/text="Name this account"/, 90);
    } catch (error) {
        shot('4-stalled');
        sh(`am start -W -a android.intent.action.VIEW -d 'muxr:///settings/accounts' -n ${activity}`);
        await tapText(/^Add a Claude account$/);
        await tapText(/^Open Claude sign-in$/);
        await sleep(3000);
        shot('4-stalled-second-open');
        log(`pending sign-in on the phone: ${/Sign-in is already open/.test(dump()) ? 'still held' : 'gone (a second sign-in opened)'}`);
        throw error;
    }
    await sleep(1500);
    shot('4-name-this-account');
    checkHost(signInPane);
    const named = /text="([^"]+)"[^>]*content-desc="Account name"|content-desc="Account name"[^>]*text="([^"]+)"/.exec(dump());
    const name = named?.[1] ?? named?.[2];
    await tapText(/^Save$/);
    for (const deadline = Date.now() + 30_000; dump().includes('text="Name this account"'); await sleep(1000)) {
        if (Date.now() > deadline) throw new Error('Save never closed the naming sheet');
    }
    const row = await added();
    if (row === undefined) throw new Error('the host has no signed-in umer.work@example.com account');
    if (name !== undefined && row.name !== name) throw new Error(`the host named it ${row.name}, not ${name}`);
    log(`host lists ${row.name} <${row.email}> signed in`);
    // The account in the phone's own list. (The Added notice and the step back off the closed
    // tab hang on the sign-in banner's on-tab check, which a separate fix owns.)
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr:///settings/accounts' -n ${activity}`);
    await waitFor(/umer\.work@example\.com/, 60);
    await sleep(1000);
    shot('5-accounts-list');
    // done-done's step record: what this run drove and what the captures show.
    const version = sh(`dumpsys package ${PKG} | grep -m1 versionName`).trim().replace(/^versionName=/, '');
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: `muxr ${version} release APK on an emulator` },
        start: 'a fresh install of muxr paired to a lab computer on a private Herdr, with a stand-in Claude CLI that signs in when its code is pasted',
        steps: ['Settings, Accounts, Add a Claude account', 'Open Claude sign-in', 'Type the sign-in code into the sign-in tab\'s composer and tap Send', 'Save the suggested name'],
        result: 'adding a Claude account from the phone ends on the account added screen. 4-name-this-account.png shows the "Name this account" sheet signed in as umer.work@example.com, and 5-accounts-list.png the saved account listed on the Accounts screen; the sign-in tab is closed and the sign-in read exactly one line (sign-in-lines.txt). 1-add-sheet.png, 2-sign-in-tab.png and 3-code-in-composer.png are the steps before',
    }, null, 2)}\n`);
    log('PASS: account added from the phone');
} catch (error) {
    failed = error?.done !== true;
    if (emu !== undefined) {
        // The app's own warnings for the run, whatever the outcome.
        try { writeFileSync(join(evidence, 'app-log.txt'), execFileSync('adb', ['-s', emu.serial, 'logcat', '-d', '-s', 'ReactNativeJS:V'], { encoding: 'utf8' })); } catch { /* the emulator is gone */ }
    }
    if (failed && emu !== undefined) {
        // The phone's screen and its view tree at the step that stalled.
        try {
            writeFileSync(join(evidence, 'failure.png'), execFileSync('adb', ['-s', emu.serial, 'exec-out', 'screencap', '-p']));
            execFileSync('adb', ['-s', emu.serial, 'shell', 'uiautomator dump /sdcard/d.xml >/dev/null']);
            writeFileSync(join(evidence, 'failure.xml'), execFileSync('adb', ['-s', emu.serial, 'exec-out', 'cat', '/sdcard/d.xml']));
        } catch { /* the emulator is gone */ }
    }
    if (failed) {
        log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
        if (lab !== undefined) {
            writeFileSync(join(evidence, 'host-output.txt'), lab.hostOutput().split('\n').slice(-80).join('\n'));
            // What Herdr holds when the add stalls: which panes are open and what the sign-in read.
            try { writeFileSync(join(evidence, 'herdr-panes.txt'), panes().map((pane) => `${pane.pane_id} ${pane.agent ?? '-'} ${pane.agent_status} ${pane.cwd}`).join('\n')); } catch { /* lab already gone */ }
            writeFileSync(join(evidence, 'sign-in-lines.txt'), `${linesRead().join('\n')}\n`);
        }
    }
} finally {
    if (recorder !== undefined && emu !== undefined) {
        try { execFileSync('adb', ['-s', emu.serial, 'shell', 'pkill', '-INT', 'screenrecord']); } catch { /* already stopped */ }
        await sleep(3000);
        try { execFileSync('adb', ['-s', emu.serial, 'pull', '/sdcard/add.mp4', join(evidence, 'add-account.mp4')]); } catch { log('no recording pulled'); }
    }
    offering?.destroy();
    await lab?.stop();
    if (emu !== undefined) {
        try { execFileSync('adb', ['-s', emu.serial, 'emu', 'kill'], { timeout: 30_000 }); } catch { /* already gone */ }
        await emu.stop?.();
    }
    log(`done${failed ? ' with failure' : ''}`);
    process.exitCode = failed ? 1 : 0;
}
