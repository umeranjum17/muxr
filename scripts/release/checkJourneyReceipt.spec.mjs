import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acceptStable } from './application/acceptStable.mjs';
import { checkJourneyReceipt } from './application/checkJourneyReceipt.mjs';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

const commit = (repo, message) => {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
    return git(repo, ['rev-parse', 'HEAD']);
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const receipt = (head, tree, capture, journey, records) => ({
    schema: 2,
    repo: 'pockit',
    head,
    tree,
    claim: 'the phone attaches to the host and stays attached while the panes churn',
    result: 'pass',
    at: new Date().toISOString(),
    files: [{ path: capture.path, sha256: capture.sha256 }, ...records.map((record, index) => ({ path: `<evidence root>/run-1/record-${index}.json`, sha256: sha(record) }))],
    runs: [{ run_id: 'run-1', journey, command: 'node scripts/diagnostics/application/checkPhoneAttach.mjs' }],
    judge: {
        route: 'claude-code',
        model: 'claude-haiku-5-5',
        independence: 'agent',
        verdicts: [{ path: capture.path, sha256: capture.sha256, verdict: 'pass' }],
    },
});

// What the emulator journey writes for the build it ran.
const journeyResult = (build, timings = { attachMs: 3100, scrollMs: 2400 }) => `${JSON.stringify({
    schema: 1, journey: 'phone-attach', version: build.version, build: { apk: build.apk, package: build.package },
    result: 'pass', steps: { pair: 'pass', attach: 'pass', send: 'pass', scroll: 'pass', usage: 'pass', 'one-host': 'pass' },
    hosts: 1, timings,
}, null, 2)}\n`;

it('covers a release, and publishes it as npm latest once the captain names it, only while the receipt proves the code and the exact build the release ships', () => {
    const repo = mkdtempSync(join(tmpdir(), 'muxr-release-receipt-'));
    try {
        git(repo, ['init', '-q', '-b', 'main']);
        git(repo, ['config', 'user.email', 'gate@example.test']);
        git(repo, ['config', 'user.name', 'gate']);
        mkdirSync(join(repo, 'apps', 'host', 'src'), { recursive: true });
        mkdirSync(join(repo, 'evidence'), { recursive: true });
        writeFileSync(join(repo, 'apps', 'host', 'src', 'main.ts'), 'export const host = 1;\n');
        const capture = Buffer.from('a phone capture of an attached agent');
        writeFileSync(join(repo, 'evidence', 'phone-attach.mp4'), capture);
        const head = commit(repo, 'the code the release ships');
        const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
        const cited = { path: 'evidence/phone-attach.mp4', sha256: createHash('sha256').update(capture).digest('hex') };

        const build = { version: '0.2.11', apk: sha('the release apk'), package: sha('the release tarball') };
        // What the v0.2.11 GitHub release sealed, and the gate before it is published as npm latest.
        const manifest = (source) => ({ release: { channel: 'stable', version: '0.2.11' }, source: { commit: source },
            artifacts: [{ name: 'muxr-0.2.11-60.apk', sha256: build.apk }, { name: 'trymuxr-cli-0.2.11.tgz', sha256: build.package }] });
        const publishable = (source, tarballSha256, captainTested = '0.2.11') => acceptStable({ version: '0.2.11', manifest: manifest(source), taggedCommit: source, tarballSha256, captainTested, repo, receiptsRef: 'HEAD' });
        // The receipt cites the journey result; the x86_64 twin's APK check lands beside it.
        const land = (journey, result, message, apkCheck) => {
            rmSync(join(repo, '.done-done-receipts', 'builds'), { recursive: true, force: true });
            mkdirSync(join(repo, '.done-done-receipts', 'builds'), { recursive: true });
            const records = [result].filter(Boolean);
            writeFileSync(join(repo, '.done-done-receipts', `${head}.json`), `${JSON.stringify(receipt(head, tree, cited, journey, records), null, 2)}\n`);
            if (result) writeFileSync(join(repo, '.done-done-receipts', 'builds', '0.2.11.json'), result);
            if (apkCheck) writeFileSync(join(repo, '.done-done-receipts', 'builds', '0.2.11.release-apk.json'), apkCheck);
            return commit(repo, message);
        };

        // The receipt lands with the release: a version bump, the receipt, and
        // nothing that says which build the journey ran. Promotion is refused.
        writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ version: '0.2.11' }, null, 2)}\n`);
        const bare = land('phone-attach', undefined, 'bump the version and carry the receipt');
        const unbuilt = checkJourneyReceipt({ repo, commit: bare, receiptsRef: 'HEAD', build });
        expect(unbuilt.ok).toBe(false);
        expect(unbuilt.reason).toContain('no journey result is committed at .done-done-receipts/builds/0.2.11.json');
        expect(publishable(bare, build.package).ok).toBe(false);

        // A journey that ran another APK proves nothing about this one.
        const otherApk = land('phone-attach', journeyResult({ ...build, apk: sha('a local debug apk') }), 'a result for another apk');
        const elsewhere = checkJourneyReceipt({ repo, commit: otherApk, receiptsRef: 'HEAD', build });
        expect(elsewhere.ok).toBe(false);
        expect(elsewhere.reason).toContain(`it ran apk ${sha('a local debug apk').slice(0, 12)}, not this release's ${build.apk.slice(0, 12)}`);

        // The journey on this exact build, cited by the receipt: promotion is allowed.
        const release = land('phone-attach', journeyResult(build), 'the journey result for this build');
        const covered = checkJourneyReceipt({ repo, commit: release, receiptsRef: 'HEAD', build });
        expect(covered.reason).toBeUndefined();
        expect(covered.path).toBe(`.done-done-receipts/${head}.json`);
        expect(publishable(release, build.package)).toEqual({ ok: true, proof: `.done-done-receipts/${head}.json` });
        // A push names no captain-tested version: the receipt alone never makes it latest.
        expect(publishable(release, build.package, '').reason).toContain('only from a release.yml run started by hand with captain_tested');
        // A tarball packed again after the tag is not the build the journey ran: it is not published.
        expect(publishable(release, sha('a tarball packed after the tag')).reason).toContain('is not the v0.2.11 tarball the journey tests');

        // The arm64-only stable APK cannot run on an x86_64 emulator, so the
        // journey may run an x86_64 APK built from the tagged commit, standing
        // for the release only through a cited check of the released APK.
        const twinApk = sha('the x86_64 apk built from the tagged commit');
        const twin = { ...build, apk: twinApk };
        const apkCheck = ({ checks = {}, commit: built = head } = {}) => `${JSON.stringify({
            schema: 1, version: '0.2.11',
            releaseApk: { name: 'muxr-0.2.11-60.apk', sha256: build.apk, checks: { signature: 'pass', manifest: 'pass', nativeLibs: 'pass', version: 'pass', code: 'pass', source: 'pass', ...checks } },
            journeyApk: { name: 'app-release.apk', sha256: twinApk, abi: 'x86_64', commit: built },
        }, null, 2)}\n`;
        const tagged = { ...build, commit: head };
        const twinFault = (record) => checkJourneyReceipt({ repo, commit: head, receiptsRef: land('phone-attach', journeyResult(twin), 'the twin journey', record), build: tagged }).reason;
        expect(twinFault(undefined)).toContain(`it ran apk ${twinApk.slice(0, 12)}, not this release's ${build.apk.slice(0, 12)}`);
        expect(twinFault(apkCheck({ checks: { code: 'fail' } }))).toContain('the released apk did not pass code');
        expect(twinFault(apkCheck({ checks: { signature: 'fail' } }))).toContain('the released apk did not pass signature');
        expect(twinFault(apkCheck({ commit: sha('another commit').slice(0, 40) }))).toContain('its journey apk was built from');
        expect(twinFault(apkCheck())).toBeUndefined();
        // The tag points at the proved commit: the twin's receipt makes it publishable, still only on the captain's word.
        const accept = (captainTested) => acceptStable({ version: '0.2.11', manifest: manifest(head), taggedCommit: head, tarballSha256: build.package, captainTested, repo, receiptsRef: 'HEAD' });
        expect(accept('0.2.11')).toEqual({ ok: true, proof: `.done-done-receipts/${head}.json` });
        expect(accept('').reason).toContain('only from a release.yml run started by hand with captain_tested');
        // An emulator under load is slow: the twin's times are reported, labelled, and never refuse it.
        const loaded = { attachMs: 37542, scrollMs: 14742 };
        const slowTwin = checkJourneyReceipt({ repo, commit: head, receiptsRef: land('phone-attach', journeyResult(twin, loaded), 'a slow twin journey', apkCheck()), build: tagged });
        expect(slowTwin.reason).toBeUndefined();
        expect(slowTwin.timings).toEqual({ basis: 'emulator-under-load, informational', ...loaded });
        // The same times on the release's own APK, a phone run, are over budget: refused.
        const slowPhone = checkJourneyReceipt({ repo, commit: head, receiptsRef: land('phone-attach', journeyResult(build, loaded), 'a slow phone journey'), build: tagged });
        expect(slowPhone.reason).toContain('its attachMs of 37542 is over the 23000 budget');
        land('phone-attach', journeyResult(build), 'the exact-build journey again');

        // The same receipt does not cover a rebuilt tarball under the same version.
        const rebuilt = checkJourneyReceipt({ repo, commit: release, receiptsRef: 'HEAD', build: { ...build, package: sha('a rebuilt tarball') } });
        expect(rebuilt.ok).toBe(false);
        expect(rebuilt.reason).toContain('it ran package');

        // A receipt about another journey proves nothing about the phone.
        const other = land('fast', journeyResult(build), 'a receipt about another journey');
        const unrelated = checkJourneyReceipt({ repo, commit: other, receiptsRef: 'HEAD', build });
        expect(unrelated.ok).toBe(false);
        expect(unrelated.reason).toContain('no capture run drove the phone-attach journey');

        // Product code that changed after the proof is not covered by it.
        land('phone-attach', journeyResult(build), 'the journey receipt again');
        writeFileSync(join(repo, 'apps', 'host', 'src', 'main.ts'), 'export const host = 2;\n');
        const changed = commit(repo, 'a product change after the proof');
        const stale = checkJourneyReceipt({ repo, commit: changed, receiptsRef: 'HEAD', build });
        expect(stale.ok).toBe(false);
        expect(stale.reason).toContain('the release changed apps/host/src/main.ts after it proved the code');
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
