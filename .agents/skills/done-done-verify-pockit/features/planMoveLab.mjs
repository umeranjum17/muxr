// Move a live conversation between two Claude accounts on a real (lab) Herdr, from the phone.
// Two stand-in accounts are added through the BYOKit accounts kit the host composes,
// a stand-in Claude runs on account A, and the candidate APK on an owned emulator moves it
// A -> B -> A while the screen records. See plan-move.md. Run from the repo root with
// HERDR_LAB_HELPER set:
//   node .agents/skills/done-done-verify-pockit/features/planMoveLab.mjs <apk> <evidenceDir> <labRoot>
// With `-` for <apk> it moves through plans.move from the lab link instead, with no phone.
// With `web` for <apk> it leaves the lab up for a browser: it writes a browser pairing link to
// <labRoot>/browser-link.txt and runs until <labRoot>/stop exists (drive the PWA meanwhile).
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';

const [apk, evidence, root] = process.argv.slice(2);
const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const { requestLab } = await import(join(repo, 'scripts/diagnostics/application/linkLabClient.mjs'));
const PKG = 'com.trymuxr.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };

// Stand-in `claude`: signs in instantly as the next lab account, says which account a
// conversation runs on, replays the conversation it resumes, and reports its lifecycle and
// conversation to Herdr the way Claude's Herdr hook does (source herdr:claude). Never a real account.
const work = join(root, 'w');
const folder = join(work, 'muxr');
const bin = join(work, 'bin');
// Each run signs in afresh: the stand-in's own markers and transcripts start empty.
for (const stale of ['signed', 'conversations']) rmSync(join(work, stale), { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), `#!/bin/sh
lab=${JSON.stringify(work)}
dir="$CLAUDE_CONFIG_DIR"
if [ "$1" = auth ] && [ "$2" = status ]; then
  [ -n "$dir" ] && [ -f "$dir/lab-account.json" ] && { cat "$dir/lab-account.json"; exit 0; }
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
if [ "$1" = auth ] && [ "$2" = login ]; then
  mkdir -p "$lab/signed" "$dir"
  if [ -e "$lab/signed/a" ]; then who=b; else who=a; fi
  touch "$lab/signed/$who"
  printf '{"loggedIn":true,"authMethod":"claude.ai","email":"umer.%s@example.com","subscriptionType":"max"}\\n' "$who" > "$dir/lab-account.json"
  echo "Signed in as umer.$who@example.com"; exit 0
fi
id=""; [ "$1" = --resume ] && id="$2"
[ -n "$id" ] || id="lab-$(date +%s%N)"
email=$(sed -n 's/.*"email":"\\([^"]*\\)".*/\\1/p' "$dir/lab-account.json" 2>/dev/null)
mkdir -p "$lab/conversations"; convo="$lab/conversations/$id.log"
seq() { date +%s%N; }
report() { herdr pane report-agent --source herdr:claude --agent claude --state "$1" --seq "$(seq)" "$HERDR_PANE_ID" >/dev/null 2>&1; }
printf '\\033[2J\\033[H'
echo "Claude Code (lab stand-in) on \${email:-no account}"
[ -f "$convo" ] && { echo "Resumed this conversation:"; cat "$convo"; }
( sleep 2; herdr pane report-agent-session --source herdr:claude --agent claude --seq "$(seq)" --agent-session-id "$id" "$HERDR_PANE_ID" >/dev/null 2>&1; report idle ) &
printf '> '
while IFS= read -r line; do
  report working
  printf '> %s\\n  (%s) Heard: %s\\n' "$line" "$email" "$line" >> "$convo"
  printf '  (%s) Heard: %s\\n> ' "$email" "$line"
  report idle
done
`, { mode: 0o755 });
// The lab Herdr, its panes and the host find only the stand-in, never an installed Claude.
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.HOME ?? '', 'Android/Sdk');
process.env.PATH = [bin, dirname(process.execPath), join(sdk, 'platform-tools'), join(sdk, 'emulator'), '/usr/bin', '/bin'].join(':');

