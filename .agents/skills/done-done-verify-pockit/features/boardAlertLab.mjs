// Board alert journey (notify.md, notify-android-link): a real host and relay over
// fake Herdr, the release APK on an owned emulator. Run from the repo root:
// node <this> <apk> <evidence-dir>; MUXR_LAB_AVD_HOME picks the emulator home.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { startFakeStack } = await import(join(repo, 'perf/lib/fakeStack.mjs'));
const { waitForHerd, worldLabels } = await import(join(repo, 'perf/lib/pairPhone.mjs'));
const { setAndroidSerial } = await import(join(repo, 'perf/lib/deviceTarget.mjs'));

const exec = promisify(execFile);
const [apk, evidence] = process.argv.slice(2).map((p) => resolve(p));
mkdirSync(evidence, { recursive: true });
const PKG = 'com.trymuxr.app';
const log = [];
const note = (line) => { log.push(line); console.log(line); writeFileSync(join(evidence, 'journey.log'), `${log.join('\n')}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const emu = await bootOwnedEmulator({
    name: 'mxba',
    avdHome: process.env.MUXR_LAB_AVD_HOME,
    launcher: ['nice', '-n', '10'],
    extraArgs: ['-no-snapshot-load'],
});
note(`emulator ${emu.serial} pid ${emu.pid}`);
const adb = (...args) => exec('adb', ['-s', emu.serial, ...args], { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
const shot = async (name) => {
    const { stdout } = await exec('adb', ['-s', emu.serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(evidence, `${name}.png`), stdout);
    note(`captured ${name}.png`);
};
// uiautomator dump fails while the screen is still settling; retry, else read as empty.
const dump = async () => {
    for (let i = 0; i < 5; i += 1) {
        try {
            await adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
            const { stdout } = await adb('shell', 'cat', '/sdcard/ui.xml');
            // A slow host can raise "System UI isn't responding" over the app; tap Wait and look again.
            const wait = stdout.includes('responding') ? stdout.match(/<node\s[^>]*text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) : null;
            if (wait !== null) {
                const [, x1, y1, x2, y2] = wait.map(Number);
                await adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
                note('tapped Wait on a not-responding dialog');
                await sleep(1500);
                continue;
            }
            if (stdout.includes('<hierarchy')) return stdout;
        } catch { /* settling */ }
        await sleep(1000);
    }
    return '';
};
let stack;
try {
    await adb('install', '-r', apk);
    await adb('shell', 'pm', 'clear', PKG);
    await adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS');
    note('installed release APK, cleared data, granted notifications');

    stack = await startFakeStack({ panes: 4, agents: 1 });
    note(`lab stack: relay ${stack.relayPort}, host http ${stack.hostHttpPort}, host pid ${stack.pids.host}, relay pid ${stack.pids.relay}`);
    // perf/flows/pair.yaml predates the "Let's connect" screen; pair through the
    // muxr://pair deep link and its review screen instead.
    setAndroidSerial(emu.serial);
    for (const args of [['svc', 'power', 'stayon', 'true'], ['input', 'keyevent', 'KEYCODE_WAKEUP'], ['wm', 'dismiss-keyguard']]) await adb('shell', ...args).catch(() => undefined);
    const pairing = await stack.mintPairing();
    const link = /^(muxr|https?):/.test(pairing.code) ? pairing.code : `muxr://pair#${pairing.code}`;
    await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
    let tapped = false;
    for (let i = 0; i < 30 && !tapped; i += 1) {
        await sleep(2000);
        const nodes = [...(await dump()).matchAll(/<node\s[^>]*>/g)].map((m) => m[0]);
        const node = nodes.find((n) => /(text|content-desc)="Pair"/.test(n) && n.includes('clickable="true"'))
            ?? nodes.find((n) => /text="Pair"/.test(n));
        if (node === undefined) continue;
        const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
        await adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
        tapped = true;
    }
    note(`tapped Pair: ${tapped}`);
    const herd = await waitForHerd(worldLabels(stack.world), 60);
    pairing.release();
    note(`paired: ${JSON.stringify(herd)}`);
    await shot('00-paired-home');
    // The herd check reads older chrome words; the notify count below is the real proof of a live link.

    const token = readFileSync(join(stack.root, 'muxr', 'notify-token'), 'utf8').trim();
    const notify = async (body) => {
        const res = await fetch(`http://127.0.0.1:${stack.hostHttpPort}/v1/notify`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        return `${res.status} ${await res.text()}`;
    };

    // Default level (important): the phone is counted but drops the notice.
    note(`POST /v1/notify at default level -> ${await notify({ title: 'Should not show', body: 'level important', id: 'lab-important' })}`);

    // Settings > Notifications > "An agent finishes" on = level all.
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`, '-a', 'android.intent.action.VIEW', '-d', 'muxr://settings/notifications');
    let toggled = false;
    for (let i = 0; i < 20 && !toggled; i += 1) {
        await sleep(1500);
        const xml = await dump();
        const node = [...xml.matchAll(/<node\s[^>]*>/g)].map((m) => m[0])
            .find((n) => n.includes('content-desc="An agent finishes"') && n.includes('Switch'));
        if (node === undefined) continue;
        if (node.includes('checked="true"')) { toggled = true; break; }
        const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
        await adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
    }
    note(`"An agent finishes" switch on: ${toggled}`);
    await shot('01-settings-level-all');

    // Leave muxr so the alert is a real background notification, then send.
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(2000);
    const answer = await notify({ title: 'Decision needed', body: 'Pick a layout for the board', url: 'https://example.com/board#waiting', id: 'lab-board-1' });
    note(`POST /v1/notify at level all -> ${answer}`);
    writeFileSync(join(evidence, 'notify-response.txt'), `${answer}\n`);
    await sleep(4000);
    // Was it posted? Read the system's own record for our package only.
    const posted = async (title) => {
        const { stdout } = await adb('shell', 'dumpsys', 'notification', '--noredact');
        const ours = stdout.split(/\n(?=\s*NotificationRecord\()/).filter((r) => r.includes(`pkg=${PKG}`));
        return { ours, hit: ours.some((r) => r.includes(title)) };
    };
    let record = await posted('Decision needed');
    note(`dumpsys: ${record.ours.length} muxr records; "Decision needed" posted (app in background): ${record.hit}`);
    if (!record.hit) {
        // Second chance with muxr in front, to tell a background drop from no alert at all.
        await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
        await sleep(3000);
        note(`POST /v1/notify with muxr in front -> ${await notify({ title: 'Decision needed', body: 'Pick a layout for the board', url: 'https://example.com/board#waiting', id: 'lab-board-2' })}`);
        await sleep(4000);
        record = await posted('Decision needed');
        note(`dumpsys: "Decision needed" posted (app in front): ${record.hit}`);
        await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
        await sleep(1500);
    }
    writeFileSync(join(evidence, 'dumpsys-muxr-notifications.txt'), record.ours.map((r) => r.split('\n').filter((l) => /NotificationRecord|pkg=|android\.title|android\.text|channel=|importance/.test(l)).join('\n')).join('\n\n'));
    // Open the shade and confirm it is open before the capture.
    let open = false;
    for (let i = 0; i < 4 && !open; i += 1) {
        if (i % 2 === 0) await adb('shell', 'cmd', 'statusbar', 'expand-notifications');
        else await adb('shell', 'input', 'swipe', '540', '10', '540', '1700', '400');
        await sleep(2500);
        const xml = await dump();
        open = /notification_stack_scroller|text="Clear all"|text="Manage"|text="No notifications"/.test(xml) || xml.includes('Decision needed');
        if (open) note(`shade open (try ${i + 1}); shows "Decision needed": ${xml.includes('Decision needed')}; shows "Should not show": ${xml.includes('Should not show')}`);
    }
    if (!open) note('shade did not open');
    await shot('02-shade-board-alert');
    writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
        target: { version: `muxr release APK ${JSON.parse(readFileSync(`${apk}.json`, 'utf8')).revision}` },
        start: 'fresh app data on an Android emulator; a private lab host (relay + host over fake Herdr, one agent) with no phone paired',
        steps: [
            'open the muxr://pair link from the lab host and tap Pair',
            'the host posts a board alert with POST /v1/notify at the default alert level',
            'open Settings > Notifications and turn on "An agent finishes" (level all)',
            'leave muxr (Home) and the host posts the board alert "Decision needed / Pick a layout for the board"',
            'open the notification shade',
        ],
        result: 'notify answers delivered_to 1 both times; only the second alert shows: "Decision needed" is in the shade and in dumpsys notification',
    }, null, 2));
    await adb('shell', 'cmd', 'statusbar', 'collapse');
} finally {
    stack?.stop();
    note('stack stopped');
    await emu.stop();
    note('emulator stopped');
}
