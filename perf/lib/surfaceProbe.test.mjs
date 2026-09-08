import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandScope } from './commands.mjs';
import { artifactMismatch, acquireOwnerLock, childProcessesHealthy, judgeProbeMovement, provenanceMismatch, sampleValidity, screenshotsComplete, validateDeadline, validateFixtureProof, validateSession, worldIdentity } from './surfaceProbe.mjs';
import { validPixelCrop } from './gestureMetrics.mjs';
import { documentContract, documentPayload, scenarioDescriptor } from './scenario.mjs';

const root = new URL('../..', import.meta.url).pathname;
const crop = (value) => ({ width: 4, height: 4, bytes: Buffer.from(Array.from({ length: 16 }, (_, index) => [value + index % 2 * 20, 255 - value, 80, 255]).flat()) });
const digest = (text) => createHash('sha256').update(text).digest('hex');
const baseline = (path) => execFileSync('git', ['show', `16e17c88dd1f798dbb835afe82b211d12d0090dc:${path}`], { encoding: 'utf8' });
const block = (source, marker, end = '\n}') => { const start = source.indexOf(marker); assert.notEqual(start, -1, `${marker} missing`); const stop = source.indexOf(end, start) + end.length; assert.ok(stop > start, `${marker} end missing`); return source.slice(start, stop); };
const session = (overrides = {}) => {
    const world = { panes: [], agents: [], workspaces: [] };
    const fixturePanes = { text: 'pane-text', graphics: 'pane-graphics' };
    return {
        version: 1, pid: process.pid, platform: 'android', device: { serial: 'serial-a', package: 'com.trymuxr.app' },
        candidate: { source: { sourceSha256: digest('source'), mobileSha256: digest('mobile'), dirty: false }, harness: { revision: 'head', sha256: digest('harness') }, artifact: { path: '/candidate.apk', sha256: digest('apk'), package: 'com.trymuxr.app', versionName: '1.0.0', versionCode: 1, signerDigest: 'AA' }, installed: { sha256: digest('apk'), remotePath: '/data/app/base.apk' }, manifestPath: '/candidate.apk.json' },
        hostBuild: { version: 1, kind: 'muxr.host-build', buildCommand: 'yarn build' },
        host: { world, worldIdentity: worldIdentity({ world, fixturePanes }), identity: 'host', relayPort: 1234, pids: { relay: 10, host: 11, herdr: 12 }, pidIdentities: { relay: undefined, host: undefined, herdr: undefined }, fixturePanes, fixture: { name: 'perf-document.md', gitRevision: 'tree', gitTree: 'tree', payloadSha256: documentContract().sha256, servedBytes: documentContract().servedBytes, servedLines: documentContract().servedLines, servedSha256: documentContract().servedSha256 } },
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
    assert.equal(validateFixtureProof({ name: 'perf-document.md', payloadSha256: documentContract().sha256, gitRevision: 'real', gitTree: 'real', servedSha256: digest(served), servedBytes: Buffer.byteLength(served), servedLines: served.split('\n').filter(Boolean).length }, { ...documentContract(), servedBytes: Buffer.byteLength(served), servedLines: served.split('\n').filter(Boolean).length, servedSha256: digest(served) }), undefined);
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
    const before = { bounds, filename: 'perf-document.md', position: { line: 1, top: 100 }, crop: crop(20), surfaceSeen: true };
    const moving = { bounds, filename: 'perf-document.md', position: { line: 20, top: 100 }, crop: crop(220), surfaceSeen: true };
    const settled = { bounds, filename: 'perf-document.md', position: { line: 1, top: 100 }, crop: crop(40), surfaceSeen: true };
    assert.equal(judgeProbeMovement('document', { before, moving, settled }).proven, true);
    const pngs = { before: join(fixtureRoot, 'before.png'), moving: join(fixtureRoot, 'moving.png'), settled: join(fixtureRoot, 'settled.png') };
    assert.equal(screenshotsComplete(pngs), false);
    for (const [index, path] of Object.values(pngs).entries()) { const image = new PNG({ width: 4, height: 4 }); image.data = crop(20 + index * 40).bytes; writeFileSync(path, PNG.sync.write(image)); }
    assert.equal(screenshotsComplete(pngs), true);
    assert.equal(judgeProbeMovement('document', { before, moving: { ...moving, filename: undefined }, settled }).proven, false);
    assert.equal(judgeProbeMovement('document', { before, moving: { ...moving, position: before.position }, settled }).proven, false);
    assert.equal(validPixelCrop({ width: 2, height: 2, bytes: Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) }).valid, false);
    assert.equal(judgeProbeMovement('tree', { before: { position: { identity: 'row-a', top: 10 }, crop: crop(20) }, moving: { position: { identity: 'row-a', top: 10 }, crop: crop(220) }, settled: { position: { identity: 'row-b', top: 10 }, crop: crop(40) } }).proven, false);
    assert.equal(judgeProbeMovement('terminal', { before: { surfaceSeen: true, hostProof: true, position: { scrolls: 0 }, crop: crop(20) }, moving: { surfaceSeen: true, hostProof: true, inputProof: false, position: { scrolls: 0 }, crop: crop(220) }, settled: { surfaceSeen: true, hostProof: true, position: { scrolls: 0 }, crop: crop(40) } }).proven, false);
    assert.equal(judgeProbeMovement('terminal', { before: { bounds, surfaceSeen: true, hostProof: true, position: { scrolls: 0 }, crop: crop(20) }, moving: { bounds, surfaceSeen: true, hostProof: true, inputProof: true, position: { scrolls: 1 }, crop: crop(220) }, settled: { bounds, surfaceSeen: true, hostProof: true, position: { scrolls: 1 }, crop: crop(40) } }).proven, true);
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
