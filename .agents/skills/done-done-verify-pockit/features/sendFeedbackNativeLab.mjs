// The composer's send feedback on a real (lab) Herdr: a Claude Code pane on the canned
// fixture, the release APK on an owned emulator at 390 dp. Records a send (Sending, then
// Sent once the host confirms), then a send the agent cannot take (Not sent, the text back
// in the field, Retry) per width, text size and theme, and its retry from the chip. Main's
// APK runs the same journey for the before shots. See send-feedback.md. From the repo root,
// inside a provisioned Herdr lab (HERDR_LAB_HELPER, HERDR_LAB_SESSION, HERDR_LAB_PREPROVISIONED=1):
//   node .agents/skills/done-done-verify-pockit/features/sendFeedbackNativeLab.mjs <apk> <evidenceDir> <labRoot>
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [apk, evidence, root] = process.argv.slice(2);
const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { startSendLab } = await import(join(repo, '.agents/skills/done-done-verify-pockit/features/sendLab.mjs'));
const PKG = 'com.trymuxr.app';
// 1080 x 2376 px: density 443 is a 390 dp phone, 640 the reference phone's 270 dp.
// SEND_WIDTHS=390 or 270 splits the cells over two runs, each inside the emulator lock's 30 min.
const WIDTHS = (process.env.SEND_WIDTHS ?? '390,270').split(',');
const CELLS = [['390', 443], ['270', 640]].filter(([width]) => WIDTHS.includes(width)).flatMap(([width, density]) =>
    ['1.0', '2.0'].flatMap((font) => ['dark', 'light'].map((theme) => ({ width, density, font, theme }))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };

const emu = await bootOwnedEmulator({
    name: 'mxsf', avdHome: process.env.AVD_HOME ?? join(root, 'avd'),
    systemImage: 'system-images;android-35;google_apis;x86_64', launcher: ['nice', '-n', '10'],
});
const serial = emu.serial;
log(`emulator ${serial}`);
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: ['install', 'uninstall'].includes(args[0]) ? 600_000 : 120_000 });
const sh = (cmd) => adb('shell', cmd);
const shot = (name) => writeFileSync(join(evidence, `${name}.png`), execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20, timeout: 30_000 }));
const dump = () => { sh('uiautomator dump /sdcard/d.xml >/dev/null'); return adb('exec-out', 'cat', '/sdcard/d.xml'); };
const nodeFor = (xml, re) => (xml.match(/<node\s[^>]*>/g) ?? []).find((node) =>
    re.test(/text="([^"]*)"/.exec(node)?.[1] ?? '') || re.test(/content-desc="([^"]*)"/.exec(node)?.[1] ?? ''));
const centre = (node) => {
    const [, x1, y1, x2, y2] = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).map(Number);
    return [(x1 + x2) >> 1, (y1 + y2) >> 1];
};
const waitFor = async (re, seconds = 60) => {
    for (let i = 0; i < seconds; i += 2) { const xml = dump(); if (nodeFor(xml, re) !== undefined) return xml; await sleep(2000); }
    throw new Error(`never saw ${re}`);
};
const tap = async (re, seconds = 60) => {
    const [x, y] = centre(nodeFor(await waitFor(re, seconds), re));
    sh(`input tap ${x} ${y}`);
    log(`tap ${re}`);
};
// One recording per moment, cut by its own time limit; the 4x slow copy is what a reader watches.
const record = (name, seconds) => {
    const child = spawn('adb', ['-s', serial, 'shell', 'screenrecord', '--time-limit', String(seconds), '--bit-rate', '8000000', `/sdcard/${name}.mp4`], { stdio: 'ignore' });
    return async () => {
        await new Promise((resolve) => child.once('exit', resolve));
        await sleep(1000);
        adb('pull', `/sdcard/${name}.mp4`, join(evidence, `${name}.mp4`));
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(evidence, `${name}.mp4`), '-filter:v', 'setpts=4.0*PTS', '-an', join(evidence, `${name}-slow4x.mp4`)]);
        log(`recorded ${name}.mp4 and ${name}-slow4x.mp4`);
    };
};
const leads = [];
const check = (name) => {
    const dir = join(evidence, 'visual');
    mkdirSync(dir, { recursive: true });
    let out;
    try { out = execFileSync(process.execPath, [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), serial, dir, name], { encoding: 'utf8', timeout: 180_000 }); }
    catch (cause) { out = `${cause.stdout ?? ''}${cause.stderr ?? ''}`; }
    const defects = out.split('\n').filter((line) => line.startsWith('DEFECT'));
    for (const line of defects) leads.push(`${name}: ${line}`);
    log(`shot ${name}: ${defects.length === 0 ? 'clean' : defects.join(' | ')}`);
};
const AGENT_CARD = /\. (Idle|Working|Done|Needs you)\b|Umer send check/;

