import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { scenarioMismatch } from './scenario.mjs';
import { pixelsMoved, validPixelCrop } from './gestureMetrics.mjs';

export const PROBE_KIND = 'muxr.surface-probe';

export function validateDeadline(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 110) throw new Error('--seconds must be finite, positive and <=110');
    return seconds;
}

export function artifactMismatch(candidate, actual) {
    for (const field of ['sha256', 'jsSha256', 'resourcesSha256', 'package', 'bundle', 'version', 'versionCode', 'build', 'signerDigest']) {
        if (candidate?.[field] !== undefined && candidate[field] !== actual?.[field]) return `installed artifact ${field} differs from candidate`;
    }
    return undefined;
}

function requiredHash(value, name) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? undefined : `${name} identity is unavailable`;
}

export function provenanceMismatch(stored, current) {
    const source = current?.source;
    const harness = current?.harness;
    for (const [value, name] of [[stored?.source?.sourceSha256, 'stored sourceSha256'], [source?.sourceSha256, 'current sourceSha256'], [stored?.source?.mobileSha256, 'stored mobileSha256'], [source?.mobileSha256, 'current mobileSha256'], [stored?.harness?.sha256, 'stored harnessIdentity'], [harness?.sha256, 'current harnessIdentity']]) {
        const missing = requiredHash(value, name);
        if (missing) return missing;
    }
    if (stored?.source?.sourceSha256 !== source.sourceSha256) return 'sourceSha256 changed since preparation';
    if (stored.source.mobileSha256 !== source.mobileSha256) return 'mobileSha256 changed since preparation';
    if (stored.source.dirty !== false || source.dirty !== false) return 'source is not clean';
    if (typeof stored.harness.revision !== 'string' || stored.harness.revision === '' || stored.harness.revision !== harness.revision) return 'harness revision changed since preparation';
    if (stored.harness.sha256 !== harness.sha256) return 'harnessIdentity changed since preparation';
    return undefined;
}

export function processStartIdentity(pid) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return undefined;
    try {
        // Linux carries starttime in /proc; Darwin has no /proc, and a descriptor
        // whose identities are undefined loses those keys to JSON entirely.
        if (process.platform === 'darwin') return execFileSync('ps', ['-p', String(id), '-o', 'lstart='], { encoding: 'utf8', timeout: 5_000 }).trim() || undefined;
        const stat = readFileSync(`/proc/${id}/stat`, 'utf8').trim();
        return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] || undefined;
    } catch { return undefined; }
}

export function validateOwnerLock(path, owner) {
    try {
        const held = JSON.parse(readFileSync(`${path}/owner.json`, 'utf8'));
        const same = held.pid === owner.pid && held.descriptor === owner.descriptor && held.device === owner.device;
        return same && (owner.token === undefined || held.token === owner.token) && (owner.startIdentity === undefined || held.startIdentity === owner.startIdentity)
            ? undefined : 'probe lock is owned by another session';
    } catch { return 'probe lock is missing'; }
}

export function acquireOwnerLock(path, owner) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { mkdirSync(path, { mode: 0o700 }); } catch { throw new Error('probe lock is already held'); }
    const record = { ...owner, token: owner.token ?? randomUUID(), startIdentity: owner.startIdentity ?? processStartIdentity(owner.pid) };
    writeFileSync(`${path}/owner.json`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const release = () => {
        try {
            const held = JSON.parse(readFileSync(`${path}/owner.json`, 'utf8'));
            if (held.token === record.token) rmSync(path, { recursive: true, force: true });
        } catch { /* another owner or already released */ }
    };
    release.owner = record;
    return release;
}

