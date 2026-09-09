import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandScope } from './commands.mjs';
import { CommandScope as Scope, useCommandScope } from './commands.mjs';
import { samplePhase } from './androidSignals.mjs';
import { summarize } from './gestures.mjs';
import { sleep } from './iosSignals.mjs';
import { artifactMismatch, acquireOwnerLock, childProcessesHealthy, cropScreenshot, judgeProbeMovement, processCpuPercent, processStartIdentity, provenanceMismatch, sampleValidity, screenshotsComplete, validateDeadline, validateFixtureProof, validateSession, worldIdentity } from './surfaceProbe.mjs';
import { knownRowKey, treePosition, validPixelCrop } from './gestureMetrics.mjs';
import { documentContract, documentPayload, scenarioDescriptor } from './scenario.mjs';

const root = new URL('../..', import.meta.url).pathname;
const crop = (value) => ({ width: 4, height: 4, bytes: Buffer.from(Array.from({ length: 16 }, (_, index) => [value + index % 2 * 20, 255 - value, 80, 255]).flat()) });
const digest = (text) => createHash('sha256').update(text).digest('hex');
const baseline = (path) => execFileSync('git', ['show', `16e17c88dd1f798dbb835afe82b211d12d0090dc:${path}`], { encoding: 'utf8' });
const block = (source, marker, end = '\n}') => { const start = source.indexOf(marker); assert.notEqual(start, -1, `${marker} missing`); const stop = source.indexOf(end, start) + end.length; assert.ok(stop > start, `${marker} end missing`); return source.slice(start, stop); };
const started = processStartIdentity(process.pid);
const session = (overrides = {}) => {
    const world = { panes: [], agents: [], workspaces: [] };
    const fixturePanes = { text: 'pane-text', graphics: 'pane-graphics' };
    return {
        version: 1, pid: process.pid, platform: 'android', device: { serial: 'serial-a', package: 'com.trymuxr.app' },
        candidate: { source: { sourceSha256: digest('source'), mobileSha256: digest('mobile'), dirty: false }, harness: { revision: 'head', sha256: digest('harness') }, artifact: { path: '/candidate.apk', sha256: digest('apk'), package: 'com.trymuxr.app', versionName: '1.0.0', versionCode: 1, signerDigest: 'AA' }, installed: { sha256: digest('apk'), remotePath: '/data/app/base.apk' }, manifestPath: '/candidate.apk.json' },
        hostBuild: { version: 1, kind: 'muxr.host-build', buildCommand: 'yarn build' },
        host: { world, worldIdentity: worldIdentity({ world, fixturePanes }), identity: 'host', relayPort: 1234, pids: { relay: process.pid, host: process.pid, herdr: process.pid }, pidIdentities: { relay: started, host: started, herdr: started }, fixturePanes, fixture: { name: 'perf-document.md', gitRevision: 'tree', gitTree: 'tree', payloadSha256: documentContract().sha256, servedBytes: documentContract().servedBytes, servedLines: documentContract().servedLines, servedSha256: documentContract().servedSha256 } },
        scenario: scenarioDescriptor(), lock: '/tmp/session.lock', probeLock: '/tmp/session.lock/active-probe', ...overrides,
    };
};

