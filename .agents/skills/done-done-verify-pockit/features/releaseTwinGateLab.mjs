// The stable gate on a real release whose journey ran its x86_64 twin: the
// release's sealed APK, signer, manifest and native provenance from GitHub,
// checked against the twin built from its tag (checkReleaseApk.mjs), then
// the gate and the npm latest dry run against the receipts committed at HEAD.
// The released APK standing in as its own twin is refused. Publishes nothing.
//
// usage: TWIN_APK=<x86_64 apk built from the tag, its .json beside it> node releaseTwinGateLab.mjs <evidence dir> <version>
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [evidenceArg, version] = process.argv.slice(2);
const twin = process.env.TWIN_APK;
if (!evidenceArg || !version || !twin) throw new Error('usage: TWIN_APK=<apk> releaseTwinGateLab.mjs <evidence dir> <version>');
const evidence = resolve(evidenceArg);
mkdirSync(evidence, { recursive: true });
const lines = [];
const say = (line = '') => { lines.push(line); process.stdout.write(`${line}\n`); };
const node = (label, args) => {
    const step = spawnSync(process.execPath, args, { encoding: 'utf8' });
    say(`## ${label}`);
    say(`$ node ${args.join(' ').replaceAll(scratch, '<scratch>')}`);
    say(`exit ${step.status}: ${(step.stdout + step.stderr).trim().replaceAll(scratch, '<scratch>')}`);
    say();
    return step.status;
};

const scratch = mkdtempSync(join(tmpdir(), 'muxr-twin-gate-'));
try {
    const release = join(scratch, 'release');
    const gh = spawnSync('gh', ['release', 'download', `v${version}`, '--repo', 'umeranjum17/muxr', '--dir', release, '--pattern', '*.apk', '--pattern', '*.tgz',
        '--pattern', 'release-manifest.json', '--pattern', 'signer.txt', '--pattern', 'compiled-manifest.xml', '--pattern', 'native-provenance.json'], { encoding: 'utf8' });
    if (gh.status !== 0) throw new Error(gh.stderr);
    const manifest = JSON.parse(readFileSync(join(release, 'release-manifest.json'), 'utf8'));
    const named = (suffix) => manifest.artifacts.find((item) => item.name.endsWith(suffix)).name;
    say(`# the v${version} stable gate on its x86_64 twin`);
    say();
    const apkCheck = (label, apk, out) => node(label, ['scripts/release/presentation/checkReleaseApk.mjs', '--version', version, '--release', release, '--journey-apk', apk, '--repo', out]);
    const checked = apkCheck('static checks of the released APK against the twin', resolve(twin), join(scratch, 'twin'));
    say(readFileSync(join(scratch, 'twin', '.done-done-receipts', 'builds', `${version}.release-apk.json`), 'utf8').replaceAll(scratch, '<scratch>'));
    const self = join(scratch, 'self.apk');
    copyFileSync(join(release, named('.apk')), self);
    const build = JSON.parse(readFileSync(`${twin}.json`, 'utf8'));
    const digest = spawnSync('sha256sum', [self], { encoding: 'utf8' }).stdout.split(' ')[0];
    writeFileSync(`${self}.json`, JSON.stringify({ ...build, apkSha256: digest }));
    const refused = apkCheck('the released arm64 APK as its own twin', self, join(scratch, 'self'));
    const gate = node('the stable gate on the committed receipts', ['scripts/release/presentation/checkJourneyReceipt.mjs', '--tag', `v${version}`, '--commit', manifest.source.commit, '--receipts', 'HEAD']);
    const push = node('npm latest dry run, as a push', ['scripts/release/presentation/acceptStable.mjs', '--version', version, '--package', join(release, named('.tgz')), '--receipts', 'HEAD']);
    const wrong = [checked !== 0 && 'twin checks', refused === 0 && 'self twin', gate !== 0 && 'gate', push !== 0 && 'dry run'].filter(Boolean);
    say(`RESULT ${wrong.length ? `fail: ${wrong.join(', ')}` : 'pass: the released APK passes every check against its twin, a wrong twin is refused, and the gate accepts the twin receipt with its times informational'}`);
    writeFileSync(join(evidence, 'gate.log'), `${lines.join('\n')}\n`);
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version, apk: named('.apk') },
        start: `the v${version} GitHub release's sealed APK, signer, manifest and native provenance, its x86_64 twin built from the tag, and the receipts committed at HEAD`,
        steps: ['check the released APK against its twin', 'check the released APK as its own twin', 'run the stable gate on the committed receipts', 'run the npm latest dry run as a push'],
        result: wrong.length ? 'fail' : 'the released APK passes signature, manifest, native libraries, version, code and source checks; the arm64 APK as its own twin is refused; the gate accepts the twin receipt with its emulator times informational; a push leaves npm latest where it is',
    }, null, 2)}\n`);
    if (wrong.length) process.exitCode = 1;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
