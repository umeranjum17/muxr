/** Assemble and license-audit the self-hostable npm artifact in dist-npm/ (host + relay + CLI). */
import { build } from 'esbuild';
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { licenseInventory, writeThirdPartyInventory } from './licenseInventory.mjs';
import { releaseCompatibility } from './repairHost.mjs';
import { distribution } from '../domain/channel.mjs';
import { bundleVoiceRuntime } from './bundleVoiceRuntime.mjs';
import { runtimeDependencies as deriveRuntimeDependencies } from './runtimeDependencies.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const out = join(root, 'dist-npm');
const rootPackage = require(join(root, 'package.json'));
const release = distribution(process.env.MUXR_RELEASE_VERSION?.trim() || rootPackage.version,
    process.env.MUXR_RELEASE_CHANNEL?.trim() || undefined);
const version = release.version;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim() !== '';
const releaseMetadata = { ...release, commit, sourceTree, sourceDirty };
// The desktop engine is a dependency, not inlined: installing muxr installs
// @desklink/host, whose optional platform package carries the prebuilt engine.
// The link loads libsodium's native addon, which cannot be bundled: install it.
const runtimeDependencies = deriveRuntimeDependencies(root);
const external = Object.keys(runtimeDependencies);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
    absWorkingDir: join(root, 'apps', 'host', 'dist'),
    entryPoints: ['main.js'],
    outfile: join(out, 'host.js'),
    preserveSymlinks: true,
    define: { 'process.env.MUXR_PACKAGED': '"1"' },
    minifySyntax: true,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    metafile: true,
    minifyWhitespace: true,
    legalComments: 'none',
    logLevel: 'warning',
});
await build({
    entryPoints: ['packages/crypto/dist/index.js'],
    outfile: join(out, 'crypto.js'),
    preserveSymlinks: true,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    minifyWhitespace: true,
    legalComments: 'none',
    logLevel: 'warning',
});

await build({
    entryPoints: ['apps/relay/dist/main.js'],
    outfile: join(out, 'relay.js'),
    preserveSymlinks: true,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    minifyWhitespace: true,
    legalComments: 'none',
    logLevel: 'warning',
});

const voiceResult = await bundleVoiceRuntime({ root, out, external });

const dependencies = licenseInventory({
    bundles: [
        { root: join(root, 'apps', 'host', 'dist'), metafile: result.metafile },
        { root, metafile: voiceResult.metafile },
    ],
    root,
    rootPackage,
    declared: runtimeDependencies,
});
const reactNative = dependencies.find((dependency) => dependency.name === 'react-native');
writeThirdPartyInventory({
    inventoryPath: join(out, 'THIRD_PARTY_LICENSES.json'),
    licenseDir: join(out, 'LICENSES', 'npm'),
    artifact: `@trymuxr/cli@${version}`,
    dependencies,
});
const contractResult = await build({
    entryPoints: ['packages/contract/dist/index.js'],
    outfile: join(out, 'contract.mjs'),
    preserveSymlinks: true,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    metafile: true,
    minifyWhitespace: true,
    legalComments: 'none',
    logLevel: 'warning',
});
const zodInput = [...Object.keys(result.metafile.inputs), ...Object.keys(contractResult.metafile.inputs), ...Object.keys(voiceResult.metafile.inputs)]
    .find((input) => /(?:^|\/)node_modules\/zod\//.test(input.replaceAll('\\', '/')));
if (zodInput !== undefined) throw new Error(`package artifact must not bundle Zod (${zodInput})`);
const copyContext = (name) => {
    cpSync(join(root, 'scripts', name), join(out, name), {
        recursive: true,
        filter: (src) => {
            if (src.endsWith('.ts') || src.endsWith('tsconfig.json') || src.endsWith('.tsbuildinfo')) return false;
            if (name !== 'diagnostics' || !src.endsWith('.mjs')) return true;
            const base = src.split(/[\\/]/).pop();
            return base === 'index.mjs' || base === 'dumpDiagnostics.mjs' || base === 'waitForRelay.mjs';
        },
    });
};
copyFileSync(join(root, 'scripts', 'cli.mjs'), join(out, 'cli.mjs'));
copyFileSync(join(root, 'muxr.config.example.json'), join(out, 'muxr.config.example.json'));
for (const context of ['setup', 'release', 'diagnostics', 'terminal', 'naming', 'preview', 'accounts']) copyContext(context);
if (!existsSync(join(out, 'setup', 'domain', 'dist', 'index.js'))) {
    throw new Error('setup domain was not compiled; run yarn build before packing');
}
cpSync(join(root, 'resources'), join(out, 'resources'), { recursive: true });
// The retention rules live in one compiled host module so `muxr artifacts` and
// the host's daily sweep cannot drift apart. It imports only node builtins,
// which is why it copies verbatim instead of being bundled.
mkdirSync(join(out, 'artifacts'), { recursive: true });
copyFileSync(
    join(root, 'apps', 'host', 'dist', 'agent', 'infrastructure', 'artifactRetention.js'),
    join(out, 'artifacts', 'retention.mjs'),
);
cpSync(join(root, 'skills', 'muxr'), join(out, 'skills', 'muxr'), { recursive: true });
const webDist = join(root, 'apps', 'mobile', 'dist');
if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error('web export missing; run `yarn web:export` before packing');
}
const newestMtime = (path) => {
    const info = statSync(path);
    if (!info.isDirectory()) return info.mtimeMs;
    return Math.max(info.mtimeMs, ...readdirSync(path).map((name) => newestMtime(join(path, name))));
};
const webInputs = ['apps/mobile/sources', 'apps/mobile/app.config.js', 'apps/mobile/package.json']
    .map((path) => join(root, path));
