// Herdr Core installer and doctor check (plan slice 4, jg-kile-s4), in a scratch MUXR_HOME.
// A fresh home ends with the pinned core; a changed archive is refused with its cause and leaves
// nothing behind; a Mac and an older core are named plainly in the doctor. Needs the network for
// the real release, and `yarn build` for the doctor. Writes gate.log, one text capture per step
// and steps.json.
//   node .agents/skills/done-done-verify-pockit/features/herdrCoreInstall.mjs <evidenceDir>
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [evidence] = process.argv.slice(2);
if (!evidence) throw new Error('usage: herdrCoreInstall.mjs <evidenceDir>');
const repo = process.cwd();
mkdirSync(evidence, { recursive: true });
const gate = join(evidence, 'gate.log');
const capture = (name, lines) => writeFileSync(join(evidence, name), `${lines.join('\n')}\n`);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok }); appendFileSync(gate, `${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}\n`); };

const home = mkdtempSync(join(tmpdir(), 'hci-'));
process.env.MUXR_HOME = join(home, 'muxr');
const core = await import(pathToFileURL(join(repo, 'scripts/setup/infrastructure/herdrCore.mjs')).href);
const doctor = (extra = {}) => spawnSync('node', ['scripts/diagnostics/presentation/doctor.mjs'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, MUXR_HERDR_CORE_CHECK: '1', NO_COLOR: '1', ...extra },
}).stdout.split('\n').filter((line) => /herdr core/i.test(line)).join('\n').trim();
let server;
try {
    // 1. Fresh scratch home: the core is missing, and the doctor says so.
    const before = core.herdrCoreStatus();
    const doctorMissing = doctor();
    capture('01-fresh-home.txt', [`MUXR_HOME=${process.env.MUXR_HOME} (scratch, empty)`, `status: ${JSON.stringify(before)}`, `doctor: ${doctorMissing}`]);
    check('fresh home has no core', before.state === 'missing' && /missing/.test(doctorMissing), doctorMissing);

    // 2. A changed archive, served beside the genuine manifest, is refused and installs nothing.
    const real = `https://releases.herdr.dev/core/${core.HERDR_CORE_PIN.version}`;
    const manifest = Buffer.from(await (await fetch(`${real}/manifest.json`)).arrayBuffer());
    const tamper = mkdtempSync(join(tmpdir(), 'hct-'));
    writeFileSync(join(tamper, 'herdr-core'), '#!/bin/sh\necho hc 0.1.19\n');
    chmodSync(join(tamper, 'herdr-core'), 0o755);
    execFileSync('tar', ['-czf', join(tamper, 'a.tgz'), '-C', tamper, 'herdr-core']);
    const bad = execFileSync('cat', [join(tamper, 'a.tgz')]);
    server = createServer((req, res) => {
        res.end(req.url.endsWith('manifest.json') ? manifest : bad);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const mirror = `http://127.0.0.1:${server.address().port}`;
    // The mirror serves /<version>/..., so any path under it answers.
    let refusal = '';
    try { await core.installHerdrCore({ baseUrl: mirror }); } catch (cause) { refusal = cause.message; }
    const leftovers = existsSync(join(process.env.MUXR_HOME, 'herdr-core')) ? readdirSync(join(process.env.MUXR_HOME, 'herdr-core')) : [];
    capture('02-changed-archive.txt', [`mirror ${mirror} serves the genuine manifest and a different archive`, `refusal: ${refusal}`, `left in herdr-core/: ${JSON.stringify(leftovers)}`, `status: ${JSON.stringify(core.herdrCoreStatus())}`]);
    check('changed archive refused', /refused: its SHA-256 is/.test(refusal) && leftovers.length === 0 && core.herdrCoreStatus().state === 'missing', refusal);
    rmSync(tamper, { recursive: true, force: true });

    // 3. The real release installs; the doctor then says ok; a second call reuses it.
    const first = await core.installHerdrCore();
    const second = await core.installHerdrCore();
    const reported = execFileSync(first.binary, ['--version'], { encoding: 'utf8' }).trim();
    const doctorOk = doctor();
    capture('03-real-install.txt', [JSON.stringify(first), `reported: ${reported}`, `second call reused: ${second.reused}`, `doctor: ${doctorOk}`]);
    check('fresh home gets the pinned build', reported === `hc ${core.HERDR_CORE_PIN.version}` && !first.reused && second.reused && /Herdr Core 0\.1\.19/.test(doctorOk), `${reported}; doctor: ${doctorOk}`);

    // 4. An older core is "too old"; a Mac is refused with the reason.
    writeFileSync(first.binary, '#!/bin/sh\necho hc 0.1.18\n');
    const doctorOld = doctor();
    process.env.MUXR_PLATFORM = 'darwin';
    let mac = '';
    try { await core.installHerdrCore(); } catch (cause) { mac = cause.message; }
    capture('04-old-and-mac.txt', [`doctor with hc 0.1.18: ${doctorOld}`, `status: ${JSON.stringify(core.herdrCoreStatus())}`, `MUXR_PLATFORM=darwin install: ${mac}`]);
    check('old core is too old', /too old/.test(doctorOld), doctorOld);
    check('platform scope recorded', process.arch === 'x64' || process.arch === 'arm64' ? /Linux only/.test(mac) : true, mac);
} finally {
    server?.close();
    rmSync(home, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok);
const ok = checks.length === 5 && failed.length === 0;
writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
    target: { version: `muxr's Herdr Core installer at ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}, pinning Herdr Core ${core.HERDR_CORE_PIN.version}` },
    start: 'a scratch MUXR_HOME with no Herdr Core in it',
    steps: [
        'Read the status and the doctor row in the fresh home',
        'Offer an archive that differs from the release, beside the genuine manifest, and try to install it',
        'Install the real pinned release, run it, install again, and read the doctor row',
        'Swap in a core that reports 0.1.18 and read the doctor row; try the install as a Mac',
    ],
    result: `gate.log lists ${checks.filter((c) => c.ok).length} of ${checks.length} checks passing: the fresh home gets hc ${core.HERDR_CORE_PIN.version}, the changed archive is refused with its SHA-256 and installs nothing, the doctor says missing, ok and too old, and a Mac is refused with the reason; ${ok ? 'pass' : 'fail'}`,
}, null, 2)}\n`);
console.log(failed.length === 0 ? `herdr-core-install ok (${checks.length} checks)` : `herdr-core-install FAILED: ${failed.map((c) => c.name).join(', ')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
