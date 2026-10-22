// The npm latest gate on a real stable release, driven the way release.yml
// drives it: the `accepted` step's own command and environment from the
// workflow file, the release's real sealed manifest and npm tarball from
// GitHub, and receipts read from git. Nothing is published: the gate never
// publishes, and the lab only reports whether the publish step would run.
//
// The captain's phone-test receipt for that build is not committed yet, so a
// scratch clone carries a stand-in: a receipt in the shape done-done writes,
// citing a journey result whose digests are the release's own. The live
// origin/main, which has no such receipt, is checked too.
//
// usage: node releaseLatestGateLab.mjs <evidence dir> [version, default the newest stable GitHub release]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const REPOSITORY = 'umeranjum17/muxr';
const repo = process.cwd();
const evidence = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: releaseLatestGateLab.mjs <evidence dir> [version]');
mkdirSync(evidence, { recursive: true });
const lines = [];
const say = (line = '') => { lines.push(line); process.stdout.write(`${line}\n`); };
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...options }).trim();

const workflow = yaml.load(readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8'));
const steps = workflow.jobs.publish.steps;
const accepted = steps.find((step) => step.id === 'accepted');
const publish = steps.find((step) => step.name === 'Publish with provenance');
const inputs = workflow.on.workflow_dispatch.inputs;

const version = process.argv[3] ?? JSON.parse(run('gh', ['release', 'list', '--repo', REPOSITORY, '--exclude-pre-releases', '--limit', '1', '--json', 'tagName']))[0].tagName.slice(1);
const tag = `v${version}`;
const scratch = mkdtempSync(join(tmpdir(), 'muxr-latest-gate-'));
try {
    say(`# npm latest gate on ${tag}, as release.yml runs it`);
    say();
    say(`release.yml workflow_dispatch inputs: ${Object.keys(inputs).join(', ')}`);
    say(`accepted step CAPTAIN_TESTED: ${accepted.env.CAPTAIN_TESTED}`);
    say(`accepted step run: ${accepted.run.trim()}`);
    say(`publish step if: ${publish.if}`);
    say();

    // The release's real assets: the tarball the journey tests and npm would get.
    const runnerTemp = join(scratch, 'runner');
    mkdirSync(join(runnerTemp, 'package'), { recursive: true });
    run('gh', ['release', 'download', tag, '--repo', REPOSITORY, '--pattern', '*.tgz', '--pattern', 'release-manifest.json', '--dir', join(scratch, 'assets')]);
    const manifest = JSON.parse(readFileSync(join(scratch, 'assets', 'release-manifest.json'), 'utf8'));
    const tarball = manifest.artifacts.find((item) => item.name.endsWith('.tgz'));
    const apk = manifest.artifacts.find((item) => item.name.endsWith('.apk'));
    run('cp', [join(scratch, 'assets', tarball.name), join(runnerTemp, 'package', tarball.name)]);
    const taggedCommit = run('git', ['rev-parse', `${tag}^{commit}`], { cwd: repo });
    say(`${tag}: commit ${taggedCommit.slice(0, 12)}, manifest sealed from ${manifest.source.commit.slice(0, 12)}, tarball ${tarball.name} sha256 ${tarball.sha256.slice(0, 12)}, apk sha256 ${apk?.sha256.slice(0, 12)}`);

    // A scratch clone with the stand-in receipt committed on top of the tag.
    const clone = join(scratch, 'clone');
    run('git', ['clone', '-q', '--shared', '--no-checkout', repo, clone]);
    run('git', ['checkout', '-q', '--detach', taggedCommit], { cwd: clone });
    const tree = run('git', ['rev-parse', `${taggedCommit}^{tree}`], { cwd: clone });
    const result = `${JSON.stringify({
        schema: 1, journey: 'phone-attach', version, build: { apk: apk?.sha256, package: tarball.sha256 }, result: 'pass',
        steps: { pair: 'pass', attach: 'pass', send: 'pass', scroll: 'pass', usage: 'pass', 'one-host': 'pass' }, hosts: 1, timings: { attachMs: 9700, scrollMs: 3700 },
    }, null, 2)}\n`;
    const capture = { path: '<evidence root>/run-1/attached.png', sha256: createHash('sha256').update('stand-in capture').digest('hex') };
    const receipt = {
        schema: 2, repo: 'pockit', head: taggedCommit, tree, claim: 'stand-in for the captain phone-test receipt', result: 'pass', at: new Date().toISOString(),
        files: [capture, { path: '<evidence root>/run-1/release-build.json', sha256: createHash('sha256').update(result).digest('hex') }],
        runs: [{ run_id: 'run-1', journey: 'phone-attach' }],
        judge: { route: 'lab', model: 'lab', independence: 'agent', verdicts: [{ ...capture, verdict: 'pass' }] },
    };
    mkdirSync(join(clone, '.done-done-receipts', 'builds'), { recursive: true });
    writeFileSync(join(clone, '.done-done-receipts', `${taggedCommit}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(join(clone, '.done-done-receipts', 'builds', `${version}.json`), result);
    run('git', ['add', '-A'], { cwd: clone });
    run('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.test', 'commit', '-q', '-m', 'stand-in release journey receipt'], { cwd: clone });
    const withReceipt = run('git', ['rev-parse', 'HEAD'], { cwd: clone });

    // One run of the accepted step: its own command, CAPTAIN_TESTED as the
    // workflow expression yields it for this event, then the publish step's if.
    const gate = ({ label, event, captainTested, testedVersion, receipts, cwd }) => {
        const captain = event === 'workflow_dispatch' && captainTested && testedVersion ? testedVersion : '';
        const output = join(scratch, `${label.replace(/\W+/g, '-')}.out`);
        writeFileSync(output, '');
        const command = accepted.run.trim().replace('scripts/release/', `${repo}/scripts/release/`) + (receipts ? ` --receipts ${receipts}` : '');
        const step = spawnSync('bash', ['-c', command], {
            cwd, encoding: 'utf8',
            env: { ...process.env, RELEASE_VERSION: version, RUNNER_TEMP: runnerTemp, CAPTAIN_TESTED: captain, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' },
        });
        const ok = readFileSync(output, 'utf8').includes('accepted=true');
        const publishes = ok; // publish step if, stable and needed: steps.accepted.outputs.accepted == 'true'
        say();
        say(`## ${label}`);
        say(`event=${event} captain_tested=${captainTested} version=${testedVersion || '(none)'} receipts=${receipts ?? 'origin/main'}; CAPTAIN_TESTED='${captain}'`);
        say(`gate (exit ${step.status}): ${(step.stdout + step.stderr).trim()}`);
        say(`GITHUB_OUTPUT: accepted=${ok}`);
        say(`publish step: ${publishes ? `RUNS: npm publish ${tarball.name} --tag latest --provenance` : 'SKIPPED: nothing is published, npm latest stays where it is'}`);
        return publishes;
    };

    const outcomes = {
        'push to main, receipt committed': gate({ label: 'push to main, receipt committed', event: 'push', captainTested: false, testedVersion: '', receipts: withReceipt, cwd: clone }),
        'hand run, captain_tested and version, receipt committed': gate({ label: 'hand run, captain_tested and version, receipt committed', event: 'workflow_dispatch', captainTested: true, testedVersion: version, receipts: withReceipt, cwd: clone }),
        'hand run, captain_tested unchecked, receipt committed': gate({ label: 'hand run, captain_tested unchecked, receipt committed', event: 'workflow_dispatch', captainTested: false, testedVersion: version, receipts: withReceipt, cwd: clone }),
        'hand run naming another version, receipt committed': gate({ label: 'hand run naming another version, receipt committed', event: 'workflow_dispatch', captainTested: true, testedVersion: '0.0.1', receipts: withReceipt, cwd: clone }),
        'hand run, captain_tested and version, no receipt': gate({ label: 'hand run, captain_tested and version, no receipt', event: 'workflow_dispatch', captainTested: true, testedVersion: version, receipts: taggedCommit, cwd: clone }),
        'hand run, captain_tested and version, live origin/main': gate({ label: 'hand run, captain_tested and version, live origin/main', event: 'workflow_dispatch', captainTested: true, testedVersion: version, cwd: repo }),
    };
    const expected = { 'hand run, captain_tested and version, receipt committed': true };
    const wrong = Object.entries(outcomes).filter(([label, publishes]) => publishes !== (expected[label] ?? false));
    say();
    say(`RESULT ${wrong.length ? `fail: ${wrong.map(([label]) => label).join('; ')}` : 'pass: only the hand run with captain_tested, the version and the receipt publishes'}`);
    writeFileSync(join(evidence, 'gate.log'), `${lines.join('\n')}\n`);
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version, tag, tarball: tarball.name, sha256: tarball.sha256 },
        start: `release.yml as committed, the ${tag} GitHub release's manifest and npm tarball, a scratch clone carrying a stand-in journey receipt for that exact build`,
        steps: Object.keys(outcomes),
        result: wrong.length ? 'fail' : 'only the hand run naming the captain-tested version, with the receipt, would publish to npm latest',
    }, null, 2)}\n`);
    if (wrong.length) process.exitCode = 1;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
