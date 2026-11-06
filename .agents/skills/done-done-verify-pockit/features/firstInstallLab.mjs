// The wait a new user sits through first: a cold `npm install -g` of the CLI, the published
// release against this candidate, alternating rounds so load and network hit both alike. Then the
// installed candidate runs: setup's inspection, and its real relay publishing itself on the LAN,
// the one path that loads bonjour-service at run time. HOME, prefix and npm cache are private, and
// PATH holds only stand-ins for the CLI, so no real service or Herdr can be reached.
//   node .agents/skills/done-done-verify-pockit/features/firstInstallLab.mjs <evidenceDir>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitForRelay } from '../../../../scripts/diagnostics/index.mjs';

const ROUNDS = 2;
const [evidence] = process.argv.slice(2);
mkdirSync(evidence, { recursive: true });
mkdirSync(join(homedir(), '.cache', 'fms'), { recursive: true });
const root = mkdtempSync(join(homedir(), '.cache', 'fms', 'fi.'));
const log = (line) => { console.log(line); appendFileSync(join(evidence, 'gate.log'), `${line}\n`); };
const write = (name, text) => appendFileSync(join(evidence, name), `${text.replaceAll(root, '/lab')}\n`);
const run = (command, args, env = process.env) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
};
const megabytes = (path) => Math.round(Number(run('du', ['-sb', path]).split('\t')[0]) / 1e6);

function install(label, round, spec) {
    const dir = join(root, `${label}-${round}`);
    const [home, prefix, cache] = ['umer', 'prefix', 'cache'].map((name) => join(dir, name));
    for (const path of [home, prefix, cache]) mkdirSync(path, { recursive: true });
    const started = performance.now();
    const output = run('npm', ['install', '-g', '--ignore-scripts', '--no-audit', '--no-fund', spec], {
        ...process.env, HOME: home, npm_config_prefix: prefix, npm_config_cache: cache, npm_config_update_notifier: 'false',
    });
    const seconds = (performance.now() - started) / 1000;
    const pkg = join(prefix, 'lib', 'node_modules', '@trymuxr', 'cli');
    const row = {
        label, round, seconds, pkg,
        packages: Number(/added (\d+) packages/.exec(output)?.[1]),
        files: Number(run('sh', ['-c', `find "${pkg}" -type f | wc -l`]).trim()),
        installedMb: megabytes(pkg),
        downloadedMb: megabytes(join(cache, '_cacache', 'content-v2')),
    };
    write('install-before-after.txt', `${label.padEnd(9)} round ${round}  ${seconds.toFixed(1).padStart(5)} s  ${String(row.packages).padStart(3)} packages  ${String(row.files).padStart(6)} files  ${String(row.installedMb).padStart(4)} MB on disk  ${String(row.downloadedMb).padStart(4)} MB fetched`);
    return row;
}