// One compact flow through the exported gates. It intentionally uses no device,
// build, install, pairing, emulator, or simulator.
test('warm probe fails closed across identity, ownership, fixture, movement, sampling, deadline, and envelope', async () => {
    assert.throws(() => validateDeadline(180), /<=110/);
    const base = session();
    assert.deepEqual(scenarioDescriptor().load, { panes: 100, agents: 30, titleChurnHz: 2, terminalBytesPerSecond: 4096, graphicsFrameHz: 4 });
    assert.deepEqual(scenarioDescriptor().document, { name: 'perf-document.md', generatedLines: 240, bytes: 26640, sha256: '6041d293b6ec060a8e4b388ca4f9c4b16d4a7a4b0d681f99fa81553b16c2190f', servedSha256: '0403252d0bace2dd34b7a83184cd33e3e8b0e0e8e5e159758b83fdf1393b8a0d', servedBytes: 24576, servedLines: 222, marker: 'PERF_LINE_' });
    assert.equal(block(readFileSync(join(root, 'perf/releaseGate.mjs'), 'utf8'), 'const PHASES = [', '\n];'), block(baseline('perf/releaseGate.mjs'), 'const PHASES = [', '\n];'));
    assert.equal(block(readFileSync(join(root, 'perf/iosReleaseGate.mjs'), 'utf8'), 'export const PHASES = [', '\n];'), block(baseline('perf/iosReleaseGate.mjs'), 'export const PHASES = [', '\n];'));
    assert.equal(block(readFileSync(join(root, 'perf/lib/gestureMetrics.mjs'), 'utf8'), 'export function creditLedger', '\n}\n\n/**'), block(baseline('perf/lib/gestureMetrics.mjs'), 'export function creditLedger', '\n}\n\n/**'));
    assert.equal(readFileSync(join(root, 'perf/lib/gestureMetrics.mjs'), 'utf8').slice(readFileSync(join(root, 'perf/lib/gestureMetrics.mjs'), 'utf8').indexOf('export function verdict')).trim(), baseline('perf/lib/gestureMetrics.mjs').slice(baseline('perf/lib/gestureMetrics.mjs').indexOf('export function verdict')).trim());
    const current = { platform: 'android', device: { serial: 'serial-a', package: 'com.trymuxr.app' }, source: { sourceSha256: digest('source'), mobileSha256: digest('mobile'), dirty: false }, harness: { revision: 'head', sha256: digest('harness') }, worldIdentity: base.host.worldIdentity, connection: true, childHealth: () => true };
    assert.equal(validateSession(base, current), undefined);
    assert.match(validateSession(base, { ...current, device: { serial: 'other' } }), /serial/);
    assert.match(validateSession({ ...base, host: { ...base.host, fixture: undefined } }, current), /Git/);
    assert.equal(validateFixtureProof(base.host.fixture, documentContract()), undefined);
    assert.match(validateFixtureProof({ name: 'perf-document.md', payloadSha256: documentContract().sha256 }, documentContract()), /Git/);
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'muxr-real-fixture-'));
    writeFileSync(join(fixtureRoot, 'perf-document.md'), documentPayload());
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRoot });
    execFileSync('git', ['add', '--', 'perf-document.md'], { cwd: fixtureRoot });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: fixtureRoot });
    const served = JSON.parse(execFileSync(process.execPath, [join(root, 'plugins/code/files.mjs'), 'read'], { cwd: root, env: { ...process.env, MUXR_PLUGIN_CONTEXT_JSON: JSON.stringify({ sessions: [{ cwd: fixtureRoot }] }) }, input: JSON.stringify({ cwd: fixtureRoot, root: fixtureRoot, path: 'perf-document.md' }), encoding: 'utf8' })).body;
    assert.equal(digest(Buffer.from(served)), documentContract().servedSha256, 'the real plugin did not serve the canonical bytes');
    assert.equal(validateFixtureProof({ name: 'perf-document.md', payloadSha256: documentContract().sha256, gitRevision: 'real', gitTree: 'real', servedSha256: digest(Buffer.from(served)), servedBytes: Buffer.byteLength(served), servedLines: served.split('\n').filter(Boolean).length }, documentContract()), undefined);
    assert.match(provenanceMismatch({ source: { sourceSha256: digest('bad'), mobileSha256: digest('mobile'), dirty: false }, harness: base.candidate.harness }, current), /sourceSha256/);
    assert.match(provenanceMismatch({ source: { sourceSha256: digest('source'), mobileSha256: digest('bad'), dirty: false }, harness: base.candidate.harness }, current), /mobileSha256/);
    assert.match(provenanceMismatch({ source: base.candidate.source, harness: { revision: 'head', sha256: digest('bad') } }, current), /harnessIdentity/);
    assert.match(artifactMismatch({ sha256: 'candidate' }, { sha256: 'installed' }), /installed artifact/);
    assert.match(childProcessesHealthy({ relay: 10, host: 10, dead: 11 }, (pid) => pid === 10), /dead/);

    const lock = join(mkdtempSync(join(tmpdir(), 'muxr-probe-lock-')), 'owner.lock');
    const release = acquireOwnerLock(lock, { pid: process.pid, device: 'serial-a' });
    assert.throws(() => acquireOwnerLock(lock, { pid: process.pid, device: 'serial-a' }), /already held/);
    release();

    const bounds = { l: 0, t: 0, r: 4, b: 4 };
    const before = { bounds, filename: 'perf-document.md', position: { line: 1, top: 100 }, crop: crop(20), surfaceSeen: true, connected: true };
    const moving = { bounds, filename: 'perf-document.md', position: { line: 20, top: 100 }, crop: crop(220), surfaceSeen: true, connected: true };
    const settled = { bounds, filename: 'perf-document.md', position: { line: 1, top: 100 }, crop: crop(40), surfaceSeen: true, connected: true };
    assert.equal(judgeProbeMovement('document', { before, moving, settled }).proven, true);
    // The document viewer hides the root's connected chrome: the exact-terminal
    // attach proof carries it, and nothing carries it when that proof is absent.
    const offRoot = (entry, hostProof) => ({ ...entry, connected: false, hostProof });
    assert.equal(judgeProbeMovement('document', { before: offRoot(before, true), moving: offRoot(moving, true), settled: offRoot(settled, true) }).proven, true);
    assert.deepEqual(judgeProbeMovement('document', { before: offRoot(before, false), moving: offRoot(moving, true), settled: offRoot(settled, true) }).reasons, ['connection proof missing']);
    const pngs = { before: join(fixtureRoot, 'before.png'), moving: join(fixtureRoot, 'moving.png'), settled: join(fixtureRoot, 'settled.png') };
    assert.equal(screenshotsComplete(pngs), false);
    for (const [index, path] of Object.values(pngs).entries()) { const image = new PNG({ width: 4, height: 4 }); image.data = crop(20 + index * 40).bytes; writeFileSync(path, PNG.sync.write(image)); }
    assert.equal(screenshotsComplete(pngs), true);
    assert.equal(judgeProbeMovement('document', { before, moving: { ...moving, filename: undefined }, settled }).proven, false);
    assert.equal(judgeProbeMovement('document', { before, moving: { ...moving, position: before.position }, settled }).proven, false);
    assert.equal(validPixelCrop({ width: 2, height: 2, bytes: Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) }).valid, false);
    assert.equal(judgeProbeMovement('tree', { before: { connected: true, position: { identity: 'row-a', top: 10 }, crop: crop(20) }, moving: { connected: true, position: { identity: 'row-a', top: 10 }, crop: crop(220) }, settled: { connected: true, position: { identity: 'row-b', top: 10 }, crop: crop(40) } }).proven, false);
    assert.equal(judgeProbeMovement('terminal', { before: { connected: true, surfaceSeen: true, hostProof: true, position: { scrolls: 0 }, crop: crop(20) }, moving: { connected: true, surfaceSeen: true, hostProof: true, inputProof: false, position: { scrolls: 0 }, crop: crop(220) }, settled: { connected: true, surfaceSeen: true, hostProof: true, position: { scrolls: 0 }, crop: crop(40) } }).proven, false);
    assert.equal(judgeProbeMovement('terminal', { before: { bounds, connected: true, surfaceSeen: true, hostProof: true, position: { scrolls: 0 }, crop: crop(20) }, moving: { bounds, connected: true, surfaceSeen: true, hostProof: true, inputProof: true, position: { scrolls: 1 }, crop: crop(220) }, settled: { bounds, connected: true, surfaceSeen: true, hostProof: true, position: { scrolls: 1 }, crop: crop(40) } }).proven, true);
    assert.deepEqual(sampleValidity({ gaps: 1, restarts: 1, missingPss: 1, sampledSeconds: 4, jsBusyPercent: 10 }, { requiredSeconds: 1 }), { valid: false, reasons: ['sampler gaps', 'app restarted during sample', 'PSS was missing'] });
    assert.ok(sampleValidity({ commandFailed: true, missingCpu: true, sampledSeconds: 4 }, { requiredSeconds: 1 }).reasons.includes('CPU was not sampled'));

    const scope = new CommandScope();
    scope.setDeadline(Date.now() + 100);
    const start = Date.now();
    await assert.rejects(scope.run(process.execPath, ['-e', 'setTimeout(() => {}, 180000)'], { timeout: 180_000 }), /cancelled|deadline|exceeded/);
    assert.ok(Date.now() - start < 5_000, 'deadline did not cancel the long transport');
    await scope.close();

    const dir = mkdtempSync(join(tmpdir(), 'muxr-probe-envelope-'));
    const missing = join(dir, 'missing.json');
    let stdout;
    try { execFileSync(process.execPath, ['perf/surfaceProbe.mjs', '--session', missing, '--platform', 'android', '--surface', 'document', '--serial', 'serial-a', '--seconds', '1'], { cwd: root, encoding: 'utf8' }); } catch (error) { stdout = error.stdout; }
    const envelope = JSON.parse(stdout);
    assert.deepEqual({ kind: envelope.kind, partial: envelope.partial, acceptance: envelope.acceptance, outcome: envelope.outcome }, { kind: 'muxr.surface-probe', partial: true, acceptance: false, outcome: 'inconclusive' });
    assert.equal(Object.keys(envelope).filter((key) => key === 'outcome').length, 1);
});

