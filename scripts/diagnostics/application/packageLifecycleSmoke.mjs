import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseNpmSpec, readNpmArchive, installPlugin, updatePlugin, removePlugin, listPlugins } from '../../plugin/index.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-package-lifecycle-'));
const homeParent = mkdtempSync(join(homedir(), '.muxr-package-lifecycle-'));
const home = join(homeParent, 'home');
const bin = join(scratch, 'bin');
const statePath = join(scratch, 'herdr.json');
const logPath = join(scratch, 'herdr.log');
const npmArgvPath = join(scratch, 'npm-argv.log');
const failurePath = join(scratch, 'failure.once');
mkdirSync(bin, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(bin, 'herdr'), `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const [command, sub, ...rest] = process.argv.slice(2); const state = process.env.FAKE_STATE; const log = process.env.FAKE_LOG;
const read = () => existsSync(state) && readFileSync(state, 'utf8').trim() ? JSON.parse(readFileSync(state, 'utf8')) : undefined;
const save = (value) => writeFileSync(state, JSON.stringify(value));
const maybeFail = () => { if (process.env.FAKE_FAIL === sub && !existsSync(process.env.FAKE_FAIL_FILE)) { writeFileSync(process.env.FAKE_FAIL_FILE, 'used'); process.stderr.write('injected failure'); process.exit(1); } };
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
if (command === 'plugin' && sub === 'list') { const value = read(); process.stdout.write(JSON.stringify({ result: { plugins: value ? [value] : [] } })); process.exit(0); }
if (command === 'plugin' && sub === 'install') {
    const source = rest[0];
    if (process.env.FAKE_GIT_FAIL === source) { process.stderr.write('native install cancelled'); process.exit(1); }
    const refIndex = rest.indexOf('--ref'); const ref = refIndex < 0 ? undefined : rest[refIndex + 1];
    save({ plugin_id: 'test.github', name: 'Git lifecycle', version: ref ?? 'default', plugin_root: '/native/test.github', enabled: true, source: { kind: 'github', owner: 'owner', repo: 'repo', ref }, actions: [], build: [], startup: [], events: [], panes: [], link_handlers: [] }); process.exit(0);
}
if (command === 'plugin' && sub === 'uninstall') { maybeFail(); if (existsSync(state)) writeFileSync(state, ''); process.exit(0); }
if (command === 'plugin' && sub === 'link') {
    maybeFail(); const root = rest[0]; const text = readFileSync(root + '/herdr-plugin.toml', 'utf8'); const id = /^id\\s*=\\s*\"([^\"]+)\"/m.exec(text)[1];
    const pkg = existsSync(root + '/package.json') ? JSON.parse(readFileSync(root + '/package.json', 'utf8')) : {};
    save({ plugin_id: id, name: pkg.name ?? id, version: pkg.version ?? '1.0.0', plugin_root: root, enabled: false, source: { kind: 'local' }, actions: [], build: [], startup: [], events: [], panes: [], link_handlers: [] }); process.exit(0);
}
if (command === 'plugin' && sub === 'enable') { maybeFail(); const value = read(); const root = value.plugin_root; const text = readFileSync(root + '/herdr-plugin.toml', 'utf8'); const parsedId = /^id\\s*=\\s*\"([^\"]+)\"/m.exec(text)?.[1]; if (parsedId !== value.plugin_id) process.exit(1); value.enabled = true; save(value); process.exit(0); }
if (command === 'plugin' && sub === 'disable') { maybeFail(); const value = read(); value.enabled = false; save(value); process.exit(0); }
if (command === 'plugin' && sub === 'unlink') { maybeFail(); if (existsSync(state)) writeFileSync(state, ''); process.exit(0); }
process.stderr.write('unexpected fake herdr command'); process.exit(1);
`, { mode: 0o755 });

