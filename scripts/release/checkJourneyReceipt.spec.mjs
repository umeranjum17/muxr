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

const receipt = (head, tree, capture, journey) => ({
    schema: 2,
    repo: 'pockit',
    head,
    tree,
    claim: 'the phone attaches to the host and stays attached while the panes churn',
    result: 'pass',
    at: new Date().toISOString(),
    files: [{ path: capture.path, sha256: capture.sha256 }],
    runs: [{ run_id: 'run-1', journey, command: 'node scripts/diagnostics/application/checkPhoneAttach.mjs' }],
    judge: {
        route: 'claude-code',
        model: 'claude-haiku-5-5',
        independence: 'agent',
        verdicts: [{ path: capture.path, sha256: capture.sha256, verdict: 'pass' }],
    },
});

it('covers a release only while the receipt proves the code the release ships', () => {
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

        // The receipt lands with the release: a version bump and the receipt itself.
        mkdirSync(join(repo, '.done-done-receipts'), { recursive: true });
        writeFileSync(join(repo, '.done-done-receipts', `${head}.json`), `${JSON.stringify(receipt(head, tree, cited, 'phone-attach'), null, 2)}\n`);
        writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ version: '0.2.11' }, null, 2)}\n`);
        const release = commit(repo, 'bump the version and carry the receipt');
        const covered = checkJourneyReceipt({ repo, commit: release, receiptsRef: 'HEAD' });
        expect(covered.ok).toBe(true);
        expect(covered.path).toBe(`.done-done-receipts/${head}.json`);

        // A receipt about another journey proves nothing about the phone.
        writeFileSync(join(repo, '.done-done-receipts', `${head}.json`), `${JSON.stringify(receipt(head, tree, cited, 'fast'), null, 2)}\n`);
        const other = commit(repo, 'a receipt about another journey');
        const unrelated = checkJourneyReceipt({ repo, commit: other, receiptsRef: 'HEAD' });
        expect(unrelated.ok).toBe(false);
        expect(unrelated.reason).toContain('no capture run drove the phone-attach journey');

        // Product code that changed after the proof is not covered by it.
        writeFileSync(join(repo, '.done-done-receipts', `${head}.json`), `${JSON.stringify(receipt(head, tree, cited, 'phone-attach'), null, 2)}\n`);
        writeFileSync(join(repo, 'apps', 'host', 'src', 'main.ts'), 'export const host = 2;\n');
        const changed = commit(repo, 'a product change after the proof');
        const stale = checkJourneyReceipt({ repo, commit: changed, receiptsRef: 'HEAD' });
        expect(stale.ok).toBe(false);
        expect(stale.reason).toContain('the release changed apps/host/src/main.ts after it proved the code');
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
