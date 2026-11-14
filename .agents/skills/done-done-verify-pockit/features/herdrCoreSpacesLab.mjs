// Spaces, tabs and panes on Herdr Core (core-spaces.md, jg-kile slice 8): the release APK on an owned
// emulator, paired to a real lab relay and a real lab host started with the lab-only --herdr-core-lab
// source over a private lab Herdr Core. The lab Core is seeded the way the Herdr app leaves it: three
// agents and a `herdr-app` document that names the spaces and tabs differently from the agents' labels
// and holds fields muxr has never heard of. On the phone: Home groups the agents by the document's
// spaces and tabs; New tab and Rename tab, New pane (a split) and Close pane, and Close workspace each
// change Core and the document; the unknown fields are still there at the end.
// Break test: in renameTab (domain/herdrAppLayout.ts) build the tab as `{ id: tab.id, name, root: tab.root }`
// instead of `{ ...tab, name }`, rebuild; the journey ends with `DEFECT the Herdr app's own fields were lost`.
// Run from the repo root, after `yarn build`: node <this> <apk> <evidence-dir>;
// MUXR_LAB_AVD_HOME picks the emulator home.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const repo = process.cwd();
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { startFakeStack } = await import(join(repo, 'perf/lib/fakeStack.mjs'));
const { setAndroidSerial } = await import(join(repo, 'perf/lib/deviceTarget.mjs'));

