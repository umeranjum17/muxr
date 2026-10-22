import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkJourneyReceipt } from './application/checkJourneyReceipt.mjs';

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

const commit = (repo, message) => {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
    return git(repo, ['rev-parse', 'HEAD']);
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const receipt = (head, tree, capture, journey, result) => ({
    schema: 2,
    repo: 'pockit',
    head,
    tree,
    claim: 'the phone attaches to the host and stays attached while the panes churn',
    result: 'pass',
    at: new Date().toISOString(),
    files: [{ path: capture.path, sha256: capture.sha256 }, ...(result ? [{ path: '<evidence root>/run-1/release-build.json', sha256: sha(result) }] : [])],
    runs: [{ run_id: 'run-1', journey, command: 'node scripts/diagnostics/application/checkPhoneAttach.mjs' }],
    judge: {
        route: 'claude-code',
        model: 'claude-haiku-5-5',
        independence: 'agent',
        verdicts: [{ path: capture.path, sha256: capture.sha256, verdict: 'pass' }],
    },
});

// What the emulator journey writes for the build it ran.
const journeyResult = (build) => `${JSON.stringify({
    schema: 1, journey: 'phone-attach', version: build.version, build: { apk: build.apk, package: build.package },
    result: 'pass', steps: { pair: 'pass', attach: 'pass', send: 'pass', scroll: 'pass', usage: 'pass', 'one-host': 'pass' },
    hosts: 1, timings: { attachMs: 3100, scrollMs: 2400 },
}, null, 2)}\n`;

it('covers a release only while the receipt proves the code and the exact build the release ships', () => {
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
        const land = (journey, result, message) => {
            mkdirSync(join(repo, '.done-done-receipts', 'builds'), { recursive: true });
            writeFileSync(join(repo, '.done-done-receipts', `${head}.json`), `${JSON.stringify(receipt(head, tree, cited, journey, result), null, 2)}\n`);
            if (result) writeFileSync(join(repo, '.done-done-receipts', 'builds', '0.2.11.json'), result);
            else rmSync(join(repo, '.done-done-receipts', 'builds'), { recursive: true, force: true });
            return commit(repo, message);
        };

        // The receipt lands with the release: a version bump, the receipt, and
        // nothing that says which build the journey ran. Promotion is refused.
        writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ version: '0.2.11' }, null, 2)}\n`);
        const bare = land('phone-attach', undefined, 'bump the version and carry the receipt');
        const unbuilt = checkJourneyReceipt({ repo, commit: bare, receiptsRef: 'HEAD', build });
        expect(unbuilt.ok).toBe(false);
        expect(unbuilt.reason).toContain('no journey result is committed at .done-done-receipts/builds/0.2.11.json');

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
