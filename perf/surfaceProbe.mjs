#!/usr/bin/env node
/** Warm, surface-selective development probe. It never builds, installs or pairs. */
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandScope, fetchCommand, useCommandScope } from './lib/commands.mjs';
import { setAndroidSerial, androidArgs } from './lib/deviceTarget.mjs';
import { deviceIdentity, dumpUiXml, samplePhase, screenshot } from './lib/androidSignals.mjs';
import { fling, drag, summarize } from './lib/gestures.mjs';
import { documentPosition, knownRowKey, parseUiNodes, scrollableBounds, treePosition, TERMINAL_SURFACE } from './lib/gestureMetrics.mjs';
import { apkIdentity, harnessIdentity, iosAppIdentity, patchedDependencies, runtimeIdentity, sha256, sourceIdentity } from './lib/provenance.mjs';
import { IosControls, appPid as iosAppPid, command as iosCommand, processSample } from './lib/iosSignals.mjs';
import { iosConnectionProof } from './lib/iosWarm.mjs';
import { PROBE_KIND, acquireOwnerLock, artifactMismatch, cropScreenshot, judgeProbeMovement, metric, processCpuPercent, processStartIdentity, provenanceMismatch, sampleValidity, screenshotsComplete, validateDeadline, validateFixtureProof, validateOwnerLock, validateSession, worldIdentity } from './lib/surfaceProbe.mjs';
import { documentPayload, scenarioDescriptor } from './lib/scenario.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const sessionPath = resolve(flag('--session', '/tmp/muxr-probe-session.json'));
const platform = flag('--platform', 'android');
const surface = flag('--surface', 'document');
const attachmentsDir = flag('--attachments-dir') ?? (process.env.HERDR_PANE_ID ? join(process.env.HOME, '.muxr/attachments/pane', process.env.HERDR_PANE_ID) : resolve('/tmp/muxr-surface-probe-attachments'));
const serial = flag('--serial');
const udid = flag('--udid');
const scope = new CommandScope();
useCommandScope(scope);
const startedAt = Date.now();
let session;
let shots = {};
let probeRelease;
let attempt;
let selectedHostProof = false;
let iosUi;
let knownKeys = [];

