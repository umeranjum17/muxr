// Shared-workspace name proof on a real (lab) Herdr: a project workspace `umer-desk` holds two
// lane tabs, and each lane self-names with `muxr name --workspace <its task slug>`, the last one
// `ssh-ed25519`. A lone-tab workspace self-names too. A third lead sits in an unlabelled tab as
// agent `firstmate-addons`, every lead's terminal title is Claude's Firstmate doorbell topic, and
// the task-titles plugin titles the `fm-crewhouse` lead. With <taskTitlesPlugin>, an installed
// herdr.task-titles checkout, its real hook titles a Pi stand-in from a Pi session transcript.
// Pairs the release APK on an owned emulator and captures Home and Panes beside Herdr's own lists. See workspace-names.md. Run from the
// repo root with HERDR_LAB_HELPER set; <cliRepo> is the checkout whose `scripts/cli.mjs` runs:
//   node .agents/skills/done-done-verify-pockit/features/workspaceNameLab.mjs <apk> <evidenceDir> <labRoot> <cliRepo> [taskTitlesPlugin]
// With <apk> `pwa` it boots no emulator: it builds the same scene, prints `browser link: <link>` and
// holds the lab until SIGTERM, for the installed-PWA capture in agent-naming.md.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const [apk, evidence, root, cliRepo, taskTitles] = process.argv.slice(2);
const repo = process.cwd();
const pwa = apk === 'pwa';
const helper = process.env.HERDR_LAB_HELPER;
let session;
const { bootOwnedEmulator } = await import(join(repo, 'perf/lib/androidEmulator.mjs'));
const { linkHerdrLab } = await import(join(repo, 'scripts/diagnostics/application/linkHerdrLab.mjs'));
const PKG = 'com.trymuxr.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(evidence, { recursive: true });
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(evidence, 'journey.log'), `${line}\n`); };
const herdr = (...args) => execFileSync(helper, ['run', session, ...args], { encoding: 'utf8', timeout: 30_000 });

const work = join(root, 'w');
const folder = join(work, 'muxr');
const soloFolder = join(work, 'solo');
const bin = join(work, 'bin');
mkdirSync(folder, { recursive: true });
mkdirSync(soloFolder, { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'claude'), "#!/bin/sh\nprintf '\\033]2;%s\\007' '✳ Firstmate operational inbox input'\nwhile :; do sleep 3600; done\n", { mode: 0o755 });
const AGENTS = [['w1:t1', 'fd-prompt-nosript'], ['w1:t2', 'fm-crewhouse'], ['w1:t3', 'firstmate-addons']];
const buildScene = () => {
    herdr('workspace', 'create', '--cwd', folder, '--label', 'umer-desk', '--no-focus');
    herdr('tab', 'rename', 'w1:t1', 'fd-prompt-nosript');
    herdr('tab', 'create', '--workspace', 'w1', '--cwd', folder, '--label', 'fm-crewhouse', '--no-focus');
    // No label: Herdr numbers the tab, which names nothing.
    herdr('tab', 'create', '--workspace', 'w1', '--cwd', folder, '--no-focus');
    herdr('workspace', 'create', '--cwd', soloFolder, '--label', 'solo', '--no-focus');
    if (taskTitles) herdr('tab', 'create', '--workspace', 'w1', '--cwd', folder, '--no-focus');
};
// A Pi stand-in reports its session transcript the way Pi does, then the plugin's own hook runs on
// the `working` event and publishes the title through `pane report-metadata`.
const titlePiPane = (pane) => {
    const transcript = join(work, 'pi-session.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Fix the flaky pairing retry on slow networks' }] } })}\n`);
    writeFileSync(join(bin, 'pi'), '#!/bin/sh\nwhile :; do sleep 3600; done\n', { mode: 0o755 });
    herdr('pane', 'send-text', pane, `${join(bin, 'pi')}\n`);
    herdr('pane', 'report-agent-session', pane, '--source', 'herdr:pi', '--agent', 'pi', '--seq', '1', '--session-start-source', 'startup', '--agent-session-path', transcript);
    herdr('pane', 'report-agent', pane, '--source', 'herdr:pi', '--agent', 'pi', '--state', 'working', '--seq', '2', '--agent-session-path', transcript);
    const hookHome = join(root, 'hook-home');
    mkdirSync(join(hookHome, 'herdr.task-titles'), { recursive: true });
    const socket = JSON.parse(herdr('status', '--json')).server.socket;
    return execFileSync(process.execPath, [join(taskTitles, 'hook.mjs')], {
        encoding: 'utf8', timeout: 60_000,
        env: {
            PATH: process.env.PATH, HOME: hookHome, XDG_CONFIG_HOME: hookHome, HERDR_SOCKET_PATH: socket,
            HERDR_BIN_PATH: join(root, 'lab', 'herdr-lab.sh'), HERDR_PLUGIN_CONFIG_DIR: join(hookHome, 'herdr.task-titles'),
            HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: pane, agent_status: 'working', agent: 'pi' } }),
        },
    });
};
const startAgents = async (panes) => {
    for (const [tab, name] of AGENTS) {
        const pane = panes.find((entry) => entry.tab_id === tab).pane_id;
        herdr('pane', 'send-text', pane, `${join(bin, 'claude')}\n`);
        await sleep(1500);
        herdr('agent', 'rename', pane, name);
    }
    // The task-titles plugin publishes a lead's title as Herdr title metadata.
    const crewhouse = panes.find((entry) => entry.tab_id === 'w1:t2').pane_id;
    herdr('pane', 'report-metadata', crewhouse, '--source', 'herdr.task-titles', '--title', 'Show the SSH key fingerprint');
};
// Each lane runs the real CLI from its own pane identity; Herdr calls go through the lab wrapper.
const selfName = (paneId, slug, title) => {
    try {
        return execFileSync(process.execPath, [join(cliRepo, 'scripts/cli.mjs'), 'name', '--workspace', slug, '--pane', title], {
            encoding: 'utf8', timeout: 60_000,
            env: { ...process.env, HERDR_PANE_ID: paneId, HERDR_BIN_PATH: join(root, 'lab', 'herdr-lab.sh') },
        }).trim();
    } catch (cause) {
        return `exit ${cause.status}: ${`${cause.stdout ?? ''}${cause.stderr ?? ''}`.trim()}`;
    }
};
const saveHerdr = (name) => writeFileSync(join(evidence, `herdr-${name}.txt`),
    ['workspace list', 'tab list', 'agent list'].map((cmd) => `$ herdr ${cmd}\n${herdr(...cmd.split(' '))}`).join('\n'));

let offering;
const mintPairing = (path, intent) => new Promise((resolve, reject) => {
    const socket = offering = createConnection(path);
    let pending = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ intent })}\n`));
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

