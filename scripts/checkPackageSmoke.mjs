import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageInfoFromPath, packagePathFromInput } from './packageAudit.mjs';

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'muxr-package-smoke-'));
const tarDir = join(scratch, 'tar');
const installDir = join(scratch, 'install');
const home = join(scratch, 'home');
const binDir = join(scratch, 'bin');
const fakeState = join(scratch, 'herdr-installed');
const fakeLog = join(scratch, 'herdr.log');
mkdirSync(tarDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
const instructionPath = join(home, '.pi', 'agent', 'AGENTS.md');
writeFileSync(instructionPath, '# Existing user instructions\n\nKeep this line.\n');
writeFileSync(join(home, '.config', 'herdr', 'config.toml'), '# user herdr config\nchannel = "stable"\n');

const fakeHerdr = `#!/bin/sh
case "$*" in
  "--version") echo "herdr 0.8.0" ;;
  "status") echo "server: running" ;;
  "plugin list --json") echo '{"result":{"plugins":[]}}' ;;
  "plugin link "*) echo plugin-link >> "$FAKE_HERDR_LOG" ;;
  "plugin unlink "*) echo plugin-unlink >> "$FAKE_HERDR_LOG" ;;
  "integration status")
    if [ -f "$FAKE_HERDR_STATE" ]; then echo "pi: current (v8) ($HOME/.pi/agent/extensions/herdr-agent-state.ts)";
    else echo "pi: not installed ($HOME/.pi/agent/extensions/herdr-agent-state.ts)"; fi ;;
  "integration install pi") echo install >> "$FAKE_HERDR_LOG"; : > "$FAKE_HERDR_STATE" ;;
  "integration uninstall pi") echo uninstall >> "$FAKE_HERDR_LOG"; /bin/rm -f "$FAKE_HERDR_STATE" ;;
  "server update-agent-manifests --json") echo manifests >> "$FAKE_HERDR_LOG"; echo '{}' ;;
  "--skill") printf '%s\\n' '---' 'name: herdr' 'description: fake smoke skill' '---' '' '# Herdr smoke skill' ;;
  *) echo "unexpected fake herdr args: $*" >&2; exit 1 ;;
esac
`;
writeFileSync(join(binDir, 'herdr'), fakeHerdr, { mode: 0o755 });
const installerBin = join(scratch, 'installer-bin');
const fakeHerdrSource = join(scratch, 'fake-herdr-source');
const fakeInstaller = join(scratch, 'fake-herdr-installer');
const fakeInstallerLog = join(scratch, 'fake-installer.log');
mkdirSync(installerBin, { recursive: true });
writeFileSync(fakeHerdrSource, fakeHerdr, { mode: 0o755 });
writeFileSync(fakeInstaller, '#!/bin/sh\n/bin/cp "$FAKE_HERDR_SOURCE" "$FAKE_HERDR_INSTALL_DIR/herdr"\n/bin/chmod 755 "$FAKE_HERDR_INSTALL_DIR/herdr"\nprintf invoked > "$FAKE_HERDR_INSTALL_LOG"\n', { mode: 0o755 });
writeFileSync(join(binDir, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
writeFileSync(join(binDir, 'stty'), '#!/bin/sh\nexec /usr/bin/stty "$@"\n', { mode: 0o755 });

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
    if (result.status !== 0 && options.allowFailure !== true) {
        throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    return result;
}

function filesSnapshot(path) {
    const out = [];
    function walk(current) {
        if (!existsSync(current)) return;
        for (const name of readdirSync(current).sort()) {
            const file = join(current, name);
            const info = statSync(file);
            if (info.isDirectory()) walk(file);
            else out.push([file.slice(path.length), info.mode & 0o777, readFileSync(file).toString('base64')]);
        }
    }
    walk(path);
    return JSON.stringify(out);
}

function cliEnv(targetHome = home, extra = {}) {
    const inherited = { ...process.env };
    delete inherited.MUXR_HOME;
    return {
        ...inherited,
        HOME: targetHome,
        PATH: `${binDir}:${dirname(process.execPath)}`,
        HERDR_BIN: join(binDir, 'herdr'),
        FAKE_HERDR_STATE: fakeState,
        FAKE_HERDR_LOG: fakeLog,
        MUXR_NO_SERVICE_COMMANDS: '1',
        MUXR_SKIP_HOSTED_AUTH: '1',
        npm_config_cache: join(scratch, 'npm-cache'),
        ...extra,
    };
}

function cliEnvWithoutHerdr(targetHome, extra = {}) {
    const env = cliEnv(targetHome, { PATH: `${installerBin}:${dirname(process.execPath)}`, ...extra });
    delete env.HERDR_BIN;
    return env;
}

function stopRelayFor(dataDir) {
    const marker = `MUXR_RELAY_DATA_DIR=${dataDir}`;
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            if (!readFileSync(`/proc/${name}/environ`).toString().split('\0').includes(marker)) continue;
            process.kill(Number(name), 'SIGTERM');
        } catch {}
    }
}

function signalNodeDescendant(parentPid) {
    const rows = run('/usr/bin/ps', ['-eo', 'pid=,ppid=,comm=']).stdout.trim().split('\n').map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return match ? { pid: Number(match[1]), parent: Number(match[2]), command: match[3] } : undefined;
    }).filter(Boolean);
    const descendants = new Set([parentPid]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const row of rows) {
            if (descendants.has(row.parent) && !descendants.has(row.pid)) {
                descendants.add(row.pid);
                changed = true;
            }
        }
    }
    const node = rows.find((row) => descendants.has(row.pid) && /node/.test(row.command));
    assert.ok(node, 'could not find the CLI node process under the test PTY');
    process.kill(node.pid, 'SIGINT');
}

