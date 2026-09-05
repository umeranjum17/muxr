/** Local, supervised live probe. JSON commands on this dedicated shell's stdin. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CommandScope, useCommandScope } from './lib/commands.mjs';
import { startLiveStack } from './lib/fakeStack.mjs';
import { pairPhone } from './lib/pairPhone.mjs';
import { parseUiNodes, cropRaw, pixelsMoved } from './lib/gestureMetrics.mjs';
import { sourceIdentity, harnessIdentity, patchedDependencies, sha256 } from './lib/provenance.mjs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
for (const key of ['--host-root', '--apk', '--out', '--auth-home', '--gate-report']) if (!args.includes(key)) throw new Error(`Required ${key}`);
const hostRoot = realpathSync(option('--host-root')), apk = realpathSync(option('--apk'));
const authHome = realpathSync(option('--auth-home')), out = resolve(option('--out'));
const serial = 'emulator-5554', pkg = 'com.trymuxr.app';
process.env.ANDROID_SERIAL = serial;
const lock = `/tmp/muxr-pr-gate-${serial}.lock`;
const scope = new CommandScope(); useCommandScope(scope);
let operationDeadline = Infinity;
const run = (bin, argv, options = {}) => {
    const timeout = Math.min(options.timeout ?? 30000, operationDeadline - Date.now());
    check(timeout > 0, 'Phase deadline reached');
    return scope.run(bin, argv, { ...options, timeout });
};
function adbFailureClass(args) {
    if (args[0] === 'shell' && args[1] === 'dumpsys' && args[2] === 'activity') return 'get-state';
    if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'tap') return 'input-tap';
    if (args[0] === 'shell' && args[1] === 'uiautomator') return 'ui-dump';
    if (args[0] === 'shell' && args[1] === 'cat') return 'ui-read';
    if (args[0] === 'exec-out' && args[1] === 'screencap') return 'screencap';
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'start') return 'activity-start';
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') return 'force-stop';
    if (args[0] === 'shell' && args[1] === 'pidof') return 'get-state';
    if (args[0] === 'shell' && args[1] === 'sh' && args[2] === '-c' && String(args[3]).startsWith('pidof ')) return 'get-state';
    return String(args[0] ?? 'unknown').replace(/[^a-z0-9_.-]/gi, '').slice(0, 48) || 'unknown';
}
function sanitizeAdbText(value) {
    return String(value ?? '')
        .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._~+/-]+/gi, '[redacted]')
        .replace(/(?:\/[^\s,;<>]+){2,}/g, '[path redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}
function recordAdbFailure(args, cause) {
    report.adbFailures ??= [];
    const message = String(cause?.message ?? '');
    const exit = /exit (\d+)/.exec(message)?.[1];
    const signal = /signal (SIG[A-Z0-9]+)/i.exec(message)?.[1];
    report.adbFailures.push({
        at: new Date().toISOString(),
        class: adbFailureClass(args),
        result: exit ? `exit-${exit}` : signal ? `signal-${signal}` : /exceeded/.test(message) ? 'timeout' : 'error',
        stderr: sanitizeAdbText(cause?.stderr),
    });
}
const adbRunOn = async (commandScope, args, options = {}) => {
    try {
        return (await commandScope.run('adb', ['-s', serial, ...args], { timeout: 15_000, ...options })).stdout;
    } catch (cause) {
        if (options.allowAbsentPid && args[0] === 'shell' && args[1] === 'pidof'
            && /\bexit 1\b/.test(String(cause?.message ?? '')) && !sanitizeAdbText(cause?.stderr)) {
            const deviceState = await adbRunOn(commandScope, ['get-state'], { timeout: 10_000 });
            if (deviceState.trim() === 'device') return '';
        }
        recordAdbFailure(args, cause);
        throw cause;
    }
};
const adbRun = async (args, options = {}) => adbRunOn({ run }, args, options);
const adb = async (...args) => adbRun(args);
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const check = (yes, why) => { if (!yes) throw new Error(why); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { startedAt: new Date().toISOString(), serial, checks: [], failures: [], acceptance: 'Pending supervised evidence review; never automatic live audio or GitHub paint PASS' };
let scratchRoot, stack, ownsLock = false, ownsOut = false, deviceTouched = false, finishing = false, producer, tab, voiceTimer;
let voicePhase = 'idle', voiceDeadline = 0;
const save = (name, bytes) => writeFileSync(join(out, name), bytes);
function publish(path) {
    for (const pane of new Set([process.env.HERDR_PANE_ID, process.env.PERF_PARENT_PANE].filter(Boolean))) for (const app of ['.pocketherdr', '.muxr']) {
        const dir = join(homedir(), app, 'attachments/pane', pane); mkdirSync(dir, { recursive: true });
        copyFileSync(path, join(dir, `${basename(out)}-${basename(path)}`));
    }
}
async function ui() {
    await adb('shell', 'rm', '-f', '/sdcard/live-probe.xml');
    await adb('shell', 'uiautomator', 'dump', '/sdcard/live-probe.xml');
    const xml = await adb('shell', 'cat', '/sdcard/live-probe.xml');
    check(xml.includes('<hierarchy'), 'Missing UI hierarchy'); return xml;
}
async function tap(text) {
    const node = parseUiNodes(await ui()).find((node) => node.text === text || node.desc === text);
    check(node && node.r > node.l && node.b > node.t, `Missing control ${text}`);
    await adb('shell', 'input', 'tap', String((node.l + node.r) / 2), String((node.t + node.b) / 2));
}
async function capture(name) {
    check(/^[a-z0-9-]+$/.test(name), 'Invalid evidence name');
    save(`${name}.png`, await adbRun(['exec-out', 'screencap', '-p'], { encoding: 'buffer' }));
    publish(join(out, `${name}.png`));
    save(`${name}.xml`, await ui());
}
async function voiceStateSnapshot(phase) {
    const raw = await adb('shell', 'dumpsys', 'activity', 'top');
    const state = raw.split('\n').filter((line) => /(?:mResumedActivity|ResumedActivity|mFocusedApp)/.test(line))
        .map(sanitizeAdbText).join(' | ').slice(0, 240);
    (report.voiceState ??= []).push({
        at: new Date().toISOString(),
        phase,
        status: state ? 'available' : 'missing',
        voicePhase,
        voiceStarted: Boolean(report.voiceStartedAt),
    });
}
const herdr = async (...args) => (await run('/usr/bin/herdr', args, { timeout: 15_000 })).stdout;
async function open(uri) {
    check(uri.startsWith('muxr:///') || uri.startsWith('muxr://session/'), 'Only muxr routes allowed');
    await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shellQuote(uri), pkg);
}
async function maestro(_flow, variables) {
    // Pairing credentials and Maestro output remain in private fresh scratch.
    const argv = ['x', 'maestro@cli-2.7.0', '--', 'maestro', '--device', serial, 'test', '--debug-output', join(scratchRoot, 'maestro'), ...Object.entries(variables).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'perf/flows/pair.yaml'];
    try { await run('mise', argv, { timeout: 160_000 }); return { code: 0, output: '' }; }
    catch { return { code: 1, output: 'Pairing flow failed (private diagnostics)' }; }
}
function processStart(pid) {
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; }
}
async function retireProducer(deadline = Date.now() + 10000) {
    if (!producer || !processStart(producer.pid)) return;
    check(processStart(producer.pid) === producer.start, 'Producer PID reused; refusing signal');
    report.retirementSignalAt ??= new Date().toISOString();
    process.kill(producer.pid, 'SIGTERM');
    const end = Math.min(Date.now() + 5000, deadline - 1000);
    while (processStart(producer.pid) === producer.start && Date.now() < end) await sleep(100);
    if (processStart(producer.pid) === producer.start) {
        process.kill(producer.pid, 'SIGKILL');
        const killEnd = Math.min(Date.now() + 5000, deadline);
        while (processStart(producer.pid) === producer.start && Date.now() < killEnd) await sleep(100);
        check(processStart(producer.pid) !== producer.start, 'Owned producer did not terminate; retain lock');
    }
    report.retiredAt ??= new Date().toISOString();
}
async function memory(label, pid) {
    check((await adb('shell', 'pidof', pkg)).trim() === pid, 'APK process died or changed');
    const at = new Date().toISOString();
    const raw = await adb('shell', 'dumpsys', 'meminfo', pid);
    save(`${label}-meminfo.txt`, `${at}\n${raw}`);
    const pss = Number(/TOTAL PSS:\s+(\d+)/.exec(raw)?.[1]);
    check(Number.isFinite(pss) && pss > 0, 'Missing TOTAL PSS');
    const completedAt = new Date().toISOString();
    const phase = !producer ? 'baseline' : !report.retirementSignalAt || completedAt < report.retirementSignalAt ? 'paint' : report.retiredAt && at >= report.retiredAt ? 'retired' : 'transition';
    const sample = { at, completedAt, phase, label, pid, pssKiB: pss, nativeHeapKiB: Number(/Native Heap:\s+(\d+)/.exec(raw)?.[1]), javaHeapKiB: Number(/Java Heap:\s+(\d+)/.exec(raw)?.[1]) };
    check(Number.isFinite(sample.nativeHeapKiB) && Number.isFinite(sample.javaHeapKiB), 'Missing heap evidence');
    (report.memory ??= []).push(sample);
    check(pss <= 900000, `Memory stop: ${pss}KiB exceeds 900000KiB`);
}
async function browserInventory() {
    return JSON.parse((await run('terminal-browser', ['ls', '--all', '--json'], { timeout: 10_000 })).stdout).browsers ?? [];
}
function bodyPixelProof(path) {
    const png = PNG.sync.read(readFileSync(path));
    const left = Math.floor(png.width * 0.04), right = Math.floor(png.width * 0.86);
    const top = Math.floor(png.height * 0.20), bottom = Math.floor(png.height * 0.78);
    let nonWhite = 0, dark = 0, colorBuckets = new Set();
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const i = (y * png.width + x) * 4, r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
        if (a < 16) continue;
        if (r < 245 || g < 245 || b < 245) nonWhite++;
        if (r < 100 && g < 100 && b < 100) dark++;
        colorBuckets.add(`${r >> 4}:${g >> 4}:${b >> 4}`);
    }
    return { width: png.width, height: png.height, nonWhite, dark, colorBuckets: colorBuckets.size, proven: nonWhite >= 2_000 && dark >= 200 && colorBuckets.size >= 24 };
}
async function retireOwnedBrowser(browser, deadline = Date.now() + 10000) {
    check(browser?.key && browser?.tabId !== undefined, 'Missing owned browser identity');
    try {
        await run('terminal-browser', ['action', '--browser', browser.key, '--tab', String(browser.tabId), '--', 'eval', 'document.dispatchEvent(new Event("muxr-owned-probe-retire"))'], { timeout: Math.max(1, Math.min(3000, deadline - Date.now() - 1000)) });
    } catch { report.browserQuitResponse = 'Command response unavailable; require scoped inventory absence'; }
    do {
        const remaining = (await browserInventory()).filter((entry) => entry.key === browser.key || entry.pane?.pane === tab.pane);
        if (remaining.length === 0) { report.browserRetiredAt = new Date().toISOString(); return; }
        await sleep(250);
    } while (Date.now() < deadline);
    throw new Error('Owned browser remained after scoped quit; retain lock and scratch');
}
async function prepareGraphicsPane() {
    const deadline = Date.now() + 30_000;
    const previousDeadline = operationDeadline;
    operationDeadline = deadline;
    try {
        for (let attempt = 0; Date.now() < deadline; attempt++) {
            const xml = await ui();
            save(`graphics-preflight-${attempt}.xml`, xml);
            if (xml.includes('Show live agent updates?')) { await tap('CANCEL'); await sleep(250); continue; }
            if (/text="(Terminal|ctrl)"/.test(xml)) return;
            await sleep(500);
        }
    } finally {
        operationDeadline = previousDeadline;
    }
    throw new Error('Terminal not mounted during bounded graphics preflight');
}
async function github() {
    check(tab && !producer, 'Create owned producer pane and mount it first');
    await prepareGraphicsPane();
    const pid = (await adb('shell', 'pidof', pkg)).trim(); check(/^\d+$/.test(pid), 'Expected one APK PID');
    await memory('baseline', pid);
    // This script reports its own PID before exec; only that exact PID/start is retired.
    const pidFile = join(scratchRoot, 'producer.pid');
    const script = join(scratchRoot, 'producer.sh');
    // The supported quit API lives in Electron's isolated preload world, not
    // page eval. This owned preload exposes only retirement of its own window.
    const preload = join(scratchRoot, 'owned-browser-preload.cjs');
    writeFileSync(preload, 'document.addEventListener("muxr-owned-probe-retire", () => globalThis.terminalBrowser.quit(), { once: true });', { mode: 0o600 });
    writeFileSync(script, `#!/bin/sh\necho $$ > ${shellQuote(pidFile)}\nexec terminal-browser open --preload=${shellQuote(preload)} --no-toolbar --no-merge --no-frame https://github.com/\n`, { mode: 0o700 });
    const launchAt = Date.now();
    const paintDeadline = launchAt + 20000;
    report.producerLaunchAt = new Date(launchAt).toISOString();
    operationDeadline = paintDeadline;
    const paintStop = setTimeout(() => void finish(new Error('Producer exceeded launch-to-retirement cap')), 20000);
    try {
        await herdr('pane', 'run', tab.pane, `${shellQuote(script)}; printf '\\nMEMORY PROBE RETIRED\\n'`);
        const end = Math.min(Date.now() + 5000, paintDeadline);
        while (!existsSync(pidFile) && Date.now() < end) await sleep(100);
        check(existsSync(pidFile), 'Owned producer did not announce PID');
        const producerPid = Number(readFileSync(pidFile, 'utf8').trim());
        check(Number.isSafeInteger(producerPid) && producerPid > 1, 'Invalid owned PID');
        producer = { pid: producerPid, start: processStart(producerPid) }; check(producer.start, 'Producer exited before identity capture');
        report.producer = { ...producer, pane: tab.pane, url: 'https://github.com/' };
        // Reserve eight seconds inside the launch cap for both retirements.
        const deadline = paintDeadline - 8000;
        operationDeadline = deadline;
        // Bind the exact owned window before judging readiness or requesting quit.
        do {
            const owned = (await browserInventory()).filter((browser) => browser.pane?.pane === tab.pane);
            check(owned.length <= 1, 'Multiple browser windows in owned pane');
            const target = owned[0]?.tabs.find((entry) => entry.url === 'https://github.com/');
            if (target) {
                const browserStart = processStart(owned[0].pid);
                check(browserStart, 'Cannot capture owned browser PID start identity');
                report.browser = { key: owned[0].key, pid: owned[0].pid, start: browserStart, pane: owned[0].pane, tabId: target.id, url: target.url, title: target.title };
                break;
            }
            await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
        } while (Date.now() < deadline);
        check(report.browser, 'Cannot bind GitHub browser to owned pane inside paint deadline');
        const scrollPosition = async () => {
            const value = JSON.parse((await run('terminal-browser', ['action', '--browser', report.browser.key, '--tab', String(report.browser.tabId), '--', 'eval', 'window.scrollY'], { timeout: 5000 })).stdout);
            check(Number.isFinite(value), 'Missing owned page scroll position'); return value;
        };
        report.githubPaintSamples = [];
        for (let i = 0; Date.now() < deadline; i++) {
            await memory(`paint-${i}`, pid);
            const name = `github-paint-${i}`;
            // Screenshot directly: repeated UI dumps can consume the paint cap.
            save(`${name}.png`, await adbRun(['exec-out', 'screencap', '-p'], { encoding: 'buffer' }));
            const proof = { at: new Date().toISOString(), ...bodyPixelProof(join(out, `${name}.png`)) };
            report.githubPaintSamples.push(proof);
            if (proof.proven && !report.githubPaint?.proven) {
                report.githubPaint = proof;
                copyFileSync(join(out, `${name}.png`), join(out, 'github-paint.png'));
                publish(join(out, 'github-paint.png'));
            }
            if (report.githubScrollAt && !report.githubScroll) {
                const before = PNG.sync.read(readFileSync(join(out, 'github-paint.png')));
                const after = PNG.sync.read(readFileSync(join(out, `${name}.png`)));
                const region = { l: before.width * .04, r: before.width * .86, t: before.height * .20, b: before.height * .78 };
                const movement = pixelsMoved(cropRaw({ ...before, bytes: before.data }, region), cropRaw({ ...after, bytes: after.data }, region));
                const scrollY = await scrollPosition();
                if (proof.proven && movement.moved && scrollY > report.githubScrollFrom + 16) report.githubScroll = { at: proof.at, from: report.githubScrollFrom, to: scrollY, ...movement };
            }
            if (proof.proven && !report.githubScrollAt && Date.now() + 4000 < deadline) {
                const { width, height } = proof;
                report.githubScrollFrom = await scrollPosition();
                await adb('shell', 'input', 'swipe', String(Math.round(width * .5)), String(Math.round(height * .66)), String(Math.round(width * .5)), String(Math.round(height * .43)), '400');
                report.githubScrollAt = new Date().toISOString();
            }
            await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
        }
        check(report.githubPaint?.proven, 'GitHub body pixels never painted within the bounded window; all samples retained');
        check(report.githubScroll?.moved, 'No painted content movement after the phone scroll; retain samples without scroll acceptance');
    } finally {
        operationDeadline = paintDeadline;
        try {
            try {
                await retireProducer(Math.min(Date.now() + 4000, paintDeadline - 2000));
            } finally {
                // Browser cleanup is independent even if the controller fails.
                if (report.browser) await retireOwnedBrowser(report.browser, paintDeadline);
            }
            check(Date.now() <= paintDeadline, 'Launch-to-retirement exceeded 20 seconds');
        } finally {
            clearTimeout(paintStop);
            operationDeadline = Infinity;
        }
    }
    const retirementDeadline = Date.now() + 20000;
    operationDeadline = retirementDeadline;
    try {
        for (let i = 0; Date.now() < retirementDeadline; i++) {
            await memory(`retired-${i}`, pid);
            await sleep(Math.min(2000, Math.max(0, retirementDeadline - Date.now())));
        }
    } finally { operationDeadline = Infinity; }
    await capture('github-retired');
    report.retiredPane = (await run('/usr/bin/herdr', ['pane', 'read', tab.pane, '--source', 'visible', '--lines', '8'], { timeout: 10000 })).stdout;
    check(report.retiredPane?.includes('MEMORY PROBE RETIRED'), 'Owned shell did not return');
    report.checks.push('GitHub bounded memory window complete; screenshots require actual painted-page review');
}
async function command(input) {
    check(input && !Array.isArray(input) && typeof input === 'object', 'Expected command object');
    check(Object.entries(input).every(([key, value]) => ['op', 'text', 'uri', 'name'].includes(key) && typeof value === 'string' && value.length <= 2048), 'Invalid command fields');
    const { op, text, uri, name } = input;
    if (op === 'capture') return capture(name);
    if (op === 'tap') {
        check(text !== 'Talk to this session', 'Use voice-start for the realtime voice control');
        return tap(text);
    }
    if (op === 'open') return open(uri);
    if (op === 'back') return adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    if (op === 'pane') {
        check(!tab, 'Probe pane already exists');
        const result = JSON.parse(await herdr('tab', 'create', '--workspace', process.env.HERDR_PANE_ID.split(':')[0], '--cwd', scratchRoot, '--label', 'Owned live graphics probe', '--no-focus')).result;
        tab = { id: result.tab.tab_id, pane: result.root_pane.pane_id };
        await herdr('pane', 'run', tab.pane, "printf '\\nMEMORY PROBE READY\\n'");
        await herdr('tab', 'focus', tab.id);
        await open(`muxr://session/${encodeURIComponent(`shell:${tab.pane}`)}`);
        report.probePane = tab; return;
    }
    if (op === 'github') return github();
    if (op === 'voice-start') {
        check(voicePhase === 'idle', 'Voice attempt already used');
        voicePhase = 'establishing'; voiceDeadline = Date.now() + 30000;
        voiceTimer = setTimeout(() => void finish(new Error('Voice establishment exceeded 30 seconds')), 30000);
        report.voiceStartedAt = new Date().toISOString();
        await voiceStateSnapshot('before-tap');
        await tap(text);
        await voiceStateSnapshot('after-tap');
        return;
    }
    if (op === 'voice-connected') {
        check(voicePhase === 'establishing' && Date.now() < voiceDeadline, 'Invalid voice connection transition');
        voicePhase = 'connected'; voiceDeadline = Date.now() + 30000;
        clearTimeout(voiceTimer);
        voiceTimer = setTimeout(() => void finish(new Error('Voice interaction exceeded 30 seconds')), 30000);
        report.voiceConnectedObservationAt = new Date().toISOString();
        report.checks.push('Operator observed connection; real audio proof still requires separate evidence');
        return;
    }
    if (op === 'voice-end') {
        check(['establishing', 'connected'].includes(voicePhase), 'No active voice attempt');
        voicePhase = 'ending';
        await tap(text); // Existing absolute deadline stays armed until finish forces stop.
        report.voiceEndRequestedAt = new Date().toISOString();
        return;
    }
    if (op === 'voice-state') {
        check(/^[a-z0-9-]+$/.test(name), 'Invalid voice state name');
        save(`${name}-service.txt`, await adb('shell', 'dumpsys', 'activity', 'services', pkg));
        save(`${name}-mic.txt`, await adb('shell', 'cmd', 'appops', 'get', pkg, 'RECORD_AUDIO'));
        return capture(name);
    }
    if (op === 'finish') return finish();
    throw new Error('Unknown probe command');
}
const evidenceTimestamp = (value) => typeof value === 'string' && value.length <= 30
    && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
function connectionEvidence() {
    if (!stack || !existsSync(stack.journalPath)) return { events: [] };
    const journal = JSON.parse(readFileSync(stack.journalPath, 'utf8'));
    const kinds = ['local', 'native', 'browser', 'peer', 'unknown'];
    return {
        sampledAt: new Date().toISOString(),
        startedAt: evidenceTimestamp(journal.current?.startedAt),
        updatedAt: evidenceTimestamp(journal.current?.updatedAt),
        recentClients: Object.fromEntries(kinds.map((kind) => {
            const count = journal.current?.recentClients?.[kind];
            return [kind, Number.isSafeInteger(count) && count >= 0 && count <= 1000000 ? count : null];
        })),
        relayState: ['connecting', 'open', 'closed', 'replaced'].includes(journal.current?.relayState) ? journal.current.relayState : 'unknown',
        events: (journal.events ?? []).filter((event) => (['relay.state', 'client.hello', 'client.reject'].includes(event.event)
            || event.event === 'client.request' && event.clientKind === 'native' && event.outcome === 'ok'
                && ['session.list', 'machines.list'].includes(event.request))).slice(-32).map((event) => ({
            at: evidenceTimestamp(event.at),
            event: event.event,
            state: ['connecting', 'open', 'closed', 'replaced'].includes(event.state) ? event.state : undefined,
            kind: kinds.includes(event.kind ?? event.clientKind) ? event.kind ?? event.clientKind : undefined,
            outcome: ['decrypt-rejected', 'malformed', 'ok'].includes(event.outcome) ? event.outcome : undefined,
            request: event.event === 'client.request' && ['session.list', 'machines.list'].includes(event.request) ? event.request : undefined,
        })),
    };
}
function nativeConnectionProof(evidence, requireHello) {
    const start = Date.parse(report.startedAt);
    const fresh = (at) => Date.parse(at) >= start && Date.parse(at) <= Date.parse(evidence.sampledAt);
    if (evidence.events.some((event) => event.event === 'client.hello' && event.kind === 'native' && fresh(event.at))) return 'accepted-native-hello';
    if (!requireHello && evidence.events.some((event) => event.event === 'client.request'
        && event.kind === 'native' && event.outcome === 'ok' && fresh(event.at))) return 'successful-native-read';
    // host.ts counts a native client only after authenticated ingress. Ordinary
    // RPCs update this count even when an unsolicited encrypted host frame made
    // the phone live before its hello was accepted. The fresh owned journal starts
    // with zero clients; require its startup and persisted snapshot within this run.
    if (!requireHello && fresh(evidence.startedAt) && fresh(evidence.updatedAt)
        && evidence.recentClients?.native > 0) return 'authenticated-native-activity';
    return null;
}
async function waitForNativeConnection() {
    const deadline = Date.now() + 30000;
    operationDeadline = deadline;
    try {
        do {
            const xml = await ui(); save('live-connecting.xml', xml);
            report.connectionJournal = connectionEvidence();
            const proof = nativeConnectionProof(report.connectionJournal, args.includes('--diagnose-reconnect'));
            if (/text="connected"/.test(xml) && proof) {
                report.connectionProof = { kind: proof, evidence: report.connectionJournal };
                report.connectedAt = new Date().toISOString(); return;
            }
            if (['Keep muxr connected in the background?', 'Show live agent updates?'].some((title) => xml.includes(`text="${title}"`))) await tap('CANCEL');
            await sleep(Math.min(1200, Math.max(0, deadline - Date.now())));
        } while (Date.now() < deadline);
        throw new Error('Live host did not connect: require connected UI and fresh authenticated native evidence; see connectionJournal/live-connecting.xml');
    } finally { operationDeadline = Infinity; }
}
async function connectedBeforeReady() {
    if (!args.includes('--diagnose-reconnect')) return waitForNativeConnection();
    report.acceptance = 'Diagnostic reconnect only; not product pairing or live workload acceptance';
    report.reconnectDiagnostic = { startedAt: new Date().toISOString() };
    const diagnostic = report.reconnectDiagnostic;
    const stateMetadata = () => {
        // This is the already-owned scratch enrollment, never real auth HOME.
        const path = join(dirname(stack.dataDir), 'selfhost.json');
        const state = JSON.parse(readFileSync(path, 'utf8'));
        return { observedAt: new Date().toISOString(), mtime: statSync(path).mtime.toISOString(), deviceCount: Object.keys(state.machine.crypto.devices ?? {}).length, pendingRotation: Boolean(state.machine.crypto.pendingRotation) };
    };
    try {
        await waitForNativeConnection();
        diagnostic.result = 'Initial connection succeeded; reconnect distinction not exercised';
        return;
    } catch (cause) {
        diagnostic.initialFailure = cause.message;
        diagnostic.beforeJournal = connectionEvidence();
        copyFileSync(join(out, 'live-connecting.xml'), join(out, 'before-reconnect.xml'));
    }
    diagnostic.beforeState = stateMetadata();
    check(diagnostic.beforeState.deviceCount > 0, 'No persisted enrollment for reconnect diagnostic');
    // Wait from observing persisted enrollment, not an inferred CLI completion.
    await sleep(3000);
    diagnostic.preReconnectState = stateMetadata();
    check(diagnostic.preReconnectState.mtime === diagnostic.beforeState.mtime
        && diagnostic.preReconnectState.deviceCount === diagnostic.beforeState.deviceCount, 'Enrollment changed while waiting; diagnostic not comparable');
    diagnostic.reconnectAt = new Date().toISOString();
    await adb('shell', 'am', 'force-stop', pkg);
    await open('muxr:///'); // Preserve app data, machine enrollment and crypto guards.
    await waitForNativeConnection();
    copyFileSync(join(out, 'live-connecting.xml'), join(out, 'after-reconnect.xml'));
    diagnostic.afterState = stateMetadata();
    diagnostic.afterJournal = connectionEvidence();
    check(diagnostic.afterJournal.events.some((event) => event.event === 'client.hello' && event.kind === 'native' && event.at >= diagnostic.reconnectAt), 'No newly accepted native hello after reconnect');
    diagnostic.result = 'Same enrollment connected after delayed app reconnect; initial rejection subtype remains unproven';
}
async function finish(error) {
    if (finishing) return; finishing = true; clearTimeout(watchdog); clearTimeout(voiceTimer);
    if (error) report.failures.push(error.message ?? String(error));
    if (!ownsOut) { console.error('Probe setup failed before creating evidence:', report.failures); process.exit(1); }
    let clean = true;
    if (report.producerLaunchAt && !producer) { clean = false; report.failures.push('Producer launch lacks PID ownership proof; retaining lock and scratch'); }
    try { await retireProducer(); } catch (cause) { report.failures.push(cause.message); clean = false; }
    if (report.producerLaunchAt && !report.browserRetiredAt) {
        clean = false;
        report.failures.push('Browser absence was not proven after launch; retaining lock and scratch');
    }
    try { await scope.close(); } catch (cause) { report.failures.push(cause.message); clean = false; }
    try { report.connectionJournal = connectionEvidence(); } catch { report.failures.push('Connection journal unavailable'); }
    const diagnostics = new CommandScope();
    const cleanupStep = async (action) => { try { await action(); } catch (cause) { clean = false; report.failures.push(cause.message); } };
    if (deviceTouched) await cleanupStep(async () => {
        await adbRunOn(diagnostics, ['shell', 'am', 'force-stop', pkg]);
        const status = await adbRunOn(diagnostics, ['shell', 'pidof', pkg], { timeout: 10000, allowAbsentPid: true });
        check(status.trim() === '', 'APK remains after force-stop');
    });
    if (tab) await cleanupStep(() => diagnostics.run('/usr/bin/herdr', ['tab', 'close', tab.id], { timeout: 15000 }));
    await cleanupStep(() => diagnostics.close());
    if (clean) {
        scope.cleanup();
        if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
        if (ownsLock) rmSync(lock, { recursive: true, force: true });
    }

    try {
        check(sourceIdentity(hostRoot).sourceSha256 === report.host.sourceSha256, 'Host source changed');
        check(sha256(join(hostRoot, 'apps/host/dist/main.js')) === report.host.entrySha256, 'Built host changed');
        check(harnessIdentity().sha256 === report.harness.sha256, 'Harness changed');
        check(JSON.stringify(patchedDependencies(hostRoot)) === JSON.stringify(report.apk.nativeDependencies), 'Native dependency bytes changed');
        report.finalFreeze = true;
    } catch (cause) { report.failures.push(cause.message); }
    report.cleanup = clean; report.finishedAt = new Date().toISOString();
    save('report.json', JSON.stringify(report, null, 2)); publish(join(out, 'report.json'));
    const exporter = new CommandScope();
    try {
        const archive = `${out}.tar.gz`;
        await exporter.run('tar', ['-czf', archive, '-C', out, '.'], { timeout: 30000 });
        publish(archive);
    } catch (cause) { console.error('Evidence archive failed:', cause.message); process.exitCode = 1; }
    await exporter.close();
    process.exit(report.failures.length || process.exitCode ? 1 : 0);
}
const watchdog = setTimeout(() => void finish(new Error('Live probe exceeded 10-minute deadline')), 600000);
process.once('SIGTERM', () => void finish(new Error('Interrupted')));
process.once('SIGINT', () => void finish(new Error('Interrupted')));
async function main() {
    mkdirSync(out); ownsOut = true; // Require a new evidence directory; never overwrite failed runs.
    mkdirSync(lock); ownsLock = true;
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, pane: process.env.HERDR_PANE_ID, startedAt: report.startedAt }));
    scratchRoot = mkdtempSync(join(tmpdir(), 'muxr-live-probe-'));
    report.apk = JSON.parse(readFileSync(`${apk}.json`, 'utf8'));
    report.host = sourceIdentity(hostRoot); report.harness = harnessIdentity();
    check(report.apk.variant === 'release' && /^[a-f0-9]{40}$/.test(report.apk.revision), 'Missing release revision');
    check(report.apk.nativeDependencies && Object.keys(report.apk.nativeDependencies).length > 0, 'Missing native provenance');
    check(report.apk.apkSha256 === sha256(apk), 'APK manifest mismatch');
    check(report.apk.mobileSha256 === report.host.mobileSha256, 'APK mobile mismatch');
    check(JSON.stringify(report.apk.nativeDependencies) === JSON.stringify(patchedDependencies(hostRoot)), 'APK native mismatch');
    report.host.entrySha256 = sha256(join(hostRoot, 'apps/host/dist/main.js'));
    const gate = JSON.parse(readFileSync(option('--gate-report'), 'utf8'));
    check(gate.passed === true && gate.flow === 'full', 'Require a completed passing full gate');
    check(gate.host.sourceSha256 === report.host.sourceSha256 && gate.host.entrySha256 === report.host.entrySha256, 'Host dist/source not bound to matching full-gate build');
    check(gate.installedApkSha256 === report.apk.apkSha256, 'Full-gate APK mismatch');
    report.buildEvidence = { path: resolve(option('--gate-report')), sha256: sha256(option('--gate-report')), host: gate.host, installedApkSha256: gate.installedApkSha256 };
    const installed = (await adb('shell', 'pm', 'path', pkg)).trim().replace(/^package:/, '');
    const pull = join(scratchRoot, 'installed.apk'); await adb('pull', installed, pull);
    check(sha256(pull) === report.apk.apkSha256, 'Installed APK mismatch'); report.installedApkSha256 = sha256(pull);
    deviceTouched = true;
    await adb('shell', 'pm', 'clear', pkg);
    stack = await startLiveStack({ sourceRoot: hostRoot, authHome, socketPath: join(authHome, '.config/herdr/herdr.sock'), clientSocketPath: join(authHome, '.config/herdr/herdr-client.sock'), binPath: '/usr/bin/herdr' });
    report.pairing = await pairPhone({ stack, maestro, attempts: 1, patienceSeconds: 30 });
    check(report.pairing.ok, report.pairing.why);
    await sleep(8000);
    const xml = await ui();
    if (xml.includes('Show live agent updates?')) await tap('CANCEL');
    await connectedBeforeReady();
    if (args.includes('--diagnose-reconnect')) return finish();
    console.log('LIVE_PROBE_READY: JSON stdin commands capture/tap/open/back/pane/github/voice-state/finish');
    // Stream backpressure bounds queued chunks; cap both framing and command size.
    let pending = '';
    for await (const chunk of process.stdin) {
        check(chunk.length <= 4096 && Buffer.byteLength(pending) + chunk.length <= 4096, 'Command input exceeds 4096 bytes');
        pending += chunk.toString('utf8');
        while (pending.includes('\n')) {
            const newline = pending.indexOf('\n');
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (finishing) return;
            await command(JSON.parse(line)); console.log('COMMAND_DONE');
        }
    }
    check(pending.trim() === '', 'Incomplete command at EOF');
    await finish();
}
main().catch((error) => void finish(error));
