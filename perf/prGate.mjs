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
import { PNG } from 'pngjs';
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
const flow = option('--flow', 'full');
const pkg = 'com.trymuxr.app';
const load = { panes: 30, agents: 6, titleChurnHz: 2, terminalBytesPerSecond: 4096, graphicsFrameHz: 4 };
const report = { flow, startedAt: new Date().toISOString(), serial, load, phases: [], failures: [], limits: { minimumSampledSeconds: 25, jsBusyPercent: 60, pssDriftKb: 102400, frameStallSeconds: 30 }, performanceScope: flow !== 'full' ? `Not measured: ${flow}-only feature flow` : 'Emulator pathology smoke; not physical-device feel or a release soak' };
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
    let xml = await dump();
    if (['Session actions', 'Open terminal keyboard', 'Zoom in', 'Zoom out', 'Reset zoom'].includes(text)
        && !xml.includes(`content-desc="${text}"`) && xml.includes('content-desc="Show terminal controls"')) {
        await tapText('Show terminal controls');
        xml = await dump();
    }
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
async function stabilizeStartup() {
    // Cancelling the background prompt clears a ref, not an effect dependency.
    // A real foreground transition lets the deferred Live Updates prompt run
    // before sampling. One full fake-agent status cycle bounds the fallback.
    const started = Date.now();
    const deadline = started + 65000;
    const evidence = { startedAt: new Date(started).toISOString(), prompts: [], foregroundTransitions: 0, quietLooks: 0 };
    report.startupStabilization = evidence;
    const foreground = async () => {
        await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
        await sleep(1200);
        await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'muxr:///', pkg);
        evidence.foregroundTransitions++;
    };
    await foreground();
    let lastPromptAt = started;
    let promotionSeen = false;
    do {
        const xml = await dump('startup-settle');
        const title = ['Keep muxr connected in the background?', 'Show live agent updates?'].find((text) => xml.includes(`text="${text}"`));
        if (title) {
            const cancel = parseUiNodes(xml).find((node) => node.text === 'CANCEL');
            check(cancel && cancel.r > cancel.l && cancel.b > cancel.t, `Startup prompt has no Cancel control: ${title}`);
            save(`startup-prompt-${evidence.prompts.length}.xml`, xml);
            evidence.prompts.push({ title, at: new Date().toISOString(), action: 'CANCEL' });
            await adb('shell', 'input', 'tap', String((cancel.l + cancel.r) / 2), String((cancel.t + cancel.b) / 2));
            lastPromptAt = Date.now(); evidence.quietLooks = 0;
            if (title === 'Show live agent updates?') promotionSeen = true;
            else await foreground();
        } else {
            evidence.quietLooks = /text="connected"/.test(xml) ? evidence.quietLooks + 1 : 0;
        }
        if (promotionSeen && evidence.quietLooks >= 2 && Date.now() - lastPromptAt >= 4000) break;
        await sleep(1200);
    } while (Date.now() < deadline);
    check(evidence.quietLooks >= 2, 'Startup did not settle on a mounted connected herd');
    evidence.elapsedMs = Date.now() - started;
    evidence.promotionPromptObserved = promotionSeen;
    await requireScreen('startup-ready', /text="connected"/);
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
    if (flow === 'usage' && name !== 'usage-switch-and-recency') return;
    if (flow === 'polish' && name !== 'polish') return;
    if (flow === 'rich' && name !== 'rich') return;
    if (flow === 'controls' && !['terminal-text', 'graphics'].includes(name)) return;
    if (name === 'rich' && flow !== 'rich') return;
    if (flow !== 'polish' && name === 'polish') return;
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
async function viewerLineTarget() {
    const agent = stack.world.agents.find((row) => row.pane_id === stack.world.panes[0].pane_id);
    const routes = JSON.parse(readFileSync(join(stack.dataDir, 'herdr-routes.json'), 'utf8')).bindings;
    const binding = routes.find((row) => ['source', 'agent', 'kind', 'value'].every((key) => row.agentSession[key] === agent?.agent_session[key]));
    check(binding?.route, 'Cannot resolve real host session for line-target route');
    // A relative path makes session identity resolution part of the real route.
    const url = `muxr://session/${encodeURIComponent(binding.route)}/file?path=${encodeURIComponent('line-target.ts')}`;
    const open = (line) => {
        // adb shell joins argv again on Android: quote the complete URI there.
        const uri = `'${`${url}&line=${line}`.replaceAll("'", "'\\''")}'`;
        return adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', uri, pkg);
    };
    const top = async (name) => {
        await open(1);
        const xml = await requireScreen(name, /PR gate document line 1:/);
        check(!xml.includes('PR_GATE_TARGET_LINE_200'), 'Line200 must start offscreen before targeted navigation');
    };
    const target = async (name) => {
        await open(200);
        const xml = await requireScreen(name, /PR_GATE_TARGET_LINE_200/);
        const node = parseUiNodes(xml).find((row) => row.text.includes('PR_GATE_TARGET_LINE_200'));
        check(node && node.b > node.t && node.t > report.device.height * .15 && node.b < report.device.height * .6, 'Source line200 did not reach the upper visible code region');
        await capture(`${name}.png`);
        return node;
    };
    await top('line-target-initial');
    await adb('shell', 'am', 'force-stop', pkg);
    const cold = await target('line-target-cold');
    await top('line-target-warm-top');
    const warm = await target('line-target-warm');
    report.viewer.lineTarget = { sourceLine: 200, relativePath: 'line-target.ts', realSessionBinding: true, cold, warm, mode: 'file (untracked fixture has no git patch)', limits: 'Diff deletion collisions and folded targets are not asserted on device' };
    // Remove only this run's relay tunnel. A cold launch cannot hydrate the
    // session root; it must reach a bounded in-screen error instead of ENOENT.
    let offline;
    try {
        await adb('reverse', '--remove', `tcp:${stack.relayPort}`);
        await adb('shell', 'am', 'force-stop', pkg);
        const startedAt = Date.now();
        await open(200);
        const xml = await requireScreen('line-target-offline', /This session is not available, so the file could not be located/, 20000);
        check(!xml.includes('ENOENT') && !/text="OK"/.test(xml), 'Offline missing root surfaced a file-read alert');
        offline = { elapsedMs: Date.now() - startedAt, error: 'session root unavailable', scope: 'owned relay tunnel removed, cold relative line200 route' };
        check(offline.elapsedMs <= 25000, 'Offline missing-root error exceeded bounded wait');
        await capture('line-target-offline.png');
    } finally {
        await adb('reverse', `tcp:${stack.relayPort}`, `tcp:${stack.relayPort}`);
    }
    await adb('shell', 'am', 'force-stop', pkg);
    const recovered = await target('line-target-reconnected');
    report.viewer.lineTarget.offline = offline;
    report.viewer.lineTarget.reconnected = recovered;
}