async function runTty(command, env, inputAfter, timeoutMs = 20_000, completionMarker, scriptEcho = 'never', inputMarker = 'OpenAI API key for Live Voice') {
    assert.ok(existsSync('/usr/bin/script'), 'util-linux script is required for the Linux TTY smoke');
    const child = spawn('/usr/bin/script', ['-qE', scriptEcho, '-ec', command, '/dev/null'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let sent = false;
    const collect = (chunk) => {
        output += chunk.toString();
        if (!sent && output.includes(inputMarker)) {
            sent = true;
            if (inputAfter === '__SIGINT__') signalNodeDescendant(child.pid);
            else if (inputAfter !== null) child.stdin.end(inputAfter);
        }
        if (completionMarker && output.includes(completionMarker) && !child.stdin.destroyed) child.stdin.end();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`TTY smoke timed out\n${output}`));
        }, timeoutMs);
        child.on('exit', (value) => {
            clearTimeout(timer);
            resolve(value ?? 1);
        });
    });
    return { code, output };
}

try {
    run('npm', ['run', 'web:export']);
    const auditFixture = join(scratch, 'audit-fixture');
    for (const [directory, version] of [
        [join(auditFixture, 'node_modules', 'nested-license-fixture'), '1.0.0'],
        [join(auditFixture, 'workspace', 'node_modules', 'nested-license-fixture'), '2.0.0'],
    ]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: 'nested-license-fixture', version, license: 'MIT' })}\n`);
        writeFileSync(join(directory, 'LICENSE'), 'MIT fixture\n');
    }
    const nestedPackagePath = packagePathFromInput(auditFixture, 'workspace/node_modules/nested-license-fixture/index.js');
    assert.equal(packageInfoFromPath(nestedPackagePath, true).auditedVersion, '2.0.0', 'license audit resolved the hoisted copy instead of the bundled nested copy');

    const expoConfig = (appEnv, extra = {}) => JSON.parse(run('npx', ['expo', 'config', '--json'], {
        cwd: join(root, 'apps', 'mobile'),
        env: { ...process.env, APP_ENV: appEnv, ...extra },
    }).stdout);
    const development = expoConfig('development');
    const preview = expoConfig('preview');
    const production = expoConfig('production', {
        MUXR_APP_ID_BASE: 'com.trymuxr.app',
        MUXR_PUBLIC_BASE_URL: 'https://owner.invalid',
    });
    assert.deepEqual(
        [development.name, development.scheme, development.android.package, development.ios.bundleIdentifier],
        ['muxr (dev)', 'muxr', 'app.muxr.local.dev', 'app.muxr.local.dev'],
    );
    assert.deepEqual(
        [preview.name, preview.scheme, preview.android.package, preview.ios.bundleIdentifier],
        ['muxr (preview)', 'muxr', 'app.muxr.local.preview', 'app.muxr.local.preview'],
    );
    assert.deepEqual(
        [production.name, production.scheme, production.android.package, production.ios.bundleIdentifier, production.extra.app.publicBaseUrl],
        ['muxr', 'muxr', 'com.trymuxr.app', 'com.trymuxr.app', 'https://owner.invalid'],
    );
    assert.equal(production.extra.eas, undefined, 'an old EAS project id leaked into production config');
    const unconfiguredProduction = run('npx', ['expo', 'config', '--json'], {
        cwd: join(root, 'apps', 'mobile'),
        env: { ...process.env, APP_ENV: 'production', MUXR_APP_ID_BASE: '', MUXR_PUBLIC_BASE_URL: '' },
        allowFailure: true,
    });
    assert.notEqual(unconfiguredProduction.status, 0, 'production config accepted missing publishing origin');

    run(process.execPath, ['scripts/pack.mjs'], {
        env: { ...process.env, MUXR_PACKAGE_CONTROL_URL: 'https://package-smoke.invalid' },
    });
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', tarDir], { cwd: join(root, 'dist-npm') }).stdout);
    const tarball = join(tarDir, packed[0].filename);
    const listing = run('tar', ['-tf', tarball]).stdout.split('\n');
    assert.ok(listing.includes('package/host.js'));
    assert.ok(listing.includes('package/crypto.js'), 'strict hosted crypto runtime missing');
    assert.ok(listing.includes('package/THIRD_PARTY_LICENSES.json'));
    assert.ok(!listing.includes('package/esbuild-metafile.json'));
    assert.ok(listing.includes('package/relay.js'), 'self-host relay bundle missing from npm artifact');
    assert.ok(listing.includes('package/plugins/control/run.mjs'), 'control plugin missing from npm artifact');
    assert.ok(listing.includes('package/plugins/run-server/start.mjs'), 'Run Server plugin missing from npm artifact');
    assert.ok(listing.includes('package/plugins/voice/rpc.mjs'), 'Voice plugin missing from npm artifact');
    assert.ok(listing.includes('package/web/index.html'), 'secure browser client missing from npm artifact');
    assert.ok(!listing.some((file) => /apps\/relay|commerce|stripe|website|betaCodeAdmin|controlPlane|controlRepository/i.test(file)), 'private control-plane source shipped in npm artifact');
    run(process.execPath, ['scripts/checkNoSecrets.mjs']);
    const hostBundle = run('tar', ['-xOf', tarball, 'package/host.js']).stdout;
    const cryptoBundle = run('tar', ['-xOf', tarball, 'package/crypto.js']).stdout;
    assert.doesNotMatch(`${hostBundle}\n${cryptoBundle}`, /(?:apps|packages)\/(?:host|wire|contract|crypto)\/(?:src|dist)\//, 'bundle leaked proprietary source paths');
    const licenseInventory = JSON.parse(run('tar', ['-xOf', tarball, 'package/THIRD_PARTY_LICENSES.json']).stdout);
    const packageJson = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']).stdout);
    assert.equal(licenseInventory.bundledInputs, undefined);
    assert.ok(!JSON.stringify(licenseInventory).includes(`${root}/`), 'license inventory leaked a repository path');
    for (const dependency of licenseInventory.dependencies) {
        assert.equal(dependency.declaredRange, dependency.bundled ? null : packageJson.dependencies[dependency.name]);
        assert.match(dependency.auditedVersion, /^\d+\.\d+\.\d+/);
        assert.equal(dependency.version, undefined, 'ambiguous dependency version field returned');
    }
    assert.equal(packageJson.name, '@trymuxr/cli');
    assert.deepEqual(packageJson.bin, { muxr: './cli.mjs' });

    writeFileSync(join(installDir, 'package.json'), '{"private":true}\n');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
        cwd: installDir,
        env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    });
    const cli = join(installDir, 'node_modules', '.bin', 'muxr');

    const refusalHome = join(scratch, 'refusal-home');
    mkdirSync(refusalHome, { recursive: true });
    const refusal = run(cli, ['setup', '--no-agent-config'], {
        cwd: installDir,
        env: cliEnvWithoutHerdr(refusalHome),
        allowFailure: true,
    });
    assert.notEqual(refusal.status, 0, 'non-TTY setup installed missing Herdr without explicit approval');
    assert.match(`${refusal.stdout}${refusal.stderr}`, /rerun with --install-herdr/);
    assert.ok(!existsSync(fakeInstallerLog), 'safe refusal executed an installer');

    const ttyRefusalHome = join(scratch, 'tty-refusal-home');
    mkdirSync(ttyRefusalHome, { recursive: true });
    const ttyRefusal = await runTty(
        `${cli} setup --no-agent-config`,
        cliEnvWithoutHerdr(ttyRefusalHome),
        '\n',
        20_000,
        undefined,
        'never',
        'Herdr is missing.',
    );
    assert.notEqual(ttyRefusal.code, 0, ttyRefusal.output);
    assert.match(ttyRefusal.output, /\[y\/N\]/);
    assert.ok(!existsSync(fakeInstallerLog), 'No-default interactive refusal executed an installer');

    const installerHome = join(scratch, 'installer-home');
    mkdirSync(installerHome, { recursive: true });
    const installerPort = 18_000 + (process.pid % 10_000);
    try {
        run(cli, [
            'setup', '--install-herdr', '--no-agent-config', '--relay-only',
            '--port', String(installerPort), '--advertise', `ws://127.0.0.1:${installerPort}`,
        ], {
            cwd: installDir,
            env: cliEnvWithoutHerdr(installerHome, {
                MUXR_HERDR_INSTALLER: fakeInstaller,
                FAKE_HERDR_SOURCE: fakeHerdrSource,
                FAKE_HERDR_INSTALL_DIR: installerBin,
                FAKE_HERDR_INSTALL_LOG: fakeInstallerLog,
            }),
        });
        assert.equal(readFileSync(fakeInstallerLog, 'utf8'), 'invoked');
    } finally {
        stopRelayFor(join(installerHome, '.muxr', 'relay'));
    }

    const env = cliEnv();
    const setupPort = 20_000 + (process.pid % 10_000);
    const setupArgs = ['--relay-only', '--port', String(setupPort), '--advertise', `ws://127.0.0.1:${setupPort}`];
    assert.equal(run(cli, ['version'], { cwd: installDir, env }).stdout.trim(), packageJson.version);
    const beforeHelp = filesSnapshot(home);
    assert.match(run(cli, ['setup', '--help'], { cwd: installDir, env }).stdout, /Guided setup adopts or installs Herdr/);
    assert.equal(filesSnapshot(home), beforeHelp, 'subcommand help changed the home directory');

    const beforeDryRun = filesSnapshot(home);
    run(cli, ['setup', '--dry-run'], { cwd: installDir, env });
    assert.equal(filesSnapshot(home), beforeDryRun, 'dry-run changed the home directory');

    const configBefore = readFileSync(join(home, '.config', 'herdr', 'config.toml'), 'utf8');
    run(cli, ['setup', ...setupArgs], { cwd: installDir, env });
    const manifestAfterFirst = readFileSync(join(home, '.muxr', 'setup-manifest.json'), 'utf8');
    run(cli, ['setup', ...setupArgs], { cwd: installDir, env });
    assert.equal(readFileSync(join(home, '.muxr', 'setup-manifest.json'), 'utf8'), manifestAfterFirst);
    run(cli, ['daemon', 'install', '--mode', 'selfhost'], { cwd: installDir, env });
    assert.equal(readFileSync(join(home, '.config', 'herdr', 'config.toml'), 'utf8'), configBefore);
    const instructions = readFileSync(instructionPath, 'utf8');
    assert.equal(instructions.match(/muxr:herdr-skill:start/g)?.length, 1);
    assert.match(instructions, /Keep this line\./);
    assert.ok(readdirSync(join(home, '.pi', 'agent')).some((name) => name.startsWith('AGENTS.md.muxr-backup-')));
    assert.equal(statSync(join(home, '.muxr', 'setup-manifest.json')).mode & 0o777, 0o600);
    assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'muxr.service')));

    writeFileSync(instructionPath, readFileSync(instructionPath, 'utf8').replace('When the user explicitly asks', 'When someone asks'));
    const mutationsBeforeDrift = existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '';
    const drift = run(cli, ['integrations', 'sync'], { cwd: installDir, env, allowFailure: true });
    assert.notEqual(drift.status, 0);
    assert.match(`${drift.stdout}${drift.stderr}`, /drift:/);
    assert.equal(readFileSync(fakeLog, 'utf8'), mutationsBeforeDrift, 'drift preflight invoked mutating herdr commands');
    run(cli, ['integrations', 'sync', '--force'], { cwd: installDir, env });
    assert.match(readFileSync(instructionPath, 'utf8'), /Keep this line\./);
    run(cli, ['doctor'], { cwd: installDir, env });

    const host = spawn(cli, ['up', '--fake'], { cwd: installDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let hostOutput = '';
    host.stdout.on('data', (chunk) => { hostOutput += chunk; });
    host.stderr.on('data', (chunk) => { hostOutput += chunk; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`packaged host did not start\n${hostOutput}`)), 10_000);
        const poll = setInterval(() => {
            if (hostOutput.includes('(fake)')) {
                clearTimeout(timer);
                clearInterval(poll);
                resolve();
            }
        }, 50);
    });
    host.kill('SIGTERM');
    await new Promise((resolve) => host.once('exit', resolve));

    const macHome = join(scratch, 'mac-home');
    mkdirSync(macHome, { recursive: true });
    const macEnv = cliEnv(macHome, { MUXR_PLATFORM: 'darwin' });
    run(cli, ['daemon', 'install'], { cwd: installDir, env: macEnv });
    assert.match(readFileSync(join(macHome, 'Library', 'LaunchAgents', 'com.muxr.host.plist'), 'utf8'), /com\.muxr\.host/);
    run(cli, ['daemon', 'uninstall'], { cwd: installDir, env: macEnv });

    writeFileSync(join(home, '.muxr', 'xai.key'), 'xai-user-owned\n', { mode: 0o600 });
    run(cli, ['daemon', 'uninstall'], { cwd: installDir, env });
    run(cli, ['integrations', 'uninstall'], { cwd: installDir, env });
    assert.match(readFileSync(instructionPath, 'utf8'), /Keep this line\./);
    assert.ok(!readFileSync(instructionPath, 'utf8').includes('muxr:herdr-skill'));
    assert.ok(existsSync(join(home, '.muxr', 'xai.key')), 'integration uninstall removed user data');
    run('npm', ['uninstall', 'muxr', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: installDir,
        env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    });

    process.stdout.write(`package smoke passed: ${tarball}\n`);
} finally {
    stopRelayFor(join(home, '.muxr', 'relay'));
    rmSync(scratch, { recursive: true, force: true });
}