const exec = promisify(execFile);
const [apk, evidence] = process.argv.slice(2).map((p) => resolve(p));
mkdirSync(evidence, { recursive: true });
const PKG = 'com.trymuxr.app';
const log = [];
const note = (line) => { log.push(line); console.log(line); writeFileSync(join(evidence, 'journey.log'), `${log.join('\n')}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defects = [];

const emu = await bootOwnedEmulator({ name: 'mxcorespaces', avdHome: process.env.MUXR_LAB_AVD_HOME, launcher: ['nice', '-n', '10'], extraArgs: ['-no-snapshot-load'] });
note(`emulator ${emu.serial} pid ${emu.pid}`);
// Before any stack starts: its adb reverse must name this emulator, never another attached device.
setAndroidSerial(emu.serial);
const adbOnce = (...args) => exec('adb', ['-s', emu.serial, ...args], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
const adb = (...args) => adbOnce(...args).catch(async () => { await sleep(3000); return adbOnce(...args); });
const dump = async () => {
    for (let i = 0; i < 5; i += 1) {
        try {
            await adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
            const { stdout } = await adb('shell', 'cat', '/sdcard/ui.xml');
            if (stdout.includes('<hierarchy')) return stdout;
        } catch { /* settling */ }
        await sleep(1000);
    }
    return '';
};
const waitFor = async (test, seconds) => {
    for (let i = 0; i < seconds; i += 2) {
        if (test(await dump())) return true;
        await sleep(2000);
    }
    return false;
};
const nodeBounds = (xml, pattern) => {
    const node = [...xml.matchAll(/<node\s[^>]*>/g)].map((m) => m[0]).find((n) => pattern.test(n));
    if (node === undefined) return undefined;
    const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
    return { x: (x1 + x2) >> 1, y: (y1 + y2) >> 1 };
};
const tap = async (pattern, seconds = 30) => {
    for (let i = 0; i < seconds; i += 2) {
        const at = nodeBounds(await dump(), pattern);
        if (at !== undefined) { await adb('shell', 'input', 'tap', String(at.x), String(at.y)); return true; }
        await sleep(2000);
    }
    return false;
};
const longPress = async (pattern, seconds = 30) => {
    for (let i = 0; i < seconds; i += 2) {
        const at = nodeBounds(await dump(), pattern);
        if (at !== undefined) { await adb('shell', 'input', 'swipe', String(at.x), String(at.y), String(at.x), String(at.y), '900'); return true; }
        await sleep(2000);
    }
    return false;
};
const until = async (test, seconds) => {
    for (let i = 0; i < seconds * 2; i += 1) {
        const got = await test();
        if (got) return got;
        await sleep(500);
    }
    return undefined;
};
const cell = (dir, name) => {
    let report;
    try { report = execFileSync('node', [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), emu.serial, dir, name], { encoding: 'utf8' }); }
    catch (cause) { report = `${cause.stdout ?? ''}${cause.stderr ?? ''}`; }
    // The screenshot is the evidence; the view dumps only feed the visual lead check above.
    for (const suffix of ['.xml', '.compressed.xml']) rmSync(join(dir, `${name}${suffix}`), { force: true });
    // Layout of existing screens is reported here, not gated: the judge still reads the captures for the claimed outcome.
    for (const line of report.split('\n').filter((l) => /DEFECT/.test(l))) note(`visual note on ${name}: ${line.replace(/^DEFECT /, '').trim()}`);
    note(`captured ${name}`);
};
// A relaunch can reopen the agent screen; step back until Home (its Right now card and prompt box) shows.
const goHome = async () => {
    for (let i = 0; i < 4; i += 1) {
        if (/Plan, ask, build|Right now/.test(await dump())) return;
        await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await sleep(1500);
    }
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    await sleep(5000);
};
const retype = async (text) => {
    await tap(/EditText/, 20);
    await adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END');
    for (let i = 0; i < 40; i += 1) await adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
    await adb('shell', 'input', 'text', text);
};

let stack;
let api;
let finished = false;
const scratch = join(process.env.MUXR_LAB_SCRATCH ?? `${process.env.HOME}/.cache/fms/cspaces`, 'agent');
try {
    await adb('install', '-r', apk).catch(async (cause) => {
        if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(String(cause.stderr))) throw cause;
        await adb('uninstall', PKG);
        await adb('install', apk);
    });
    note('installed release APK');
    await adb('shell', 'pm', 'clear', PKG);
    for (const args of [['wm', 'size', 'reset'], ['wm', 'density', 'reset'], ['settings', 'put', 'system', 'font_scale', '1.0']]) await adb('shell', ...args).catch(() => undefined);
    await adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS').catch(() => undefined);

    // The stand-in Pi: reports idle the way Claude and Codex report status (OSC 7501) and reads its input.
    mkdirSync(scratch, { recursive: true });
    const agent = join(scratch, 'stand-in-pi.sh');
    writeFileSync(agent, ['#!/bin/sh', "printf '\\033]7501;state=idle:app=pi\\033\\\\'", 'while IFS= read -r line; do :; done', ''].join('\n'));
    chmodSync(agent, 0o755);

    stack = await startFakeStack({ panes: 1, agents: 0, hostOnHerdrCore: true, coreAgent: agent });
    const core = stack.herdrCore;
    note(`lab stack: relay ${stack.relayPort}, host pid ${stack.pids.host}, relay pid ${stack.pids.relay}, lab Herdr Core pid ${core.pid} (HC_SESSION ${core.session})`);
    for (const args of [['svc', 'power', 'stayon', 'true'], ['input', 'keyevent', 'KEYCODE_WAKEUP'], ['wm', 'dismiss-keyguard']]) await adb('shell', ...args).catch(() => undefined);
    api = await core.connect();
    const terminals = async () => (await api.call('terminal.list', {})).terminals;
    const document = async () => (await api.call('doc.get', { name: 'herdr-app' })).value;
    const snap = async (name) => { const xml = await dump(); writeFileSync(join(evidence, `${name}.xml`), xml); return xml; };

    // The world the Herdr app leaves: the labels say pockit/fix-login, review and notes; the document says
    // Pockit (Fixes holds two panes, in a row) and Notes (Daily), and carries fields muxr does not know.
    const run = (space, tab) => api.call('terminal.run', { argv: [agent], cwd: scratch, labels: { 'muxr.kind': 'pi', 'herdr.space': space, 'herdr.tab': tab }, keep: true });
    const [t1, t2, t3] = [await run('pockit', 'fix-login'), await run('pockit', 'review'), await run('notes', 'notes')];
    const block = (id, terminal) => ({ id, type: 'block', content: { terminal: terminal.address } });
    await api.call('doc.set', { name: 'herdr-app', version: 0, value: { future: { keep: 'me' }, spaces: [
        { id: 'sp1', name: 'Pockit', folder: scratch, pinned: true, tabs: [{ id: 'tb1', name: 'Fixes', accent: 'green', root: { id: 'r1', type: 'row', gap: 4, children: [block('b1', t1), block('b2', t2)] } }] },
        { id: 'sp2', name: 'Notes', folder: scratch, tabs: [{ id: 'tb2', name: 'Daily', root: block('b3', t3) }] },
    ] } });
    note(`Core runs ${t1.address}, ${t2.address} and ${t3.address}; the herdr-app document names Pockit/Fixes and Notes/Daily`);

    const pairing = await stack.mintPairing();
    const link = /^(muxr|https?):/.test(pairing.code) ? pairing.code : `muxr://pair#${pairing.code}`;
    await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
    const PAIR = /(text|content-desc)="Pair"[^>]*clickable="true"|clickable="true"[^>]*(text|content-desc)="Pair"|text="Pair"/;
    let pairTapped = await tap(PAIR, 90);
    if (!pairTapped) {
        writeFileSync(join(evidence, 'pair-missed.xml'), await dump());
        await adb('shell', `am start -n ${PKG}/.MainActivity -a android.intent.action.VIEW -d '${link}'`);
        pairTapped = await tap(PAIR, 150);
    }
    note(`tapped Pair: ${pairTapped}`);
    const paired = await waitFor((xml) => /Right now|Spaces|Computers/.test(xml), 180);
    pairing.release();
    if (!paired) defects.push('Home never opened after pairing');
    await tap(/Don.t allow/, 4);

    const dir = join(evidence, 'native');
    mkdirSync(dir, { recursive: true });
    const capture = async (name) => {
        await adb('shell', 'wm', 'size', '1080x2376');
        await adb('shell', 'wm', 'density', '640');
        await adb('shell', 'settings', 'put', 'system', 'font_scale', '2.0');
        await adb('shell', 'cmd', 'uimode', 'night', 'yes');
        await adb('shell', 'am', 'force-stop', PKG);
        await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
        await sleep(6000);
        await tap(/Don.t allow/, 4);
        await goHome();
        // The Spaces list sits under the Live row: scroll it into view before the shot.
        await adb('shell', 'input', 'swipe', '540', '1900', '540', '500', '400');
        await sleep(1500);
        await waitFor((xml) => /workspace, \d agent/.test(xml), 30);
        cell(dir, name);
        for (const args of [['wm', 'size', 'reset'], ['wm', 'density', 'reset'], ['settings', 'put', 'system', 'font_scale', '1.0']]) await adb('shell', ...args).catch(() => undefined);
        await sleep(2000);
        await goHome();
    };
    const spaceCards = (xml) => [...xml.matchAll(/content-desc="([^"]*workspace, \d+ agents?[^"]*)"/g)].map((m) => m[1]);

    // 1. Home groups by the document: Pockit holds Fixes twice and Notes holds Daily, never the labels.
    const grouped = await waitFor((xml) => /Pockit workspace, 2 agents/.test(xml) && /Notes workspace, 1 agent/.test(xml) && /Open Fixes, pi · t1/.test(xml) && /Open Daily, pi · t3/.test(xml), 60);
    note(`Home groups by the Herdr app's spaces and tabs: ${grouped}`);
    if (!grouped) defects.push(`Home did not group agents by the layout document (saw ${spaceCards(await snap('home-grouped-missed')).join('; ')})`);
    await capture('home-grouped-270-2.0-dark');

    // 2. New tab: Panes -> New tab. Core runs one more agent, in a second tab of Pockit.
    note(`opened Panes: ${await tap(/content-desc="Panes"/, 20)}`);
    note(`tapped New tab: ${await tap(/content-desc="New tab"/, 20)}`);
    const added = await until(async () => (await terminals()).find((t) => ![t1.address, t2.address, t3.address].includes(t.address)), 30);
    if (added === undefined) defects.push('New tab never ran an agent in Core');
    await sleep(4000);
    const afterTab = await until(async () => { const v = await document(); return v?.spaces?.[0]?.tabs?.length === 2 ? v : undefined; }, 20);
    if (afterTab === undefined) defects.push('New tab did not add a second tab to the Pockit space in the document');
    else if (!JSON.stringify(afterTab.spaces[0].tabs[1].root).includes(added?.address ?? '?')) defects.push('the new tab does not show the new agent');

    // 3. Rename that tab from the agent screen: long-press the current tab chip, Rename, type, Save.
    note(`long-pressed the current tab: ${await longPress(/content-desc="Current tab/, 30)}`);
    note(`tapped Rename: ${await tap(/text="Rename"/, 20)}`);
    await retype('Review');
    await snap('rename-typed');
    note(`tapped Save: ${await tap(/text="Save"/, 20)}`);
    const renamed = await until(async () => { const v = await document(); return v?.spaces?.[0]?.tabs?.some((tab) => tab.name === 'Review') ? v : undefined; }, 20);
    note(`the document names the tab Review: ${renamed !== undefined}`);
    if (renamed === undefined) defects.push('Rename tab did not reach the layout document');

    // 4. Split: back to Panes, New pane in Fixes, Pi. Fixes gains a third pane beside the others.
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(2000);
    await goHome();
    note(`opened Panes again: ${await tap(/content-desc="Panes"/, 20)}`);
    note(`tapped New pane in Fixes: ${await tap(/content-desc="New pane in Fixes"/, 20)}`);
    note(`chose Pi: ${await tap(/Pi, /, 20)}`);
    const split = await until(async () => { const v = await document(); const fixes = v?.spaces?.[0]?.tabs?.find((tab) => tab.name === 'Fixes'); return JSON.stringify(fixes?.root).match(/"terminal"/g)?.length === 3 ? { v, fixes } : undefined; }, 30);
    if (split === undefined) defects.push('New pane in Fixes did not give the Fixes tab a third pane');
    const splitAddress = split === undefined ? undefined : (await terminals()).map((t) => t.address).find((a) => ![t1.address, t2.address, t3.address, added?.address].includes(a));
    await sleep(3000);
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(2000);
    await goHome();
    await snap('home-after-split');
    await capture('home-after-split-270-2.0-dark');

    // 5. Close pane: Panes, long-press the split pane, Close pane, Close. Core and the document lose it.
    note(`opened Panes a third time: ${await tap(/content-desc="Panes"/, 20)}`);
    note(`long-pressed the split pane: ${await longPress(new RegExp(`content-desc="Open Fixes, pi · ${splitAddress ?? 't5'} `), 30)}`);
    note(`tapped Close pane: ${await tap(/text="Close pane"/, 20)}`);
    note(`confirmed: ${await tap(/text="Close"/, 20)}`);
    const paneGone = await until(async () => splitAddress !== undefined && !(await terminals()).some((t) => t.address === splitAddress), 30);
    if (!paneGone) defects.push('Close pane left the terminal in Core');
    const afterClose = await document();
    if (splitAddress !== undefined && JSON.stringify(afterClose).includes(`"${splitAddress}"`)) defects.push('Close pane left the pane in the layout document');
    await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(2000);
    await goHome();

    // 6. Close workspace: Home, long-press Notes, Close workspace, Close. Its agent ends and its space goes.
    note(`long-pressed Notes: ${await longPress(/content-desc="Notes workspace/, 30)}`);
    note(`tapped Close workspace: ${await tap(/text="Close workspace"/, 20)}`);
    note(`confirmed: ${await tap(/text="Close"/, 20)}`);
    const notesGone = await until(async () => !(await terminals()).some((t) => t.address === t3.address), 30);
    if (!notesGone) defects.push('Close workspace left the Notes agent in Core');
    const final = await document();
    if (final?.spaces?.some((space) => space.name === 'Notes')) defects.push('Close workspace left the Notes space in the layout document');
    await sleep(2000);
    await snap('home-after-close');

    // 7. Everything the Herdr app wrote that muxr does not know is still there.
    const fixes = final?.spaces?.[0]?.tabs?.find((tab) => tab.name === 'Fixes');
    const kept = final?.future?.keep === 'me' && final?.spaces?.[0]?.pinned === true && fixes?.accent === 'green' && fixes?.root?.gap === 4;
    note(`the Herdr app's own fields are kept: ${kept}`);
    if (!kept) defects.push(`the Herdr app's own fields were lost (document ${JSON.stringify(final)})`);
    await capture('home-after-close-270-2.0-dark');
    for (const at of [evidence, dir]) {
        writeFileSync(join(at, 'steps.json'), `${JSON.stringify({
            target: { version: `this checkout's host, built from it, on a lab Herdr Core, with the released muxr app` },
            start: 'fresh app data on an Android emulator; a lab relay and host started with --herdr-core-lab over a private lab Herdr Core seeded with three agents and a herdr-app document',
            steps: [
                'open the muxr://pair link from the lab host and tap Pair',
                'read Home: agents are grouped by the document\'s spaces and tabs (Pockit/Fixes, Notes/Daily)',
                'Panes, New tab; long-press the current tab, Rename, type Review, Save',
                'Panes, New pane in Fixes, Pi',
                'Panes, long-press the new pane, Close pane, Close',
                'Home, long-press Notes, Close workspace, Close',
            ],
            result: `Home groups by the Herdr app's layout; New tab, Rename, a split, Close pane and Close workspace each changed Core and the document; the document's own fields (future, pinned, accent, gap) were still there at the end: ${kept}`,
        }, null, 2)}\n`);
    }
    finished = true;
} finally {
    if (!finished) defects.push('the journey stopped before its end');
    api?.close();
    try { await adb('shell', 'wm', 'size', 'reset'); await adb('shell', 'wm', 'density', 'reset'); await adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0'); } catch { /* emulator gone */ }
    const pids = stack ? [stack.pids.relay, stack.pids.host, stack.herdrCore?.pid].filter((pid) => pid !== undefined) : [];
    stack?.stop();
    note('stack stopped');
    await emu.stop();
    note('emulator stopped');
    for (const pid of pids) {
        for (let i = 0; i < 50 && spawnSync('ps', ['-p', String(pid)], { stdio: 'ignore' }).status === 0; i += 1) await sleep(200);
    }
    rmSync(scratch, { recursive: true, force: true });
    for (const defect of defects) note(`DEFECT ${defect}`);
    note(`done; defects: ${defects.length}`);
    process.exitCode = defects.length > 0 ? 1 : 0;
}