export function screenshotsComplete(screenshots) {
    return ['before', 'moving', 'settled'].every((name) => {
        const shot = screenshots?.[name];
        const path = typeof shot === 'string' ? shot : shot?.path;
        if (typeof path !== 'string' || !existsSync(path)) return false;
        try {
            const bytes = readFileSync(path);
            const image = PNG.sync.read(bytes);
            return image.width > 0 && image.height > 0 && (shot?.width === undefined || shot.width === image.width) && (shot?.height === undefined || shot.height === image.height) && (shot?.sha256 === undefined || shot.sha256 === createHash('sha256').update(bytes).digest('hex')) && validPixelCrop({ width: image.width, height: image.height, bytes: image.data }).valid;
        } catch { return false; }
    });
}

export function validateFixtureProof(fixture, contract) {
    if (contract === undefined || fixture?.name !== contract.name || fixture?.payloadSha256 !== contract.sha256) return 'fixture payload identity does not match scenario';
    if (!fixture?.gitRevision || !fixture?.gitTree || fixture.servedBytes !== contract.servedBytes || fixture.servedLines !== contract.servedLines || fixture.servedSha256 !== contract.servedSha256) return 'fixture is not a verified real Git/Files-plugin fixture';
    return undefined;
}

export function childProcessesHealthy(pids, isAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
}, identities = {}) {
    const entries = Object.entries(pids ?? {});
    if (entries.length < 3) return 'fake-stack child identity is incomplete';
    for (const [name, pid] of entries) {
        if (!Number.isInteger(Number(pid)) || Number(pid) <= 0 || !isAlive(Number(pid))) return `fake-stack ${name} (pid ${pid}) is not alive`;
        if (identities[name] !== undefined && processStartIdentity(Number(pid)) !== identities[name]) return `fake-stack ${name} process identity changed`;
    }
    return undefined;
}

export function validateSession(session, { platform, device, source, harness, worldIdentity, childHealth, connection, isAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
} } = {}) {
    if (session?.version !== 1) return 'unsupported session descriptor';
    if (!Number.isInteger(Number(session.pid)) || Number(session.pid) <= 0 || !isAlive(Number(session.pid))) return `session owner (pid ${session.pid}) is gone`;
    if (session.platform !== platform) return `session is ${session.platform}, probe asked for ${platform}`;
    if (platform === 'android' && (!device?.serial || session.device?.serial !== device.serial || session.device.package !== 'com.trymuxr.app')) return 'Android serial/package does not match the prepared session';
    if (platform === 'ios' && (!device?.udid || session.device?.udid !== device.udid || session.device.bundle !== 'com.trymuxr.app')) return 'iOS UDID/bundle does not match the prepared session';
    const artifact = session.candidate?.artifact;
    const installed = session.candidate?.installed;
    if (!artifact?.path || !artifact.sha256 || !installed?.sha256 || !session.candidate?.manifestPath) return 'candidate/installed artifact identity is absent';
    if (platform === 'android' && (!artifact.package || !artifact.versionName || !Number.isFinite(artifact.versionCode) || !artifact.signerDigest || !installed.remotePath)) return 'Android artifact identity is incomplete';
    if (platform === 'ios' && (!artifact.bundle || !artifact.executable || !artifact.jsSha256 || !artifact.resourcesSha256 || !installed.bundle || !installed.executable || !installed.jsSha256 || !installed.resourcesSha256)) return 'iOS artifact identity is incomplete';
    const provenance = provenanceMismatch(session.candidate, { source, harness });
    if (provenance) return provenance;
    if (scenarioMismatch(session.scenario)) return 'session scenario is not the current canonical scenario';
    if (typeof session.host?.worldIdentity !== 'string' || session.host.worldIdentity.length !== 64 || session.host.world === undefined) return 'fake-world identity is absent';
    if (worldIdentity !== undefined && session.host.worldIdentity !== worldIdentity) return 'fake-world identity changed';
    if (!session.host.fixture?.gitRevision || !session.host.fixture?.gitTree) return 'fixture is not a committed Git repository';
    if (typeof session.host.identity !== 'string' || session.host.identity.length === 0) return 'connected host identity is absent';
    if (!Number.isInteger(Number(session.host.relayPort)) || Number(session.host.relayPort) <= 0) return 'relay identity is absent';
    if (!session.host?.pidIdentities || Object.keys(session.host.pids ?? {}).some((name) => typeof session.host.pidIdentities[name] !== 'string' || session.host.pidIdentities[name] === '')) return 'fake-stack process identities are absent';
    const children = childProcessesHealthy(session.host?.pids, childHealth, session.host?.pidIdentities);
    if (children) return children;
    if ((session.host?.childHealth ?? []).some((entry) => entry.exitCode !== null || entry.signal !== null)) return 'fake-stack child health recorded a dead child';
    if (connection !== undefined && connection !== true) return 'connected app/host proof is absent';
    if (session.host?.fixturePanes?.text === undefined || session.host?.fixturePanes?.graphics === undefined) return 'expected fixture panes are absent';
    if (!session.lock || !session.probeLock) return 'session lock identity is absent';
    return undefined;
}

