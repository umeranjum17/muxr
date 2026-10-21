// Pane account chip proof on a real (lab) Herdr: a Claude pane muxr never started, whose own
// process runs with the Work sign-in folder, wears the Work chip, not the computer's account.
// Pairs the APK on an owned emulator and captures each pane's header. See pane-account-chip.md.
//   node .agents/skills/done-done-verify-pockit/features/paneAccountChipLab.mjs <apk> <evidenceDir> <labRoot>
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const [apk, evidence, root] = process.argv.slice(2);
const repo = process.cwd();
const helper = process.env.HERDR_LAB_HELPER;
let session;
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const PKG = 'com.trymuxr.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };
const herdr = (...args) => execFileSync(helper, ['run', session, ...args], { encoding: 'utf8', timeout: 30_000 });

const labDir = join(root, 'lab');
const bin = join(root, 'bin');
const hostBin = join(root, 'hostbin');
// The computer's own sign-in folder, set on the host as CLAUDE_CONFIG_DIR, and the Work account's folder.
const ownFolder = join(labDir, 'home', 'own-signin');
const workFolder = join(labDir, 'muxr', 'plans', 'claude', Buffer.from('work').toString('hex'));
// Host-side `claude`: answers `auth status` from the folder's lab-account.json. Never a real account.
const STATUS = `#!/bin/sh
dir="$CLAUDE_CONFIG_DIR"
[ "$1" = auth ] && [ "$2" = status ] && [ -f "$dir/lab-account.json" ] && { cat "$dir/lab-account.json"; exit 0; }
echo '{"loggedIn":false}'; exit 1
`;
const seed = () => {
    for (const dir of [bin, hostBin, workFolder, ownFolder]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(hostBin, 'claude'), STATUS, { mode: 0o755 });
    // The pane's agent: a process named claude that just waits.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "\\033]2;Account chip lab\\007"\nwhile :; do sleep 3600; done\n', { mode: 0o755 });
    const account = (email) => `{"loggedIn":true,"authMethod":"claude.ai","email":"${email}","subscriptionType":"max"}\n`;
    writeFileSync(join(ownFolder, 'lab-account.json'), account('umer@example.com'));
    writeFileSync(join(workFolder, 'lab-account.json'), account('work@example.com'));
    writeFileSync(join(labDir, 'muxr', 'plans', 'accounts-v1.json'),
        JSON.stringify({ version: 1, accounts: [{ id: 'pa_work', provider: 'claude', name: 'Work', folder: workFolder, found: false }] }), { mode: 0o600 });
    const cwd = join(root, 'w');
    mkdirSync(cwd, { recursive: true });
    herdr('workspace', 'create', '--cwd', cwd, '--label', 'chip-lab', '--no-focus');
    herdr('tab', 'rename', 'w1:t1', 'work-pane');
    herdr('tab', 'create', '--workspace', 'w1', '--cwd', cwd, '--label', 'own-pane', '--no-focus');
};
const startAgents = async () => {
    const panes = JSON.parse(herdr('pane', 'list')).result.panes;
    const at = (tab) => panes.find((entry) => entry.tab_id === tab).pane_id;
    herdr('pane', 'send-text', at('w1:t1'), `clear; CLAUDE_CONFIG_DIR=${workFolder} ${join(bin, 'claude')}\n`);
    herdr('pane', 'send-text', at('w1:t2'), `clear; ${join(bin, 'claude')}\n`);
    await sleep(3000);
};

let offering;
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
            if (event.approval) { socket.write('{"yes":true}\n'); log('device paired'); }
            if (event.error) reject(new Error(event.error));
        }
    });
});