let offering;
const mintPairing = (path, kind = 'native') => new Promise((resolve, reject) => {
    const socket = offering = createConnection(path);
    let pending = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ intent: { kind, authority: 'control', personal: false } })}\n`));
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

let session;
let lab;
let emu;
let recorder;
let failed = false;
const herdr = (...args) => lab.herdr(args, 30_000);
const ask = (type, params) => requestLab(lab.link, type, params);
// The accounts kit adds each account and runs its own sign-in command (the stand-in answers it).
// Not plans.add: the guarded Herdr helper pins CLAUDE_CONFIG_DIR, so the per-account hook
// install that plans.add runs through Herdr cannot target a new account folder in a lab.
const addAccount = async (name) => {
    const { planAccounts } = await import(join(repo, 'apps/host/dist/plans/planAccounts.js'));
    const added = await planAccounts(lab.env).add('claude');
    execFileSync('/bin/sh', ['-c', added.signIn.shell], { stdio: 'ignore', env: lab.env, timeout: 30_000 });
    const accountId = added.account.id;
    const { account } = await ask('plans.status', { accountId });
    if (!account.signedIn) throw new Error(`${name} did not sign in`);
    await ask('plans.rename', { accountId, name });
    log(`added ${name}`);
    return accountId;
};
const screen = (pane) => herdr('pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '30');
const paneOf = async (sessionId) => (await ask('session.open', { sessionId })).info.paneId;
// Herdr settles a freshly started agent once (idle, unknown, idle) a few seconds after launch;
// a move started inside that window is refused as changed. Wait until it holds still.
const settled = async (sessionId) => {
    let last = '';
    let since = Date.now();
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(1000)) {
        const agent = JSON.parse(herdr('agent', 'get', await paneOf(sessionId))).result.agent;
        const now = `${agent.agent_status}:${agent.state_change_seq}`;
        if (now !== last) { last = now; since = Date.now(); }
        if (agent.agent_status === 'idle' && agent.agent_session?.value && Date.now() - since >= 10_000) return;
    }
    throw new Error('the agent never settled');
};
try {
    mkdirSync(join(root, 'lab'), { recursive: true });
    lab = await linkHerdrLab(join(root, 'lab'), 'pm', undefined, (run, labSession) => {
        session = labSession;
        run(['workspace', 'create', '--cwd', folder, '--label', 'muxr', '--no-focus']);
    });
    log(`lab host up on relay port ${lab.port}, herdr ${session}`);
    const a = await addAccount('Account A');
    const b = await addAccount('Account B');
    const started = await ask('session.start', { cwd: folder, kind: 'claude', planAccount: a, label: 'move-demo' });
    const sessionId = started.info.id;
    await settled(sessionId);
    herdr('pane', 'send-text', await paneOf(sessionId), 'Plan the release notes\n');
    await settled(sessionId);
    writeFileSync(join(evidence, 'herdr-on-a.txt'), screen(await paneOf(sessionId)));
    if (apk === 'web') {
        const link = await mintPairing(join(root, 'lab', 'host', 'pair.sock'), 'browser');
        writeFileSync(join(root, 'browser-link.txt'), link);
        log('browser link ready; the lab stays up until the stop file appears');
        while (!existsSync(join(root, 'stop'))) await sleep(1000);
        offering?.destroy();
        log('PASS: web lab held for the browser');
        throw Object.assign(new Error('web lab finished'), { done: true });
    }
    if (apk === '-') {
        for (const [to, id, letter] of [['Account B', b, 'b'], ['Account A', a, 'a']]) {
            await ask('plans.move', { sessionId, accountId: id });
            await settled(sessionId);
            const pane = await paneOf(sessionId);
            herdr('pane', 'send-text', pane, `Still here on ${to}?\n`);
            await sleep(2000);
            const text = screen(pane);
            writeFileSync(join(evidence, `herdr-on-${letter}-after-move.txt`), text);
            if (!text.includes(`umer.${letter}@example.com`) || !text.includes('Plan the release notes')) throw new Error(`the conversation did not carry over to ${to}`);
            if ((await ask('plans.agent', { sessionId })).accountId !== id) throw new Error(`the host does not record ${to}`);
            log(`moved to ${to}`);
        }
        log('PASS: conversation moved A -> B -> A (host only)');
        throw Object.assign(new Error('host-only run finished'), { done: true });
    }

    emu = await bootOwnedEmulator({
        name: 'mxmv', avdHome: process.env.AVD_HOME ?? join(root, 'avd'),
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
    await tapText(/^Pair$/);
    log('pairing');
    await waitFor(/Plan the release notes|move-demo/, 90);
    offering?.destroy();

    recorder = spawn('adb', ['-s', serial, 'shell', 'screenrecord', '--time-limit', '170', '/sdcard/move.mp4'], { stdio: 'ignore' });
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr:///session/${encodeURIComponent(sessionId)}' -n ${activity}`);
    await waitFor(/umer\.a@example\.com/, 60);
    await sleep(1500);
    shot('1-on-account-a');
    let current = sessionId;
    for (const [to, letter, step] of [['Account B', 'b', '2'], ['Account A', 'a', '3']]) {
        await settled(current);
        await tapText(/^Pane actions/);
        await tapText(/^Move to another account/);
        await sleep(1500);
        shot(`${step}a-move-sheet-to-${letter}`);
        await tapText(new RegExp(`^Move to ${to}$`));
        await waitFor(new RegExp(`Moved to ${to}`), 120);
        shot(`${step}b-moved-notice-${letter}`);
        await waitFor(new RegExp(`umer\\.${letter}@example\\.com`), 60);
        await sleep(1500);
        shot(`${step}c-on-account-${letter}`);
        const agent = await ask('plans.agent', { sessionId: current });
        const expected = letter === 'b' ? b : a;
        if (agent.accountId !== expected) throw new Error(`host says ${agent.accountId}, expected ${to}`);
        const pane = await paneOf(current);
        herdr('pane', 'send-text', pane, `Still here on ${to}?\n`);
        await sleep(2000);
        writeFileSync(join(evidence, `herdr-on-${letter}-after-move.txt`), screen(pane));
        if (!/Resumed this conversation/.test(screen(pane)) || !/Plan the release notes/.test(screen(pane))) {
            throw new Error(`the conversation did not carry over to ${to}`);
        }
        await sleep(2500);
        shot(`${step}d-turn-on-${letter}`);
        current = (await ask('session.open', { sessionId: current })).info.id;
        log(`moved to ${to}; host and pane agree`);
    }
    log('PASS: conversation moved A -> B -> A');
} catch (error) {
    failed = error?.done !== true;
    if (failed) {
        log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
        if (lab !== undefined) writeFileSync(join(evidence, 'host-output.txt'), lab.hostOutput().split('\n').slice(-80).join('\n'));
    }
} finally {
    if (recorder !== undefined && emu !== undefined) {
        try { execFileSync('adb', ['-s', emu.serial, 'shell', 'pkill', '-INT', 'screenrecord']); } catch { /* already stopped */ }
        await sleep(3000);
        try { execFileSync('adb', ['-s', emu.serial, 'pull', '/sdcard/move.mp4', join(evidence, 'move-a-b-a.mp4')]); } catch { log('no recording pulled'); }
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
