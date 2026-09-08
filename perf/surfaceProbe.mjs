#!/usr/bin/env node
/**
 * One surface, about a minute, against a session somebody already prepared.
 *
 * This is a development probe, not acceptance. It does not build, install,
 * pair, run the prescribed idle baseline, soak or tour: it validates the
 * session it was handed, drives one surface with the same helpers the release
 * gate uses, and reports what it actually measured. Every result it prints is
 * marked `partial`, because a warm probe cannot be release evidence and must
 * never be mistaken for it.
 *
 * Frame accounting is deliberately absent. The gfxinfo ledger is frozen for
 * acceptance, so this probe reports CPU and memory as diagnostics and proves
 * behaviour with fresh captures, movement candidates and host records instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandScope, useCommandScope } from './lib/commands.mjs';
import {
    deviceIdentity,
    dismissPrompts,
    dumpUiXml,
    refreshHz,
    samplePhase,
    screenshot,
} from './lib/androidSignals.mjs';
import { drag, fling } from './lib/gestures.mjs';
import { documentPosition, documentViewport, scrollableBounds, stripPosition, TERMINAL_SURFACE, verticalScrollers } from './lib/gestureMetrics.mjs';
import { harnessIdentity, sha256, sourceIdentity } from './lib/provenance.mjs';
import { SCENARIO_VERSION } from './lib/scenario.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
};
const sessionPath = resolve(flag('--session', '/tmp/muxr-probe-session.json'));
const platform = flag('--platform', 'android');
const surface = flag('--surface', 'document');
const deadlineSeconds = Number(flag('--seconds', '110'));
const attachmentsDir = flag('--attachments-dir')
    ?? (process.env.HERDR_PANE_ID ? join(process.env.HOME, '.muxr/attachments/pane', process.env.HERDR_PANE_ID) : undefined);

if (!['android', 'ios'].includes(platform) || !['document', 'tree', 'terminal'].includes(surface)) {
    process.stderr.write('usage: surfaceProbe.mjs --session <path> --platform android|ios --surface document|tree|terminal\n');
    process.exit(2);
}

const scope = new CommandScope();
useCommandScope(scope);
const startedAt = Date.now();

/** Missing is never zero: a metric nobody could take says so and why. */
const metric = (name, value, unit, scope_, definition, collector) => (value === undefined
    ? { name, unit, scope: scope_, definition, collector, validity: 'unavailable', reason: `${name} did not read` }
    : { name, value, unit, scope: scope_, definition, collector, validity: 'measured' });

const finish = (outcome, extra = {}) => {
    const envelope = {
        // A warm probe is never release acceptance, and says so in its own body.
        kind: 'muxr.surface-probe',
        partial: true,
        acceptance: false,
        note: 'development probe against a warm session; not release acceptance',
        scenario: { version: SCENARIO_VERSION, ...(session?.scenario ?? {}) },
        candidate: session?.candidate,
        host: session?.host === undefined ? undefined : { relayPort: session.host.relayPort, fixturePanes: session.host.fixturePanes },
        plugins: session?.plugins,
        platform,
        surface,
        startedAt: new Date(startedAt).toISOString(),
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        outcome,
        ...extra,
    };
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    scope.cleanup();
    process.exit(outcome === 'pass' ? 0 : 1);
};

let session;
try {
    session = JSON.parse(readFileSync(sessionPath, 'utf8'));
} catch (error) {
    finish('inconclusive', { validity: 'unavailable', reason: `no session descriptor at ${sessionPath} (${error.code ?? error.message})` });
}

// The session has to be the one this probe was told to measure, and it has to
// still be alive. A dead owner means the world and the pairing are gone.
const stale = (() => {
    if (session.version !== 1) return `session descriptor version ${session.version} is not this probe's`;
    if (session.platform !== platform) return `session is ${session.platform}, probe asked for ${platform}`;
    if (session.scenario?.version !== SCENARIO_VERSION) return `session scenario ${session.scenario?.version} is not ${SCENARIO_VERSION}`;
    try { process.kill(session.pid, 0); } catch { return `the session owner (pid ${session.pid}) is gone`; }
    const source = sourceIdentity('.');
    if (session.candidate?.source?.sha256 !== source.sha256) return 'the working tree is not the source this session prepared';
    if (session.candidate?.artifact !== undefined) {
        if (!existsSync(session.candidate.artifact)) return 'the candidate artifact is gone';
        if (sha256(session.candidate.artifact) !== session.candidate.sha256) return 'the candidate artifact changed since preparation';
    }
    const document = session.scenario?.document;
    const onDisk = join(session.host?.cwd ?? '', document?.name ?? '');
    if (document !== undefined && (!existsSync(onDisk) || sha256(onDisk) !== document.sha256)) {
        return 'the document fixture on the host is not the one this session prepared';
    }
    return undefined;
})();
if (stale !== undefined) finish('inconclusive', { validity: 'invalid', reason: stale });