export function worldIdentity(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function positionChanged(before, moving) {
    return before !== undefined && moving !== undefined
        && (before.identity !== moving.identity || before.line !== moving.line || before.top !== moving.top);
}

export function judgeProbeMovement(surface, observations) {
    const before = observations?.before;
    const moving = observations?.moving;
    const settled = observations?.settled;
    const reasons = [];
    const bounds = [before?.bounds, moving?.bounds, settled?.bounds];
    const sameBounds = bounds.every((value) => value && ['l', 't', 'r', 'b'].every((key) => Number.isFinite(value[key]))) && bounds.slice(1).every((value) => ['l', 't', 'r', 'b'].every((key) => Math.abs(value[key] - bounds[0][key]) <= 2));
    if (!sameBounds) reasons.push('surface viewport geometry changed');
    const crops = [before, moving, settled].map((entry) => validPixelCrop(entry?.crop));
    if (crops.some((crop) => !crop.valid)) reasons.push('invalid crop');
    const pixels = pixelsMoved(before?.crop, moving?.crop);
    if (!pixels.moved) reasons.push('before-to-moving pixels below noise floor');
    if ([before, moving, settled].some((entry) => entry?.connected !== true)) reasons.push('connection proof missing');
    if (surface === 'document') {
        const names = [before?.filename, moving?.filename, settled?.filename];
        if (names.some((name) => name !== 'perf-document.md') || new Set(names).size !== 1) reasons.push('document filename changed or disappeared');
        if ([before, moving, settled].some((entry) => entry?.position === undefined)) reasons.push('document position unavailable');
        if (!positionChanged(before?.position, moving?.position)) reasons.push('document did not travel one way');
    } else if (surface === 'tree') {
        if ([before, moving, settled].some((entry) => entry?.position === undefined)) reasons.push('tree row position unavailable');
        if (!positionChanged(before?.position, moving?.position)) reasons.push('vertical tree position did not move');
    } else if (surface === 'terminal') {
        if (before?.surfaceSeen !== true || moving?.surfaceSeen !== true || settled?.surfaceSeen !== true) reasons.push('terminal surface identity missing');
        if (before?.hostProof !== true || moving?.hostProof !== true || settled?.hostProof !== true || moving?.inputProof !== true) reasons.push('terminal host scroll/input or exact attach proof missing');
        if (!Number.isFinite(before?.position?.scrolls) || !Number.isFinite(moving?.position?.scrolls) || moving.position.scrolls <= before.position.scrolls) reasons.push('terminal scroll position did not advance');
    } else reasons.push('unknown surface');
    const behaviorReasons = surface === 'document' ? ['before-to-moving pixels below noise floor', 'document did not travel one way'] : surface === 'tree' ? ['before-to-moving pixels below noise floor', 'vertical tree position did not move'] : ['before-to-moving pixels below noise floor', 'terminal scroll position did not advance'];
    const failure = reasons.length > 0 && reasons.every((reason) => behaviorReasons.includes(reason));
    return {
        proven: reasons.length === 0,
        failure,
        reasons,
        pixels: { ...pixels, cropValidity: crops },
        before: before?.position,
        moving: moving?.position,
        settled: settled?.position,
    };
}

/**
 * One crop, in the screenshot's own pixels. AX bounds are points; the scale is
 * the physical image over the observed point viewport, never over itself.
 */
export function cropScreenshot(image, bounds, { points, pixels } = {}) {
    if (!(points?.width > 0 && points?.height > 0 && pixels?.width > 0 && pixels?.height > 0)) throw new Error('screenshot geometry is unavailable');
    if (image.width !== pixels.width || image.height !== pixels.height) throw new Error('screenshot orientation/scale is incoherent');
    const scale = image.width / points.width;
    if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - image.height / points.height) > .02) throw new Error('screenshot orientation/scale is incoherent');
    const left = Math.round((bounds?.l ?? 0) * scale), top = Math.round((bounds?.t ?? 0) * scale), right = Math.round((bounds?.r ?? 0) * scale), bottom = Math.round((bounds?.b ?? 0) * scale);
    if (left < 0 || top < 0 || right <= left || bottom <= top || right > image.width || bottom > image.height) throw new Error('surface crop is outside screenshot bounds');
    const width = right - left, height = bottom - top, bytes = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) image.data.copy(bytes, y * width * 4, ((top + y) * image.width + left) * 4, ((top + y) * image.width + right) * 4);
    return { width, height, bytes, scale };
}