// Real native IME state, not visibility inferred from a toolbar or XML label.
async function terminalKeyboard(name) {
    const keyboard = async () => {
        const state = await adb('shell', 'dumpsys', 'input_method');
        const match = /\bmInputShown=(true|false)\b/.exec(state);
        check(match, 'Android did not expose keyboard visibility');
        return match[1] === 'true';
    };
    const waitKeyboard = async (shown) => {
        for (let n = 0; n < 8; n++) {
            if (await keyboard() === shown) return;
            await sleep(350);
        }
        throw new Error(`${name}: keyboard did not become ${shown ? 'visible' : 'hidden'}`);
    };
    await waitKeyboard(false);
    const before = await dump(`${name}-before`);
    check(before.includes('Show terminal controls') || before.includes('Hide terminal controls'), 'Terminal command control missing');
    const { width, height } = report.device;
    for (let n = 0; n < 3; n++) {
        await adb('shell', 'input', 'tap', String(Math.round(width * .3)), String(Math.round(height * .4)));
        await sleep(500);
        check(!await keyboard(), `${name}: terminal tap unexpectedly opened keyboard`);
    }
    await capture(`${name}-tap-stable.png`);
    await tapText('Open terminal keyboard');
    await waitKeyboard(true);
    await capture(`${name}-explicit-keyboard.png`);
    await adb('shell', 'input', 'keyevent', '4');
    await waitKeyboard(false);
    await requireScreen(`${name}-restored`, /Show terminal controls/);
    await tapText('Show terminal controls');
    await requireScreen(`${name}-commands`, /Open terminal keyboard/);
    await capture(`${name}-restored.png`);
    (report.keyboard ??= []).push({ name, tapCount: 3, autoOpened: false, explicitOpen: true, dismissed: true });
    const handle = (xml, label) => parseUiNodes(xml).find((node) => node.desc === label);
    const initial = handle(await dump(`${name}-controls-before`), 'Hide terminal controls');
    check(initial && initial.r > initial.l && initial.b > initial.t, 'Movable toolbar handle missing');
    const cx = Math.round((initial.l + initial.r) / 2), cy = Math.round((initial.t + initial.b) / 2);
    // Drag the dedicated handle, not a browser surface or a zoom button.
    await adb('shell', 'input', 'swipe', String(cx), String(cy), String(Math.max(80, cx - width * .35)), String(cy), '650');
    const movedXml = await dump(`${name}-controls-moved`);
    const moved = handle(movedXml, 'Hide terminal controls');
    check(moved && Math.abs(moved.l - initial.l) > width * .15, 'Toolbar drag did not move the native handle');
    check(moved.l >= 0 && moved.r <= width && moved.t >= 0 && moved.b <= height, 'Toolbar moved outside the viewport');
    await tapText('Hide terminal controls');
    const collapsed = await dump(`${name}-controls-collapsed`);
    check(handle(collapsed, 'Show terminal controls') && !collapsed.includes('Open terminal keyboard'), 'Toolbar buttons did not collapse');
    await capture(`${name}-controls-collapsed.png`);
    await tapText('Show terminal controls');
    const expanded = await dump(`${name}-controls-expanded`);
    check(expanded.includes('Open terminal keyboard') && expanded.includes('Zoom in') && expanded.includes('Session actions'), 'Command control did not restore its actions');
    const commandLabels = ['Hide terminal controls', 'Open terminal keyboard', 'Zoom in', 'Zoom out', 'Reset zoom', 'Session actions'];
    const commands = parseUiNodes(expanded).filter((node) => commandLabels.includes(node.desc));
    check(commands.length === commandLabels.length, 'Command fan contains missing or duplicate buttons');
    for (const command of commands) {
        check(command.l >= 0 && command.r <= width && command.t >= 0 && command.b <= height, `Command outside screen: ${command.desc}`);
        check(Math.abs((command.r - command.l) - (commands[0].r - commands[0].l)) <= 2, 'Command button sizes are inconsistent');
        for (const other of commands) if (other !== command) check(Math.min(command.r, other.r) <= Math.max(command.l, other.l) || Math.min(command.b, other.b) <= Math.max(command.t, other.t), 'Command buttons overlap');
    }
    report.commandFan = { buttons: commands, singlePuck: true };
    await capture(`${name}-controls-moved.png`);
    (report.movableControls ??= []).push({ name, before: initial, after: moved, collapsed: true, restored: true });

}