function checkDeadline() { scope.signal.throwIfAborted(); scope.remaining(1); }
function readJsonl(path, cap = 256) {
    if (!existsSync(path)) throw new Error('required evidence log is missing');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > cap) throw new Error('required evidence log exceeds its bound');
    try { return lines.map(JSON.parse); } catch { throw new Error('required evidence log is malformed'); }
}
function hostJournal() {
    const path = join(session.host.dataDir, 'diagnostics.json');
    if (!existsSync(path)) throw new Error('required host journal is missing');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(value.events) || value.events.length > 512) throw new Error('required host journal is malformed or over cap');
    return value.events;
}
function pathFor(name, suffix = '') { return join(attachmentsDir, `probe-${surface}-${name}-${startedAt}${suffix}.png`); }
function routeFor(paneId) {
    const agent = (session.host.world?.agents ?? []).find((row) => row.pane_id === paneId);
    if (!agent) return `shell:${paneId}`;
    const routes = JSON.parse(readFileSync(join(session.host.dataDir, 'herdr-routes.json'), 'utf8')).bindings;
    return routes.find((row) => ['source', 'agent', 'kind', 'value'].every((key) => row.agentSession?.[key] === agent.agent_session[key]))?.route;
}
async function adb(argv, options = {}) { checkDeadline(); return (await scope.run('adb', androidArgs(argv), { timeout: scope.remaining(options.timeout ?? 20_000), ...options })).stdout; }
async function maestro(flow) {
    checkDeadline();
    return new Promise((done, reject) => {
        const child = scope.spawn('mise', ['x', 'maestro@cli-2.7.0', '--', 'maestro', '--device', serial, 'test', join('perf/flows', flow)], { stdio: ['ignore', 'pipe', 'pipe'] });
        const output = []; child.stdout.on('data', (chunk) => output.push(String(chunk))); child.stderr.on('data', (chunk) => output.push(String(chunk)));
        child.once('error', reject); child.once('close', (code) => code === 0 ? done({ code, output: output.join('') }) : reject(new Error(`Maestro exited ${code}: ${output.join('').slice(-400)}`)));
    });
}
function androidConnected(dump) {
    const values = parseUiNodes(dump).flatMap((node) => [node.text, node.desc]).map((value) => String(value ?? '').trim());
    return values.some((value) => /^connected$/i.test(value)) && !values.some((value) => /^(disconnected|reconnecting|connecting)$/i.test(value));
}
function iosScrollers(nodes) {
    return nodes.filter((node) => node.frame && /scroll|list|collection|table/i.test(`${node.type ?? ''} ${node.AXRole ?? ''} ${node.role ?? ''}`) && node.frame.width > 0 && node.frame.height > 0).sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height);
}
function iosDocumentPosition(nodes) {
    const rows = nodes.filter((node) => /^PERF_LINE_\d+/.test(node.AXLabel ?? '') && iosUi.visible(node) && node.frame.height <= 80).sort((a, b) => a.frame.y - b.frame.y);
    const line = /PERF_LINE_(\d+)/.exec(rows[0]?.AXLabel ?? '');
    const scroller = iosScrollers(nodes).find((node) => rows.some((row) => row.frame.y >= node.frame.y && row.frame.y + row.frame.height <= node.frame.y + node.frame.height));
    return line && scroller ? { line: Number(line[1]), top: rows[0].frame.y, viewport: frameBounds(scroller.frame) } : undefined;
}
function frameBounds(frame) { return { l: frame.x, t: frame.y, r: frame.x + frame.width, b: frame.y + frame.height }; }
function iosTreePosition(nodes) {
    const row = nodes.filter((node) => node.frame && iosUi.visible(node) && node.frame.height > 20 && node.frame.height <= 100 && knownRowKey(node.AXLabel, knownKeys) !== undefined).sort((a, b) => a.frame.y - b.frame.y)[0];
    const scroller = iosScrollers(nodes).find((node) => row && row.frame.y >= node.frame.y && row.frame.y + row.frame.height <= node.frame.y + node.frame.height);
    return row && scroller ? { identity: knownRowKey(row.AXLabel, knownKeys), top: row.frame.y, viewport: frameBounds(scroller.frame) } : undefined;
}
function terminalProof(paneId, since) {
    const geometry = (existsSync(session.host.cellMetricsJsonl) ? readJsonl(session.host.cellMetricsJsonl) : []).filter((row) => row.pane_id === paneId && row.mode === 'control' && row.source === 'terminal.attach' && Date.parse(row.at) >= since && row.cols > 0 && row.rows > 0);
    const inputs = (existsSync(session.host.inputJsonl) ? readJsonl(session.host.inputJsonl) : []).filter((row) => row.pane_id === paneId && Date.parse(row.at) >= since && ((row.source === 'terminal.scroll' && ['up', 'down'].includes(row.direction) && Number(row.lines) > 0) || (row.source === 'terminal.input' && Number(row.notches) > 0)));
    const requests = hostJournal().filter((row) => row.event === 'client.request' && row.request === 'terminal.attach' && row.outcome === 'ok' && Date.parse(row.at) >= since);
    return { attached: geometry.length > 0 && requests.length > 0, input: inputs.length > 0, distance: inputs.reduce((total, row) => total + (Number(row.lines) > 0 ? Number(row.lines) : Number(row.notches)), 0), records: { geometry, requests, inputs } };
}
async function capture(name, bounds) {
    checkDeadline(); mkdirSync(attachmentsDir, { recursive: true });
    const original = pathFor(name, '-full');
    if (platform === 'android') await screenshot(original); else await iosUi.screenshot(original);
    const image = PNG.sync.read(readFileSync(original));
    const geometry = platform === 'ios'
        ? { points: { width: iosUi.width, height: iosUi.height }, pixels: { width: iosUi.pixelWidth, height: iosUi.pixelHeight } }
        : { points: { width: image.width, height: image.height }, pixels: { width: image.width, height: image.height } };
    const crop = cropScreenshot(image, bounds, geometry);
    const path = pathFor(name);
    const output = new PNG({ width: crop.width, height: crop.height }); output.data = crop.bytes; writeFileSync(path, PNG.sync.write(output));
    const shot = { path, width: crop.width, height: crop.height, bounds, scale: crop.scale, sha256: sha256(path) };
    shots[name] = shot;
    return { ...crop, shot };
}
function observationFilename(nodes) {
    const name = session.scenario.document.name;
    return nodes.some((node) => [`File ${name}`, name].includes(String(node.AXLabel ?? '').trim())) ? name : undefined;
}
function surfaceNode(nodes, predicate) { return nodes.find((node) => node.frame && iosUi.visible(node) && predicate(node)); }
async function observe(since = 0, captureName = 'observation') {
    checkDeadline();
    if (platform === 'android') {
        const dump = await dumpUiXml(scope.remaining(20_000));
        if (!dump.includes('<hierarchy')) throw new Error('fresh Android hierarchy is unavailable');
        const device = await deviceIdentity();
        const position = surface === 'document' ? documentPosition(dump) : surface === 'tree' ? treePosition(dump, knownKeys) : undefined;
        const bounds = surface === 'tree' ? position?.viewport : scrollableBounds(surface, dump, device);
        if (bounds === undefined) throw new Error(`${surface} viewport is unavailable`);
        const filename = surface === 'document' && dump.includes(session.scenario.document.name) ? session.scenario.document.name : undefined;
        const proof = surface === 'terminal' ? terminalProof(session.host.fixturePanes.text, since) : undefined;
        const surfacePosition = surface === 'terminal' ? { scrolls: proof.distance } : position;
        const surfaceSeen = surface === 'terminal' ? dump.includes(`content-desc="${TERMINAL_SURFACE}"`) : surface === 'document' ? filename !== undefined && position !== undefined : surfacePosition !== undefined;
        const crop = captureName === false ? undefined : await capture(captureName, bounds);
        return { bounds, crop, position: surfacePosition, filename, surfaceSeen, connected: androidConnected(dump), hostProof: surface === 'terminal' ? proof.attached : selectedHostProof, inputProof: surface === 'terminal' ? proof.input : true, hostRecords: proof?.records, raw: dump };
    }
    const nodes = await iosUi.ui();
    const terminal = surfaceNode(nodes, (node) => String(node.AXLabel ?? '').trim() === TERMINAL_SURFACE);
    const application = surfaceNode(nodes, (node) => node.type === 'Application' && String(node.AXLabel ?? '') === 'muxr');
    const position = surface === 'document' ? iosDocumentPosition(nodes) : surface === 'tree' ? iosTreePosition(nodes) : undefined;
    const bounds = surface === 'terminal' ? terminal?.frame && frameBounds(terminal.frame) : position?.viewport;
    const filename = surface === 'document' ? observationFilename(nodes) : undefined;
    const proof = surface === 'terminal' ? terminalProof(session.host.fixturePanes.text, since) : undefined;
    const surfacePosition = surface === 'terminal' ? { scrolls: proof.distance } : position;
    if (!bounds || (surface === 'document' && (!filename || !position)) || (surface === 'tree' && !position) || (surface === 'terminal' && !terminal)) throw new Error(`${surface} surface identity or viewport is unavailable`);
    const connection = iosConnectionProof(iosUi, []).then((value) => value.connected);
    const crop = captureName === false ? undefined : await capture(captureName, bounds);
    return { bounds, crop, position: surfacePosition, filename, surfaceSeen: surface !== 'terminal' || terminal !== undefined, connected: await connection, hostProof: surface === 'terminal' ? proof.attached : selectedHostProof, inputProof: surface === 'terminal' ? proof.input : true, hostRecords: proof?.records, raw: nodes, application: application ? frameBounds(application.frame) : undefined };
}
async function exactHostChallenge(since) {
    const route = routeFor(session.host.fixturePanes.text);
    if (!route) throw new Error('no exact terminal fixture route');
    if (platform === 'android') {
        await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `muxr://session/${encodeURIComponent(route)}`, session.device.package]);
        const end = Date.now() + scope.remaining(20_000);
        while (Date.now() < end) {
            const dump = await dumpUiXml(scope.remaining(5_000));
            const proof = terminalProof(session.host.fixturePanes.text, since);
            if (androidConnected(dump) && dump.includes(`content-desc="${TERMINAL_SURFACE}"`) && proof.attached) { selectedHostProof = true; return; }
        }
    } else {
        await iosUi.open(`session/${encodeURIComponent(route)}`);
        const end = Date.now() + scope.remaining(20_000);
        while (Date.now() < end) {
            const nodes = await iosUi.ui();
            const proof = terminalProof(session.host.fixturePanes.text, since);
            const connected = (await iosConnectionProof(iosUi, [])).connected;
            if (connected && surfaceNode(nodes, (node) => String(node.AXLabel ?? '').trim() === TERMINAL_SURFACE) && proof.attached) { selectedHostProof = true; return; }
        }
    }
    throw new Error('selected prepared host did not attach exact terminal fixture');
}
async function navigate() {
    const since = Date.now();
    await exactHostChallenge(since);
    if (surface === 'document') {
        if (platform === 'android') { const result = await maestro('openDocument.yaml'); if (result.code !== 0) throw new Error(`document navigation failed: ${result.output.slice(-400)}`); }
        else { await iosUi.home(); await iosUi.tapMatch(/^Files$/); await iosUi.waitFor(/^Repositories$/); await iosUi.tapMatch(/^project$/); await iosUi.waitFor(new RegExp(`^File ${session.scenario.document.name}$`)); await iosUi.tapMatch(new RegExp(`^File ${session.scenario.document.name}$`)); await iosUi.waitFor(/^PERF_LINE_/); }
    } else if (surface === 'tree') {
        if (platform === 'android') await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'muxr:///', session.device.package]);
        else await iosUi.home();
    }
    const end = Date.now() + scope.remaining(20_000);
    while (Date.now() < end) {
        const observation = await observe(since, false).catch(() => undefined);
        if (observation?.connected && observation.surfaceSeen && (surface !== 'document' || observation.filename === session.scenario.document.name)) return { since };
    }
    throw new Error(`${surface} did not become the requested surface`);
}
async function sampleIos(seconds, onOpen) {
    const started = Date.now(), end = started + Math.min(seconds * 1000, scope.remaining(seconds * 1000));
    let previous, pid, restarts = 0, gaps = 0, missingCpu = 0, rss = [];
    const samples = [];
    const take = async () => {
        checkDeadline(); const current = await iosAppPid(udid, session.device.bundle);
        if (!current) { gaps += 1; previous = undefined; pid = undefined; return; }
        if (pid && current !== pid) { restarts += 1; previous = undefined; }
        pid = current; const sample = await processSample(current); samples.push(sample);
        if (!sample.alive || sample.pid !== current || !Number.isFinite(sample.cpuSeconds) || !Number.isFinite(sample.rssKb)) { gaps += 1; missingCpu += 1; previous = undefined; return; }
        rss.push(sample.rssKb);
        if (previous && !((Date.parse(sample.at) - Date.parse(previous.at)) > 0 && sample.cpuSeconds >= previous.cpuSeconds)) gaps += 1;
        previous = sample;
    };
    // main() waits on attempt.close() before it consumes this. Whatever happens
    // here -- closure, deadline, a dead simulator -- the attempt gets its answer.
    try {
        await take();
        onOpen?.();
        while (attempt?.open !== false && Date.now() < end) {
            let timer;
            await Promise.race([new Promise((done) => { timer = setTimeout(done, Math.min(1000, Math.max(1, end - Date.now()))); }), attempt?.signal ?? new Promise(() => {})]);
            clearTimeout(timer);
            await take();
        }
        await take();
    } finally { attempt?.acknowledge?.(); }
    const cpu = processCpuPercent(samples);
    return { sampledSeconds: cpu.seconds, processCpuPercent: cpu.percent, rssFirstKb: rss[0], rssLastKb: rss.at(-1), rssPeakKb: rss.length ? Math.max(...rss) : undefined, samples, gaps, restarts, missingCpu, missingPss: 0 };
}
function supportedMetricReason(name, sample, validity) {
    const supported = platform === 'android' ? ['jsBusyPercent', 'pssMaxKb', 'sampledSeconds'] : ['processCpuPercent', 'rssPeakKb', 'sampledSeconds'];
    return supported.includes(name) && !validity.valid ? validity.reasons.join(', ') : undefined;
}
/** The candidate on disk, still byte-for-byte what preparation recorded. */
async function candidateUnchanged() {
    const artifact = session.candidate.artifact;
    if (!artifact?.path || !existsSync(artifact.path)) return false;
    if (platform === 'android') return sha256(artifact.path) === artifact.sha256;
    // A .app is a directory: hashing its path throws. The bundle identity is the
    // executable, the JS bundle, the plist fields and the bundled resources.
    return artifactMismatch(artifact, await iosAppIdentity(artifact.path)) === undefined;
}

