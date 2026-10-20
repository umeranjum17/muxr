// Pane-name proof on a real (lab) Herdr: tabs labelled like Firstmate's, agents whose
// terminal title is Claude's restart topic. Pairs the
// candidate release APK on an owned emulator, captures, restarts the lab Herdr through the
// guarded helper, captures the matrix, then relabels a tab live and captures again.
// See pane-tab-names.md. Run from the repo root with HERDR_LAB_HELPER set:
//   node .agents/skills/done-done-verify-pockit/features/paneTabNamesLab.mjs <apk> <evidenceDir> <labRoot>
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

// The Firstmate desk after a restart: each lead agent in a tab named for its lane.
const work = join(root, 'w');
const folder = join(work, 'muxr');
const bin = join(work, 'bin');
mkdirSync(folder, { recursive: true });
mkdirSync(bin, { recursive: true });
const standIn = (title) => `#!/bin/sh\nprintf '\\033]2;%s\\007' '${title}'\nwhile :; do sleep 3600; done\n`;
writeFileSync(join(bin, 'claude'), standIn('✳ Firstmate operational inbox message'), { mode: 0o755 });
writeFileSync(join(bin, 'codex'), standIn('Firstmate operational inbox message'), { mode: 0o755 });
const TABS = [['fd-prompt-nosript', 'claude'], ['fm-crewhouse', 'claude'], ['fm-muxr', 'codex']];
const buildScene = () => {
    herdr('workspace', 'create', '--cwd', folder, '--label', 'muxr', '--no-focus');
    herdr('tab', 'rename', 'w1:t1', TABS[0][0]);
    for (const [label] of TABS.slice(1)) herdr('tab', 'create', '--workspace', 'w1', '--cwd', folder, '--label', label, '--no-focus');
};
// Herdr restores tabs and labels on restart; the agents come back as new processes, as a resumed Claude does.
const startAgents = async () => {
    const panes = JSON.parse(herdr('pane', 'list')).result.panes;
    for (const [index, [label, kind]] of TABS.entries()) {
        const pane = panes.find((entry) => entry.tab_id === `w1:t${index + 1}`);
        herdr('pane', 'send-text', pane.pane_id, `${join(bin, kind)}\n`);
        await sleep(1500);
        herdr('agent', 'rename', pane.pane_id, label);
    }
};
const saveHerdr = (name) => writeFileSync(join(evidence, `herdr-${name}.txt`),
    ['workspace list', 'tab list', 'agent list'].map((cmd) => `$ herdr ${cmd}\n${herdr(...cmd.split(' '))}`).join('\n'));

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

const emu = await bootOwnedEmulator({
    name: 'mxpn', avdHome: process.env.AVD_HOME ?? join(root, 'avd'),
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
let lab;
let defects = 0;
try {
    adb('install', '-r', apk);
    const activity = sh(`cmd package resolve-activity --brief ${PKG}`).trim().split('\n').pop();
    mkdirSync(join(root, 'lab'), { recursive: true });
    lab = await linkHerdrLab(join(root, 'lab'), 'pn', undefined, (_herdr, labSession) => { session = labSession; buildScene(); });
    log(`lab host up on relay port ${lab.port}, herdr ${session}`);
    await startAgents();
    saveHerdr('before-restart');

    sh(`pm clear ${PKG}`);
    adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
    sh('wm size 1080x2376'); sh('wm density 440'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no');
    const offer = await mintNativePairing(join(root, 'lab', 'host', 'pair.sock'));
    sh(`am start -W -n ${activity}`);
    await sleep(4000);
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr://pair#${offer}' -n ${activity}`);
    await tapText(/^Pair$/);
    await waitFor(/Fd prompt nosript/, 90);
    offering?.destroy();

    const capture = async (dir, name, screen) => {
        sh(`am force-stop ${PKG}`);
        sh(`am start -W -n ${activity}`);
        await sleep(3000);
        if (screen === 'panes') sh(`am start -W -a android.intent.action.VIEW -d 'muxr:///panes' -n ${activity}`);
        await waitFor(/Fd prompt nosript/, 60).catch(() => log(`${name}: names not seen`));
        await sleep(2500);
        mkdirSync(dir, { recursive: true });
        try {
            writeFileSync(join(dir, `${name}.check.txt`), execFileSync('node',
                [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), serial, dir, name], { encoding: 'utf8' }));
        } catch (cause) {
            defects += 1;
            writeFileSync(join(dir, `${name}.check.txt`), `${cause.stdout ?? ''}${cause.stderr ?? ''}`);
        }
        log(`captured ${name}`);
    };
    for (const screen of ['home', 'panes']) await capture(join(evidence, 'before-restart'), `${screen}-393-1.0-light`, screen);

    log('restarting the lab Herdr');
    execFileSync(helper, ['stop', session], { stdio: 'inherit' });
    execFileSync(helper, ['provision', session], { stdio: 'inherit' });
    await startAgents();
    saveHerdr('after-restart');
    await sleep(5000);

    for (const [width, density] of [['393', 440], ['270', 640]]) {
        for (const font of ['1.0', '2.0']) {
            for (const theme of ['light', 'dark']) {
                sh(`wm density ${density}`); sh(`settings put system font_scale ${font}`);
                sh(`cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
                for (const screen of ['home', 'panes']) await capture(join(evidence, 'after-restart'), `${screen}-${width}-${font}-${theme}`, screen);
            }
        }
    }

    // A relabel in Herdr shows on the phone with no restart: nothing first-seen sticks.
    sh('wm density 440'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no');
    herdr('tab', 'rename', 'w1:t2', 'fm-office');
    saveHerdr('after-relabel');
    await sleep(3000);
    await capture(join(evidence, 'after-relabel'), 'panes-393-1.0-light', 'panes');
    if (!/Office/.test(dump())) { defects += 1; log('relabel not shown'); }
} finally {
    try { sh('wm size reset'); sh('wm density reset'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); } catch { /* emulator gone */ }
    offering?.destroy();
    await lab?.stop();
    try { execFileSync('adb', ['-s', serial, 'emu', 'kill'], { timeout: 30_000 }); } catch { /* already gone */ }
    await emu.stop?.();
    log(`done; cells with defects: ${defects}`);
}