// Focused native UI acceptance, separate from the four measured phases.
async function polishControls() {
    const version = /versionName=([^\s]+)/.exec(readFileSync(join(out, 'package.txt'), 'utf8'))?.[1];
    check(version, 'Installed package version unavailable');
    await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'muxr:///settings/connection', pkg);
    const settings = await requireScreen('polish-settings', /Installed versions/i);
    check(settings.includes(`Version ${version}`), 'Settings does not report the installed binary version');
    check(settings.includes('Connection &amp; updates') || settings.includes('Connection & updates'), 'Missing unified connection title');
    await capture('polish-settings.png');
    report.polish = { installedVersion: version, settingsVersion: true, compatibilityWarningScope: 'Same-version fixture; mismatched release comparison is covered by the existing version flow' };
    await herd();
    check((await maestro('graphicsScroll.yaml')).code === 0, 'Could not open owned terminal for composer');
    await requireScreen('polish-composer', /Add attachment/);
    const photo = new PNG({ width: 360, height: 1080 });
    for (let y = 0; y < photo.height; y++) for (let x = 0; x < photo.width; x++) {
        const index = (y * photo.width + x) * 4;
        const band = Math.floor(y / 90) % 3;
        photo.data[index] = band === 0 ? 230 : 30;
        photo.data[index + 1] = band === 1 ? 210 : 40;
        photo.data[index + 2] = band === 2 ? 220 : 50;
        photo.data[index + 3] = 255;
    }
    const name = `muxr-polish-${process.pid}`;
    const photoPath = join(out, `${name}.png`), remote = `/sdcard/Pictures/${name}.png`;
    writeFileSync(photoPath, PNG.sync.write(photo)); publish(photoPath);
    try {
        await adb('shell', 'mkdir', '-p', '/sdcard/Pictures');
        await adb('push', photoPath, remote);
        await adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`);
        await adb('shell', 'pm', 'grant', pkg, 'android.permission.READ_MEDIA_IMAGES');
        // MediaStore canonicalizes /sdcard to /storage/emulated/0. Match the
        // unique owned display name, and wait for asynchronous media scanning.
        let mediaId;
        const scanDeadline = Date.now() + 10000;
        do {
            const media = await adb('shell', 'content', 'query', '--uri', 'content://media/external/images/media', '--projection', '_id:_display_name', '--where', `"_display_name='${name}.png'"`);
            save('polish-media-registration.txt', media);
            mediaId = /\b_id=(\d+)/.exec(media)?.[1];
            if (mediaId) break;
            await sleep(500);
        } while (Date.now() < scanDeadline);
        check(mediaId, 'Owned generated photo was not registered in MediaStore');
        await tapText('Add attachment');
        await capture('polish-picker.png');
        const picker = await requireScreen('polish-picker', /Photo|photo|Recent/);
        const tile = parseUiNodes(picker).find((node) => /photo taken|Photo taken|Photo,|Image taken/.test(node.desc));
        check(tile && tile.r > tile.l && tile.b > tile.t, 'Owned photo picker tile unavailable; selector evidence retained');
        await adb('shell', 'input', 'tap', String(Math.round((tile.l + tile.r) / 2)), String(Math.round((tile.t + tile.b) / 2)));
        const selected = await dump('polish-picker-selected');
        const add = parseUiNodes(selected).find((node) => /^(Add|Done)( \(\d+\))?$/.test(node.text));
        if (add) await adb('shell', 'input', 'tap', String((add.l + add.r) / 2), String((add.t + add.b) / 2));
        const uploaded = await requireScreen('polish-thumbnail', /Remove attachment /);
        // Android Photo Picker may expose the MediaStore ID as its filename.
        const previewNode = parseUiNodes(uploaded).find((node) => node.desc === `Preview attachment ${name}.jpg` || node.desc === `Preview attachment ${mediaId}.jpg`);
        check(previewNode, 'Composer preview does not match the owned MediaStore image');
        const uploadedName = previewNode.desc.slice('Preview attachment '.length);
        const thumbnail = cropRaw(await screencapRaw(), previewNode);
        const colors = { red: 0, green: 0, blue: 0 };
        for (let offset = 0; offset < thumbnail.bytes.length; offset += 4) {
            const [r, g, b] = thumbnail.bytes.subarray(offset, offset + 3);
            if (r > 150 && g < 90 && b < 90) colors.red++;
            if (g > 150 && r < 90 && b < 90) colors.green++;
            if (b > 150 && r < 90 && g < 90) colors.blue++;
        }
        check(Object.values(colors).every((count) => count > 100), 'Thumbnail does not render the owned RGB fixture pixels');
        report.polish.thumbnailPixels = colors;
        await capture('polish-thumbnail.png');
        await tapText(`Preview attachment ${uploadedName}`);
        await requireScreen('polish-image-fit', /Close attachment preview/);
        await capture('polish-image-fit.png');
        const { width, height } = report.device;
        const region = { l: width * .25, r: width * .75, t: height * .3, b: height * .7 };
        const fitted = cropRaw(await screencapRaw(), region);
        await tapText('Zoom in'); await sleep(400);
        const zoom = pixelsMoved(fitted, cropRaw(await screencapRaw(), region));
        check(zoom.moved, 'Image zoom did not change actual content pixels');
        await capture('polish-image-zoom.png');
        const beforePan = cropRaw(await screencapRaw(), region);
        await adb('shell', 'input', 'swipe', String(width / 2), String(height * .6), String(width / 2), String(height * .4), '500');
        const pan = pixelsMoved(beforePan, cropRaw(await screencapRaw(), region));
        check(pan.moved, 'Zoomed image did not pan');
        await capture('polish-image-pan.png');
        await tapText('Fit image'); await tapText('Close attachment preview');
        await tapText(`Remove attachment ${uploadedName}`);
        const removed = await dump('polish-attachment-removed');
        check(!removed.includes(`Preview attachment ${uploadedName}`), 'Removed image still present in composer');
        Object.assign(report.polish, { composerUpload: true, thumbnail: true, preview: true, zoom, pan, removed: true });
    } finally {
        await adb('shell', 'rm', '-f', remote);
        await adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`);
    }
}

