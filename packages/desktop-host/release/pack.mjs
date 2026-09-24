#!/usr/bin/env node
/**
 * Pack this package's publishable tarballs. Publishes nothing: `release/publish.mjs`
 * does that, platform package first.
 *
 *   node release/pack.mjs --engine dist-desklink/engine-linux-x64-gnu
 *
 * The engine comes from `release/build-engine.sh`; tarballs go to
 * `dist-desklink/` at the repository root. Compile the package (`tsc --build`) first.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { engine: { type: 'string' } } });
const out = join(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: packageRoot, encoding: 'utf8' }).trim(), 'dist-desklink');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
if (!values.engine) throw new Error('engine output missing: pass --engine <dir> from release/build-engine.sh');
const engine = resolve(values.engine);
const notices = ['THIRD_PARTY_LICENSES.txt', 'COPYRIGHT-rust-library.html'];
for (const file of ['desklink-host', ...notices, 'provenance.json']) {
    if (!existsSync(join(engine, file))) throw new Error(`engine output missing: ${join(engine, file)}`);
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const provenance = JSON.parse(readFileSync(join(engine, 'provenance.json'), 'utf8'));
if (provenance.sha256 !== sha256(join(engine, 'desklink-host'))) {
    throw new Error(`${engine}/desklink-host is not the executable its provenance.json describes`);
}
if (provenance.engine !== manifest.version) {
    throw new Error(`the engine is version ${provenance.engine}, but ${manifest.name} is ${manifest.version}`);
}
const compiled = join(packageRoot, 'dist', 'resolveEngine.js');
if (!existsSync(compiled)) throw new Error(`${manifest.name} is not compiled: run tsc --build first`);
// The same tag the runtime resolver looks for, so the two cannot disagree.
const { platformTag } = await import(pathToFileURL(compiled).href);
const platformName = `${manifest.name}-${platformTag('linux', 'x64', true)}`;
const stage = join(out, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`);
// npm 10 reports a packed package in an array, npm 11 and later keyed by name.
const npmPack = (args, options) => {
    const report = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', ...args], { encoding: 'utf8', ...options }));
    return Array.isArray(report) ? report[0] : Object.values(report)[0];
};
function pack(directory) {
    const packed = npmPack([directory, '--pack-destination', out]);
    const tarball = join(out, packed.filename);
    process.stdout.write(`packed  ${tarball}  sha256 ${sha256(tarball)}\n`);
    return tarball;
}

// The host package is exactly what npm would pack from the source, plus the
// platform package as an optional dependency pinned to this version. The pin is
// added here rather than in the source manifest because an optional dependency
// the registry does not have yet fails a workspace's frozen install outright.
const hostStage = join(stage, 'host');
const listing = npmPack(['--dry-run'], { cwd: packageRoot });
for (const { path } of listing.files) {
    mkdirSync(dirname(join(hostStage, path)), { recursive: true });
    copyFileSync(join(packageRoot, path), join(hostStage, path));
}
writeJson(join(hostStage, 'package.json'), {
    ...manifest,
    optionalDependencies: { ...manifest.optionalDependencies, [platformName]: manifest.version },
});
for (const name of readdirSync(out)) {
    if (name.startsWith('desklink-host-') && name.endsWith('.tgz')) rmSync(join(out, name));
}

const platformStage = join(stage, 'platform');
mkdirSync(platformStage);
for (const file of ['desklink-host', ...notices, 'provenance.json']) {
    copyFileSync(join(engine, file), join(platformStage, file));
}
chmodSync(join(platformStage, 'desklink-host'), 0o755);
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(packageRoot, file), join(platformStage, file));
writeFileSync(join(platformStage, 'README.md'), `# ${platformName}

The prebuilt engine executable for [\`${manifest.name}\`](https://www.npmjs.com/package/${manifest.name})
on Linux x64 with glibc 2.36 or newer. Install \`${manifest.name}\`, not this:
it is selected and found automatically.

At run time the engine loads libpipewire-0.3, libxkbcommon, libevdev and
libstdc++ from the system. libvpx and inputtino are linked into it; their
licences, and those of every linked crate, are in \`THIRD_PARTY_LICENSES.txt\`,
and the Rust standard library's in \`COPYRIGHT-rust-library.html\`.
\`provenance.json\` records the source commit and the pinned build inputs.
`);
writeJson(join(platformStage, 'package.json'), {
    name: platformName,
    version: manifest.version,
    description: `Prebuilt ${manifest.name} engine for Linux x64 (glibc 2.36 or newer)`,
    license: manifest.license,
    os: ['linux'],
    cpu: ['x64'],
    libc: ['glibc'],
    executable: 'desklink-host',
    files: ['desklink-host', ...notices, 'provenance.json', 'NOTICE'],
});
pack(platformStage);
pack(hostStage);
rmSync(stage, { recursive: true, force: true });