let stage;
let failed = false;
try {
    // The google_apis image runs Play's verifier on every adb install, which stalls this APK past 10 min.
    sh('settings put global verifier_verify_adb_installs 0; settings put global package_verifier_enable 0');
    // A fresh install is fresh app data: nothing paired to a real computer survives.
    const started = Date.now();
    try { adb('uninstall', PKG); } catch { /* not installed */ }
    log(`uninstalled in ${Math.round((Date.now() - started) / 1000)} s`);
    adb('install', '--no-incremental', apk);
    log(`installed in ${Math.round((Date.now() - started) / 1000)} s`);
    const activity = sh(`cmd package resolve-activity --brief ${PKG}`).trim().split('\n').pop();
    stage = await startSendLab(root, { lps: '20' });
    const { lab } = stage;
    const [agent] = stage.agents;
    log(`lab host on relay port ${lab.port}; claude in ${agent.paneId}`);
    const openAgent = async () => {
        sh(`am force-stop ${PKG}`);
        sh(`am start -W -n ${activity}`);
        // A relaunch comes back on the agent it was showing; from Home, open it.
        const first = await waitFor(/connected|^Prompt$/, 90);
        if (nodeFor(first, /^Prompt$/) === undefined) {
            await sleep(2000);
            await tap(AGENT_CARD, 60);
        }
        await waitFor(/^Prompt$/, 60);
        await sleep(2500);
    };
    const type = async (words) => {
        await tap(/^Prompt$/);
        sh(`input text '${words.replaceAll(' ', '%s')}'`);
        sh('input keyevent KEYCODE_BACK');
        await sleep(1500);
    };

    adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
    sh('wm size 1080x2376'); sh('wm density 443'); sh('settings put system font_scale 1.0'); sh('cmd uimode night yes');
    sh('settings put global heads_up_notifications_enabled 0');
    const offer = await stage.offer('native');
    sh(`am start -W -n ${activity}`);
    await sleep(4000);
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr://pair#${offer}' -n ${activity}`);
    await tap(/^Pair$/);
    await waitFor(/connected/, 120);
    log('device paired');
    for (const dismiss of [/^Not now$/, /^Deny$/, /^Later$/]) await tap(dismiss, 4).catch(() => undefined);
    await openAgent();

    // A send that lands: Sending at the tap, Sent once the host confirms the pane took it.
    await type('Reply with exactly: ok');
    shot('01-typed');
    const sendNode = nodeFor(dump(), /^Send$/);
    if (sendNode === undefined) throw new Error('no Send button');
    const [sx, sy] = centre(sendNode);
    const stopSent = record('send-delivered', 6);
    await sleep(1200);
    sh(`input tap ${sx} ${sy}`);
    const tappedAt = Date.now();
    let echoMs;
    for (let i = 0; i < 100 && echoMs === undefined; i++) {
        if (lab.herdr(['pane', 'read', agent.paneId, '--source', 'visible']).includes('Reply with exactly: ok')) echoMs = Date.now() - tappedAt;
        else await sleep(30);
    }
    log(`tapped Send; prompt in the lab pane ${echoMs ?? 'never'} ms later (adb tap and pane-read polling included)`);
    await stopSent();

    // A send the agent cannot take: Herdr calls it unknown, so the host holds it, then
    // refuses, and the text comes back. Per cell: Sending while held, then Not sent.
    stage.setReady(agent, false);
    for (const [index, { width, density, font, theme }] of CELLS.entries()) {
        const cell = `${width}-${font}-${theme}`;
        sh(`wm density ${density}`); sh(`settings put system font_scale ${font}`); sh(`cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        await openAgent();
        await type(`Second line for the lab ${index + 1}`);
        await tap(/^Send$/);
        await sleep(2500);
        check(`sending-${cell}`);
        await waitFor(/^Send failed$/, 90);
        if (index === 0) shot('02-send-failed-alert');
        await tap(/^(Cancel|OK)$/i, 10);
        await sleep(1500);
        check(`not-sent-${cell}`);
        if (!dump().includes(`Second line for the lab ${index + 1}`)) { failed = true; log(`DEFECT ${cell}: the refused text is not back in the field`); }
    }

    // The agent is ready again; the chip (main: Send) sends the text that came back, once.
    sh('wm density 443'); sh('settings put system font_scale 1.0'); sh('cmd uimode night yes');
    await openAgent();
    await type('Third line for the lab');
    await tap(/^Send$/);
    await waitFor(/^Send failed$/, 90);
    await tap(/^(Cancel|OK)$/i, 10);
    await sleep(1000);
    shot('03-not-sent-text-back');
    stage.setReady(agent, true);
    await sleep(2000);
    const retry = nodeFor(dump(), /^Not sent\. Send again$/) === undefined ? /^Send$/ : /^Not sent\. Send again$/;
    const stopRetry = record('send-retry', 8);
    await sleep(1200);
    await tap(retry, 10);
    await stopRetry();
    shot('04-after-retry');
    const pane = lab.herdr(['pane', 'read', agent.paneId, '--source', 'recent']);
    writeFileSync(join(evidence, 'lab-pane-after.txt'), pane);
    const copies = pane.split('Third line for the lab').length - 1;
    log(`retried text in the pane ${copies} time(s)`);
    if (copies !== 1) { failed = true; log('DEFECT: the retried text must reach the pane exactly once'); }
    log(`visual check leads: ${leads.length === 0 ? 'none' : `\n${leads.join('\n')}`}`);
    log(failed ? 'RESULT FAIL' : 'RESULT done');
} catch (error) {
    failed = true;
    log(`RESULT FAIL: ${error instanceof Error ? error.message : String(error)}`);
    try { shot('failure'); } catch { /* emulator gone */ }
} finally {
    try { sh('wm size reset'); sh('wm density reset'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); } catch { /* emulator gone */ }
    await stage?.stop();
    try { execFileSync('adb', ['-s', serial, 'emu', 'kill'], { timeout: 30_000 }); } catch { /* already gone */ }
    await emu.stop?.();
    process.exitCode = failed ? 1 : 0;
}