async function richPreviews() {
    const attachmentDir = join(stack.root, 'muxr/attachments/pane/w1:p1');
    mkdirSync(attachmentDir, { recursive: true });
    writeFileSync(join(attachmentDir, 'preview.md'), '# NATIVE_MARKDOWN_READY\n\n```mermaid\nflowchart LR\n A[Beta] --> B[Phone testing]\n```');
    writeFileSync(join(attachmentDir, 'preview.csv'), 'Feature,Status\nNATIVE_CSV_READY,Ready');
    writeFileSync(join(attachmentDir, 'preview.html'), '<h1>NATIVE_HTML_READY</h1><script>document.body.innerHTML="UNSAFE_SCRIPT_RAN"</script>');
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
    for (const [index, color] of ['0 0 1', '1 0 0'].entries()) {
        const stream = `${color} rg 40 100 320 300 re f`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }
    let pdf = '%PDF-1.4\n'; const offsets = [];
    for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    writeFileSync(join(attachmentDir, 'preview.pdf'), pdf);
    await herd();
    check((await maestro('graphicsScroll.yaml')).code === 0, 'Could not open owned attachment session');
    await tapText('Session actions');
    await tapText('Open attachments');
    await requireScreen('rich-attachments', /preview.md/);
    report.richPreviews = [];
    for (const [file, marker] of [['preview.md', 'NATIVE_MARKDOWN_READY'], ['preview.csv', 'NATIVE_CSV_READY'], ['preview.html', 'NATIVE_HTML_READY']]) {
        await tapText(file);
        const xml = await requireScreen(`rich-${file}`, file.endsWith('.csv') ? /Preview: up to 200 data rows/ : new RegExp(marker));
        check(!xml.includes('UNSAFE_SCRIPT_RAN'), 'Untrusted HTML executed in native preview');
        await capture(`rich-${file}.png`);
        if (file.endsWith('.csv')) {
            // Android's WebView hierarchy omits semantic table cells. Prove the
            // actual rendered fixture text from pixels, never from the footer.
            const pixels = (await run('tesseract', [join(out, `rich-${file}.png`), 'stdout', '--psm', '6'], { timeout: 15_000 })).stdout;
            save('rich-csv-ocr.txt', pixels);
            check(pixels.includes(marker), 'CSV content did not paint in native WebView');
        }
        report.richPreviews.push({ file, nativeContent: true, evidence: file.endsWith('.csv') ? 'screenshot OCR' : 'native hierarchy' });
        await tapText('Close document preview');
    }
    await tapText('preview.pdf');
    await requireScreen('rich-pdf-page1', /Page 1 of 2/);
    const coloredPixels = async (color) => {
        const { width, height } = report.device;
        const frame = cropRaw(await screencapRaw(), { l: width * .2, r: width * .8, t: height * .25, b: height * .7 });
        let count = 0;
        for (let i = 0; i < frame.bytes.length; i += 4) if (frame.bytes[i + color] > 180 && frame.bytes[i + (color === 0 ? 2 : 0)] < 70 && frame.bytes[i + 1] < 70) count++;
        check(count > 1000, 'PDF status mounted but actual page pixels did not render'); return count;
    };
    const blue = await coloredPixels(2); await capture('rich-pdf-page1.png');
    await tapText('Next page'); await requireScreen('rich-pdf-page2', /Page 2 of 2/);
    const red = await coloredPixels(0); await capture('rich-pdf-page2.png');
    report.richPreviews.push({ file: 'preview.pdf', blue, red, pageNavigation: true });
    await tapText('Close document preview');
}