function tarEntry(path, body, type = '0', mode = 0o644) {
    const header = Buffer.alloc(512, 0);
    header.write(path, 0, 100, 'utf8');
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    header.write((type === '5' ? 0 : body.length).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header[156] = type.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0); body.copy(padded);
    return Buffer.concat([header, padded]);
}
function archive(entries) { return gzipSync(Buffer.concat([...entries.map(([path, body, type, mode]) => tarEntry(path, Buffer.from(body), type, mode)), Buffer.alloc(1024)])); }
const packageV1 = archive([
    ['package/package.json', '{"name":"pkg","version":"1.0.0"}'],
    ['package/herdr-plugin.toml', 'id = "test.npm"\nname = "Npm lifecycle"\nversion = "1.0.0"\n'],
    ['package/run.sh', '#!/bin/sh\nexit 0\n', '0', 0o755],
]);
const packageV2 = archive([
    ['package/package.json', '{"name":"pkg","version":"2.0.0"}'],
    ['package/herdr-plugin.toml', 'id = "test.npm"\nname = "Npm lifecycle"\nversion = "2.0.0"\n'],
    ['package/run.sh', '#!/bin/sh\nexit 0\n', '0', 0o755],
]);
const malicious = archive([['package/../escape', 'bad']]);
const scopedPackage = archive([
    ['package/package.json', '{"name":"@scope/pkg","version":"1.2.3"}'],
    ['package/herdr-plugin.toml', 'id = "test.scoped"\nname = "Scoped lifecycle"\nversion = "1.2.3"\n'],
]);
writeFileSync(join(scratch, 'pkg-1.0.0.tgz'), packageV1);
writeFileSync(join(scratch, 'pkg-2.0.0.tgz'), packageV2);
writeFileSync(join(scratch, 'pkg-9.9.9.tgz'), malicious);
writeFileSync(join(scratch, 'scoped-1.2.3.tgz'), scopedPackage);
const integrity = (data) => `sha512-${createHash('sha512').update(data).digest('base64')}`;
writeFileSync(join(bin, 'npm'), `#!/bin/sh
spec=""; destination=""; previous=""; name="pkg"
printf '%s\\n' "$@" >> "$FAKE_NPM_ARGV"
for arg in "$@"; do
  if [ "$previous" = "--pack-destination" ]; then destination="$arg"; fi
  case "$arg" in pkg@*|@scope/pkg@*) spec="$arg";; esac
  previous="$arg"
done
case "$spec" in
  pkg@1.0.0) archive="$FAKE_NPM_V1"; filename="pkg-1.0.0.tgz"; version="1.0.0"; integrity="$FAKE_NPM_I1";;
  pkg@2.0.0) archive="$FAKE_NPM_V2"; filename="pkg-2.0.0.tgz"; version="2.0.0"; integrity="$FAKE_NPM_I2";;
  pkg@9.9.9) archive="$FAKE_NPM_BAD"; filename="pkg-9.9.9.tgz"; version="9.9.9"; integrity="$FAKE_NPM_IB";;
  @scope/pkg@1.2.3) archive="$FAKE_NPM_SCOPED"; filename="scoped-1.2.3.tgz"; version="1.2.3"; integrity="$FAKE_NPM_IS"; name="@scope/pkg";;
  *) echo "unexpected fake npm spec: $spec" >&2; exit 1;;
esac
cp "$archive" "$destination/$filename"
printf '[{"name":"%s","version":"%s","filename":"%s","integrity":"%s"}]\\n' "$name" "$version" "$filename" "$integrity"
`, { mode: 0o755 });

async function captureOutput(action) {
    const original = process.stdout.write;
    let output = '';
    process.stdout.write = (chunk, ...args) => { output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk); return true; };
    try { return { value: await action(), output }; } finally { process.stdout.write = original; }
}

