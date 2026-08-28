/** Assemble and license-audit the self-hostable npm artifact in dist-npm/ (host + relay + CLI). */
import { build } from 'esbuild';
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { packageInfoFromPath, packagePathFromInput } from '../infrastructure/audit.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const out = join(root, 'dist-npm');
const rootPackage = require(join(root, 'package.json'));
const version = rootPackage.version ?? '0.1.0';
const runtimeDependencies = { ccusage: rootPackage.dependencies.ccusage, ws: '^8.18.0', tweetnacl: '^1.0.3', qrcode: '^1.5.4', 'web-push': '^3.6.7', 'bonjour-service': '^1.4.4' };
const external = Object.keys(runtimeDependencies);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
    entryPoints: ['apps/host/dist/main.js'],
    outfile: join(out, 'host.js'),
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
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    minifyWhitespace: true,
    legalComments: 'none',
    logLevel: 'warning',
});

const bundledPackagePaths = new Set(
    Object.keys(result.metafile.inputs)
        .map((input) => packagePathFromInput(root, input))
        .filter((path) => path !== undefined),
);
const bundledDependencies = [...bundledPackagePaths]
    .sort()
    .map((path) => ({ ...packageInfoFromPath(path, true), declaredRange: null }));
const bundledNames = new Set(bundledDependencies.map(({ name }) => name));
const ccusagePlatformRoot = join(root, 'node_modules', '@ccusage');
const ccusageManifestPath = join(root, 'node_modules', 'ccusage', 'package.json');
const ccusageManifest = JSON.parse(readFileSync(ccusageManifestPath, 'utf8'));
const ccusagePackage = packageInfoFromPath(ccusageManifestPath, false);
const ccusagePlatformDependencies = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((target) => {
    const name = `@ccusage/ccusage-${target}`;
    const version = ccusageManifest.optionalDependencies?.[name];
    if (version !== rootPackage.dependencies.ccusage) throw new Error(`license audit: ccusage does not pin ${name} to ${rootPackage.dependencies.ccusage}`);
    const installedManifest = join(ccusagePlatformRoot, `ccusage-${target}`, 'package.json');
    if (existsSync(installedManifest)) {
        const pkg = JSON.parse(readFileSync(installedManifest, 'utf8'));
        if (pkg.name !== name || pkg.license !== ccusagePackage.license || pkg.version !== version) {
            throw new Error(`license audit: ccusage platform metadata mismatch for ${pkg.name}@${pkg.version}`);
        }
    }
    return {
        name,
        auditedVersion: version,
        license: ccusagePackage.license,
        bundled: false,
        licensePath: ccusagePackage.licensePath,
        declaredRange: null,
        transitiveOf: 'ccusage',
    };
});
const dependencies = [
    ...bundledDependencies,
    ...ccusagePlatformDependencies,
    ...external
        .filter((name) => !bundledNames.has(name))
        .sort()
        .map((name) => ({
            ...packageInfoFromPath(join(root, 'node_modules', ...name.split('/'), 'package.json'), false),
            declaredRange: runtimeDependencies[name],
        })),
];