// PHONE_SERIAL=a4b93ea2 (inside its keeper lock) runs on the test phone instead of an owned emulator.
const phone = process.env.PHONE_SERIAL;
if (phone !== undefined && phone !== 'a4b93ea2') throw new Error('only the test phone a4b93ea2, under its keeper lock');
const emu = phone ? undefined : await bootOwnedEmulator({
    name: 'mxchip', avdHome: process.env.AVD_HOME ?? join(root, 'avd'),
    systemImage: 'system-images;android-35;google_apis;x86_64', launcher: ['nice', '-n', '10'],
});
const serial = phone ?? emu.serial;
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
// system_server can restart under a loaded host; wait until it answers again.
const ready = async () => { for (let i = 0; i < 60 && !/package:/.test(spawnSync('adb', ['-s', serial, 'shell', 'pm path android'], { encoding: 'utf8' }).stdout); i += 1) await sleep(5000); };
let lab;
let startDensity = 'reset'; // the phone keeps its own display override; put it back
let defects = 0;
let finished = false;
try {
    await ready();
    startDensity = /Override density: (\d+)/.exec(sh('wm density'))?.[1] ?? 'reset';
    // A fresh app data dir: the phone refuses pm clear, and an install over the app would keep its old pairing.
    if (phone) { try { adb('uninstall', PKG); } catch { /* not installed yet */ } }
    execFileSync('adb', ['-s', serial, 'install', '-r', apk], { timeout: 290_000 }); // a loaded host installs slowly
    const activity = sh(`cmd package resolve-activity --brief ${PKG}`).trim().split('\n').pop();
    mkdirSync(labDir, { recursive: true });
    lab = await linkHerdrLab(labDir, 'chip', undefined, (_herdr, labSession) => { session = labSession; seed(); },
        { PATH: `${hostBin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: ownFolder });
    log(`lab host up on relay port ${lab.port}, herdr ${session}`);
    await startAgents();

    await ready();
    if (!phone) sh(`pm clear ${PKG}`);
    adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
    if (!phone) sh('wm size 1080x2376');
    if (phone) { sh('input keyevent KEYCODE_WAKEUP'); sh('wm dismiss-keyguard'); } else { sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); }
    sh('wm density 440');
    const offer = await mintNativePairing(join(labDir, 'host', 'pair.sock'));
    sh(`am start -W -n ${activity}`);
    await sleep(4000);
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr://pair#${offer}' -n ${activity}`);
    await tapText(/^Pair$/);
    await waitFor(/work-pane/, 90);
    offering?.destroy();
    // The tree names chips from the accounts the host last listed.
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr://settings/accounts' -n ${activity}`);
    await waitFor(/Work/, 60);
    await sleep(3000);

    const capture = async (label, expected, density) => {
        sh(`wm density ${density}`);
        sh(`am force-stop ${PKG}`);
        sh(`am start -W -n ${activity}`);
        await sleep(3000);
        await tapText(new RegExp(label), 60);
        await sleep(3500);
        const name = `${label}-${density === 440 ? 393 : 270}-1.0-light`;
        const dir = join(evidence, 'candidate');
        mkdirSync(dir, { recursive: true });
        try {
            log(`${name}: ${execFileSync('node', [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), serial, dir, name], { encoding: 'utf8' }).trim().split('\n').pop()}`);
        } catch (cause) {
            defects += 1;
            log(`${name}: visual check failed: ${String(cause.stdout ?? cause.message).split('\n').pop()}`);
        }
        // Keep the screen below the status bar (its notification icons are the phone owner's), cleared pane text only.
        const top = density === 440 ? 120 : 160;
        execFileSync('magick', [join(dir, `${name}.png`), '-crop', `1080x${2376 - top}+0+${top}`, '+repage', join(dir, `${name}.screen.png`)]);
        for (const extra of ['.png', '.xml', '.compressed.xml', '.check.txt']) rmSync(join(dir, `${name}${extra}`), { force: true });
        const header = /content-desc="([^"]*Open panes)"/.exec(dump())?.[1] ?? '';
        const ok = new RegExp(`On ${expected}\\b`).test(header);
        log(`${name}: header "${header}" ${ok ? 'OK' : 'WRONG ACCOUNT'}`);
        if (!ok) defects += 1;
    };
    for (const density of [440, 640]) {
        await capture('work-pane', 'Work', density);
        await capture('own-pane', 'Umer', density);
    }
    // done-done's step record: what this run drove and what the captured headers held.
    const version = sh(`dumpsys package ${PKG} | grep -m1 versionName`).trim().replace(/^versionName=/, '');
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: `muxr ${version} release APK on ${phone ? 'the test phone' : 'an emulator'}` },
        start: 'a fresh install of muxr and a private lab Herdr with two Claude panes: work-pane runs under the Work account folder, own-pane under the computer\'s own folder',
        steps: ['Install muxr and open it', 'Pair it with the lab computer from a pairing link', 'Open work-pane and read its header', 'Open own-pane and read its header', 'Repeat at 270 dp'],
        result: 'a Claude pane started under its own plans folder shows the account signed in at that folder in its header chip, not the default computer account, in two parts labelled exactly "work" and "own". Part "work": work-pane-393-1.0-light.screen.png and work-pane-270-1.0-light.screen.png each show the header chip reading Work. Part "own": own-pane-393-1.0-light.screen.png and own-pane-270-1.0-light.screen.png each show the header chip reading Umer. Each file is a phone screen below its status bar',
    }, null, 2)}\n`);
    finished = true;
} finally {
    try { if (!phone) sh('wm size reset'); sh(`wm density ${startDensity}`); if (!phone) { sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); } } catch { /* emulator gone */ }
    offering?.destroy();
    await lab?.stop();
    if (phone) { try { adb('reverse', '--remove', `tcp:${lab.port}`); } catch { /* never set */ } } else {
        try { execFileSync('adb', ['-s', serial, 'emu', 'kill'], { timeout: 30_000 }); } catch { /* already gone */ }
        await emu.stop?.();
    }
    log(finished ? `done; defects: ${defects}` : 'FAILED before all captures; nothing proven');
}