const sourceMtime = Math.max(...webInputs.map(newestMtime));
if (statSync(join(webDist, 'index.html')).mtimeMs < sourceMtime) {
    throw new Error('web export is stale; run `yarn web:export` before packing');
}
cpSync(webDist, join(out, 'web'), { recursive: true });
copyFileSync(join(root, 'install.sh'), join(out, 'web', 'install.sh'));
chmodSync(join(out, 'cli.mjs'), 0o755);

copyFileSync(join(root, 'docs', 'npm-readme.md'), join(out, 'README.md'));
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(root, file), join(out, file));
cpSync(join(root, 'LICENSES'), join(out, 'LICENSES'), { recursive: true });

const pkg = {
    name: '@trymuxr/cli',
    version,
    muxrRelease: releaseMetadata,
    muxrCompatibility: releaseCompatibility,
    description: 'Control every Herdr coding agent from your phone with a self-hosted encrypted relay.',
    license: 'Apache-2.0',
    type: 'module',
    bin: { muxr: './cli.mjs' },
    engines: { node: '>=22' },
    files: [
        '*.mjs',
        'release.json',
        'setup/',
        'release/',
        'diagnostics/',
        'terminal/',
        'naming/',
        'preview/',
        'accounts/',
        'host.js',
        'relay.js',
        'crypto.js',
        'README.md',
        'LICENSE',
        'NOTICE',
        'LICENSES/',
        'THIRD_PARTY_LICENSES.json',
        'voice/',
        'resources/',
        'artifacts/',
        'skills/',
        'web/',
    ],
    // react-native-zeroconf declares react-native as an unbounded required
    // peer (>=0.60), so left to itself a consumer install resolves today's
    // latest — a dependency tree the audit never walked. Pin the audited
    // version so consumers install exactly the closure the inventory names.
    // ponytail: pins only this peer; surface required-peer edges from
    // installedClosure if another package drifts the same way.
    dependencies: {
        ...runtimeDependencies,
        ...(reactNative === undefined ? {} : { 'react-native': reactNative.auditedVersion }),
    },
    repository: { type: 'git', url: 'git+https://github.com/umeranjum17/muxr.git' },
    homepage: 'https://trymuxr.com',
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(join(out, 'release.json'), `${JSON.stringify(releaseMetadata, null, 2)}\n`);
process.stdout.write(`packed self-hostable @trymuxr/cli@${version} -> dist-npm/ (${dependencies.length} audited dependencies)\n`);
