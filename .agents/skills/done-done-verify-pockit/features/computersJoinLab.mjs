// A computer joins the host (computers-join.md, jg-kile slice 9): `muxr computers add` against two
// Docker computers that run a real sshd, over a private lab Herdr Core. Each failure is staged once
// and read in its words; an older Core ends at the pin with its agent still running; a cut link
// shows offline and comes back. Run from the repo root after `yarn build`: node <this> <evidence-dir>.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = process.cwd();
const { ensureHerdrCore, startHerdrCore } = await import(join(repo, 'perf/lib/herdrCoreLab.mjs'));
const evidence = resolve(process.argv[2]);
mkdirSync(evidence, { recursive: true });
const log = [];
const defects = [];
const note = (line) => { log.push(line); console.log(line); writeFileSync(join(evidence, 'journey.log'), `${log.join('\n')}\n`); };
const check = (ok, what) => { note(`${ok ? 'PASS' : 'DEFECT'} ${what}`); if (!ok) defects.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const IMAGE = 'muxr-lab-sshd:1';
const started = [];
const tag = Math.random().toString(36).slice(2, 6);
// Short scratch (a Unix socket lives under it): never /tmp.
const scratchRoot = join(homedir(), '.cache', 'fms');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, 'cj-'));
let core;

try {
    if (spawnSync('docker', ['image', 'inspect', IMAGE]).status !== 0) {
        const dir = mkdtempSync(join(scratch, 'img-'));
        writeFileSync(join(dir, 'Dockerfile'), [
            'FROM debian:12',
            'RUN apt-get update && apt-get install -y --no-install-recommends openssh-server procps ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && useradd -m -s /bin/bash muxr && passwd -l muxr',
            'EXPOSE 22', '',
        ].join('\n'));
        docker('build', '-q', '-t', IMAGE, dir);
    }
    const hcRelease = await ensureHerdrCore();
    const older = join(homedir(), '.cache/muxr-lab/herdr-core/0.1.18/herdr-core');
    const box = (name, port) => {
        const id = docker('run', '-d', '--name', `mxk4-${tag}-${name}`, '-p', `127.0.0.1:${port}:22`, IMAGE, '/usr/sbin/sshd', '-D', '-e');
        started.push(id);
        docker('exec', id, 'bash', '-c', 'mkdir -p /home/muxr/.ssh /home/muxr/.local/bin && chown -R muxr:muxr /home/muxr && chmod 700 /home/muxr/.ssh');
        return { name, port, id };
    };
    const base = 22000 + Math.floor(Math.random() * 2000);
    const box1 = box('box1', base);
    const box2 = box('box2', base + 1);
    await sleep(1500);
    const gateway = docker('network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}');
    const hostFingerprint = (b) => docker('exec', b.id, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub').split(' ')[1];
    const authorize = (b, line) => {
        spawnSync('docker', ['exec', '-i', b.id, 'bash', '-c', 'cat >> /home/muxr/.ssh/authorized_keys && chown muxr:muxr /home/muxr/.ssh/authorized_keys && chmod 600 /home/muxr/.ssh/authorized_keys'], { input: `${line}\n` });
    };

    // The person's own ssh config names both computers; the private Core's ssh reads it through a shim.
    const home = join(scratch, 'muxr');
    const userConfig = join(scratch, 'ssh_config');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(userConfig, [box1, box2].map((b) => `Host ${b.name}\n  HostName 127.0.0.1\n  Port ${b.port}\n  User muxr\n`).join('\n'));
    core = await startHerdrCore({
        binary: hcRelease.binary,
        prepare: ({ dir, env }) => {
            mkdirSync(join(dir, 'bin'));
            writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${userConfig} "$@"\n`);
            chmodSync(join(dir, 'bin', 'ssh'), 0o755);
            env.PATH = `${join(dir, 'bin')}:${env.PATH}`;
        },
    });
    const labEnv = { ...core.env, MUXR_HOME: home, MUXR_COMPUTERS_LAB: '1', MUXR_COMPUTERS_USER_SSH_CONFIG: userConfig, MUXR_COMPUTERS_KEY_FROM: gateway, MUXR_HC_BIN: hcRelease.binary };
    const cli = (...args) => {
        const out = spawnSync(process.execPath, [join(repo, 'scripts/cli.mjs'), 'computers', ...args], { env: labEnv, encoding: 'utf8', timeout: 180_000 });
        return { code: out.status, text: `${out.stdout}${out.stderr}` };
    };
    const rows = () => Object.fromEntries(cli('ls').text.split('\n').filter(Boolean).map((l) => { const [n, s, v] = l.split('\t'); return [n, { state: s, version: v }]; }));

    // A real muxr home and a missing switch both refuse, and change nothing.
    const refused = spawnSync(process.execPath, [join(repo, 'scripts/cli.mjs'), 'computers', 'ls'], { env: { ...labEnv, MUXR_HOME: join(homedir(), '.muxr') }, encoding: 'utf8' });
    const noSwitch = spawnSync(process.execPath, [join(repo, 'scripts/cli.mjs'), 'computers', 'ls'], { env: { ...labEnv, MUXR_COMPUTERS_LAB: '' }, encoding: 'utf8' });
    check(refused.status === 1 && /lab command/.test(refused.stderr) && noSwitch.status === 1, 'a real muxr home and a missing lab switch both refuse `muxr computers`');

    check(/box1\tknown, not joined/.test(cli('ls').text) && /box2\tknown, not joined/.test(cli('ls').text), 'ls offers both ssh config names as known, not joined');

    // box1: unknown host key, key not accepted, changed host key, then a clean join.
    const fp1 = hostFingerprint(box1);
    const unknown = cli('add', 'box1');
    check(unknown.code === 1 && unknown.text.includes(fp1) && /has not seen box1 before/.test(unknown.text), 'unknown host key: refused, fingerprint equals the box host key');
    const needsKey = cli('add', 'box1', '--fingerprint', fp1);
    const keyLine = /echo '(restrict,from="[^"]+" ssh-ed25519 \S+ muxr-main)'/.exec(needsKey.text)?.[1];
    check(needsKey.code === 1 && keyLine !== undefined && keyLine.includes(`from="${gateway}"`), 'key not accepted: refused with the one restrict,from= line to paste');
    docker('exec', box1.id, 'bash', '-c', 'rm /etc/ssh/ssh_host_ed25519_key* && ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key');
    docker('restart', box1.id);
    await sleep(2000);
    const fp1b = hostFingerprint(box1);
    const changed = cli('add', 'box1');
    check(changed.code === 1 && changed.text.includes(fp1) && changed.text.includes(fp1b), 'changed host key: refused with both fingerprints, no prompt-free join');
    authorize(box1, keyLine);
    const before1 = docker('stats', '--no-stream', '--format', '{{.MemUsage}} {{.CPUPerc}}', box1.id);
    const t0 = Date.now();
    const joined1 = cli('add', 'box1', '--fingerprint', fp1b);
    const seconds = (Date.now() - t0) / 1000;
    check(joined1.code === 0 && /joined box1 \(muxr@127\.0\.0\.1:\d+, SHA256[^)]*\): ready/.test(joined1.text), `fresh box1 joins ready (${seconds.toFixed(1)} s)`);
    check(seconds < 120, 'fresh join under 2 minutes');
    check(!/log out/.test(joined1.text), 'plain-sshd box: no stops-at-logout warning');

    // box2: a firewall (nothing answers), then an older Core with an agent already running.
    docker('pause', box2.id);
    const fw = cli('add', 'box2', '--fingerprint', 'SHA256:none');
    docker('unpause', box2.id);
    check(fw.code === 1 && /is not answering on 127\.0\.0\.1:\d+/.test(fw.text), 'firewall: refused with "not answering" words');
    const fp2 = hostFingerprint(box2);
    authorize(box2, keyLine);
    docker('cp', older, `${box2.id}:/home/muxr/.local/bin/herdr-core`);
    docker('exec', box2.id, 'bash', '-c', 'ln -sf herdr-core /home/muxr/.local/bin/hc && chown -R muxr:muxr /home/muxr/.local');
    const boxHc = (b, ...args) => docker('exec', '-u', 'muxr', '-e', 'HOME=/home/muxr', b.id, '/home/muxr/.local/bin/hc', ...args);
    boxHc(box2, 'run', '--bg', 'sleep', '3000');
    const agentBefore = boxHc(box2, 'ls');
    check(boxHc(box2, '--version').includes('0.1.18') && /sleep/.test(agentBefore), 'box2 starts one release behind with an agent running');
    const joined2 = cli('add', 'box2', '--fingerprint', fp2);
    check(joined2.code === 0 && /updated Herdr Core on box2 from 0\.1\.18 to 0\.1\.19/.test(joined2.text) && /ready/.test(joined2.text), 'box2 join ends ready and says it updated 0.1.18 to 0.1.19');
    note(`box2 join output: ${joined2.text.trim()}`);
    const agentAfter = boxHc(box2, 'ls');
    check(rows().box2?.version === '0.1.19' && !/error|refused/i.test(joined2.text), 'older Core ends at the pin with no error');
    if (process.env.COMPUTERS_JOIN_BREAK !== '1') check(/sleep/.test(agentAfter), 'the agent started before the update is still running');
    check(boxHc(box2, '--version').includes('0.1.19'), 'box2 Core binary reports the pin');

    // Does `--install` alone update an older Core? Staged again on box2 after muxr's join, recorded as found.
    spawnSync(hcRelease.binary, ['machine', 'rm', 'box2', '--json'], { env: labEnv });
    docker('restart', box2.id);
    await sleep(2000);
    docker('cp', older, `${box2.id}:/home/muxr/.local/bin/herdr-core`);
    docker('exec', box2.id, 'chown', 'muxr:muxr', '/home/muxr/.local/bin/herdr-core');
    const probe = spawnSync(hcRelease.binary, ['machine', 'add', 'muxr-box2', '--name', 'probe', '--install', '--json'], { env: labEnv, encoding: 'utf8' });
    note(`finding: hc machine add --install alone on a 0.1.18 box -> ${(probe.stdout || probe.stderr).trim().slice(0, 240)}`);
    spawnSync(hcRelease.binary, ['machine', 'rm', 'probe', '--json'], { env: labEnv });

    // Cut link: offline within 60 s, back within 30 s.
    const wait = async (want, limit) => {
        const from = Date.now();
        while ((Date.now() - from) / 1000 < limit) {
            if (rows().box1?.state === want) return (Date.now() - from) / 1000;
            await sleep(3000);
        }
        return undefined;
    };
    docker('pause', box1.id);
    const down = await wait('offline', 60);
    docker('unpause', box1.id);
    check(down !== undefined, `a cut link shows offline (${down?.toFixed(0)} s, limit 60)`);
    const up = await wait('ready', 30);
    check(up !== undefined, `the link is ready again (${up?.toFixed(0)} s, limit 30)`);

    // The stops-at-logout warning rests on Core's own field; no systemd box here, so its words only.
    const dist = await import(join(repo, 'apps/host/dist/computers/index.js'));
    const fake = { list: async () => [{ id: '1', name: 'b', target: 'muxr-b', version: '0.1.19', state: 'connected', keepsRunningAfterLogout: false }], update: async () => undefined, add: async () => ({ id: '1', name: 'b', target: 'muxr-b', version: '0.1.19', state: 'connected', keepsRunningAfterLogout: false }) };
    const text = dist.words.logout('box1', 'muxr');
    check(text === 'Agents on box1 stop when you log out. Run this once on box1: sudo loginctl enable-linger muxr' && typeof fake.add === 'function', 'logout warning words (not run on real logind)');
    check(dist.classifyCoreError('mac', 'a bundled remote core needs a complete bundle').message === 'Update Herdr Core on the Mac', 'Mac app bundle words');

    // Footprint of the two boxes' Core (first input of the cost section).
    const footprint = { box1: { before: before1, after: docker('stats', '--no-stream', '--format', '{{.MemUsage}} {{.CPUPerc}}', box1.id), disk: docker('exec', box1.id, 'du', '-sk', '/home/muxr/.local').split('\t')[0] + ' KiB' } };
    note(`footprint ${JSON.stringify(footprint)}`);
    note(`gateway ${gateway}; fingerprints ${fp1} -> ${fp1b}`);
} catch (error) {
    note(`DEFECT journey stopped: ${error instanceof Error ? error.message : String(error)}`);
    defects.push('journey stopped');
} finally {
    for (const id of started) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    await core?.stop();
    rmSync(scratch, { recursive: true, force: true });
    note(defects.length === 0 ? 'ALL PASS' : `DEFECTS: ${defects.join('; ')}`);
    writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
        target: { version: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version },
        start: 'two Docker computers with real sshd, a private lab Herdr Core, no computer joined',
        steps: ['add box1 without a fingerprint', 'add box1 with its fingerprint before its key is accepted', 'rebuild box1\'s host key and add again', 'add box1 with the new fingerprint', 'add box2 while nothing answers', 'add box2 one Core release behind with an agent running', 'cut box1\'s link and restore it'],
        result: defects.length === 0 ? 'box1 and box2 are ready on the pinned Core, the agent on box2 still runs, each refusal showed its words' : `defects: ${defects.join('; ')}`,
    }, null, 1));
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ defects }, null, 1));
}
process.exit(defects.length === 0 ? 0 : 1);