if (platform === 'ios') {
    // Two tiny branches, one CLI. The iOS probe drives simctl through the
    // existing controls; it is not wired here yet, and saying so is the honest
    // answer rather than reporting an Android measurement under an iOS label.
    finish('inconclusive', {
        validity: 'unavailable',
        reason: 'the iOS surface probe is not wired to this session yet; use perf/iosReleaseGate.mjs --phases',
    });
}

const device = await deviceIdentity().catch(() => undefined);
const hz = await refreshHz().catch(() => undefined);
const shots = {};
const capture = async (name) => {
    if (attachmentsDir === undefined) return undefined;
    mkdirSync(attachmentsDir, { recursive: true });
    const path = join(attachmentsDir, `probe-${surface}-${name}-${startedAt}.png`);
    const taken = await screenshot(path).then(() => existsSync(path)).catch(() => false);
    if (!taken) return undefined;
    shots[name] = path;
    return path;
};

/** Where the surface is standing, read from a fresh hierarchy every time. */
const readSurface = async () => {
    const dump = await dumpUiXml();
    if (dump === '' || !dump.includes('<hierarchy')) return { dumped: false };
    const bounds = scrollableBounds(surface === 'tree' ? 'tree' : surface, dump, device ?? {});
    return {
        dumped: true,
        bounds,
        ...(surface === 'document' ? { position: documentPosition(dump), viewport: documentViewport(dump).bounds } : {}),
        ...(surface === 'tree' ? { position: stripPosition(dump) } : {}),
        ...(surface === 'terminal' ? { surfaceSeen: dump.includes(`content-desc="${TERMINAL_SURFACE}"`) } : {}),
        scrollers: verticalScrollers(dump).length,
    };
};

await dismissPrompts();
const before = await readSurface();
if (!before.dumped) finish('inconclusive', { validity: 'unavailable', reason: 'the hierarchy did not read before the probe' });
if (before.bounds === undefined) {
    finish('inconclusive', { validity: 'unavailable', reason: `the ${surface} surface is not on screen` });
}
await capture('before');

// One-way travel first, then back: the same gestures the gate drives, at the
// same commanded speeds, with the surface's own bounds.
const box = before.bounds;
const midX = Math.round((box.l + box.r) / 2);
const top = Math.round(box.t + (box.b - box.t) * 0.28);
const bottom = Math.round(box.t + (box.b - box.t) * 0.72);
const actions = [];
let moving;
const sampled = samplePhase({ pkg: 'com.trymuxr.app', seconds: Math.min(20, deadlineSeconds), intervalMs: 2000 });
for (let pass = 0; pass < 3 && (Date.now() - startedAt) / 1000 < deadlineSeconds - 20; pass += 1) {
    actions.push(await fling({ x: midX, y: bottom }, { x: midX, y: top }));
    if (moving === undefined) {
        moving = await readSurface();
        await capture('moving');
    }
    actions.push(await drag({ from: { x: midX, y: top }, to: { x: midX, y: bottom } }));
}
const measured = await sampled;
const settled = await readSurface();
await capture('settled');

const candidates = [
    { name: 'moving', observation: moving },
    { name: 'settled', observation: settled },
].filter((entry) => entry.observation !== undefined);
const travelled = candidates.some((entry) => entry.observation.dumped === true
    && JSON.stringify(entry.observation.position) !== JSON.stringify(before.position));

const missingShots = ['before', 'moving', 'settled'].filter((name) => shots[name] === undefined);
finish(missingShots.length > 0 || !travelled ? 'inconclusive' : 'pass', {
    boundaries: { clock: 'device uptime for gestures, host wall clock for reads', actions: actions.length },
    device: { ...(device ?? {}), refreshHz: hz, buildMode: session.candidate?.artifact === undefined ? 'unknown' : 'installed artifact' },
    cadence: actions.map((action) => ({
        profile: action.profile, durationMs: action.durationMs, elapsedMs: action.elapsedMs,
        velocityPxPerSecond: action.velocityPxPerSecond, intendedVelocityPxPerSecond: action.intendedVelocityPxPerSecond,
    })),
    metrics: [
        metric('jsBusyPercent', measured.jsBusyPercent, 'percent', 'app JS thread',
            'JS-thread /proc tick delta over sampled seconds', 'androidSignals.samplePhase'),
        metric('pssMaxKb', measured.pssMaxKb, 'KiB', 'app process',
            'peak Total PSS across samples', 'androidSignals.samplePhase'),
        metric('pssDriftKb', measured.pssDriftKb, 'KiB', 'app process',
            'last Total PSS minus first', 'androidSignals.samplePhase'),
        metric('sampledSeconds', measured.sampledSeconds, 'seconds', 'probe window',
            'seconds of comparable CPU samples', 'androidSignals.samplePhase'),
    ],
    movement: {
        before: { position: before.position, bounds: before.bounds, dumped: before.dumped },
        candidates: candidates.map((entry) => ({ name: entry.name, ...entry.observation })),
        travelled,
        ...(travelled ? {} : { reason: 'no fresh observation showed the surface in a different position' }),
    },
    screenshots: shots,
    ...(missingShots.length > 0 ? { validity: 'unavailable', reason: `no screenshot captured: ${missingShots.join(', ')}` } : {}),
});