async function main() {
    check(['full', 'usage', 'polish', 'rich', 'controls'].includes(flow), '--flow must be full, usage, polish, rich or controls');
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
    const targetLines = [...lines];
    targetLines[199] = '// PR_GATE_TARGET_LINE_200';
    writeFileSync(join(stack.world.cwd, 'line-target.ts'), targetLines.join('\n'));
    const pairing = await pairPhone({ stack, maestro, attempts: 1, patienceSeconds: 30 });
    report.pairing = pairing;
    check(pairing.ok, pairing.why);
    await dismissPrompts();
    await requireScreen('paired-herd', /text="LIVE"/);
    await sleep(8000);
    await dismissPrompts();
    await stabilizeStartup();
    await feature('polish', polishControls);
    await feature('rich', richPreviews);
    await feature('herd', () => phase('herd', /text="connected"/, true));
    await feature('document', async () => {
        await herd(); await tapText('Files');
        await requireScreen('files', /text="(viewer.ts|README.md|project)"/);
        if (!(await dump()).includes('text="viewer.ts"')) await tapText('project');
        await requireScreen('file-list', /text="viewer.ts"/);
        await tapText('viewer.ts');
        await phase('document', /PR gate document line/, true);
        await viewerControls();
        await viewerLineTarget();
    });
    await feature('terminal-text', async () => {
        await herd();
        const opened = await maestro('graphicsScroll.yaml');
        check(opened.code === 0, 'terminal opening flow failed; see graphicsScroll.yaml.log');
        if (flow === 'controls') await requireScreen('controls-text-mounted', /Type a prompt|text="Terminal"/);
        else await phase('terminal-text', /text="(Terminal|ctrl)"|Type a prompt/, true);
        check(existsSync(stack.attachJsonl) && readFileSync(stack.attachJsonl, 'utf8').trim(), 'No real host terminal attach was observed');
        check(!existsSync(graphicsEnableFile), 'Text phase accidentally enabled graphics');
        await terminalKeyboard('text-keyboard');
    });
    await feature('graphics', async () => {
        await requireScreen('graphics-mounted', /text="(Terminal|ctrl)"|Type a prompt/);
        writeFileSync(graphicsEnableFile, 'enabled');
        const pixels = await graphicsPixels();
        report.graphics = { pixels };
        await capture('graphics-pixels.png');
        check(pixels.magenta > 100 && pixels.teal > 100, 'Kitty checkerboard did not paint in terminal region; see graphics-pixels.png');
        const since = Date.now();
        if (flow !== 'controls') await phase('graphics', /text="(Terminal|ctrl)"|Type a prompt/, true);
        const delivered = () => (JSON.parse(readFileSync(stack.journalPath, 'utf8')).events ?? []).filter((e) => e.event === 'graphics.pipeline' && Date.parse(e.at) >= since);
        if (flow === 'controls') {
            const deadline = Date.now() + 25_000;
            while (!delivered().some((event) => event.frames > 0) && Date.now() < deadline) await sleep(500);
        }
        const pipeline = delivered();
        const cellSamples = (existsSync(stack.cellMetricsJsonl) ? readFileSync(stack.cellMetricsJsonl, 'utf8').trim().split('\n').map(JSON.parse) : []).filter((row) => row.source === 'terminal.resize' && row.pane_id === stack.world.panes[0].pane_id && [row.cols, row.rows, row.cellWidthPx, row.cellHeightPx].every((value) => Number.isFinite(value) && value > 0)).slice(-3);
        const helloSamples = (existsSync(stack.graphicsInputJsonl) ? readFileSync(stack.graphicsInputJsonl, 'utf8').trim().split('\n').map(JSON.parse) : []).filter((row) => row.source === 'graphics.ClientHello' && [row.cols, row.rows, row.cellWidthPx, row.cellHeightPx].every((value) => Number.isFinite(value) && value > 0)).slice(-3);
        report.graphics = { pixels, cellSamples, helloSamples, cellEvidenceScope: 'Native resize for first pane, or real graphics connection ClientHello populated from native attach', declaredCellMetrics: stack.phoneDeclaredCellMetrics(), pipeline };
        check(cellSamples.length > 0 || helloSamples.length > 0, 'No positive native cell dimensions recorded in resize or graphics ClientHello');
        check(pipeline.some((event) => event.frames > 0), 'No delivered graphics frames during mounted phase');
        await terminalKeyboard('graphics-keyboard');
        const restoredPixels = await graphicsPixels();
        check(restoredPixels.magenta > 100 && restoredPixels.teal > 100, 'Graphics missing after explicit keyboard resize');
        report.graphics.afterKeyboard = restoredPixels;
    });
    await feature('usage-switch-and-recency', async () => {
        if (flow === 'usage') await requireScreen('usage-home', /text="LIVE"/, 25_000, true);
        await herd(); await tapText('Usage');
        const selected = (xml, expected) => {
            for (const provider of ['OMP', 'OpenCode']) {
                const control = (xml.match(/<node\b[^>]*>/g) ?? []).find((node) => node.includes(`content-desc="${provider}"`));
                check(control?.includes(`selected="${provider === expected}"`), `Usage selected state does not match ${expected}: ${provider}`);
            }
        };
        const xml = await requireScreen('usage-omp', /text="150"/);
        selected(xml, 'OMP');
        check(xml.includes('text="OMP"') && xml.includes('text="OpenCode"'), 'Both provider tabs must mount');
        check(xml.indexOf('text="OMP"') < xml.indexOf('text="OpenCode"'), 'OMP must precede OpenCode by latest event time');
        await capture('usage-omp.png');
        await tapText('OpenCode');
        const opencode = await requireScreen('usage-opencode', /text="300"/);
        selected(opencode, 'OpenCode');
        check(opencode.includes('OpenCode Go limits unavailable') && opencode.includes('connect your Go account in OpenCode'), 'Missing actionable Go limits state for isolated unauthenticated fixture');
        await capture('usage-opencode.png');
        await tapText('OMP'); selected(await requireScreen('usage-omp-return', /text="150"/), 'OMP');
        report.usage = { passed: true, orderedProviders: ['OMP', 'OpenCode'], switchedTokens: [150, 300, 150], selectedProviders: ['OMP', 'OpenCode', 'OMP'], unauthenticatedGoLimits: 'Actionable unavailable state; local tokens retained' };
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