/**
 * Whole-process CPU over the window it was actually observed across: CPU
 * seconds against elapsed seconds. Summing interval percentages and dividing by
 * total seconds reports a quarter of the truth for a two-sample window.
 */
export function processCpuPercent(samples) {
    let previous, cpuSeconds = 0, duration = 0;
    for (const sample of samples ?? []) {
        if (sample?.alive !== true || !Number.isFinite(sample.cpuSeconds)) { previous = undefined; continue; }
        if (previous !== undefined && previous.pid === sample.pid) {
            const dt = (Date.parse(sample.at) - Date.parse(previous.at)) / 1000;
            const delta = sample.cpuSeconds - previous.cpuSeconds;
            if (dt > 0 && delta >= 0) { cpuSeconds += delta; duration += dt; }
        }
        previous = sample;
    }
    return { percent: duration > 0 ? cpuSeconds * 100 / duration : undefined, seconds: duration };
}

export function sampleValidity(sample, { requiredSeconds = 1, requirePss = true } = {}) {
    const reasons = [];
    if (!sample || sample.commandFailed) reasons.push('sampler command failed');
    if (sample?.stalePid === true) reasons.push('stale app PID');
    if (sample?.hierarchyStale === true) reasons.push('stale hierarchy');
    if (sample?.wrongSurface === true) reasons.push('wrong surface');
    if (sample?.badCrop === true) reasons.push('bad screenshot crop');
    if (sample?.missingScreenshot === true) reasons.push('screenshot missing');
    if (sample?.gestureFailed === true) reasons.push('gesture command failed');
    if ((sample?.gaps ?? 0) > 0) reasons.push('sampler gaps');
    if ((sample?.restarts ?? 0) > 0) reasons.push('app restarted during sample');
    if (!(sample?.sampledSeconds >= requiredSeconds)) reasons.push('insufficient sampled duration');
    if (sample?.missingCpu === true || (!Number.isFinite(sample?.jsBusyPercent) && !Number.isFinite(sample?.processCpuPercent))) reasons.push('CPU was not sampled');
    if (requirePss && (sample?.missingPss ?? 0) > 0) reasons.push('PSS was missing');
    return { valid: reasons.length === 0, reasons };
}

export function metric(name, value, unit, scope, definition, collector, reason, reasonValidity = 'invalid') {
    if (reason) return { name, unit, scope, definition, collector, validity: reasonValidity, reason };
    return Number.isFinite(value)
        ? { name, value, unit, scope, definition, collector, validity: 'measured' }
        : { name, unit, scope, definition, collector, validity: 'unavailable', reason: `${name} collector did not produce a finite value` };
}