const emu = pwa ? undefined : await bootOwnedEmulator({
    name: 'mxwl', avdHome: process.env.AVD_HOME ?? join(root, 'avd'),
    systemImage: 'system-images;android-35;google_apis;x86_64', launcher: ['nice', '-n', '10'],
});
const serial = emu?.serial;
if (emu) log(`emulator ${serial}`);
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 120_000 });
// Under load the system server can drop (`Broken pipe`) or stall a call for a while after boot or install.
const sh = (cmd) => {
    for (let attempt = 1; ; attempt += 1) {
        try { return adb('shell', cmd); } catch (cause) {
            if (attempt >= 6 || !(cause.code === 'ETIMEDOUT' || /Broken pipe|Can't find service/.test(`${cause.stdout}${cause.stderr}`))) throw cause;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
        }
    }
};
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
    mkdirSync(join(root, 'lab'), { recursive: true });
    lab = await linkHerdrLab(join(root, 'lab'), 'wl', undefined, (_herdr, labSession) => { session = labSession; buildScene(); });
    log(`lab host up on relay port ${lab.port}, herdr ${session}`);
    const panes = JSON.parse(herdr('pane', 'list')).result.panes;
    await startAgents(panes);
    if (taskTitles) {
        const pi = panes.find((entry) => entry.tab_id === 'w1:t4').pane_id;
        titlePiPane(pi);
        log(`task-titles hook on the pi pane: ${readFileSync(join(root, 'hook-home', 'herdr.task-titles', 'outcome.json'), 'utf8').trim()}`);
    }
    saveHerdr('before-self-naming');

    const paneIn = (tab) => panes.find((entry) => entry.tab_id === tab).pane_id;
    log(`lane fd-prompt-nosript: ${selfName(paneIn('w1:t1'), 'prompt-noscript', 'Fix the prompt noscript fallback')}`);
    log(`lane fm-crewhouse: ${selfName(paneIn('w1:t2'), 'ssh-ed25519', 'Show the SSH key fingerprint')}`);
    log(`solo workspace: ${selfName(paneIn('w2:t1'), 'solo-task', 'Solo task')}`);
    saveHerdr('after-self-naming');
    const labels = JSON.parse(herdr('workspace', 'list')).result.workspaces.map((w) => w.label);
    log(`herdr workspace labels: ${labels.join(', ')}`);

    if (pwa) {
        console.log(`browser link: ${await mintPairing(join(root, 'lab', 'host', 'pair.sock'), { kind: 'browser', authority: 'observe', personal: false })}`);
        await new Promise((resolve) => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
        offering?.destroy();
        await lab.stop();
        log('pwa lab stopped');
        process.exit(0);
    }
    // Each buildPrApk run signs with its own throwaway key: a kept AVD may hold another build.
    try { adb('uninstall', PKG); } catch { /* not installed */ }
    // A loaded host can report boot before the package service answers: an install then dies with a broken pipe.
    for (let attempt = 1; ; attempt += 1) {
        try {
            sh('pm path android');
            execFileSync('adb', ['-s', serial, 'install', '-r', apk], { encoding: 'utf8', timeout: 600_000 });
            break;
        } catch (cause) {
            if (attempt >= 3) throw cause;
            log(`install attempt ${attempt} failed; retrying`);
            await sleep(20_000);
        }
    }
    const activity = sh(`cmd package resolve-activity --brief ${PKG}`).trim().split('\n').pop();
    sh(`pm clear ${PKG}`);
    adb('reverse', `tcp:${lab.port}`, `tcp:${lab.port}`);
    sh('wm size 1080x2376'); sh('wm density 440'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no');
    const offer = await mintPairing(join(root, 'lab', 'host', 'pair.sock'), { kind: 'native', authority: 'control', personal: false });
    sh(`am start -W -n ${activity}`);
    await sleep(4000);
    sh(`am start -W -a android.intent.action.VIEW -d 'muxr://pair#${offer}' -n ${activity}`);
    await tapText(/^Pair$/);
    await waitFor(/nosript/i, 90);
    offering?.destroy();

    const shown = new Set();
    const capture = async (name, screen) => {
        sh(`am force-stop ${PKG}`);
        sh(`am start -W -n ${activity}`);
        await sleep(3000);
        if (screen === 'panes') sh(`am start -W -a android.intent.action.VIEW -d 'muxr:///panes' -n ${activity}`);
        await waitFor(/nosript/i, 60).catch(() => log(`${name}: names not seen`));
        await sleep(2500);
        const xml = dump();
        for (const word of ['umer-desk', 'ssh-ed25519', 'Firstmate addons', 'Firstmate operational inbox', 'claude · firstmate-addons', 'Show the SSH key fingerprint', 'Fix the flaky pairing retry', 'pi · fix-flaky-pairing']) if (xml.includes(word)) shown.add(`${name}:${word}`);
        try {
            writeFileSync(join(evidence, `${name}.check.txt`), execFileSync('node',
                [join(repo, '.agents/skills/done-done-verify-pockit/features/visualCheck.mjs'), serial, evidence, name], { encoding: 'utf8' }));
        } catch (cause) {
            defects += 1;
            writeFileSync(join(evidence, `${name}.check.txt`), `${cause.stdout ?? ''}${cause.stderr ?? ''}`);
        }
        log(`captured ${name}`);
    };
    for (const [width, density, font, theme] of [['393', 440, '1.0', 'light'], ['270', 640, '2.0', 'light'], ['270', 640, '2.0', 'dark']]) {
        sh(`wm density ${density}`); sh(`settings put system font_scale ${font}`);
        sh(`cmd uimode night ${theme === 'dark' ? 'yes' : 'no'}`);
        for (const screen of ['home', 'panes']) await capture(`${screen}-${width}-${font}-${theme}`, screen);
    }
    log(`phone shows: ${[...shown].sort().join(', ') || 'none of the watched words'}`);
} finally {
    if (emu) try { sh('wm size reset'); sh('wm density reset'); sh('settings put system font_scale 1.0'); sh('cmd uimode night no'); } catch { /* emulator gone */ }
    offering?.destroy();
    await lab?.stop();
    if (emu) try { execFileSync('adb', ['-s', serial, 'emu', 'kill'], { timeout: 30_000 }); } catch { /* already gone */ }
    await emu?.stop?.();
    log(`done; cells with visual-check defects: ${defects}`);
}