try {
    process.env.MUXR_HOME = join(home, '.muxr');
    process.env.HERDR_BIN = join(bin, 'herdr');
    process.env.FAKE_STATE = statePath;
    process.env.FAKE_LOG = logPath;
    process.env.FAKE_NPM_V1 = join(scratch, 'pkg-1.0.0.tgz');
    process.env.FAKE_NPM_V2 = join(scratch, 'pkg-2.0.0.tgz');
    process.env.FAKE_NPM_BAD = join(scratch, 'pkg-9.9.9.tgz');
    process.env.FAKE_NPM_I1 = integrity(packageV1);
    process.env.FAKE_NPM_I2 = integrity(packageV2);
    process.env.FAKE_NPM_IB = integrity(malicious);
    process.env.FAKE_NPM_SCOPED = join(scratch, 'scoped-1.2.3.tgz');
    process.env.FAKE_NPM_IS = integrity(scopedPackage);
    process.env.FAKE_NPM_ARGV = npmArgvPath;
    process.env.FAKE_FAIL_FILE = failurePath;
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const packedPath = join(process.cwd(), 'dist-npm', 'plugin', 'index.mjs');
    assert.ok(existsSync(packedPath), 'packed CLI plugin index is missing');
    const packedPackage = await import(pathToFileURL(packedPath).href);
    assert.equal(typeof packedPackage.installPlugin, 'function', 'packed CLI installPlugin did not import');

    assert.deepEqual(parseNpmSpec('npm:@scope/pkg@1.2.3'), { kind: 'npm', name: '@scope/pkg', version: '1.2.3' });
    assert.throws(() => parseNpmSpec('npm:pkg@^1.2.3'), /exact registry version/);
    assert.equal(readNpmArchive(packageV1).size, 3);
    assert.throws(() => readNpmArchive(malicious), /unsafe|package/);

    assert.equal(await installPlugin(['npm:@scope/pkg@1.2.3', '--yes']), 0);
    assert.match(readFileSync(npmArgvPath, 'utf8'), /--@scope:registry=https:\/\/registry\.npmjs\.org\//);
    assert.equal(await removePlugin(['test.scoped', '--yes']), 0);

    // A malformed identity cannot reach Herdr and leaves no registry orphan.
    const smuggleRoot = join(scratch, 'smuggle'); mkdirSync(smuggleRoot);
    writeFileSync(join(smuggleRoot, 'herdr-plugin.toml'), '"id" = "smuggle.one"\nid = "smuggle.two"\nname = "bad"\n');
    await assert.rejects(installPlugin([smuggleRoot, '--yes']), /quoted id|exactly one|simple quoted/);
    assert.equal(readFileSync(statePath, 'utf8'), '', 'quoted-key id smuggle created a registry entry');
    assert.equal(existsSync(join(home, '.muxr', 'plugins', 'smuggle.one')), false);
    const multilineRoot = join(scratch, 'multiline'); mkdirSync(multilineRoot);
    writeFileSync(join(multilineRoot, 'herdr-plugin.toml'), 'id = "smuggle.multi"\nname = """\nsmuggle\n"""\n');
    await assert.rejects(installPlugin([multilineRoot, '--yes']), /multiline/);
    assert.equal(readFileSync(statePath, 'utf8'), '', 'multiline id smuggle created a registry entry');

    assert.equal(await installPlugin(['npm:pkg@1.0.0', '--yes']), 0);
    const extensionRoot = join(home, '.muxr', 'extensions');
    const materialized = join(extensionRoot, 'test.npm');
    const provenancePath = join(extensionRoot, '.provenance', 'test.npm.json');
    const installed = JSON.parse(readFileSync(statePath));
    assert.equal(installed.enabled, true);
    assert.equal(installed.plugin_root, materialized);
    assert.equal(statSync(join(materialized, 'run.sh')).mode & 0o777, 0o700, 'declared executable did not materialize safely executable');
    assert.equal(statSync(join(materialized, 'package.json')).mode & 0o777, 0o600, 'ordinary file became executable');
    const provenance = JSON.parse(readFileSync(provenancePath));
    assert.deepEqual(provenance, {
        schemaVersion: 1, pluginId: 'test.npm', root: materialized, name: 'pkg', version: '1.0.0', integrity: integrity(packageV1),
    });
    const listed = await captureOutput(() => listPlugins());
    assert.equal(listed.value, 0);
    assert.match(listed.output, /test\.npm\t1\.0\.0\tenabled\t\{"kind":"npm","name":"pkg","version":"1\.0\.0","integrity":"/);
    const logAfterInstall = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const linkIndex = logAfterInstall.findIndex((args) => args[0] === 'plugin' && args[1] === 'link');
    const enableIndex = logAfterInstall.findIndex((args) => args[0] === 'plugin' && args[1] === 'enable');
    assert.ok(linkIndex >= 0 && enableIndex > linkIndex);
    assert.equal(logAfterInstall[linkIndex].at(-1), '--disabled', 'npm link was not disabled before confirmation/enable');

    const assertRollback = async (phase) => {
        rmSync(failurePath, { force: true }); process.env.FAKE_FAIL = phase;
        await assert.rejects(updatePlugin(['npm:pkg@2.0.0', '--yes']), /injected failure|rollback failed/);
        delete process.env.FAKE_FAIL;
        const restored = JSON.parse(readFileSync(statePath));
        assert.equal(restored.enabled, true, `${phase} changed enabled state`);
        assert.equal(JSON.parse(readFileSync(join(materialized, 'package.json'))).version, '1.0.0', `${phase} changed live files`);
        assert.equal(JSON.parse(readFileSync(provenancePath)).version, '1.0.0', `${phase} changed provenance`);
    };
    await assertRollback('disable');
    await assertRollback('unlink');
    await assertRollback('enable');

    assert.equal(spawnSync(process.env.HERDR_BIN, ['plugin', 'disable', 'test.npm'], { env: process.env }).status, 0);
    assert.equal(JSON.parse(readFileSync(statePath)).enabled, false);
    assert.equal(await updatePlugin(['npm:pkg@2.0.0', '--yes']), 0);
    const updated = JSON.parse(readFileSync(statePath));
    assert.equal(updated.enabled, false, 'update changed the previous disabled state');
    assert.equal(updated.plugin_id, 'test.npm');
    assert.equal(updated.name, 'pkg');
    assert.equal(updated.plugin_root, materialized);
    assert.equal(JSON.parse(readFileSync(provenancePath)).version, '2.0.0');
    assert.equal(JSON.parse(readFileSync(join(materialized, 'package.json'))).version, '2.0.0');

    assert.equal(await removePlugin(['test.npm', '--yes']), 0);
    assert.equal(existsSync(materialized), false, 'remove left npm materialization behind');
    assert.equal(existsSync(provenancePath), false, 'remove left npm provenance behind');
    assert.equal(existsSync(statePath) && readFileSync(statePath, 'utf8') !== '', false);

    // A symlinked parent must not make host/package ownership disagree. The
    // stored provenance root stays canonical and exact while list/update/remove
    // resolve the already-owner-checked extensions directory to the same root.
    const directMuxrHome = process.env.MUXR_HOME;
    const aliasedHome = join(scratch, 'home-alias');
    symlinkSync(home, aliasedHome, 'dir');
    process.env.MUXR_HOME = join(aliasedHome, '.muxr');
    try {
        assert.equal(await installPlugin(['npm:pkg@1.0.0', '--yes']), 0);
        const canonicalAliasRoot = realpathSync(join(process.env.MUXR_HOME, 'extensions'));
        const aliasMaterialized = join(canonicalAliasRoot, 'test.npm');
        const aliasProvenance = join(canonicalAliasRoot, '.provenance', 'test.npm.json');
        const aliasListed = await captureOutput(() => listPlugins());
        assert.equal(aliasListed.value, 0);
        assert.match(aliasListed.output, /test\.npm\t1\.0\.0\tenabled\t\{"kind":"npm"/);
        assert.equal(await updatePlugin(['npm:pkg@2.0.0', '--yes']), 0);
        assert.equal(JSON.parse(readFileSync(aliasProvenance, 'utf8')).version, '2.0.0');
        assert.equal(await removePlugin(['test.npm', '--yes']), 0);
        assert.equal(existsSync(aliasMaterialized), false, 'aliased remove left npm materialization behind');
        assert.equal(existsSync(aliasProvenance), false, 'aliased remove left npm provenance behind');
    } finally {
        process.env.MUXR_HOME = directMuxrHome;
    }

    await assert.rejects(installPlugin(['npm:pkg@9.9.9', '--yes']), /unsafe|package/);
    assert.equal(existsSync(materialized), false);

    // GitHub lifecycle stays native to Herdr, including ref changes, explicit
    // confirmation forwarding, uninstall, and failed native replacement.
    await installPlugin(['owner/repo@v1']);
    const githubV1 = JSON.parse(readFileSync(statePath));
    assert.equal(githubV1.source.ref, 'v1');
    const githubInstallArgs = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).findLast((args) => args[0] === 'plugin' && args[1] === 'install');
    assert.ok(githubInstallArgs);
    assert.equal(githubInstallArgs.includes('--yes'), false, 'native install received implicit --yes');
    await updatePlugin(['owner/repo@v2', '--yes']);
    assert.equal(JSON.parse(readFileSync(statePath)).source.ref, 'v2');
    const githubUpdateArgs = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).findLast((args) => args[0] === 'plugin' && args[1] === 'install');
    assert.equal(githubUpdateArgs.includes('--yes'), true, 'explicit --yes was not forwarded to native install');
    process.env.FAKE_GIT_FAIL = 'owner/repo';
    await assert.rejects(updatePlugin(['owner/repo@v3', '--yes']), /native install cancelled/);
    delete process.env.FAKE_GIT_FAIL;
    assert.deepEqual(JSON.parse(readFileSync(statePath)), { ...githubV1, version: 'v2', source: { ...githubV1.source, ref: 'v2' } });
    await removePlugin(['test.github', '--yes']);
    assert.equal(readFileSync(statePath, 'utf8'), '');
    const githubRemoveArgs = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).findLast((args) => args[0] === 'plugin' && args[1] === 'uninstall');
    assert.ok(githubRemoveArgs, 'GitHub remove did not use Herdr uninstall');

    // Local install/update/remove and a declined confirmation use the same
    // Herdr registry lifecycle as npm packages.
    const localRoot = join(scratch, 'local-plugin'); mkdirSync(localRoot);
    writeFileSync(join(localRoot, 'herdr-plugin.toml'), 'id = "local.my-plugin"\nname = "Local"\nversion = "1.0.0"\n');
    await installPlugin([localRoot]);
    assert.equal(readFileSync(statePath, 'utf8'), '', 'cancelled local install left a registry entry');
    await installPlugin([localRoot, '--yes']);
    assert.equal(JSON.parse(readFileSync(statePath)).enabled, true);
    writeFileSync(join(localRoot, 'herdr-plugin.toml'), 'id = "local.my-plugin"\nname = "Local updated"\nversion = "2.0.0"\n');
    await updatePlugin([localRoot, '--yes']);
    assert.equal(JSON.parse(readFileSync(statePath)).plugin_root, realpathSync(localRoot));
    await removePlugin(['my-plugin', '--yes']);
    assert.equal(readFileSync(statePath, 'utf8'), '');

    const liveLock = join(extensionRoot, '.locks', 'test.npm.lock');
    mkdirSync(join(extensionRoot, '.locks'), { recursive: true });
    mkdirSync(liveLock);
    writeFileSync(join(liveLock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: 0 }));
    await assert.rejects(installPlugin(['npm:pkg@1.0.0', '--yes']), /already being changed/);
    rmSync(extensionRoot, { recursive: true, force: true });

    // Managed directories are never followed when an install needs them.
    const muxrRoot = join(home, '.muxr');
    const outside = join(scratch, 'outside'); mkdirSync(outside);
    rmSync(extensionRoot, { recursive: true, force: true }); symlinkSync(outside, extensionRoot, 'dir');
    await assert.rejects(installPlugin(['npm:pkg@1.0.0', '--yes']), /extensions.*directory/);
    unlinkSync(extensionRoot); writeFileSync(extensionRoot, 'not a directory');
    await assert.rejects(installPlugin(['npm:pkg@1.0.0', '--yes']), /extensions.*directory/);
    rmSync(extensionRoot, { force: true }); mkdirSync(extensionRoot);
    symlinkSync(outside, join(extensionRoot, '.provenance'), 'dir');
    await assert.rejects(installPlugin(['npm:pkg@1.0.0', '--yes']), /provenance.*directory/);
    unlinkSync(join(extensionRoot, '.provenance')); mkdirSync(join(extensionRoot, '.provenance'));
    rmSync(join(extensionRoot, '.locks'), { recursive: true, force: true });
    symlinkSync(outside, join(extensionRoot, '.locks'), 'dir');
    await assert.rejects(installPlugin(['npm:pkg@1.0.0', '--yes']), /locks.*directory/);
    assert.equal(lstatSync(outside).isDirectory(), true, 'managed-directory checks followed an outside symlink');

    process.stdout.write('package lifecycle smoke passed\n');
} finally { rmSync(scratch, { recursive: true, force: true }); rmSync(homeParent, { recursive: true, force: true }); }