// The second flow is the one the compact test above could not reach: a
// descriptor that has been through JSON, the shared sleep and sampler the
// release runners also use, and the judgements the probe makes about pixels,
// rows, connection and injection. Real exports throughout; only OS transport
// is stubbed.
test('the prepared descriptor survives serialization and the probe callers judge honestly', async () => {
    const current = { platform: 'android', device: { serial: 'serial-a', package: 'com.trymuxr.app' }, source: { sourceSha256: digest('source'), mobileSha256: digest('mobile'), dirty: false }, harness: { revision: 'head', sha256: digest('harness') }, worldIdentity: session().host.worldIdentity, childHealth: () => true };
    // Undefined process identities do not survive JSON, and a descriptor that
    // lost them must be refused rather than validated in memory.
    const replayed = JSON.parse(JSON.stringify(session()));
    assert.equal(validateSession(replayed, current), undefined);
    delete replayed.host.pidIdentities.herdr;
    assert.match(validateSession(replayed, current), /process identities/);

    // The shared iOS sleep: no scope is a plain sleep, an aborted scope rejects.
    await sleep(0);
    const aborted = new Scope();
    aborted.abort();
    useCommandScope(aborted);
    await assert.rejects(sleep(10));
    useCommandScope(undefined);

    // A supplied but untriggered AbortSignal must not delete the sampling
    // cadence: racing the signal object itself resolved on every iteration.
    let reads = 0;
    useCommandScope({ signal: { throwIfAborted() {} }, cleanups: [], spawn() { throw new Error('the sampler spawns nothing'); }, async run() { reads += 1; return { stdout: '' }; } });
    try { await samplePhase({ pkg: 'com.example', seconds: .03, intervalMs: 5, signal: new AbortController().signal }); }
    finally { useCommandScope(undefined); }
    assert.ok(reads < 40, `sampler ignored its interval: ${reads} reads in 30 ms`);

    // Whole-process CPU: one CPU second over two elapsed seconds is 50%.
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    assert.equal(processCpuPercent([
        { at: new Date(at).toISOString(), pid: 1, alive: true, cpuSeconds: 0, rssKb: 100 },
        { at: new Date(at + 2000).toISOString(), pid: 1, alive: true, cpuSeconds: 1, rssKb: 100 },
    ]).percent, 50);

    // A 3x screenshot: AX bounds are points, the crop is physical pixels.
    const image = new PNG({ width: 12, height: 12 });
    image.data = Buffer.concat(Array.from({ length: 144 }, (_, index) => Buffer.from([index * 3 % 256, 255 - index % 200, 90, 255])));
    const cropped = cropScreenshot(image, { l: 1, t: 1, r: 3, b: 3 }, { points: { width: 4, height: 4 }, pixels: { width: 12, height: 12 } });
    assert.deepEqual({ width: cropped.width, height: cropped.height, scale: cropped.scale }, { width: 6, height: 6, scale: 3 });
    assert.throws(() => cropScreenshot(image, { l: 1, t: 1, r: 3, b: 3 }, { points: { width: 4, height: 4 }, pixels: { width: 8, height: 8 } }), /incoherent/);

    // Title churn is not travel: the identity is the prepared row key, and a
    // renamed row at the same offset fails "did not move".
    const treeDump = (title) => `<hierarchy>`
        + `<node class="androidx.recyclerview.widget.RecyclerView" text="" content-desc="" bounds="[0,100][1080,1900]" />`
        + `<node class="android.view.ViewGroup" text="" content-desc="Open ${title}, Pi 1" bounds="[0,200][1080,320]" />`
        + `<node class="android.view.ViewGroup" text="" content-desc="Open Other, Pi 10" bounds="[0,320][1080,440]" />`
        + `</hierarchy>`;
    const keys = ['Pi 1', 'Pi 10'];
    const churnBefore = treePosition(treeDump('Task A'), keys);
    const churnAfter = treePosition(treeDump('Task B'), keys);
    assert.deepEqual(churnBefore, churnAfter);
    assert.equal(churnBefore.identity, 'Pi 1');
    assert.equal(knownRowKey('Open Task, Pi 10', keys), 'Pi 10');
    assert.equal(treePosition(treeDump('Task A'), ['Nothing Prepared']), undefined);
    const treeBounds = churnBefore.viewport;
    assert.equal(judgeProbeMovement('tree', {
        before: { bounds: treeBounds, connected: true, position: churnBefore, crop: crop(20) },
        moving: { bounds: treeBounds, connected: true, position: churnAfter, crop: crop(220) },
        settled: { bounds: treeBounds, connected: true, position: churnBefore, crop: crop(40) },
    }).proven, false);

    // Closing evidence: settled host proof and connection are required too.
    const terminal = (overrides) => ({
        before: { bounds: { l: 0, t: 0, r: 4, b: 4 }, connected: true, surfaceSeen: true, hostProof: true, position: { scrolls: 0 }, crop: crop(20) },
        moving: { bounds: { l: 0, t: 0, r: 4, b: 4 }, connected: true, surfaceSeen: true, hostProof: true, inputProof: true, position: { scrolls: 1 }, crop: crop(220) },
        settled: { bounds: { l: 0, t: 0, r: 4, b: 4 }, connected: true, surfaceSeen: true, hostProof: true, position: { scrolls: 1 }, crop: crop(40) },
        ...overrides,
    });
    assert.equal(judgeProbeMovement('terminal', terminal()).proven, true);
    assert.equal(judgeProbeMovement('terminal', terminal({ settled: { ...terminal().settled, hostProof: false } })).proven, false);
    assert.equal(judgeProbeMovement('terminal', terminal({ settled: { ...terminal().settled, connected: false } })).proven, false);

    // The gesture the probe records is the helper's own, and the existing 70%
    // per-profile guard is what decides whether it was delivered.
    assert.deepEqual(summarize([{ profile: 'fling', velocityPxPerSecond: 1000, intendedVelocityPxPerSecond: 6600 }]).slowProfiles, ['fling']);
    assert.deepEqual(summarize([{ profile: 'fling', velocityPxPerSecond: 6000, intendedVelocityPxPerSecond: 6600 }]).slowProfiles, []);
});
