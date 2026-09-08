/**
 * One flow test for the development probe: it must refuse a session it cannot
 * stand on, and it must never look like release acceptance.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { documentContract, documentPayload, DOCUMENT_FIXTURE, LOAD, SCENARIO_VERSION } from './scenario.mjs';
import { sourceIdentity } from './provenance.mjs';

const root = new URL('../..', import.meta.url).pathname;
const probe = (session, extra = []) => {
    const result = execFileSync(process.execPath, [
        'perf/surfaceProbe.mjs', '--session', session, '--platform', 'android', '--surface', 'document', ...extra,
    ], { cwd: root, encoding: 'utf8', timeout: 120_000 }).toString();
    return JSON.parse(result);
};
const refuse = (session) => {
    try {
        probe(session);
        throw new Error('the probe measured a session it should have refused');
    } catch (error) {
        assert.ok(error.stdout, `the probe exited without an envelope: ${error.message}`);
        return JSON.parse(error.stdout);
    }
};

test('the probe refuses a session it cannot stand on, and never claims acceptance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muxr-probe-'));
    // A host directory holding exactly the fixture the session prepared.
    writeFileSync(join(dir, DOCUMENT_FIXTURE), documentPayload());
    const descriptor = (overrides = {}) => {
        const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(path, JSON.stringify({
            version: 1,
            pid: process.pid,
            platform: 'android',
            scenario: { version: SCENARIO_VERSION, load: LOAD, document: documentContract() },
            candidate: { source: sourceIdentity(root) },
            host: { cwd: dir, relayPort: 1, fixturePanes: { text: 'pp_a', graphics: 'pp_b' } },
            plugins: ['code'],
            ...overrides,
        }, null, 2));
        return path;
    };

    // No descriptor at all, and one whose owner has gone: both are unavailable
    // evidence, and neither is a surface that failed to move.
    const missing = refuse(join(dir, 'absent.json'));
    assert.equal(missing.outcome, 'inconclusive');
    assert.match(missing.reason, /no session descriptor/);
    const dead = refuse(descriptor({ pid: 2_147_483_646 }));
    assert.match(dead.reason, /session owner .* is gone/);

    // A different scenario, a different platform, and a candidate that changed
    // under the session are all refusals, not measurements.
    assert.match(refuse(descriptor({ scenario: { version: '0.0.1' } })).reason, /scenario/);
    assert.match(refuse(descriptor({ platform: 'ios' })).reason, /session is ios/);
    const swapped = refuse(descriptor({ candidate: { source: { sha256: 'not-this-tree' } } }));
    assert.match(swapped.reason, /not the source this session prepared/);
    const artifact = refuse(descriptor({
        candidate: { source: sourceIdentity(root), artifact: join(dir, 'gone.apk'), sha256: 'x' },
    }));
    assert.match(artifact.reason, /candidate artifact is gone/);

    // The document fixture the session prepared has to still be the one on the
    // host: a probe that reads a different file measures a different scenario.
    const elsewhere = mkdtempSync(join(tmpdir(), 'muxr-probe-nofixture-'));
    const fixture = refuse(descriptor({ host: { cwd: elsewhere, relayPort: 1 } }));
    assert.match(fixture.reason, /document fixture/);

    // Whatever it reports, it reports as a development probe.
    for (const envelope of [missing, dead, fixture]) {
        assert.equal(envelope.partial, true);
        assert.equal(envelope.acceptance, false);
        assert.notEqual(envelope.outcome, 'pass');
    }
    // iOS is answered honestly rather than measured with Android's collectors.
    const ios = JSON.parse((() => {
        try {
            return execFileSync(process.execPath, [
                'perf/surfaceProbe.mjs', '--session', descriptor({ platform: 'ios' }), '--platform', 'ios', '--surface', 'document',
            ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
        } catch (error) { return error.stdout; }
    })());
    assert.equal(ios.outcome, 'inconclusive');
    assert.match(ios.reason, /iOS surface probe is not wired/);
});