/**
 * What the device is actually running, reread from the device. `deep` reparses
 * the whole installed package once at the opening boundary; the closing recheck
 * is the installed bytes' own checksum, which fits inside the same deadline.
 */
async function verifyInstalled(deep = false) {
    const artifact = session.candidate.artifact;
    if (platform === 'android') {
        const remote = (await adb(['shell', 'pm', 'path', session.device.package])).trim().replace(/^package:/, '');
        if (!remote || remote !== session.candidate.installed.remotePath) throw new Error('installed Android package path does not match prepared identity');
        if (!deep) {
            const digest = /\b[0-9a-f]{64}\b/.exec(await adb(['shell', 'sha256sum', remote], { timeout: 30_000 }))?.[0];
            if (digest === undefined) throw new Error('installed Android bytes unavailable');
            if (digest !== artifact.sha256) throw new Error('installed artifact sha256 differs from candidate');
            return { remotePath: remote, sha256: digest };
        }
        const scratch = mkdtempSync('/tmp/muxr-probe-verify-');
        try {
            const pulled = join(scratch, 'installed.apk');
            await adb(['pull', remote, pulled], { timeout: 30_000 });
            const identity = { ...await apkIdentity(pulled), remotePath: remote };
            const problem = artifactMismatch(artifact, identity);
            if (problem) throw new Error(problem);
            return identity;
        } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
    const root = (await iosCommand('xcrun', ['simctl', 'get_app_container', udid, session.device.bundle, 'app'])).trim();
    if (!root) throw new Error('installed iOS app container is unavailable');
    const identity = await iosAppIdentity(root);
    const problem = artifactMismatch(artifact, identity);
    if (problem) throw new Error(problem);
    return identity;
}

async function verifyFixture() {
    const fixturePath = join(session.host.cwd, session.scenario.document.name);
    if (!existsSync(fixturePath) || sha256(fixturePath) !== session.scenario.document.sha256) throw new Error('document fixture changed since preparation');
    const head = (await scope.run('git', ['-C', session.host.cwd, 'rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim();
    const tree = (await scope.run('git', ['-C', session.host.cwd, 'rev-parse', 'HEAD^{tree}'], { timeout: 10_000 })).stdout.trim();
    if (head !== session.host.fixture.gitRevision || tree !== session.host.fixture.gitTree) throw new Error('fixture Git identity changed since preparation');
    const context = JSON.stringify({ sessions: [{ cwd: session.host.cwd }] });
    const read = JSON.parse((await scope.run(process.execPath, [join(process.cwd(), 'plugins/code/files.mjs'), 'read'], { cwd: process.cwd(), env: { ...process.env, MUXR_PLUGIN_CONTEXT_JSON: context }, input: JSON.stringify({ cwd: session.host.cwd, root: session.host.cwd, path: session.scenario.document.name }), timeout: 10_000 })).stdout);
    const body = Buffer.from(read.body ?? '');
    if (read.name !== session.scenario.document.name || body.compare(Buffer.from(documentPayload()).subarray(0, session.scenario.document.servedBytes)) !== 0 || body.length !== session.scenario.document.servedBytes || createHash('sha256').update(body).digest('hex') !== session.scenario.document.servedSha256 || body.toString('utf8').split('\n').filter(Boolean).length !== session.scenario.document.servedLines) throw new Error('real Files plugin fixture identity changed');
}
async function main() {
    const seconds = validateDeadline(flag('--seconds', '110'));
    if (!['android', 'ios'].includes(platform) || !['document', 'tree', 'terminal'].includes(surface)) throw new Error('invalid platform or surface');
    if (platform === 'android') { if (!serial) throw new Error('--serial is required for Android'); if (flag('--package', 'com.trymuxr.app') !== 'com.trymuxr.app') throw new Error('unsupported Android package override'); setAndroidSerial(serial); }
    else { if (!udid) throw new Error('--udid is required for iOS'); if (flag('--bundle', 'com.trymuxr.app') !== 'com.trymuxr.app') throw new Error('unsupported iOS bundle override'); iosUi = new IosControls(udid); }
    scope.setDeadline(startedAt + seconds * 1000);
    session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    knownKeys = [...new Set([...(session.host?.world?.workspaces ?? []).map((row) => row.label), ...(session.host?.world?.agents ?? []).map((row) => row.name), ...(session.host?.world?.panes ?? []).map((row) => row.label)].filter(Boolean))];
    const source = sourceIdentity('.'), harness = harnessIdentity('.'), runtime = runtimeIdentity('.');
    const witness = JSON.parse(readFileSync(session.worldWitness, 'utf8'));
    const liveWorldIdentity = worldIdentity(witness);
    const device = platform === 'android' ? { serial } : { udid };
    const stale = validateSession(session, { platform, device: { ...device, package: session.device?.package, bundle: session.device?.bundle }, source, harness, worldIdentity: liveWorldIdentity, childHealth: undefined, isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } });
    if (stale) throw new Error(stale);
    if (typeof session.pidStartIdentity !== 'string' || processStartIdentity(session.pid) !== session.pidStartIdentity) throw new Error('session owner process identity changed');
    if (validateOwnerLock(session.lock, session.lockOwner)) throw new Error('prepared session lock is not owned by this descriptor');
    if (JSON.stringify(session.scenario) !== JSON.stringify(scenarioDescriptor())) throw new Error('scenario changed since preparation');
    if (session.hostBuild?.version !== 1 || session.hostBuild.kind !== 'muxr.host-build' || session.hostBuild.buildCommand !== 'yarn build' || session.hostBuild.source?.dirty !== false || JSON.stringify(session.hostBuild.source) !== JSON.stringify(source) || JSON.stringify(session.hostBuild.harness) !== JSON.stringify(harness) || JSON.stringify(session.hostBuild.runtime) !== JSON.stringify(runtime)) throw new Error('built host provenance is missing or changed');
    const provenance = provenanceMismatch(session.candidate, { source, harness });
    if (provenance) throw new Error(provenance);
    if (liveWorldIdentity !== session.host.worldIdentity) throw new Error('live fake-world identity changed');
    const fixtureProblem = validateFixtureProof(session.host.fixture, session.scenario.document); if (fixtureProblem) throw new Error(fixtureProblem);
    await verifyFixture();
    const artifact = session.candidate.artifact;
    if (!await candidateUnchanged()) throw new Error('candidate artifact is missing or changed');
    const manifest = JSON.parse(readFileSync(session.candidate.manifestPath, 'utf8'));
    const manifestDigest = manifest.apkSha256 ?? manifest.appSha256 ?? manifest.binarySha256 ?? manifest.artifact?.sha256;
    if (manifest.sourceSha256 !== session.candidate.source.sourceSha256 || manifest.mobileSha256 !== session.candidate.source.mobileSha256 || manifest.dirty !== false || manifestDigest !== artifact.sha256 || manifest.nativeDependencies === undefined || JSON.stringify(manifest.nativeDependencies) !== JSON.stringify(patchedDependencies('.')) || (typeof manifest.signer !== 'string' && typeof manifest.buildMode !== 'string')) throw new Error('candidate build sidecar changed or is unbound');
    await verifyInstalled(true);
    const relay = await fetchCommand(`http://127.0.0.1:${session.host.relayPort}/health`).then((response) => response.ok).catch(() => false);
    if (!relay) throw new Error('prepared relay is not healthy');
    if (platform === 'ios') { const geometryRoot = mkdtempSync('/tmp/muxr-ios-geometry-'), geometryPath = join(geometryRoot, 'screen.png'); try { await iosUi.screenshot(geometryPath); const image = PNG.sync.read(readFileSync(geometryPath)); const nodes = await iosUi.ui(); const root = nodes.find((node) => node.type === 'Application' && node.frame?.width > 0 && node.frame?.height > 0) ?? nodes.find((node) => node.frame?.x === 0 && node.frame?.y === 0 && node.frame?.width > 0 && node.frame?.height > 0); if (!root) throw new Error('iOS AX root geometry is unavailable'); iosUi.setGeometry(root.frame.width, root.frame.height, image.width, image.height); } finally { rmSync(geometryRoot, { recursive: true, force: true }); } }
    probeRelease = acquireOwnerLock(session.probeLock, { pid: process.pid, descriptor: sessionPath, device: serial ?? udid });
    const ready = await navigate();
    const before = await observe(ready.since, 'before');
    if (before.position === undefined && surface !== 'terminal') throw new Error(`${surface} has no valid position before movement`);
    attempt = (await import('./lib/androidSignals.mjs')).newAttempt();
    let resolveSampleOpen;
    const sampleOpened = new Promise((resolve) => { resolveSampleOpen = resolve; });
    const sampleOpenedAt = { value: undefined };
    const onSampleOpen = () => { sampleOpenedAt.value = new Date().toISOString(); resolveSampleOpen(); };
    const samplePromise = (platform === 'android'
        ? samplePhase({ pkg: session.device.package, seconds: Math.min(20, seconds), intervalMs: 2000, attempt, signal: scope.signal, active: () => !scope.signal.aborted, onOpen: onSampleOpen })
        : sampleIos(Math.min(20, seconds), onSampleOpen)).catch((error) => { attempt.cancel(); resolveSampleOpen(); return { commandFailed: true, reason: error.message }; });
    await sampleOpened;
    const actions = [];
    const act = async (kind, from, to, fn) => { const action = { kind, startedAt: new Date().toISOString(), from, to, ...(platform === 'ios' ? { requestedDurationMs: 120, timing: 'AX command elapsed; not delivery velocity' } : {}) }; try { const actual = await fn(); Object.assign(action, actual, { finishedAt: new Date().toISOString() }); actions.push(action); return actual; } catch (error) { action.error = error.message; action.finishedAt = new Date().toISOString(); actions.push(action); throw error; } };
    const from = { x: (before.bounds.l + before.bounds.r) / 2, y: before.bounds.t + (before.bounds.b - before.bounds.t) * .72 }, to = { x: (before.bounds.l + before.bounds.r) / 2, y: before.bounds.t + (before.bounds.b - before.bounds.t) * .28 };
    let moving, settled, sample;
    try {
        if (platform === 'android') await act('fling', from, to, () => fling(from, to)); else await act('swipe', from, to, () => iosUi.swipe(from.x, from.y, to.x, to.y));
        moving = await observe(ready.since, 'moving');
        const reverseFrom = to, reverseTo = from;
        if (platform === 'android') await act('drag', reverseFrom, reverseTo, () => drag({ from: reverseFrom, to: reverseTo })); else await act('swipe', reverseFrom, reverseTo, () => iosUi.swipe(reverseFrom.x, reverseFrom.y, reverseTo.x, reverseTo.y));
        settled = await observe(ready.since, 'settled');
    } finally {
        await attempt.close().catch(() => attempt.cancel());
        sample = await samplePromise.catch((error) => ({ commandFailed: true, reason: error.message }));
    }
    checkDeadline();
    const closingSource = sourceIdentity('.'), closingHarness = harnessIdentity('.'), closingRuntime = runtimeIdentity('.');
    const closingProvenance = provenanceMismatch(session.candidate, { source: closingSource, harness: closingHarness });
    if (closingProvenance || JSON.stringify(closingRuntime) !== JSON.stringify(session.hostBuild.runtime)) throw new Error(closingProvenance ?? 'closing build/runtime identity changed');
    if (!await candidateUnchanged()) throw new Error('candidate artifact is missing or changed');
    if (worldIdentity(JSON.parse(readFileSync(session.worldWitness, 'utf8'))) !== session.host.worldIdentity) throw new Error('closing live world identity changed');
    await verifyFixture();
    await verifyInstalled();
    const movement = judgeProbeMovement(surface, { before, moving, settled });
    if (!screenshotsComplete(shots)) throw new Error('before, moving and settled cropped PNGs are mandatory');
    const validity = sampleValidity(sample, { requiredSeconds: Math.min(1, seconds), requirePss: platform === 'android' });
    const sampleReason = validity.reasons.join(', ') || undefined;
    const metricReason = (name) => supportedMetricReason(name, sample, validity);
    const metrics = [
        metric('jsBusyPercent', sample.jsBusyPercent, 'percent', 'app JS thread', 'JS-thread /proc tick delta', 'androidSignals.samplePhase', platform === 'android' ? metricReason('jsBusyPercent') : 'iOS JS CPU collector unavailable', platform === 'android' ? 'invalid' : 'unavailable'),
        metric('processCpuPercent', sample.processCpuPercent, 'percent', 'app process', 'whole-process CPU interval mean', 'iosSignals.processSample', platform === 'ios' ? metricReason('processCpuPercent') : 'Android process CPU collector unavailable', platform === 'ios' ? 'invalid' : 'unavailable'),
        metric('pssMaxKb', sample.pssMaxKb, 'KiB', 'app process', 'peak Total PSS', 'androidSignals.samplePhase', platform === 'android' ? metricReason('pssMaxKb') : 'iOS PSS unavailable', platform === 'android' ? 'invalid' : 'unavailable'),
        metric('rssPeakKb', sample.rssPeakKb, 'KiB', 'app process', 'peak resident set size', 'iosSignals.processSample', platform === 'ios' ? metricReason('rssPeakKb') : 'Android RSS collector unavailable', platform === 'ios' ? 'invalid' : 'unavailable'),
        metric('sampledSeconds', sample.sampledSeconds, 'seconds', 'probe window', 'comparable sampled duration', 'samplePhase', sampleReason),
    ];
    // iOS AX swipes have no delivery velocity to guard; Android's helpers report
    // theirs, and an under-delivered fling that still moved is not a failing app.
    const delivery = platform === 'android' ? summarize(actions.filter((action) => action.profile !== undefined)) : undefined;
    const underDelivered = delivery?.slowProfiles.length ? [`gesture injection under-delivered: ${delivery.slowProfiles.join(',')}`] : [];
    const reasons = [...validity.reasons, ...movement.reasons, ...underDelivered];
    const failure = movement.failure && validity.valid && underDelivered.length === 0;
    const outcome = failure ? 'fail' : reasons.length === 0 ? 'pass' : 'inconclusive';
    return { validity: failure || reasons.length === 0 ? 'measured' : 'invalid', outcome, ...(reasons.length === 0 ? {} : { reason: reasons.join(', ') }), device: session.device, boundaries: { deadlineSeconds: seconds, deadlineAt: new Date(startedAt + seconds * 1000).toISOString(), sampleOpenedAt: sampleOpenedAt.value, sampleClosedAt: new Date().toISOString(), actions, delivery }, metrics, sample, movement, screenshots: shots, hostWitness: { selected: selectedHostProof } };
}

let result;
let cleanupError;
try { result = await main(); } catch (error) { result = { validity: 'invalid', outcome: 'inconclusive', reason: scope.signal.aborted ? 'probe deadline exceeded' : error.message }; }
try {
    if (attempt?.open) attempt.cancel();
    const remaining = scope.deadlineAt === undefined ? 10_000 : Math.max(1, scope.deadlineAt - Date.now());
    await scope.close(remaining);
    scope.cleanup();
    probeRelease?.();
} catch (error) { cleanupError = error.message; result = { ...result, validity: 'invalid', outcome: 'inconclusive', reason: `${result.reason ? `${result.reason}; ` : ''}cleanup incomplete: ${cleanupError}` }; }
const envelope = { kind: PROBE_KIND, partial: true, acceptance: false, note: 'development probe against a warm session; not release acceptance', scenario: session?.scenario, candidate: session?.candidate, hostBuild: session?.hostBuild, host: session?.host && { relayPort: session.host.relayPort, worldIdentity: session.host.worldIdentity }, plugins: session?.plugins, platform, surface, startedAt: new Date(startedAt).toISOString(), elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)), ...result, screenshots: result?.screenshots ?? shots, cleanup: { complete: cleanupError === undefined } };
process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
process.exitCode = envelope.outcome === 'pass' ? 0 : 1;
