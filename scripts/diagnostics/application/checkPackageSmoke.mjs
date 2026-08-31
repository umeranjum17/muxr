import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageInfoFromPath, packagePathFromInput } from '../../release/index.mjs';

const root = process.cwd();
const scratchBase = process.platform === 'darwin' ? '/tmp' : tmpdir();
const scratch = realpathSync(mkdtempSync(join(scratchBase, 'muxr-package-smoke-')));
const tarDir = join(scratch, 'tar');
const installDir = join(scratch, 'install');
const home = join(scratch, 'home');
const binDir = join(scratch, 'bin');
const fakeState = join(scratch, 'herdr-installed');
const fakeServerState = join(scratch, 'herdr-server-running');
const fakeLog = join(scratch, 'herdr.log');
mkdirSync(tarDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
const instructionPath = join(home, '.pi', 'agent', 'AGENTS.md');
const initialInstructions = '# Existing user instructions\n\nKeep this line.\n';
writeFileSync(instructionPath, initialInstructions);
writeFileSync(join(home, '.config', 'herdr', 'config.toml'), '# user herdr config\nchannel = "stable"\n');
writeFileSync(fakeServerState, 'running\n');

const fakeHerdr = `#!/bin/sh
case "$*" in
  "--version") echo "herdr 0.8.0" ;;
  "status server --json")
    if [ "$FAKE_HERDR_HANG" = 1 ]; then exec /bin/sleep 5; fi
    if [ -f "$FAKE_HERDR_SERVER_STATE" ]; then echo '{"running":true}';
    else echo '{"running":false}'; fi ;;
  "status")
    if [ -f "$FAKE_HERDR_SERVER_STATE" ]; then printf 'server:\n  status: running\n';
    else printf 'server:\n  status: not running\n'; fi ;;
  "server") printf '%s\n' server-start >> "$FAKE_HERDR_LOG"; : > "$FAKE_HERDR_SERVER_STATE" ;;
  "plugin list --json")
    if [ -n "$FAKE_PLUGIN_LIST" ]; then printf '%s\n' "$FAKE_PLUGIN_LIST";
    else echo '{"result":{"plugins":[]}}'; fi ;;
  "plugin link "*) printf '%s\n' "$*" >> "$FAKE_HERDR_LOG" ;;
  "plugin unlink "*) printf '%s\n' "$*" >> "$FAKE_HERDR_LOG" ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
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
symlinkSync(process.execPath, join(installerBin, 'node'));
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

function assertCompactSkillOutput(output) {
    assert.match(output, /^---\nname: muxr\ndescription: /);
    assert.match(output, /## Task router/);
    assert.match(output, /muxr skill collaboration/);
    assert.doesNotMatch(output, /muxr-skill-reference|# Cross-machine agent collaboration|## Installed Herdr CLI reference/);
}

function assertUnifiedSkillOutput(output, { liveHerdr = true } = {}) {
    assert.match(output, /^---\nname: muxr\ndescription: /);
    assert.match(output, /## Task router/);
    const references = ['browser-takeover.md', 'collaboration.md', 'herdr.md', 'onboarding.md', 'plugins.md'];
    let previous = -1;
    for (const name of references) {
        const index = output.indexOf(`<!-- muxr-skill-reference: references/${name} -->`);
        assert.ok(index > previous, `${name} missing or out of deterministic order`);
        previous = index;
    }
    for (const heading of [
        '# Onboarding: install, pair, self-host, maintain',
        '# Herdr orchestration',
        '# Cross-machine agent collaboration',
        '# Browser takeover for login, 2FA, and CAPTCHA',
        '# muxr plugins: author, install, debug, override',
    ]) assert.match(output, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(output, /installed binary is the only command\s+contract/);
    assert.match(output, /## Packaged-reference behavior/);
    if (liveHerdr) {
        assert.match(output, /## Installed Herdr CLI reference[\s\S]*Generated by `herdr --skill` from `herdr 0\.8\.0`[\s\S]*# Herdr smoke skill/);
        assert.doesNotMatch(output, /name: herdr/, 'embedded Herdr frontmatter created a second skill');
    } else {
        assert.doesNotMatch(output, /## Installed Herdr CLI reference/);
    }
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
        MUXR_PS_BIN: '/usr/bin/ps',
        MUXR_PLATFORM: 'linux',
        HERDR_BIN: join(binDir, 'herdr'),
        FAKE_HERDR_STATE: fakeState,
        FAKE_HERDR_SERVER_STATE: fakeServerState,
        FAKE_HERDR_LOG: fakeLog,
        MUXR_NO_SERVICE_COMMANDS: '1',
        MUXR_SKIP_HOSTED_AUTH: '1',
        npm_config_cache: join(scratch, 'npm-cache'),
        ...extra,
    };
}

function cliEnvWithoutHerdr(targetHome, extra = {}) {
    const env = cliEnv(targetHome, { PATH: installerBin, ...extra });
    delete env.HERDR_BIN;
    return env;
}

function stopRelayFor(dataDir) {
    const pidPath = join(dataDir, 'relay.pid');
    if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf8').trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
            try {
                process.kill(pid, 'SIGTERM');
                return;
            } catch {}
        }
    }
    if (!existsSync('/proc')) return;
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

const expectWaitForExit = 'expect eof\nset result [wait]\nexit [lindex $result 3]';

function ttyProcess(command, scriptEcho = 'never') {
    if (process.platform === 'darwin') {
        return {
            command: '/usr/bin/expect',
            args: ['-c', `log_user 1
set timeout -1
spawn -noecho /bin/sh -c $env(MUXR_TTY_COMMAND)
send -- $env(MUXR_TTY_INPUT)
${expectWaitForExit}`],
            env: { MUXR_TTY_COMMAND: command },
        };
    }
    return {
        command: '/usr/bin/script',
        args: ['-qE', scriptEcho, '-ec', command, '/dev/null'],
        env: {},
    };
}

function runTtySync(command, options) {
    const pty = ttyProcess(command);
    assert.ok(existsSync(pty.command), 'a PTY utility is required for the TTY smoke');
    const input = typeof options.input === 'string' ? options.input : '';
    return run(pty.command, pty.args, {
        ...options,
        ...(process.platform === 'darwin' ? { input: undefined } : {}),
        env: { ...options.env, ...pty.env, ...(process.platform === 'darwin' ? { MUXR_TTY_INPUT: input } : {}) },
    });
}

async function runTty(command, env, inputAfter, timeoutMs = 20_000, completionMarker, scriptEcho = 'never', inputMarker = 'OpenAI API key for Live Voice') {
    const darwin = process.platform === 'darwin';
    const pty = darwin
        ? {
            command: '/usr/bin/expect',
            args: ['-c', `log_user 1
set timeout -1
spawn -noecho /bin/sh -c $env(MUXR_TTY_COMMAND)
expect -exact $env(MUXR_TTY_MARKER)
send -- $env(MUXR_TTY_INPUT)
${expectWaitForExit}`],
            env: {
                MUXR_TTY_COMMAND: command,
                MUXR_TTY_MARKER: inputMarker,
                MUXR_TTY_INPUT: inputAfter === '__SIGINT__' ? '\u0003' : inputAfter ?? '',
            },
        }
        : ttyProcess(command, scriptEcho);
    assert.ok(existsSync(pty.command), 'a PTY utility is required for the TTY smoke');
    const child = spawn(pty.command, pty.args, {
        env: { ...env, ...pty.env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let sent = darwin;
    const collect = (chunk) => {
        output += chunk.toString();
        if (!sent && output.includes(inputMarker)) {
            sent = true;
            if (inputAfter === '__SIGINT__') signalNodeDescendant(child.pid);
            else if (inputAfter !== null) child.stdin.end(inputAfter);
        }
        if (!darwin && completionMarker && output.includes(completionMarker) && !child.stdin.destroyed) child.stdin.end();
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
    const sourceEnv = cliEnv();
    const sourceHelp = run(process.execPath, ['scripts/cli.mjs', '--help'], { env: sourceEnv }).stdout;
    assert.match(sourceHelp, /muxr --skill \| muxr skill\s+print the compact muxr agent skill/);
    assert.match(sourceHelp, /muxr peers list\|read\|status\|watch\|prompt/);
    assert.match(sourceHelp, /muxr diagnostics\s+show bounded redacted host history/);
    const diagnosticsDir = join(home, '.muxr', 'host');
    mkdirSync(diagnosticsDir, { recursive: true });
    const diagnosticsPath = join(diagnosticsDir, 'diagnostics.json');
    writeFileSync(diagnosticsPath, `${JSON.stringify({ version: 1, current: { updatedAt: '2026-08-26T00:00:00.000Z' }, events: [{ at: '2026-08-26T00:00:00.000Z', event: 'relay.state', state: 'open' }] })}\n`, { mode: 0o600 });
    chmodSync(diagnosticsPath, 0o600);
    const sourceDiagnostics = JSON.parse(run(process.execPath, ['scripts/cli.mjs', 'diagnostics'], { env: sourceEnv }).stdout);
    assert.equal(sourceDiagnostics.events[0].event, 'relay.state');
    assert.doesNotMatch(JSON.stringify(sourceDiagnostics), /machineId|deviceId|sessionId|prompt/i);
    const sourceSkill = run(process.execPath, ['scripts/cli.mjs', '--skill'], { env: sourceEnv }).stdout;
    assertCompactSkillOutput(sourceSkill);
    assert.equal(run(process.execPath, ['scripts/cli.mjs', 'skill'], { env: sourceEnv }).stdout, sourceSkill, 'source skill alias diverged from --skill');
    assert.match(run(process.execPath, ['scripts/cli.mjs', 'skill', 'collaboration'], { env: sourceEnv }).stdout, /muxr peers prompt/);
    assertUnifiedSkillOutput(run(process.execPath, ['scripts/cli.mjs', 'skill', 'all'], { env: sourceEnv }).stdout);
    const fallbackHome = join(scratch, 'skill-fallback-home');
    mkdirSync(fallbackHome);
    assertUnifiedSkillOutput(run(process.execPath, ['scripts/cli.mjs', 'skill', 'all'], { env: cliEnvWithoutHerdr(fallbackHome) }).stdout, { liveHerdr: false });

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

    run(process.execPath, ['scripts/release/application/pack.mjs'], {
        env: { ...process.env, MUXR_PACKAGE_CONTROL_URL: 'https://package-smoke.invalid' },
    });
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', tarDir], { cwd: join(root, 'dist-npm') }).stdout);
    const packedInfo = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    const tarball = join(tarDir, packedInfo.filename);
    const listing = run('tar', ['-tf', tarball]).stdout.split('\n');
    assert.ok(listing.includes('package/host.js'));
    assert.ok(listing.includes('package/crypto.js'), 'strict hosted crypto runtime missing');
    assert.ok(listing.includes('package/THIRD_PARTY_LICENSES.json'));
    assert.ok(!listing.includes('package/esbuild-metafile.json'));
    assert.ok(listing.includes('package/relay.js'), 'self-host relay bundle missing from npm artifact');
    assert.ok(listing.includes('package/release/application/updateCli.mjs'), 'interactive CLI updater missing from npm artifact');
    assert.ok(listing.includes('package/setup/application/inspectSetup.mjs'), 'setup inspect use case missing from npm artifact');
    assert.ok(listing.includes('package/setup/application/pairDevice.mjs'), 'pair-device use case missing from npm artifact');
    assert.ok(listing.includes('package/plugin/application/checkPlugin.mjs'), 'plugin check use case missing from npm artifact');
    assert.ok(listing.includes('package/plugin/application/installPlugin.mjs'), 'plugin install use case missing from npm artifact');
    assert.ok(listing.includes('package/setup/application/promptPeerAgent.mjs'), 'peer CLI client missing from npm artifact');
    assert.ok(listing.includes('package/diagnostics/application/dumpDiagnostics.mjs'), 'host diagnostics CLI missing from npm artifact');
    assert.ok(listing.includes('package/plugins/control/run.mjs'), 'control plugin missing from npm artifact');
    assert.ok(listing.includes('package/plugins/voice/rpc.mjs'), 'Voice plugin missing from npm artifact');
    for (const provider of ['xai', 'gemini', 'openai', 'codex']) {
        assert.ok(listing.includes(`package/plugins/voice/providers/${provider}.mjs`), `${provider} voice adapter missing from npm artifact`);
    }
    assert.ok(listing.includes('package/skills/muxr/SKILL.md'), 'muxr skill missing from npm artifact');
    assert.deepEqual(listing.filter((file) => /^package\/skills\/.*\/SKILL\.md$/.test(file)), ['package/skills/muxr/SKILL.md'], 'npm artifact must ship exactly one public skill');
    assert.ok(listing.includes('package/skills/muxr/references/plugins.md'), 'muxr skill references missing from npm artifact');
    assert.ok(listing.includes('package/skills/muxr/references/browser-takeover.md'), 'browser takeover reference missing from npm artifact');
    assert.ok(listing.includes('package/web/index.html'), 'secure browser client missing from npm artifact');
    assert.ok(listing.includes('package/web/install.sh'), 'hosted npm installer wrapper missing from web artifact');
    assert.ok(!listing.some((file) => /apps\/relay|commerce|stripe|website|betaCodeAdmin|controlPlane|controlRepository/i.test(file)), 'private control-plane source shipped in npm artifact');
    run(process.execPath, ['scripts/diagnostics/application/checkNoSecrets.mjs']);
    const hostBundle = run('tar', ['-xOf', tarball, 'package/host.js']).stdout;
    const cryptoBundle = run('tar', ['-xOf', tarball, 'package/crypto.js']).stdout;
    assert.doesNotMatch(`${hostBundle}\n${cryptoBundle}`, /(?:apps|packages)\/(?:host|wire|contract|crypto)\/(?:src|dist)\//, 'bundle leaked proprietary source paths');
    const licenseInventory = JSON.parse(run('tar', ['-xOf', tarball, 'package/THIRD_PARTY_LICENSES.json']).stdout);
    const packageJson = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']).stdout);
    assert.equal(packageJson.dependencies.zod, undefined, 'packed CLI must not depend on Zod');
    assert.equal(packageJson.dependencies['@agentclientprotocol/sdk'], undefined, 'packed CLI must not require a separately installed ACP SDK');
    assert.equal(packageJson.dependencies['@agentclientprotocol/claude-agent-acp'], undefined, 'packed Claude bridge must invoke the installed CLI directly');
    assert.equal(packageJson.dependencies['@agentclientprotocol/codex-acp'], undefined, 'packed Codex bridge must invoke the installed CLI directly');
    assert.equal(licenseInventory.bundledInputs, undefined);
    assert.ok(!JSON.stringify(licenseInventory).includes(`${root}/`), 'license inventory leaked a repository path');
    for (const dependency of licenseInventory.dependencies) {
        if (dependency.transitiveOf !== undefined) {
            assert.equal(dependency.declaredRange, null);
            assert.equal(dependency.transitiveOf, 'ccusage');
            assert.equal(dependency.auditedVersion, packageJson.dependencies.ccusage);
        } else {
            assert.equal(dependency.declaredRange, dependency.bundled ? null : packageJson.dependencies[dependency.name]);
        }
        assert.match(dependency.auditedVersion, /^\d+\.\d+\.\d+/);
        assert.equal(dependency.version, undefined, 'ambiguous dependency version field returned');
    }
    assert.equal(packageJson.name, '@trymuxr/cli');
    assert.deepEqual(packageJson.bin, { muxr: './cli.mjs' });
    assert.equal(packageJson.dependencies.ccusage, '20.0.20', 'packed CLI did not pin the reviewed ccusage backend');
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
        assert.ok(licenseInventory.dependencies.some((dependency) => dependency.name === `@ccusage/ccusage-${target}` && dependency.transitiveOf === 'ccusage'), `${target} ccusage binary missing from license audit`);
    }

    writeFileSync(join(installDir, 'package.json'), '{"private":true}\n');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
        cwd: installDir,
        env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    });
    const cli = join(installDir, 'node_modules', '.bin', 'muxr');
    const installedPackage = join(installDir, 'node_modules', '@trymuxr', 'cli');
    const installedPlugins = join(installedPackage, 'plugins');
    assert.match(readFileSync(join(installedPackage, 'README.md'), 'utf8'), /muxr --skill\s+# print the compact agent skill/);
    const rootHelp = run(cli, ['--help'], { cwd: installDir }).stdout;
    assert.match(rootHelp, /muxr --skill \| muxr skill\s+print the compact muxr agent skill/);
    assert.match(rootHelp, /muxr peers list\|read\|status\|watch\|prompt/);
    assert.match(rootHelp, /muxr diagnostics\s+show bounded redacted host history/);
    assert.equal(JSON.parse(run(cli, ['diagnostics'], { cwd: installDir, env: cliEnv() }).stdout).events[0].event, 'relay.state');
    const installedSkill = run(cli, ['--skill'], { cwd: installDir, env: cliEnv() }).stdout;
    assertCompactSkillOutput(installedSkill);
    assert.equal(run(cli, ['skill'], { cwd: installDir, env: cliEnv() }).stdout, installedSkill, 'packed skill alias diverged from --skill');
    assert.match(run(cli, ['skill', 'collaboration'], { cwd: installDir, env: cliEnv() }).stdout, /muxr peers prompt/);
    assertUnifiedSkillOutput(run(cli, ['skill', 'all'], { cwd: installDir, env: cliEnv() }).stdout);
    const unavailablePeers = run(cli, ['peers', 'list'], { cwd: installDir, env: cliEnv(), allowFailure: true });
    assert.equal(unavailablePeers.status, 1);
    assert.match(unavailablePeers.stderr, /Peer access is not ready/);
    const wizardSource = readFileSync(join(installedPackage, 'setup/presentation/setupWizard.mjs'), 'utf8');
    const applyGuard = wizardSource.indexOf("if (apply !== true) return cancelSetup();");
    const tailscaleMutation = wizardSource.indexOf('await applyTailscaleConnect(found)', applyGuard);
    assert.ok(applyGuard >= 0 && tailscaleMutation > applyGuard, 'interactive setup may mutate Tailscale before Apply setup');
    assert.doesNotMatch(wizardSource.slice(wizardSource.indexOf('async function offerTailscaleConnect'), wizardSource.indexOf('async function applyTailscaleConnect')), /spawnSync\(/, 'Tailscale preflight executes a machine mutation');
    if (existsSync(ttyProcess('').command)) {
        const uiFlow = join(scratch, 'setup-ui-flow.mjs');
        writeFileSync(uiFlow, `import {withFullscreen, setupStep, outro, select} from ${JSON.stringify(`file://${join(installedPackage, 'setup/presentation/ui.mjs')}`)};\nif (process.argv[2] === 'full') await withFullscreen(async () => { setupStep(1, 5, 'Check this machine'); outro('Setup receipt'); return 0; });\nelse await withFullscreen(async () => { await select('Choose connection', [{value:'lan',title:'LAN',description:'same network'}]); return 0; });\n`);
        const fullUiEnv = { ...process.env, TERM: 'xterm-256color' };
        delete fullUiEnv.CI;
        delete fullUiEnv.SSH_CONNECTION;
        delete fullUiEnv.MUXR_NO_TUI;
        const fullUi = runTtySync(`stty cols 106 rows 43; ${process.execPath} ${uiFlow} full`, {
            input: '\n', env: fullUiEnv,
        }).stdout;
        assert.match(fullUi, /\x1b\[\?1049h/);
        assert.match(fullUi, /\x1b\[\?1049l/);
        assert.match(fullUi, /◆ Setup receipt/, 'fullscreen success left no durable receipt');
        const appendUi = runTtySync(`${process.execPath} ${uiFlow} append`, {
            input: '1\n', env: { ...process.env, TERM: 'dumb', SSH_CONNECTION: 'test' },
        }).stdout;
        assert.doesNotMatch(appendUi, /\x1b\[/, 'SSH/dumb setup emitted cursor or style control sequences');
        assert.match(appendUi, /1\. LAN[\s\S]*Choose 1-1/, 'SSH setup did not use the append-only numbered selector');
        const smallUi = runTtySync(`stty cols 70 rows 24; ${process.execPath} ${uiFlow} append`, {
            input: '1\n', env: fullUiEnv,
        }).stdout;
        assert.doesNotMatch(smallUi, /\x1b\[\?1049h|\x1b\[[0-9]+A/, 'small local setup used fullscreen or cursor redraw');
        assert.match(smallUi, /1\. LAN[\s\S]*Choose 1-1/, 'small local setup did not use the append-only selector');
    }
    const docsOutput = run(cli, ['plugin', 'docs'], { cwd: installDir }).stdout;
    assert.match(docsOutput, new RegExp(`Plugin guide: ${join(installedPackage, 'PLUGINS.md').replaceAll('\\', '\\\\')}`));
    assert.match(docsOutput, new RegExp(`Agent skill: ${join(installedPackage, 'skills', 'muxr', 'SKILL.md').replaceAll('\\', '\\\\')}`));
    assert.match(docsOutput, new RegExp(`Plugin reference: ${join(installedPackage, 'skills', 'muxr', 'references', 'plugins.md').replaceAll('\\', '\\\\')}`));
    assert.match(run(cli, ['help', 'plugin', 'create'], { cwd: installDir }).stdout, /minimal three-file/);
    assert.match(run(cli, ['help', 'plugin', 'clone'], { cwd: installDir }).stdout, /package-owned plugin/);
    assert.match(run(cli, ['plugin', '--help'], { cwd: installDir }).stdout, /plugin docs/);
    assert.notEqual(run(cli, ['plugin', 'docs', 'extra'], { cwd: installDir, allowFailure: true }).status, 0);
    const createdPlugin = join(scratch, 'created-plugin');
    run(cli, ['plugin', 'create', createdPlugin], { cwd: installDir });
    assert.deepEqual(readdirSync(createdPlugin).sort(), ['README.md', 'herdr-plugin.toml', 'muxr-ui.json']);
    assert.match(run(cli, ['plugin', 'check', createdPlugin], { cwd: installDir }).stdout, /muxr UI manifest/);
    const createdId = readFileSync(join(createdPlugin, 'herdr-plugin.toml'), 'utf8').match(/^id = "([^"]+)"/m)?.[1];
    const secondCreatedPlugin = join(scratch, 'other-parent', 'created-plugin');
    run(cli, ['plugin', 'create', secondCreatedPlugin], { cwd: installDir });
    const secondCreatedId = readFileSync(join(secondCreatedPlugin, 'herdr-plugin.toml'), 'utf8').match(/^id = "([^"]+)"/m)?.[1];
    assert.match(createdId ?? '', /^local\.created-plugin-[a-f0-9]{8}$/);
    assert.match(secondCreatedId ?? '', /^local\.created-plugin-[a-f0-9]{8}$/);
    assert.notEqual(secondCreatedId, createdId, 'same-basename plugins received the same global id');
    const clonedPlugin = join(scratch, 'cloned-terminal-keys');
    run(cli, ['plugin', 'clone', 'muxr.terminal-keys', clonedPlugin], { cwd: installDir });
    const clonedId = readFileSync(join(clonedPlugin, 'herdr-plugin.toml'), 'utf8').match(/^id = "([^"]+)"/m)?.[1];
    assert.match(clonedId ?? '', /^local\.cloned-terminal-keys-[a-f0-9]{8}$/);
    assert.equal(JSON.parse(readFileSync(join(clonedPlugin, 'muxr-ui.json'))).pluginId, clonedId);
    assert.match(run(cli, ['plugin', 'check', clonedPlugin], { cwd: installDir }).stdout, /muxr UI manifest/);
    const packageClone = join(installedPackage, 'must-not-survive');
    assert.notEqual(run(cli, ['plugin', 'clone', 'muxr.terminal-keys', packageClone], { cwd: installDir, allowFailure: true }).status, 0);
    assert.notEqual(run(cli, ['plugin', 'create', packageClone], { cwd: installDir, allowFailure: true }).status, 0);
    assert.equal(existsSync(packageClone), false);
    const packageAlias = join(scratch, 'package-alias');
    symlinkSync(installedPackage, packageAlias, 'dir');
    assert.notEqual(run(cli, ['plugin', 'clone', 'muxr.terminal-keys', join(packageAlias, 'alias-clone')], { cwd: installDir, allowFailure: true }).status, 0);
    assert.notEqual(run(cli, ['plugin', 'create', join(packageAlias, 'alias-create')], { cwd: installDir, allowFailure: true }).status, 0);
    assert.equal(existsSync(join(installedPackage, 'alias-clone')), false);
    assert.equal(existsSync(join(installedPackage, 'alias-create')), false);
    const providerHome = join(scratch, 'provider-home');
    const providerRoot = join(providerHome, '.muxr');
    // The adapters share one providerSecret store, and `plugin call` gives each
    // run a private state dir, so the selected adapter cannot persist between
    // calls. Exercising the default adapter covers the same write/clear path.
    const voicePlugin = join(installedPlugins, 'voice');
    const providerEnv = { ...cliEnv(providerHome), MUXR_HOME: providerRoot };
    run(cli, ['plugin', 'call', voicePlugin, 'key-set', '--input', '{"key":"smoke-key"}'], { cwd: installDir, env: providerEnv });
    assert.equal(statSync(providerRoot).mode & 0o777, 0o700);
    assert.equal(statSync(join(providerRoot, 'xai.key')).mode & 0o777, 0o600);
    assert.match(run(cli, ['plugin', 'call', voicePlugin, 'status'], { cwd: installDir, env: providerEnv }).stdout, /"configured": true/);
    run(cli, ['plugin', 'call', voicePlugin, 'key-clear', '--input', 'null'], { cwd: installDir, env: providerEnv });
    const symlinkTarget = join(scratch, 'provider-symlink-target');
    const symlinkRoot = join(scratch, 'provider-symlink-root');
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, symlinkRoot, 'dir');
    const symlinkWrite = run(cli, ['plugin', 'call', join(installedPlugins, 'voice'), 'key-set', '--input', '{"key":"must-not-write"}'], {
        cwd: installDir, env: { ...cliEnv(providerHome), MUXR_HOME: symlinkRoot }, allowFailure: true,
    });
    assert.notEqual(symlinkWrite.status, 0, 'provider key write followed a symlinked MUXR_HOME');
    assert.equal(existsSync(join(symlinkTarget, 'xai.key')), false);
    assert.ok(existsSync(join(installDir, 'node_modules', 'ccusage', 'src', 'cli.js')), 'ccusage wrapper missing from installed package');
    const ccusageTarget = ['linux', 'darwin'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)
        ? join(installDir, 'node_modules', '@ccusage', `ccusage-${process.platform}-${process.arch}`, 'bin', 'ccusage')
        : undefined;
    if (ccusageTarget !== undefined) {
        assert.ok(existsSync(ccusageTarget), `ccusage native backend missing for ${process.platform}-${process.arch}`);
        const usageHome = join(scratch, 'usage-home');
        const claudeLogs = join(usageHome, '.claude', 'projects', 'smoke', 'session');
        mkdirSync(claudeLogs, { recursive: true });
        writeFileSync(join(claudeLogs, 'chat.jsonl'), `${JSON.stringify({
            costUSD: 0,
            message: { id: 'smoke', model: 'claude-sonnet-4-20250514', role: 'assistant', usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1 } },
            requestId: 'smoke-request', sessionId: 'smoke-session', timestamp: new Date().toISOString(), version: '2.0.0',
        })}\n`);
        const usagePlugin = join(installDir, 'node_modules', '@trymuxr', 'cli', 'plugins', 'status', 'usage.mjs');
        const usageResult = run(process.execPath, [usagePlugin], { cwd: installDir, env: { ...process.env, HOME: usageHome, PATH: binDir } });
        const usageOutput = JSON.parse(usageResult.stdout);
        assert.ok(usageOutput.items.some((item) => item.id === 'activity-claude' && item.metadata[0]?.value === '2 tokens' && item.action?.type === 'screen'), 'installed Usage did not return a Claude activity item that opens its details');
        assert.notEqual(statSync(ccusageTarget).mode & 0o111, 0, 'packaged ccusage backend stayed non-executable');
        const resolveScript = `const {createRequire}=require('node:module');process.stdout.write(createRequire(${JSON.stringify(usagePlugin)}).resolve('@ccusage/ccusage-${process.platform}-${process.arch}/bin/ccusage'))`;
        const resolvedCcusage = run(process.execPath, ['-e', resolveScript], { cwd: installDir }).stdout;
        assert.equal(resolvedCcusage, ccusageTarget, 'Usage plugin did not resolve its installed native ccusage package');
        const probe = run(resolvedCcusage, ['daily', '--by-agent', '--json', '--offline'], {
            cwd: installDir,
            env: { ...process.env, HOME: usageHome, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' },
        });
        const parsedProbe = JSON.parse(probe.stdout);
        assert.ok(Array.isArray(parsedProbe.daily), 'pinned ccusage changed its --by-agent JSON shape');
        assert.ok(parsedProbe.daily.length > 0, 'ccusage fixture produced no daily row; shape assertions would be vacuous');
        for (const day of parsedProbe.daily) {
            assert.ok(Array.isArray(day.agents), 'pinned ccusage omitted daily[].agents');
            for (const agent of day.agents) {
                assert.equal(typeof agent.agent, 'string');
                assert.equal(typeof agent.totalTokens, 'number');
            }
        }
        assert.ok(parsedProbe.daily.some((day) => day.agents.some((agent) => agent.agent === 'claude')), 'ccusage agent ids no longer match the Usage allowlist');
    }
    const installedUpdate = await import(new URL(`file://${join(installDir, 'node_modules', '@trymuxr', 'cli', 'release/application/updateCli.mjs')}`).href);
    assert.ok(installedUpdate.compareVersions('1.0.0-beta.10', '1.0.0-beta.9') > 0);
    assert.ok(installedUpdate.compareVersions('1.0.0-beta.9', '1.0.0-beta.10') < 0);
    assert.ok(installedUpdate.compareVersions('1.0.0', '1.0.0-rc.1') > 0);
    const promptSmokePath = join(scratch, 'prompt-smoke.mjs');
    const setupUiUrl = new URL(`file://${join(installDir, 'node_modules', '@trymuxr', 'cli', 'setup/presentation/ui.mjs')}`).href;
    writeFileSync(promptSmokePath, `import { prompt } from ${JSON.stringify(setupUiUrl)};\nconst answer = await prompt('Cancel prompt');\nif (answer !== undefined) process.exitCode = 1;\n`);
    const promptSmoke = await runTty(`${process.execPath} ${promptSmokePath}`, cliEnv(), '\u0003', 20_000, undefined, 'never', 'Cancel prompt');
    assert.equal(promptSmoke.code, 0, promptSmoke.output);
    assert.doesNotMatch(promptSmoke.output, /unsettled top-level await|SyntaxError/);
    const menuCancel = await runTty(cli, cliEnv(), '\u0003', 20_000, undefined, 'never', 'What would you like to do?');
    assert.ok(menuCancel.code === 0 || menuCancel.code === 130, menuCancel.output);
    assert.doesNotMatch(menuCancel.output, /Get started\s+ muxr setup/, 'cancelling the menu printed command help');
    const inspectHome = join(scratch, 'inspect-home');
    mkdirSync(inspectHome, { recursive: true });
    const inspectBefore = filesSnapshot(inspectHome);
    const inspected = run(cli, ['setup', '--inspect'], { cwd: installDir, env: cliEnv(inspectHome) });
    assert.match(inspected.stdout, /Inspection complete\. Nothing changed\./);
    assert.equal(filesSnapshot(inspectHome), inspectBefore, '`setup --inspect` mutated a non-TTY HOME');

    const refusalHome = join(scratch, 'refusal-home');
    mkdirSync(refusalHome, { recursive: true });
    const refusal = run(cli, ['setup', '--no-agent-config', '--no-install-herdr'], {
        cwd: installDir,
        env: cliEnvWithoutHerdr(refusalHome),
        allowFailure: true,
    });
    assert.notEqual(refusal.status, 0, '--no-install-herdr accepted a missing Herdr installation');
    assert.match(`${refusal.stdout}${refusal.stderr}`, /herdr is missing/);
    assert.ok(!existsSync(fakeInstallerLog), '--no-install-herdr executed an installer');

    const installerHome = join(scratch, 'installer-home');
    mkdirSync(installerHome, { recursive: true });
    const installerPort = 18_000 + (process.pid % 10_000);
    try {
        run(cli, [
            'setup', '--no-agent-config', '--relay-only',
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
    assert.match(run(cli, ['setup', '--help'], { cwd: installDir, env }).stdout, /Interactive setup installs Herdr when missing/);
    assert.match(run(cli, ['update', '--help'], { cwd: installDir, env }).stdout, /Check npm for a newer/);
    assert.match(run(cli, ['connect', '--help'], { cwd: installDir, env }).stdout, /--enrollment/);
    assert.match(run(cli, ['machines', '--help'], { cwd: installDir, env }).stdout, /machines enroll/);
    assert.equal(filesSnapshot(home), beforeHelp, 'subcommand help changed the home directory');

    const beforeDryRun = filesSnapshot(home);
    run(cli, ['setup', '--dry-run'], { cwd: installDir, env });
    assert.equal(filesSnapshot(home), beforeDryRun, 'dry-run changed the home directory');
    const beforeInvalidList = existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '';
    const invalidList = run(cli, ['setup', ...setupArgs], { cwd: installDir, env: { ...env, FAKE_PLUGIN_LIST: 'not-json' }, allowFailure: true });
    assert.notEqual(invalidList.status, 0, 'setup accepted a malformed Herdr plugin list');
    assert.equal(existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '', beforeInvalidList, 'setup mutated plugins after a malformed list');
    const malformedEntry = run(cli, ['setup', ...setupArgs], {
        cwd: installDir,
        env: { ...env, FAKE_PLUGIN_LIST: JSON.stringify({ result: { plugins: [{ plugin_id: 'muxr.voice', plugin_root: '/old/root' }] } }) },
        allowFailure: true,
    });
    assert.notEqual(malformedEntry.status, 0, 'setup accepted a plugin without an enabled state');
    assert.equal(existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '', beforeInvalidList, 'setup mutated plugins after a malformed entry');

    const configBefore = readFileSync(join(home, '.config', 'herdr', 'config.toml'), 'utf8');
    run(cli, ['setup', ...setupArgs], { cwd: installDir, env });
    const manifestAfterFirst = readFileSync(join(home, '.muxr', 'setup-manifest.json'), 'utf8');
    const freshManifest = JSON.parse(manifestAfterFirst);
    assert.equal(readFileSync(instructionPath, 'utf8'), initialInstructions, 'fresh setup rewrote agent instructions');
    assert.equal(existsSync(join(home, '.muxr', 'integrations', 'muxr')), false, 'fresh setup copied the muxr skill');
    assert.equal(Object.entries(freshManifest.entries).some(([path, entry]) => entry.kind === 'block' || path.includes(`${join('.muxr', 'integrations')}`)), false, 'fresh setup claimed prompt files');
    assert.equal(readdirSync(join(home, '.pi', 'agent')).some((name) => name.startsWith('AGENTS.md.muxr-backup-')), false, 'fresh setup backed up an instruction file it should not touch');
    const pluginRoot = join(installDir, 'node_modules', '@trymuxr', 'cli', 'plugins');
    const firstSetupLinks = readFileSync(fakeLog, 'utf8');
    // One voice plugin ships now; the adapters live inside it.
    assert.match(firstSetupLinks, new RegExp(`plugin link ${join(pluginRoot, 'voice').replaceAll('\\', '\\\\')} --enabled`));
    assert.doesNotMatch(firstSetupLinks, /plugins[/\\]voice-(?:codex|gemini|openai)/, 'setup linked a merged voice adapter as its own plugin');
    const existingProviders = {
        result: {
            plugins: [
                { plugin_id: 'muxr.voice', plugin_root: join(pluginRoot, 'voice'), version: '0.1.0', enabled: false },
                // Any stale direct child of our bundle directory must be retracted;
                // this deliberately names no historical plugin or retirement map.
                { plugin_id: 'muxr.removed-package-smoke', plugin_root: join(pluginRoot, 'removed-package-smoke'), version: '0.1.0', enabled: true },
            ],
        },
    };
    const logBeforeSecondSetup = readFileSync(fakeLog, 'utf8');
    run(cli, ['setup', ...setupArgs], { cwd: installDir, env: { ...env, FAKE_PLUGIN_LIST: JSON.stringify(existingProviders) } });
    const secondSetupLinks = readFileSync(fakeLog, 'utf8').slice(logBeforeSecondSetup.length);
    assert.doesNotMatch(secondSetupLinks, /plugin link .*plugins[/\\]voice(?:\s|[/\\])/, 'setup relinked an existing provider and changed its enabled state');
    assert.match(secondSetupLinks, /plugin unlink muxr\.removed-package-smoke/, 'setup kept a bundled plugin it no longer ships');
    const movedProviders = {
        result: {
            plugins: existingProviders.result.plugins.map((plugin) => ({ ...plugin, plugin_root: join(scratch, 'old-package', plugin.plugin_id) })),
        },
    };
    const logBeforeMovedSetup = readFileSync(fakeLog, 'utf8');
    run(cli, ['setup', ...setupArgs], { cwd: installDir, env: { ...env, FAKE_PLUGIN_LIST: JSON.stringify(movedProviders) } });
    const movedSetupLinks = readFileSync(fakeLog, 'utf8').slice(logBeforeMovedSetup.length);
    assert.match(movedSetupLinks, new RegExp(`plugin link ${join(pluginRoot, 'voice').replaceAll('\\', '\\\\')} --disabled`));
    assert.doesNotMatch(movedSetupLinks, /plugin unlink/, 'setup unlinked a plugin outside its own bundle directory');
    assert.equal(readFileSync(join(home, '.muxr', 'setup-manifest.json'), 'utf8'), manifestAfterFirst);
    if (process.platform === 'darwin') {
        stopRelayFor(join(home, '.muxr', 'relay'));
        for (let attempt = 0; attempt < 30 && await fetch(`http://127.0.0.1:${setupPort}/health`).then((response) => response.ok).catch(() => false); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(!await fetch(`http://127.0.0.1:${setupPort}/health`).then((response) => response.ok).catch(() => false), 'Darwin smoke relay did not stop');
    }
    run(cli, ['daemon', 'install', '--mode', 'selfhost'], { cwd: installDir, env });
    rmSync(fakeServerState, { force: true });
    const deadDoctor = run(cli, ['doctor'], { cwd: installDir, env, allowFailure: true });
    assert.notEqual(deadDoctor.status, 0, 'doctor accepted a stopped Herdr server');
    assert.match(`${deadDoctor.stdout}${deadDoctor.stderr}`, /FAIL\s+herdr server\s+not running/);
    const hungProbeStarted = Date.now();
    const hungDoctor = run(cli, ['doctor'], { cwd: installDir, env: { ...env, FAKE_HERDR_HANG: '1' }, allowFailure: true });
    assert.notEqual(hungDoctor.status, 0, 'doctor accepted an unresponsive Herdr server');
    assert.ok(Date.now() - hungProbeStarted < 3_000, 'unresponsive Herdr blocked doctor');
    const wizardUrl = `file://${join(installDir, 'node_modules', '@trymuxr', 'cli', 'setup/presentation/setupWizard.mjs')}`;
    const deadInspection = run(process.execPath, ['--input-type=module', '-e', `import {probeMachine} from ${JSON.stringify(wizardUrl)}; console.log(JSON.stringify(probeMachine().herdr))`], { cwd: installDir, env });
    assert.equal(JSON.parse(deadInspection.stdout).running, false, 'onboarding accepted a stopped Herdr server');
    const restarted = run(cli, ['daemon', 'restart'], { cwd: installDir, env });
    assert.ok(existsSync(fakeServerState), 'daemon restart did not recover a stopped Herdr server');
    assert.match(restarted.stdout, /herdr server ready[\s\S]*muxr services restarted/);
    const updateNpm = join(scratch, 'update-npm');
    const updateLog = join(scratch, 'update.log');
    writeFileSync(updateNpm, '#!/bin/sh\nif [ "$1" = view ]; then printf \'"%s"\\n\' "${MUXR_UPDATE_LATEST:-9.9.9}"; exit 0; fi\nif [ "$1 $2" = "root --global" ]; then printf "%s\\n" "$MUXR_UPDATE_NPM_ROOT"; exit 0; fi\nif [ "$1" = install ]; then printf "%s\\n" "$*" >> "$MUXR_UPDATE_LOG"; exit 0; fi\nexit 1\n', { mode: 0o755 });
    const updateEnv = { ...env, MUXR_NPM_BIN: updateNpm, MUXR_UPDATE_LOG: updateLog, MUXR_UPDATE_NPM_ROOT: join(installDir, 'node_modules') };
    const cancelledUpdate = await runTty(`${cli} update`, updateEnv, '\r', 20_000, undefined, 'never', 'Apply this update?');
    assert.equal(cancelledUpdate.code, 0, cancelledUpdate.output);
    assert.ok(!existsSync(updateLog), 'pressing Enter applied the update');
    assert.match(run(cli, ['update', '--yes'], { cwd: installDir, env: { ...updateEnv, MUXR_UPDATE_LATEST: '0.0.1' } }).stdout, /newer than npm latest/);
    assert.ok(!existsSync(updateLog), 'updater installed a registry downgrade');
    assert.match(run(cli, ['update', '--check'], { cwd: installDir, env: updateEnv }).stdout, /9\.9\.9 is available/);
    const prefixMismatch = run(cli, ['update', '--yes'], {
        cwd: installDir, env: { ...updateEnv, MUXR_UPDATE_NPM_ROOT: join(scratch, 'different-node', 'node_modules') }, allowFailure: true,
    });
    assert.notEqual(prefixMismatch.status, 0, 'updater accepted npm from a different global prefix');
    assert.match(`${prefixMismatch.stdout}${prefixMismatch.stderr}`, /different npm prefix/);
    assert.ok(!existsSync(updateLog), 'prefix mismatch reached npm install');

    run(cli, ['update', '--yes'], { cwd: installDir, env: updateEnv });
    assert.match(readFileSync(updateLog, 'utf8'), /install --global --ignore-scripts @trymuxr\/cli@9\.9\.9/);
    const linuxUnit = readFileSync(join(home, '.config', 'systemd', 'user', 'muxr.service'), 'utf8');
    assert.match(linuxUnit, /MUXR_MODE=.*selfhost/, 'update removed the daemon mode');
    assert.ok(linuxUnit.includes(`Environment=PATH="${env.PATH}:`), 'Linux daemon dropped the interactive executable path');
    assert.ok(linuxUnit.includes(`Environment=HERDR_BIN="${env.HERDR_BIN}"`), 'Linux daemon did not pin the Herdr binary');
    assert.match(linuxUnit, /StartLimitIntervalSec=60[\s\S]*StartLimitBurst=20/, 'Linux daemon cannot survive bounded rapid restart recovery');
    assert.equal(readFileSync(join(home, '.config', 'herdr', 'config.toml'), 'utf8'), configBefore);
    assert.equal(readFileSync(instructionPath, 'utf8'), initialInstructions, 'update rewrote agent instructions');
    assert.equal(existsSync(join(home, '.muxr', 'integrations')), false, 'update created a copied skill tree');
    const updatedManifest = JSON.parse(readFileSync(join(home, '.muxr', 'setup-manifest.json'), 'utf8'));
    assert.equal(Object.entries(updatedManifest.entries).some(([path, entry]) => entry.kind !== 'owned' || path.includes(`${join('.muxr', 'integrations')}`)), false, 'update claimed an agent prompt file');
    assert.equal(readdirSync(join(home, '.pi', 'agent')).some((name) => name.startsWith('AGENTS.md.muxr-backup-')), false, 'update backed up an instruction file it should not touch');
    assert.equal(statSync(join(home, '.muxr', 'setup-manifest.json')).mode & 0o777, 0o600);
    assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'muxr.service')));
    const stoppedDoctor = run(cli, ['doctor'], { cwd: installDir, env, allowFailure: true });
    assert.notEqual(stoppedDoctor.status, 0, 'doctor accepted a configured relay that was not running');
    assert.match(`${stoppedDoctor.stdout}${stoppedDoctor.stderr}`, /not reachable/);

    const hostedAuthPath = join(home, '.muxr', 'auth.json');
    const key32 = Buffer.alloc(32).toString('base64');
    const key64 = Buffer.alloc(64).toString('base64');
    writeFileSync(hostedAuthPath, `${JSON.stringify({
        version: 1,
        controlUrl: 'https://control.test',
        relayUrl: 'wss://relay.test',
        credential: 'machine-credential',
        credentialExpiresAt: '9999-12-31T23:59:59.999Z',
        machine: { id: 'machine', crypto: {
            signingPublicKey: key32, signingSecretKey: key64, boxPublicKey: key32, boxSecretKey: key32, dataKey: key32,
            keyVersion: 1, devices: [],
            pendingRotation: { keyVersion: 2, dataKey: key32, devices: [], grants: [{ device_public_key: key32, grant: '' }] },
        } },
    })}\n`, { mode: 0o600 });
    const authDoctor = run(cli, ['doctor'], { cwd: installDir, env, allowFailure: true });
    assert.notEqual(authDoctor.status, 0, 'doctor accepted incomplete hosted auth');
    assert.match(`${authDoctor.stdout}${authDoctor.stderr}`, /hosted auth.*incomplete/s);
    const corruptHost = run(cli, ['up'], { cwd: installDir, env: { ...env, MUXR_MODE: 'hosted' }, allowFailure: true });
    assert.equal(corruptHost.status, 0, 'deterministic hosted auth corruption would restart-loop');
    assert.match(`${corruptHost.stdout}${corruptHost.stderr}`, /unsupported or incomplete schema/);
    chmodSync(hostedAuthPath, 0o000);
    const unreadableHost = run(cli, ['up'], { cwd: installDir, env: { ...env, MUXR_MODE: 'hosted' }, allowFailure: true });
    assert.equal(unreadableHost.status, 0, 'unreadable hosted auth would restart-loop');
    assert.match(`${unreadableHost.stdout}${unreadableHost.stderr}`, /cannot be read|EACCES|EPERM/);
    chmodSync(hostedAuthPath, 0o600);
    rmSync(hostedAuthPath, { force: true });

    const localSelfhostPath = join(home, '.muxr', 'selfhost.json');
    const upgradedLocalState = JSON.parse(readFileSync(localSelfhostPath, 'utf8'));
    upgradedLocalState.machineCredential = 'machinetok_stale-upgrade';
    writeFileSync(localSelfhostPath, `${JSON.stringify(upgradedLocalState, null, 2)}\n`, { mode: 0o600 });
    const host = spawn(cli, ['up', '--fake'], { cwd: installDir, env: { ...env, MUXR_MODE: 'selfhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let hostOutput = '';
    host.stdout.on('data', (chunk) => { hostOutput += chunk; });
    host.stderr.on('data', (chunk) => { hostOutput += chunk; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`packaged host did not start\n${hostOutput}`)), 10_000);
        const poll = setInterval(() => {
            if (hostOutput.includes('(fake)')
                && existsSync(join(home, '.muxr', 'relay', 'relay.pid'))
                && existsSync(join(home, '.muxr', 'host', 'peer', 'cli.json'))) {
                clearTimeout(timer);
                clearInterval(poll);
                resolve();
            }
        }, 50);
    });
    run(cli, ['doctor'], { cwd: installDir, env });
    host.kill('SIGTERM');
    await new Promise((resolve) => host.once('exit', resolve));
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('managed relay survived its host service')), 5_000);
        const poll = setInterval(async () => {
            const alive = await fetch(`http://127.0.0.1:${setupPort}/health`).then((response) => response.ok).catch(() => false);
            if (!alive) {
                clearTimeout(timer);
                clearInterval(poll);
                resolve();
            }
        }, 100);
    });

    const lingerLog = join(scratch, 'linger.log');
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(binDir, 'loginctl'), `#!/bin/sh\nif [ "$1" = show-user ]; then echo no; exit 0; fi\necho "$*" >> "${lingerLog}"\nexit 0\n`, { mode: 0o755 });
    const lingerHome = join(scratch, 'linger-home');
    mkdirSync(lingerHome, { recursive: true });
    run(cli, ['daemon', 'install', '--mode', 'relay'], { cwd: installDir, env: cliEnv(lingerHome, { MUXR_NO_SERVICE_COMMANDS: '' }) });
    assert.match(readFileSync(lingerLog, 'utf8'), /enable-linger/, 'relay service did not enable Linux boot persistence');

    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\ncase "$*" in\n  *daemon-reload*) exit 0 ;;\n  *status*) exit 3 ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    const failedServiceHome = join(scratch, 'failed-relay-service-home');
    mkdirSync(failedServiceHome, { recursive: true });
    const failedServicePort = setupPort + 2;
    const failedServiceEnv = cliEnv(failedServiceHome, { MUXR_NO_SERVICE_COMMANDS: '' });
    const failedService = run(cli, ['self-host', '--relay-only', '--managed-relay', '--yes', '--port', String(failedServicePort),
        '--advertise', 'wss://failed-service.example.test', '--connection-mode', 'external'], { cwd: installDir, env: failedServiceEnv, allowFailure: true });
    assert.notEqual(failedService.status, 0, 'relay service failure unexpectedly succeeded');
    assert.ok(await fetch(`http://127.0.0.1:${failedServicePort}/health`).then((response) => response.ok).catch(() => false), 'relay service failure did not restore the temporary relay');
    stopRelayFor(join(failedServiceHome, '.muxr', 'relay'));

    const browserHome = join(scratch, 'browser-home');
    const browserPort = setupPort + 3;
    const browserEnv = cliEnv(browserHome);
    mkdirSync(browserHome, { recursive: true });
    run(cli, ['self-host', '--port', String(browserPort), '--advertise', 'wss://browser.example.test', '--connection-mode', 'external', '--web', '--yes', '--no-pair'], { cwd: installDir, env: browserEnv });
    const browserPair = spawn(cli, ['pair', '--browser'], { cwd: installDir, env: browserEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let browserPairOutput = '';
    browserPair.stdout.on('data', (chunk) => { browserPairOutput += chunk; });
    browserPair.stderr.on('data', (chunk) => { browserPairOutput += chunk; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`browser pairing did not print a short link\n${browserPairOutput}`)), 10_000);
        const poll = setInterval(() => {
            if (!/https:\/\/browser\.example\.test\/pair\?pair=[^\s&]+&role=control/.test(browserPairOutput)) return;
            clearTimeout(timer); clearInterval(poll); resolve();
        }, 50);
    });
    assert.doesNotMatch(browserPairOutput, /muxr:\/\/pair|[?&#]payload=/, 'browser pairing printed the giant payload');
    browserPair.kill('SIGTERM');
    await new Promise((resolve) => browserPair.once('exit', resolve));
    stopRelayFor(join(browserHome, '.muxr', 'relay'));

    const relayHome = join(scratch, 'relay-home');
    mkdirSync(relayHome, { recursive: true });
    const relayEnv = cliEnv(relayHome);
    run(cli, ['daemon', 'install', '--mode', 'relay'], { cwd: installDir, env: relayEnv });
    assert.match(readFileSync(join(relayHome, '.config', 'systemd', 'user', 'muxr.service'), 'utf8'), /MUXR_MODE=.*relay/, 'relay-only daemon mode was not registered');
    assert.match(run(cli, ['doctor'], { cwd: installDir, env: relayEnv }).stdout, /shared relay only/);
    const relayServicePort = setupPort + 1;
    run(cli, ['self-host', '--relay-only', '--managed-relay', '--yes', '--port', String(relayServicePort),
        '--advertise', 'wss://relay.example.test', '--connection-mode', 'external'], { cwd: installDir, env: relayEnv });
    const relayOwnerState = JSON.parse(readFileSync(join(relayHome, '.muxr', 'selfhost.json'), 'utf8'));
    assert.equal(relayOwnerState.relayRole, 'shared');
    assert.equal(relayOwnerState.machine, undefined, 'shared relay owner state retained unused machine private keys');
    stopRelayFor(join(relayHome, '.muxr', 'relay'));
    for (let attempt = 0; attempt < 30 && await fetch(`http://127.0.0.1:${relayServicePort}/health`).then((response) => response.ok).catch(() => false); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const relayService = spawn(cli, ['up'], { cwd: installDir, env: { ...relayEnv, MUXR_MODE: 'relay' }, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('packaged relay-only service did not start')), 10_000);
        const poll = setInterval(async () => {
            if (await fetch(`http://127.0.0.1:${relayServicePort}/health`).then((response) => response.ok).catch(() => false)) {
                clearTimeout(timer); clearInterval(poll); resolve();
            }
        }, 100);
    });
    assert.match(run(cli, ['machines', 'enroll'], { cwd: installDir, env: relayEnv }).stdout, /muxr:\/\/enroll\?payload=/);
    const relayUnitBeforeList = readFileSync(join(relayHome, '.config', 'systemd', 'user', 'muxr.service'), 'utf8');
    assert.match(run(cli, ['machines', 'list'], { cwd: installDir, env: relayEnv }).stdout, /No enrolled machines/);
    assert.equal(readFileSync(join(relayHome, '.config', 'systemd', 'user', 'muxr.service'), 'utf8'), relayUnitBeforeList, 'machine listing rewrote the relay service');
    relayService.kill('SIGTERM');
    await new Promise((resolve) => relayService.once('exit', resolve));
    if (await fetch(`http://127.0.0.1:${relayServicePort}/health`).then((response) => response.ok).catch(() => false)) throw new Error('relay-only service left its relay child running');
    const relayUpdateLog = join(scratch, 'relay-update.log');
    const herdrBeforeRelayUpdate = existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '';
    run(cli, ['update', '--yes'], { cwd: installDir, env: { ...relayEnv, MUXR_NPM_BIN: updateNpm, MUXR_UPDATE_LOG: relayUpdateLog, MUXR_UPDATE_NPM_ROOT: join(installDir, 'node_modules') } });
    assert.match(readFileSync(relayUpdateLog, 'utf8'), /install --global --ignore-scripts @trymuxr\/cli@9\.9\.9/);
    assert.equal(existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '', herdrBeforeRelayUpdate, 'relay-only update mutated Herdr');

    const macHome = join(scratch, 'mac-home');
    const launchctlLog = join(scratch, 'launchctl.log');
    const launchctlState = join(scratch, 'launchctl.state');
    writeFileSync(join(binDir, 'launchctl'), `#!/bin/sh\necho "$*" >> "${launchctlLog}"\ncase "$1" in\n  print) [ -f "${launchctlState}" ] && /bin/cat "${launchctlState}" || exit 1 ;;\n  bootstrap) echo 'state = waiting' > "${launchctlState}" ;;\n  kickstart) echo 'state = running' > "${launchctlState}" ;;\n  bootout) /bin/rm -f "${launchctlState}" ;;\nesac\n`, { mode: 0o755 });
    mkdirSync(macHome, { recursive: true });
    const macEnv = cliEnv(macHome, { MUXR_PLATFORM: 'darwin', MUXR_NO_SERVICE_COMMANDS: '' });
    run(cli, ['daemon', 'install'], { cwd: installDir, env: macEnv });
    const macPlist = readFileSync(join(macHome, 'Library', 'LaunchAgents', 'com.muxr.host.plist'), 'utf8');
    assert.match(macPlist, /com\.muxr\.host/);
    assert.match(macPlist, /<key>RunAtLoad<\/key><true\/>/, 'macOS daemon will not start automatically after login');
    assert.ok(macPlist.includes(`<key>PATH</key><string>${macEnv.PATH}:`), 'macOS daemon dropped the interactive executable path');
    assert.ok(macPlist.includes(`<key>HERDR_BIN</key><string>${macEnv.HERDR_BIN}</string>`), 'macOS daemon did not pin the Herdr binary');
    run(cli, ['daemon', 'start'], { cwd: installDir, env: macEnv });
    assert.match(readFileSync(launchctlLog, 'utf8'), /bootstrap[\s\S]*kickstart/, 'first macOS start did not kickstart after bootstrap');
    run(cli, ['daemon', 'start'], { cwd: installDir, env: macEnv });
    assert.match(readFileSync(launchctlLog, 'utf8'), /bootstrap[\s\S]*kickstart[\s\S]*bootout[\s\S]*bootstrap[\s\S]*kickstart/, 'macOS start reused a stale loaded plist');

    const staleHerdr = join(macHome, 'Library', 'LaunchAgents', 'herdr-server.plist');
    const repairHerdr = join(binDir, 'herdr-repair');
    writeFileSync(staleHerdr, '<plist><dict><key>Label</key><string>dev.herdr.server</string><key>ProgramArguments</key><array><string>/missing/herdr</string><string>server</string></array></dict></plist>\n');
    writeFileSync(repairHerdr, '#!/bin/sh\n[ "$*" = "status server --json" ] && echo \'{"running":true}\'\nexit 0\n', { mode: 0o755 });
    const herdrLifecycleUrl = `file://${join(installDir, 'node_modules', '@trymuxr', 'cli', 'setup/infrastructure/herdr.mjs')}`;
    run(process.execPath, ['--input-type=module', '-e', `import {ensureHerdrServer} from ${JSON.stringify(herdrLifecycleUrl)}; await ensureHerdrServer(${JSON.stringify(repairHerdr)})`], {
        cwd: installDir, env: macEnv, allowFailure: true,
    });
    assert.match(readFileSync(staleHerdr, 'utf8'), new RegExp(repairHerdr.replaceAll('/', '\\/')), 'stale Herdr plist was not repaired');
    assert.match(readFileSync(launchctlLog, 'utf8'), /bootout gui\/\d+\/dev\.herdr\.server[\s\S]*bootstrap gui\/\d+ .*herdr-server\.plist[\s\S]*kickstart -k gui\/\d+\/dev\.herdr\.server/, 'loaded repaired Herdr plist was not reloaded by its declared label');
    run(cli, ['daemon', 'status'], { cwd: installDir, env: macEnv });
    run(cli, ['daemon', 'uninstall'], { cwd: installDir, env: macEnv });

    writeFileSync(join(home, '.muxr', 'xai.key'), 'xai-user-owned\n', { mode: 0o600 });
    run(cli, ['daemon', 'uninstall'], { cwd: installDir, env });
    run(cli, ['integrations', 'uninstall'], { cwd: installDir, env });
    assert.equal(readFileSync(instructionPath, 'utf8'), initialInstructions);
    assert.ok(existsSync(join(home, '.muxr', 'xai.key')), 'narrow integration uninstall removed provider data');

    mkdirSync(join(home, '.muxr', 'dist'), { recursive: true });
    mkdirSync(join(home, '.muxr', 'keys'), { recursive: true });
    mkdirSync(join(home, '.muxr', 'host', 'attachments'), { recursive: true });
    writeFileSync(join(home, '.muxr', 'dist', 'user-export.apk'), 'keep-export\n');
    writeFileSync(join(home, '.muxr', 'keys', 'signing-key'), 'keep-signing-key\n', { mode: 0o600 });
    writeFileSync(join(home, '.muxr', 'host', 'attachments', 'received.png'), 'keep-attachment\n');
    writeFileSync(join(home, '.muxr', 'host', 'runtime.json'), 'remove-runtime\n');
    run(cli, ['uninstall', '--yes'], { cwd: installDir, env });
    assert.ok(!existsSync(join(home, '.muxr', 'xai.key')), 'full uninstall retained a muxr provider key');
    assert.ok(existsSync(join(home, '.muxr', 'dist', 'user-export.apk')), 'full uninstall removed a user export');
    assert.ok(existsSync(join(home, '.muxr', 'keys', 'signing-key')), 'full uninstall removed a signing key');
    assert.ok(existsSync(join(home, '.muxr', 'host', 'attachments', 'received.png')), 'full uninstall removed a received attachment');
    assert.ok(!existsSync(join(home, '.muxr', 'host', 'runtime.json')), 'full uninstall retained host runtime state');
    assert.ok(existsSync(join(binDir, 'herdr')), 'full uninstall removed Herdr');
    assert.match(readFileSync(instructionPath, 'utf8'), /Keep this line\./);

    const stoppedHerdr = join(binDir, 'herdr-stopped');
    writeFileSync(stoppedHerdr, '#!/bin/sh\necho \'{"id":"cli:plugin","error":{"code":"server_not_running"}}\' >&2\nexit 1\n', { mode: 0o755 });
    mkdirSync(join(home, '.muxr'), { recursive: true });
    writeFileSync(join(home, '.muxr', 'setup-manifest.json'), `${JSON.stringify({ version: 1, entries: {}, herdrInstalled: ['pi'] })}\n`, { mode: 0o600 });
    const partial = run(cli, ['uninstall', '--yes'], { cwd: installDir, env: { ...env, HERDR_BIN: stoppedHerdr }, allowFailure: true });
    assert.equal(partial.status, 1, 'Herdr-down uninstall falsely reported complete success');
    assert.doesNotMatch(`${partial.stdout}${partial.stderr}`, /server_not_running|"error"\s*:/, 'Herdr-down uninstall leaked a raw server response');
    assert.match(`${partial.stdout}${partial.stderr}`, /cleanup is incomplete/);

    run('npm', ['uninstall', 'muxr', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: installDir,
        env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') },
    });

    process.stdout.write(`package smoke passed: ${tarball}\n`);
} finally {
    stopRelayFor(join(home, '.muxr', 'relay'));
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