mkdirSync(join(out, 'LICENSES', 'npm'), { recursive: true });
for (const dependency of dependencies) {
    const licenseFile = `${dependency.name.replaceAll('/', '__')}@${dependency.auditedVersion}.txt`;
    copyFileSync(dependency.licensePath, join(out, 'LICENSES', 'npm', licenseFile));
}
writeFileSync(
    join(out, 'THIRD_PARTY_LICENSES.json'),
    `${JSON.stringify({
        artifact: `@trymuxr/cli@${version}`,
        policy: 'Packaging fails on copyleft or unknown/non-approved dependency licenses.',
        dependencies: dependencies.map(({ licensePath: _licensePath, ...dependency }) => dependency),
    }, null, 2)}\n`,
);
const contractResult = await build({
    entryPoints: ['packages/contract/dist/index.js'],
    outfile: join(out, 'contract.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    metafile: true,
    minifyWhitespace: true,
    legalComments: 'none',
    logLevel: 'warning',
});
const zodInput = [...Object.keys(result.metafile.inputs), ...Object.keys(contractResult.metafile.inputs)]
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
for (const context of ['setup', 'plugin', 'release', 'diagnostics']) copyContext(context);
if (!existsSync(join(out, 'setup', 'domain', 'dist', 'index.js'))) {
    throw new Error('setup domain was not compiled; run yarn build before packing');
}
if (!existsSync(join(out, 'plugin', 'domain', 'dist', 'index.js'))) {
    throw new Error('plugin domain was not compiled; run yarn build before packing');
}
const extensionSource = readFileSync(join(out, 'plugin', 'application', 'checkPlugin.mjs'), 'utf8');
if (!extensionSource.includes("from '@muxr/contract'")) throw new Error('plugin validator import changed; update the package rewrite');
writeFileSync(join(out, 'plugin', 'application', 'checkPlugin.mjs'), extensionSource.replace("from '@muxr/contract'", "from '../../contract.mjs'"));
cpSync(join(root, 'plugins'), join(out, 'plugins'), { recursive: true });
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
const packagedControlUrl = process.env.MUXR_PACKAGE_CONTROL_URL?.trim()
    || process.env.MUXR_PUBLIC_BASE_URL?.trim();
if (!packagedControlUrl) {
    process.stderr.write('note: MUXR_PACKAGE_CONTROL_URL unset; packing a self-host-only artifact (hosted setup disabled)\n');
} else if (!/^https:\/\/[^/]+$/.test(packagedControlUrl)) {
    throw new Error('MUXR_PACKAGE_CONTROL_URL must be the published HTTPS control-plane origin');
}
const setupPath = join(out, 'setup', 'application', 'inspectSetup.mjs');
writeFileSync(
    setupPath,
    readFileSync(setupPath, 'utf8').replace('__MUXR_PACKAGED_CONTROL_URL__', packagedControlUrl ?? ''),
);
chmodSync(join(out, 'cli.mjs'), 0o755);

copyFileSync(join(root, 'docs', 'npm-readme.md'), join(out, 'README.md'));
// The tarball is the only documentation a plugin author reaches offline, so the
// authoring guide ships with it rather than living behind a URL.
const pluginGuide = readFileSync(join(root, 'docs', 'PLUGINS.md'), 'utf8')
    .replaceAll('](../plugins/', '](plugins/')
    .replaceAll('](decisions/', '](https://github.com/umeranjum17/muxr/blob/main/docs/decisions/');
writeFileSync(join(out, 'PLUGINS.md'), pluginGuide);
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(root, file), join(out, file));
cpSync(join(root, 'LICENSES'), join(out, 'LICENSES'), { recursive: true });

const pkg = {
    name: '@trymuxr/cli',
    version,
    description: 'Control every Herdr coding agent from your phone with a self-hosted encrypted relay.',
    license: 'Apache-2.0',
    type: 'module',
    bin: { muxr: './cli.mjs' },
    engines: { node: '>=22' },
    files: [
        '*.mjs',
        'setup/',
        'plugin/',
        'release/',
        'diagnostics/',
        'host.js',
        'relay.js',
        'crypto.js',
        'README.md',
        'PLUGINS.md',
        'LICENSE',
        'NOTICE',
        'LICENSES/',
        'THIRD_PARTY_LICENSES.json',
        'plugins/',
        'skills/',
        'web/',
    ],
    dependencies: runtimeDependencies,
    repository: { type: 'git', url: 'git+https://github.com/umeranjum17/muxr.git' },
    homepage: 'https://trymuxr.com',
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
process.stdout.write(`packed self-hostable @trymuxr/cli@${version} -> dist-npm/ (${dependencies.length} audited dependencies)\n`);
