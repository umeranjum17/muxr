/** Bounded PR flow. Reuses the release gate's stack, pairing and OS samplers. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { startFakeStack } from './lib/fakeStack.mjs';
import { pairPhone } from './lib/pairPhone.mjs';
import { deviceIdentity, samplePhase, resetGfx, jankReport, screenshot, screencapRaw, dismissPrompts } from './lib/androidSignals.mjs';
import { CommandScope, useCommandScope } from './lib/commands.mjs';
import { cropRaw, pixelsMoved, parseUiNodes } from './lib/gestureMetrics.mjs';
import { harnessIdentity, patchedDependencies, sha256, sourceIdentity } from './lib/provenance.mjs';
import { usageHome, usagePlugins } from './fixtures/usageHome.mjs';

const scope = new CommandScope();
useCommandScope(scope);
const run = scope.run.bind(scope);
const spawn = scope.spawn.bind(scope);
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const serial = option('--serial', 'emulator-5554');
process.env.ANDROID_SERIAL = serial; // Also pins all existing helper adb calls.
const out = resolve(option('--out', '/tmp/muxr-pr-gate'));
const apk = resolve(option('--apk', '/tmp/muxr-pr-build/app-release.apk'));
const hostRoot = resolve(option('--host-root', '.'));
const seconds = Number(option('--seconds', '35'));
const pkg = 'com.trymuxr.app';
const load = { panes: 30, agents: 6, titleChurnHz: 2, terminalBytesPerSecond: 4096, graphicsFrameHz: 4 };
const report = { startedAt: new Date().toISOString(), serial, load, phases: [], failures: [], limits: { minimumSampledSeconds: 25, jsBusyPercent: 60, pssDriftKb: 102400, frameStallSeconds: 30 }, performanceScope: 'Emulator pathology smoke; not physical-device feel or a release soak' };
let stack;
let ownsLock = false;
let deviceTouched = false;
const lock = `/tmp/muxr-pr-gate-${serial}.lock`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const adb = async (...argv) => (await run('adb', argv, { timeout: 25_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
const check = (condition, message) => { if (!condition) throw new Error(message); };
function publish(path, name = basename(path)) {
    if (!process.env.HERDR_PANE_ID) return;
    for (const pane of new Set([process.env.HERDR_PANE_ID, process.env.PERF_PARENT_PANE].filter(Boolean))) for (const app of ['.pocketherdr', '.muxr']) {
        const dir = join(homedir(), app, 'attachments/pane', pane); mkdirSync(dir, { recursive: true });
        copyFileSync(path, join(dir, `${basename(out)}-${name}`));
    }
}
const save = (name, data) => {
    writeFileSync(join(out, name), data);
    if (name === 'report.json') publish(join(out, name));
};
async function capture(name) { await screenshot(join(out, name)); publish(join(out, name)); }
async function dump(name) {
    // Never read a stale dump after uiautomator fails.
    await adb('shell', 'rm', '-f', '/sdcard/pr-gate.xml');
    await adb('shell', 'uiautomator', 'dump', '/sdcard/pr-gate.xml');
    const xml = await adb('shell', 'cat', '/sdcard/pr-gate.xml');
    check(xml.includes('<hierarchy'), 'uiautomator returned no hierarchy');
    if (name) save(`${name}.xml`, xml);
    return xml;
}
async function requireScreen(name, pattern, timeout = 25_000, dismissStartup = false) {
    const start = Date.now();
    let xml;
    do {
        xml = await dump(name);
        if (pattern.test(xml)) return xml;
        // This delayed app alert can arrive after the initial prompt sweep.
        // Handle only its exact Cancel button before measurement, never mid-window.
        if (dismissStartup && xml.includes('Show live agent updates?')) {
            const cancel = parseUiNodes(xml).find((node) => node.text === 'CANCEL');
            if (cancel) {
                save(`${name}-startup-prompt.xml`, xml);
                await adb('shell', 'input', 'tap', String(Math.round((cancel.l + cancel.r) / 2)), String(Math.round((cancel.t + cancel.b) / 2)));
                (report.startupPrompts ??= []).push({ screen: name, at: new Date().toISOString(), action: 'CANCEL live updates alert' });
            }
        }
        await sleep(800);
    } while (Date.now() - start < timeout);
    throw new Error(`${name}: screen did not mount (expected ${pattern}); see ${name}.xml`);
}
async function tapText(text) {
    const xml = await dump();
    const node = (xml.match(/<node\b[^>]*>/g) ?? []).find((node) => node.includes(`text="${text}"`) || node.includes(`content-desc="${text}"`));
    const bounds = node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    check(bounds, `Missing required control: ${text}`);
    await adb('shell', 'input', 'tap', String((Number(bounds[1]) + Number(bounds[3])) / 2), String((Number(bounds[2]) + Number(bounds[4])) / 2));
}
async function herd() {
    await dismissPrompts();
    await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'muxr:///', pkg);
    for (let n = 0; n < 5; n++) {
        if (/text="LIVE"/.test(await dump())) return;
        const { width, height } = report.device;
        await adb('shell', 'input', 'swipe', String(width / 2), String(Math.round(height * .3)), String(width / 2), String(Math.round(height * .8)), '500');
        await sleep(600);
    }
    throw new Error('Failed to return to herd');
}
async function maestro(flow, variables = {}) {
    const argv = [ ...(process.env.MAESTRO_BIN ? [] : ['x', 'maestro@cli-2.7.0', '--', 'maestro']), '--device', serial, 'test', '--debug-output', join(out, 'maestro'), ...Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]), join('perf/flows', flow)];
    const result = await new Promise((done) => {
        const child = spawn(process.env.MAESTRO_BIN ?? 'mise', argv, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        flowChildren.add(child);
        let output = '';
        const collect = (chunk) => { if (output.length < 8 * 1024 * 1024) output += chunk; };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const deadline = setTimeout(() => killFlow(child), 160_000);
        child.once('error', (error) => { output += error.message; });
        child.once('close', (code) => {
            clearTimeout(deadline); flowChildren.delete(child);
            done({ code: code ?? 1, output });
        });
    });
    // Pairing credentials are short-lived but do not belong in exported logs.
    save(`${flow}.log`, result.output.replace(/wss?:\/\/\S+\?pair=\S+/g, '[pairing redacted]'));
    return result;
}
async function phase(name, mounted, drive = false) {
    await dismissPrompts();
    const beforeXml = await requireScreen(name, mounted, 25_000, true);
    await capture(`${name}-before.png`);
    await resetGfx(pkg);
    const initialPid = (await adb('shell', 'pidof', pkg)).trim();
    const metrics = await samplePhase({ pkg, seconds, intervalMs: 3000, onTick: drive ? async () => {
        const { width, height } = report.device;
        await adb('shell', 'input', 'swipe', String(Math.round(width * .5)), String(Math.round(height * .72)), String(Math.round(width * .5)), String(Math.round(height * .35)), '350');
    } : undefined });
    const jank = await jankReport(pkg);
    save(`${name}-gfxinfo.txt`, await adb('shell', 'dumpsys', 'gfxinfo', pkg, 'framestats'));
    report.phases.push({ name, mounted: true, metrics, jank });
    const afterXml = await requireScreen(`${name}-after`, mounted);
    await capture(`${name}-after.png`);
    if (name === 'document') {
        const first = (xml) => /PR gate document line (\d+)/.exec(xml)?.[1];
        const movement = { firstLineBefore: first(beforeXml), firstLineAfter: first(afterXml) };
        report.phases.at(-1).movement = movement;
        check(movement.firstLineBefore !== movement.firstLineAfter, 'document: content did not scroll');
    }
    check((await adb('shell', 'pidof', pkg)).trim() === initialPid, `${name}: app process changed`);
    check(metrics.sampledSeconds >= 25 && Number.isFinite(metrics.jsBusyPercent), `${name}: insufficient CPU measurement window`);
    check(metrics.gaps === 0 && metrics.restarts === 0, `${name}: missing runtime samples or app restart`);
    check(Number.isFinite(metrics.pssDriftKb), `${name}: missing PSS measurement`);
    check(metrics.missingPss === 0 && metrics.pssSampledSeconds >= 25 && metrics.pssSamples.length >= 2, `${name}: insufficient timestamped PSS coverage`);
    check(metrics.missingFrames === 0 && metrics.frameSamples.length >= 2, `${name}: missing timestamped gfxinfo frame observations`);
    check(metrics.jsBusyPercent <= 60, `${name}: JS busy ${metrics.jsBusyPercent}% > 60%`);
    check(metrics.pssDriftKb <= 102400, `${name}: PSS drift ${metrics.pssDriftKb} KiB > 100 MiB`);
    check(jank.frames > 0 && metrics.frameStallSeconds < 30, `${name}: no rendered frames or 30-second frame stall`);
    console.log(`ok: ${name}: ${metrics.sampledSeconds}s sampled, JS ${metrics.jsBusyPercent}%, PSS drift ${metrics.pssDriftKb} KiB, ${jank.frames} frames`);
}
async function feature(name, work) {
    console.log(`start: ${name}`);
    try { await work(); }
    catch (error) { report.failures.push(`${name}: ${error.message}`); console.error(`FAIL: ${name}: ${error.message}`); }
}
async function viewerControls() {
    await herd();
    check((await maestro('graphicsScroll.yaml')).code === 0, 'Could not open session for native file viewer');
    await tapText('Session actions');
    await requireScreen('session-actions', /Changes/);
    await tapText('Changes');
    await requireScreen('changed-files', /viewer.ts/);
    await tapText('viewer.ts');
    await requireScreen('native-diff', /beforeMarker/);
    const diff = await requireScreen('native-diff', /afterMarker/);
    check(diff.includes('beforeMarker'), 'Real native diff must show removed and added content');
    const navigator = parseUiNodes(diff).filter((node) => /^(Previous file|Next file|Previous change|Next change|Zoom in$|Zoom out$|Toggle file and diff$)/.test(node.desc));
    report.viewer = { navigator: { viewportWidthPx: report.device.width, controls: navigator }, scrubSourceLabels: 'device-unverified: no bounded scrub-to-source-line assertion' };
    await capture('native-diff.png');
    check(navigator.some((node) => /^Next file,/.test(node.desc)) && navigator.some((node) => /^Next change, 2 of 2$/.test(node.desc)), 'Multi-file, multi-hunk navigator did not mount');
    check(navigator.some((node) => node.desc === 'Toggle file and diff'), 'Navigator overflow button missing');
    for (const node of navigator) {
        check(node.l >= 0 && node.r <= report.device.width && node.t >= 0 && node.b <= report.device.height && node.r > node.l && node.b > node.t, `Navigator control outside viewport: ${node.desc}`);
        for (const other of navigator) if (other !== node) check(Math.min(node.r, other.r) <= Math.max(node.l, other.l) || Math.min(node.b, other.b) <= Math.max(node.t, other.t), `Navigator controls overlap: ${node.desc} / ${other.desc}`);
    }
    await tapText('Toggle file and diff');
    const menu = await dump('native-nowrap-menu');
    const wrapOff = (menu.match(/<node\b[^>]*>/g) ?? []).find((node) => node.includes('content-desc="Wrap long lines"'));
    check(wrapOff?.includes('selected="false"'), 'CJK check requires Wrap long lines disabled');
    await tapText('File');
    const initial = await requireScreen('native-file', /PR gate document line/);
    const lineHeight = (xml) => {
        const line = parseUiNodes(xml).find((node) => node.text?.includes('PR gate document line 1:'));
        return line && line.b - line.t;
    };
    const cjk = parseUiNodes(initial).find((node) => node.text?.includes('CJK_START'));
    check(cjk?.text.includes('CJK_END'), 'CJK row evidence missing: start and end must share one rendered Text node');
    check(cjk && cjk.b - cjk.t > 0 && Math.abs(cjk.b - cjk.t - lineHeight(initial)) <= 2, 'Unwrapped CJK content must occupy one rendered row');
    report.viewer.cjk = { startAndEndInSameTextNode: true, rowHeightPx: cjk.b - cjk.t, asciiRowHeightPx: lineHeight(initial), horizontalExtent: 'device-unverified: accessibility bounds clip to viewport' };
    await capture('native-cjk-nowrap.png');
    await tapText('Zoom in');
    const zoomed = await requireScreen('native-zoom', /PR gate document line/);
    check(lineHeight(zoomed) > lineHeight(initial), 'Zoom did not increase actual rendered line height');
    await capture('native-zoom.png');
    const { width, height } = report.device;
    const region = { l: width * .1, r: width * .85, t: height * .25, b: height * .7 };
    const before = cropRaw(await screencapRaw(), region);
    await adb('shell', 'input', 'swipe', String(Math.round(width * .8)), String(Math.round(height * .5)), String(Math.round(width * .2)), String(Math.round(height * .5)), '450');
    await sleep(500);
    await requireScreen('native-pan', /viewer.ts/);
    const pan = pixelsMoved(before, cropRaw(await screencapRaw(), region));
    check(pan.moved, 'Unwrapped code did not visibly pan within the same file');
    await capture('native-pan.png');
    await tapText('Toggle file and diff'); await tapText('Wrap long lines');
    await tapText('Toggle file and diff');
    const wrapped = await dump('native-wrap');
    const control = (wrapped.match(/<node\b[^>]*>/g) ?? []).find((node) => node.includes('content-desc="Wrap long lines"'));
    check(control?.includes('selected="true"'), 'Wrap control did not retain enabled state');
    await tapText('Toggle file and diff');
    await capture('native-wrap.png');
    Object.assign(report.viewer, { realDiff: true, zoomLineHeights: [lineHeight(initial), lineHeight(zoomed)], pan, wrapEnabled: true });
}
async function main() {
    check(/^emulator-\d+$/.test(serial), 'PR gate only clears dedicated emulators');
    check(seconds >= 30 && seconds <= 120, '--seconds must be 30..120');
    mkdirSync(lock); ownsLock = true;
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, pane: process.env.HERDR_PANE_ID, startedAt: report.startedAt }));
    check((await adb('get-state')).trim() === 'device', `${serial} is not online`);
    report.apk = JSON.parse(readFileSync(`${apk}.json`, 'utf8'));
    check(report.apk.variant === 'release' && /^[a-f0-9]{40}$/.test(report.apk.revision), 'Missing release APK revision provenance');
    check(report.apk.apkSha256 === sha256(apk), 'APK SHA256 differs from build manifest');
    check(report.apk.nativeDependencies && Object.keys(report.apk.nativeDependencies).length > 0, 'APK manifest lacks verified native patch provenance; rebuild with buildPrApk');
    report.host = sourceIdentity(hostRoot);
    check(report.apk.mobileSha256 === report.host.mobileSha256, 'APK mobile source digest differs from host checkout; rebuild APK');
    check(JSON.stringify(report.apk.nativeDependencies) === JSON.stringify(patchedDependencies(hostRoot)), 'Host checkout patched dependency bytes differ from APK build');
    await run(process.execPath, ['scripts/diagnostics/application/verifyNativePatches.mjs'], { cwd: hostRoot, timeout: 30_000 });
    // Build the exact host checkout used by this run, without trusting stale dist.
    await run('yarn', ['build'], { cwd: hostRoot, timeout: 180_000 });
    report.host.entrySha256 = sha256(join(hostRoot, 'apps/host/dist/main.js'));
    report.harness = harnessIdentity();
    report.device = await deviceIdentity();
    check(report.device.width > 0 && report.device.height > 0, 'Cannot read emulator dimensions');
    // Intentional fresh install: gate owns this emulator, no fallback to an old APK.
    deviceTouched = true;
    await adb('uninstall', pkg).catch(() => {});
    await adb('install', apk);
    await adb('shell', 'pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
    const installed = (await adb('shell', 'pm', 'path', pkg)).trim().replace(/^package:/, '');
    const pulled = join(out, 'installed.apk');
    await adb('pull', installed, pulled);
    report.installedApkSha256 = sha256(pulled); rmSync(pulled);
    check(report.installedApkSha256 === report.apk.apkSha256, 'Installed APK bytes differ from tested artifact');
    save('package.txt', await adb('shell', 'dumpsys', 'package', pkg));
    await adb('logcat', '-c');
    const graphicsEnableFile = join(out, '.graphics-enabled');
    rmSync(graphicsEnableFile, { force: true });
    stack = await startFakeStack({ ...load, sourceRoot: hostRoot, setupHome: usageHome, setupPlugins: usagePlugins(hostRoot), graphicsEnableFile });
    report.fixtures = { usage: 'Synthetic SQLite aggregates + ccusage CLI output; scratch entry restores test env then imports actual usage plugin; no real auth/quota calls' };
    const lines = ['export function fixture() {', ...Array.from({ length: 250 }, (_, i) => `// PR gate document line ${i + 1}: deterministic readable content with a long tail for panning END_${i + 1}`), '}'];
    lines[2] = `// CJK_START ${'漢字'.repeat(40)} CJK_END`;
    lines[4] = 'const value = "beforeMarker";';
    lines[40] = 'const second = "beforeSecondHunk";';
    writeFileSync(join(stack.world.cwd, 'zz-companion.ts'), 'export const companion = "beforeCompanion";\n');
    writeFileSync(join(stack.world.cwd, 'viewer.ts'), lines.join('\n'));
    await run('git', ['init', '-q', stack.world.cwd], { timeout: 10_000 });
    await run('git', ['-C', stack.world.cwd, 'add', '.'], { timeout: 10_000 });
    await run('git', ['-C', stack.world.cwd, '-c', 'user.name=Emulator Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Baseline viewer fixture'], { timeout: 10_000 });
    lines[4] = 'const value = "afterMarker";';
    lines[40] = 'const second = "afterSecondHunk";';
    writeFileSync(join(stack.world.cwd, 'zz-companion.ts'), 'export const companion = "afterCompanion";\n');
    writeFileSync(join(stack.world.cwd, 'viewer.ts'), lines.join('\n'));
    const pairing = await pairPhone({ stack, maestro, attempts: 1, patienceSeconds: 30 });
    report.pairing = pairing;
    check(pairing.ok, pairing.why);
    await dismissPrompts();
    await requireScreen('paired-herd', /text="LIVE"/);
    await sleep(8000);
    await dismissPrompts();
    await feature('herd', () => phase('herd', /text="connected"/, true));
    await feature('document', async () => {
        await herd(); await tapText('Files');
        await requireScreen('files', /text="(viewer.ts|README.md|project)"/);
        if (!(await dump()).includes('text="viewer.ts"')) await tapText('project');
        await requireScreen('file-list', /text="viewer.ts"/);
        await tapText('viewer.ts');
        await phase('document', /PR gate document line/, true);
        await viewerControls();
    });
    await feature('terminal-text', async () => {
        await herd();
        const flow = await maestro('graphicsScroll.yaml');
        check(flow.code === 0, 'terminal opening flow failed; see graphicsScroll.yaml.log');
        await phase('terminal-text', /text="(Terminal|ctrl)"|Type a prompt/, true);
        check(existsSync(stack.attachJsonl) && readFileSync(stack.attachJsonl, 'utf8').trim(), 'No real host terminal attach was observed');
        check(!existsSync(graphicsEnableFile), 'Text phase accidentally enabled graphics');
    });
    await feature('graphics', async () => {
        await requireScreen('graphics-mounted', /text="(Terminal|ctrl)"|Type a prompt/);
        writeFileSync(graphicsEnableFile, 'enabled');
        const pixels = await graphicsPixels();
        report.graphics = { pixels };
        await capture('graphics-pixels.png');
        check(pixels.magenta > 100 && pixels.teal > 100, 'Kitty checkerboard did not paint in terminal region; see graphics-pixels.png');
        const since = Date.now();
        await phase('graphics', /text="(Terminal|ctrl)"|Type a prompt/, true);
        const events = JSON.parse(readFileSync(stack.journalPath, 'utf8')).events ?? [];
        const pipeline = events.filter((e) => e.event === 'graphics.pipeline' && Date.parse(e.at) >= since);
        const cellSamples = (existsSync(stack.cellMetricsJsonl) ? readFileSync(stack.cellMetricsJsonl, 'utf8').trim().split('\n').map(JSON.parse) : []).filter((row) => row.source === 'terminal.resize' && row.pane_id === stack.world.panes[0].pane_id && [row.cols, row.rows, row.cellWidthPx, row.cellHeightPx].every((value) => Number.isFinite(value) && value > 0)).slice(-3);
        const helloSamples = (existsSync(stack.graphicsInputJsonl) ? readFileSync(stack.graphicsInputJsonl, 'utf8').trim().split('\n').map(JSON.parse) : []).filter((row) => row.source === 'graphics.ClientHello' && [row.cols, row.rows, row.cellWidthPx, row.cellHeightPx].every((value) => Number.isFinite(value) && value > 0)).slice(-3);
        report.graphics = { pixels, cellSamples, helloSamples, cellEvidenceScope: 'Native resize for first pane, or real graphics connection ClientHello populated from native attach', declaredCellMetrics: stack.phoneDeclaredCellMetrics(), pipeline };
        check(cellSamples.length > 0 || helloSamples.length > 0, 'No positive native cell dimensions recorded in resize or graphics ClientHello');
        check(pipeline.some((event) => event.frames > 0), 'No delivered graphics frames during mounted phase');
    });
    await feature('usage-switch-and-recency', async () => {
        await herd(); await tapText('Usage');
        const xml = await requireScreen('usage-omp', /text="150"/);
        check(xml.includes('text="OMP"') && xml.includes('text="OpenCode"'), 'Both provider tabs must mount');
        check(xml.indexOf('text="OMP"') < xml.indexOf('text="OpenCode"'), 'OMP must precede OpenCode by latest event time');
        await capture('usage-omp.png');
        await tapText('OpenCode'); await requireScreen('usage-opencode', /text="300"/);
        await capture('usage-opencode.png');
        await tapText('OMP'); await requireScreen('usage-omp-return', /text="150"/);
        report.usage = { passed: true, orderedProviders: ['OMP', 'OpenCode'], switchedTokens: [150, 300, 150] };
    });
    check(sourceIdentity(hostRoot).sourceSha256 === report.host.sourceSha256, 'Host sources changed during run');
    check(JSON.stringify(patchedDependencies(hostRoot)) === JSON.stringify(report.apk.nativeDependencies), 'Patched dependencies changed during run');
    check(harnessIdentity().sha256 === report.harness.sha256, 'Harness or workflow changed during run');
}

mkdirSync(out, { recursive: true });
const watchdog = setTimeout(() => { console.error('FAIL: overall gate deadline (12 minutes)'); process.kill(process.pid, 'SIGTERM'); }, 12 * 60_000);
// Signal handling interrupts pending commands; finally exports bounded diagnostics.
process.once('SIGTERM', () => { report.failures.push('Interrupted or exceeded 12-minute deadline'); void finish(1); });
process.once('SIGINT', () => { report.failures.push('Interrupted'); void finish(130); });
let finishing = false;
const flowChildren = new Set();
function killFlow(child) {
    scope.kill(child);
}
async function graphicsPixels() {
    let result;
    for (let attempt = 0; attempt < 10; attempt++) {
        const raw = await screencapRaw();
        check(raw.format === 1, 'Graphics pixel proof needs an RGBA8888 framebuffer');
        result = { magenta: 0, teal: 0, samples: 0, region: 'x10..85%, y20..75%', tolerance: 12 };
        for (let y = Math.round(raw.height * .2); y < raw.height * .75; y += 4) for (let x = Math.round(raw.width * .1); x < raw.width * .85; x += 4) {
            const at = 16 + (y * raw.width + x) * 4;
            const matches = (color) => color.every((value, channel) => Math.abs(raw.bytes[at + channel] - value) <= 12);
            result.samples++;
            if (matches([235, 35, 170])) result.magenta++;
            if (matches([20, 215, 185])) result.teal++;
        }
        if (result.magenta > 100 && result.teal > 100) return result;
        await sleep(1500);
    }
    return result;
}
async function finish(code) {
    if (finishing) return;
    finishing = true; clearTimeout(watchdog);
    let terminated = true;
    try { await scope.close(); }
    catch (error) { terminated = false; report.failures.push(error.message); }
    const diagnostics = new CommandScope();
    const diagnosticAdb = async (...argv) => (await diagnostics.run('adb', argv, { timeout: 20_000 })).stdout;
    if (deviceTouched) {
        await diagnosticAdb('shell', 'uiautomator', 'dump', '/sdcard/pr-gate-final.xml').then(async () => save('final.xml', await diagnosticAdb('shell', 'cat', '/sdcard/pr-gate-final.xml'))).catch(() => {});
        await diagnostics.run('adb', ['exec-out', 'screencap', '-p'], { encoding: null, timeout: 20_000 }).then(({ stdout }) => { save('final.png', stdout); publish(join(out, 'final.png')); }).catch(() => {});
        const log = await diagnosticAdb('logcat', '-d', '-v', 'threadtime').catch((error) => { report.failures.push(`logcat evidence unavailable: ${error.message}`); return ''; });
        save('logcat.txt', log);
        if (/Maximum update depth exceeded|FATAL EXCEPTION|Fatal signal/.test(log)) report.failures.push('Fatal or React update-depth error in logcat');
    }
    if (stack) {
        save('host.log', stack.hostLog()); save('relay.log', stack.relayLog());
        for (const [name, path] of [['host-journal.json', stack.journalPath], ['attach.jsonl', stack.attachJsonl], ['cell-metrics.jsonl', stack.cellMetricsJsonl], ['graphics-input.jsonl', stack.graphicsInputJsonl]]) if (existsSync(path)) copyFileSync(path, join(out, name));
    }
    await diagnostics.close().catch((error) => { terminated = false; report.failures.push(error.message); });
    scope.cleanup();
    if (ownsLock && terminated) rmSync(lock, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString(); report.passed = code === 0 && report.failures.length === 0;
    save('report.json', JSON.stringify(report, null, 2));
    if (process.env.HERDR_PANE_ID) {
        const bundle = `${out}.tar.gz`;
        const exporter = new CommandScope();
        try { await exporter.run('tar', ['-czf', bundle, '-C', out, '.'], { timeout: 20_000 }); publish(bundle, 'evidence.tar.gz'); }
        finally { await exporter.close(); }
    }
    console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${join(out, 'report.json')}`);
    process.exit(report.passed ? 0 : code || 1);
}
main().then(() => finish(0), (error) => { report.failures.push(error.message); console.error(error); return finish(1); });
