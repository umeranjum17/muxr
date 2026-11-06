// `muxr triage` against deliberately broken private homes: the real CLI, before, with --fix and
// after. Never reaches a real service or Herdr: PATH holds only stand-ins, HOME and MUXR_HOME are
// disposable, and Herdr is a stub. Writes one <scene>.txt per scene plus gate.log and steps.json.
//   node .agents/skills/done-done-verify-pockit/features/triageLab.mjs <evidenceDir>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [evidence] = process.argv.slice(2);
mkdirSync(evidence, { recursive: true });
mkdirSync(join(homedir(), '.cache', 'fms'), { recursive: true });
const root = mkdtempSync(join(homedir(), '.cache', 'fms', 'tri.'));
const log = (line) => { console.log(line); appendFileSync(join(evidence, 'gate.log'), `${line}\n`); };
const stub = (path, body) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;

function scene(name, { herdr = true } = {}) {
    const home = join(root, name, 'umer');
    const state = join(home, '.muxr');
    const bin = join(root, name, 'bin');
    mkdirSync(join(state, 'relay'), { recursive: true, mode: 0o700 });
    mkdirSync(bin);
    // A stopped user service, answered by a stand-in: the real manager is not on PATH.
    stub(join(bin, 'systemctl'), 'exit 3');
    const env = { HOME: home, MUXR_HOME: state, PATH: bin, MUXR_TEST_FAKE_SERVICE_MANAGERS: '1', MUXR_PLATFORM: 'linux' };
    if (herdr) {
        env.HERDR_BIN = join(bin, 'herdr');
        stub(env.HERDR_BIN, `case "$1" in
--version) echo 'herdr 0.9.1';;
status) echo '{"running":true}';;
plugin) echo '{"plugins":[]}';;
esac`);
    }
    const run = (...args) => {
        const result = spawnSync(process.execPath, ['scripts/cli.mjs', ...args], { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = `${result.stdout}${result.stderr}`.replaceAll(root, '/lab');
        appendFileSync(join(evidence, `${name}.txt`), `$ muxr ${args.join(' ')}\n${output}\n[exit ${result.status}]\n\n`);
        return { status: result.status, output };
    };
    return { state, env, run };
}

const selfhost = (state, port) => {
    const path = join(state, 'selfhost.json');
    writeFileSync(path, `${JSON.stringify({ version: 1, relayPort: port, machine: { id: 'umer-desk' } })}\n`);
    chmodSync(path, 0o600);
    return path;
};

const stranger = createServer((_, response) => response.end('<h1>Umer\'s other web app</h1>'));
await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
const port = stranger.address().port;
try {
    // Fixable: three things that are ours and local.
    {
        const { state, run } = scene('fixable');
        const path = selfhost(state, port);
        chmodSync(path, 0o644);
        writeFileSync(join(state, 'selfhost-rotation.lock'), `${JSON.stringify({ pid: exitedPid })}\n`);
        writeFileSync(join(state, 'relay', 'relay.pid'), `${exitedPid}\n`);
        const before = run('triage');
        assert.match(before.output, /open to other users/);
        assert.match(before.output, /3 fixable.*Run: muxr triage --fix/);
        assert.equal(statSync(path).mode & 0o777, 0o644, 'triage alone changed a file');
        const fix = run('triage', '--fix');
        assert.match(fix.output, /fixed\s+set selfhost\.json to owner-only/);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(existsSync(join(state, 'selfhost-rotation.lock')), false);
        assert.equal(existsSync(join(state, 'relay', 'relay.pid')), false);
        assert.doesNotMatch(run('triage').output, /open to other users|left by process|Run: muxr triage --fix/);
        log('fixable: lock, pid file and state file repaired by --fix; nothing changed without it');
    }
    // A brand-new computer with no state folder at all.
    {
        const { state, run } = scene('missing-folder');
        rmSync(state, { recursive: true });
        assert.match(run('triage').output, /is missing — run `muxr triage --fix`/);
        run('triage', '--fix');
        assert.equal(statSync(state).mode & 0o777, 0o700);
        assert.match(run('triage').output, /state folder\s+\S+ is writable/);
        log('missing-folder: created owner-only by --fix');
    }
    // Report only: every problem here needs the user, so --fix must change nothing.
    {
        const { state, run } = scene('report-only', { herdr: false });
        const path = selfhost(state, port);
        const bytes = readFileSync(path);
        mkdirSync(join(state, 'host'));
        writeFileSync(join(state, 'host', 'diagnostics.json'), JSON.stringify({ current: { hostVersion: '99.0.0' } }));
        writeFileSync(join(state, 'selfhost-rotation.lock'), `${JSON.stringify({ pid: process.pid })}\n`);
        chmodSync(state, 0o500);
        try {
            const before = run('triage');
            assert.match(before.output, /this CLI is older than the host; run `muxr update`/);
            assert.match(before.output, /herdr\s+missing/);
            assert.match(before.output, /is not writable — run `chmod u\+rwx/);
            assert.match(before.output, new RegExp(`port ${port} is taken by another program`));
            assert.match(before.output, /host service\s+not running — start it with `muxr daemon start`/);
            const fix = run('triage', '--fix');
            assert.equal(fix.status, 1);
            assert.doesNotMatch(fix.output, /fixed/);
        } finally { chmodSync(state, 0o700); }
        assert.equal(readFileSync(path).equals(bytes), true);
        assert.equal(existsSync(join(state, 'selfhost-rotation.lock')), true, 'a live process lost its lock');
        assert.equal(stranger.listening, true);
        log('report-only: port, version, Herdr, folder and service reported; --fix changed nothing');
    }
    // Wrong socket, and a probe that throws: the rest of the list still prints.
    {
        const { state, env, run } = scene('fail-soft');
        env.HERDR_SOCKET_PATH = join(state, 'gone.sock');
        stub(env.HERDR_BIN, `case "$1" in --version) echo 'herdr 0.9.1';; *) exit 1;; esac`);
        writeFileSync(join(state, 'setup-manifest.json'), JSON.stringify({ version: 1, entries: { [state]: { kind: 'owned', hash: '' } }, herdrInstalled: [] }));
        selfhost(state, port);
        const report = run('triage');
        assert.match(report.output, /gone\.sock is not a Herdr socket/);
        assert.match(report.output, /services\s+could not be checked/);
        assert.match(report.output, /is taken by another program/);
        log('fail-soft: a throwing probe cost one line; the checks after it still ran');
    }
    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: `the muxr CLI built from ${spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()} on private homes` },
        start: 'four deliberately broken private homes for Umer, with stand-ins for Herdr and the service manager and a stranger holding the relay port',
        steps: ['Run muxr triage on each home: one line per check with the next action, nothing changed', 'Run muxr triage --fix: the stale lock, pid file, open state file and missing folder are repaired', 'Run muxr triage again: the repaired lines are gone', 'On the report-only home, --fix changes nothing: the taken port, older CLI, missing Herdr, unwritable folder and stopped host service stay printed', 'On the fail-soft home, a probe that throws costs one line and the wrong Herdr socket is named'],
        result: 'muxr triage names what is broken and the exact next action, and --fix repairs only what is local and reversible: fixable.txt and missing-folder.txt show before and after, report-only.txt shows a setup it can only report on, fail-soft.txt shows the other checks surviving a failed probe',
    }, null, 2)}\n`);
    log('triage lab passed');
} finally {
    await new Promise((resolve) => stranger.close(resolve));
    rmSync(root, { recursive: true, force: true });
}