let relay;
try {
    run(process.execPath, ['scripts/release/application/pack.mjs']);
    run('npm', ['pack', './dist-npm', '--silent', '--pack-destination', root]);
    const tarball = join(root, readdirSync(root).find((name) => name.endsWith('.tgz')));
    const version = run('npm', ['view', '@trymuxr/cli@latest', 'version']).trim();
    write('install-before-after.txt', `$ npm install -g --ignore-scripts @trymuxr/cli   (empty prefix, empty npm cache, each row)\npublished = ${version} from npm, candidate = this commit\n`);
    const rows = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
        rows.push(install('published', round, `@trymuxr/cli@${version}`), install('candidate', round, tarball));
    }
    const mean = (label) => {
        const seconds = rows.filter((row) => row.label === label).map((row) => row.seconds);
        return seconds.reduce((sum, value) => sum + value, 0) / seconds.length;
    };
    const candidate = rows.at(-1);
    const published = rows.at(-2);
    write('install-before-after.txt', `\nmean: published ${mean('published').toFixed(1)} s, candidate ${mean('candidate').toFixed(1)} s`);
    assert.ok(candidate.packages < published.packages / 1.5, 'candidate did not shed the phone toolchain');
    for (const name of ['react-native', 'react-native-zeroconf', 'metro', 'hermes-compiler']) {
        assert.equal(existsSync(join(candidate.pkg, 'node_modules', name)), false, `${name} installed`);
    }
    log(`install: ${published.packages} -> ${candidate.packages} packages, mean ${mean('published').toFixed(1)} s -> ${mean('candidate').toFixed(1)} s`);

    const home = join(root, 'run', 'umer');
    const bin = join(root, 'run', 'bin');
    mkdirSync(join(home, '.muxr'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 3\n', { mode: 0o700 });
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh\ncase "$1" in\n--version) echo 'herdr 0.9.1';;\nstatus) echo '{"running":true}';;\nplugin) echo '{"plugins":[]}';;\nesac\n`, { mode: 0o700 });
    const env = { HOME: home, MUXR_HOME: join(home, '.muxr'), PATH: bin, HERDR_BIN: join(bin, 'herdr'), MUXR_TAILSCALE_BIN: join(bin, 'none'), MUXR_PLATFORM: 'linux', MUXR_TEST_FAKE_SERVICE_MANAGERS: '1' };
    const cli = join(candidate.pkg, 'cli.mjs');
    const shown = `$ muxr version\n${run(process.execPath, [cli, 'version'], env)}\n$ muxr setup --inspect\n${run(process.execPath, [cli, 'setup', '--inspect'], env)}`;
    write('installed-cli.txt', shown);
    assert.match(shown, /Inspection complete/);
    log('installed CLI: version and setup inspection ran from the empty prefix');

    const name = `muxr umer-lab-${process.pid}`;
    relay = spawn(process.execPath, [join(candidate.pkg, 'relay.js')], {
        env: { ...env, MUXR_RELAY_PORT: '0', MUXR_RELAY_DATA_DIR: join(home, '.muxr', 'relay'), MUXR_RELAY_MDNS: '1', MUXR_RELAY_MDNS_NAME: name, MUXR_RELAY_MDNS_MACHINE: 'umer-desk' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let relayErrors = '';
    relay.stderr.on('data', (chunk) => { relayErrors += chunk; });
    const port = await waitForRelay(relay);
    const { Bonjour } = createRequire(join(candidate.pkg, 'package.json'))('bonjour-service');
    const browser = new Bonjour();
    const found = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no mDNS record for ${name}; relay said: ${relayErrors}`)), 20_000);
        browser.find({ type: 'muxr' }, (service) => {
            if (service.name === name && service.port === port) { clearTimeout(timer); resolve(service); }
        });
    });
    await new Promise((resolve) => browser.destroy(resolve));
    write('lan-discovery.txt', `installed relay.js listening on port ${port}\nbrowsed _muxr._tcp and found: name="${found.name}" port=${found.port} machine=${found.txt.machine} v=${found.txt.v}`);
    assert.doesNotMatch(relayErrors, /mDNS advertisement unavailable/);
    log('relay: the installed relay published itself and a browse found it');

    writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
        target: { version: `the muxr CLI packed from ${run('git', ['rev-parse', '--short', 'HEAD']).trim()}, against ${version} from npm` },
        start: 'for Umer: empty npm prefixes and empty npm caches, a private home, and stand-ins for Herdr and the service manager',
        steps: ['Install the published CLI and the candidate with a cold cache, alternating rounds', 'Check the phone toolchain is absent from the candidate', 'Run the installed muxr version and setup --inspect', 'Start the installed relay and browse the LAN for its record'],
        result: `A cold install drops from ${published.packages} to ${candidate.packages} packages and ${published.files} to ${candidate.files} files: install-before-after.txt. The installed CLI still runs, installed-cli.txt, and its relay is still found on the LAN, lan-discovery.txt`,
    }, null, 2)}\n`);
    log('first install lab passed');
} finally {
    if (relay !== undefined && relay.exitCode === null) {
        const exited = new Promise((resolve) => relay.once('exit', resolve));
        relay.kill();
        await exited;
    }
    rmSync(root, { recursive: true, force: true });
}
