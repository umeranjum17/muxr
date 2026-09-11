import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { runCommand } from './commands.mjs';

export const sha256 = (path) => {
    if (!statSync(path).isFile()) throw new Error(`identity path is not a file: ${path}`);
    return createHash('sha256').update(readFileSync(path)).digest('hex');
};
function filesUnder(root) {
    if (!existsSync(root)) return [];
    const files = [];
    const visit = (path) => {
        const stat = statSync(path);
        if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
        else if (stat.isFile()) files.push(path);
    };
    visit(root);
    return files;
}
function digestFiles(cwd, paths) {
    const hash = createHash('sha256');
    const files = paths.flatMap((root) => filesUnder(root)).sort();
    const identities = {};
    for (const path of files) {
        const name = relative(cwd, path);
        const digest = sha256(path);
        identities[name] = digest;
        hash.update(name).update('\0').update(digest).update('\0');
    }
    return { sha256: hash.digest('hex'), files: identities };
}
export function patchedDependencies(cwd = '.') {
    const files = new Set();
    for (const patch of readdirSync(join(cwd, 'patches')).filter((name) => name.endsWith('.patch'))) {
        const text = readFileSync(join(cwd, 'patches', patch), 'utf8');
        for (const match of text.matchAll(/^\+\+\+ b\/(node_modules\/[^\r\n]+)$/gm)) files.add(match[1]);
    }
    return Object.fromEntries([...files].sort().map((path) => [path, sha256(join(cwd, path))]));
}
export function harnessIdentity(cwd = '.') {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'perf', '.github/workflows'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
    const hash = createHash('sha256');
    for (const path of [...new Set(files)].sort()) hash.update(path).update('\0').update(readFileSync(join(cwd, path)).toString()).update('\0');
    return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), sha256: hash.digest('hex') };
}
function buildTool(name) {
    const root = join(process.env.ANDROID_HOME ?? join(homedir(), 'Android', 'Sdk'), 'build-tools');
    if (!existsSync(root)) return undefined;
    for (const version of readdirSync(root).sort().reverse()) {
        const path = join(root, version, name);
        if (existsSync(path)) return path;
    }
    return undefined;
}

/** Identity parsed from a candidate APK, without installing or starting it. */
export async function apkIdentity(path) {
    const artifact = resolve(path);
    if (!existsSync(artifact)) throw new Error(`candidate APK is missing: ${artifact}`);
    const aapt = buildTool('aapt') ?? buildTool('aapt2');
    if (aapt === undefined) throw new Error('Android build-tools aapt is unavailable');
    const dump = (await runCommand(aapt, ['dump', 'badging', artifact], { timeout: 30_000 })).stdout;
    const packageName = /package: name='([^']+)'/.exec(dump)?.[1];
    const versionCode = Number(/versionCode='(\d+)'/.exec(dump)?.[1]);
    const versionName = /versionName='([^']+)'/.exec(dump)?.[1];
    const apksigner = buildTool('apksigner');
    const cert = apksigner === undefined ? '' : (await runCommand(apksigner, ['verify', '--print-certs', artifact], { timeout: 30_000 })).stdout;
    const signerDigest = /SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(cert)?.[1];
    if (!packageName || !Number.isFinite(versionCode) || !versionName || !signerDigest) throw new Error('candidate APK has incomplete package identity');
    return { path: artifact, sha256: sha256(artifact), package: packageName, versionCode, versionName, signerDigest };
}

/** Identity of a simulator .app; paths are excluded from the identity comparison. */
export async function iosAppIdentity(path) {
    const root = resolve(path);
    if (!statSync(root).isDirectory()) throw new Error(`iOS app is not a directory: ${root}`);
    const plist = async (key) => (await runCommand('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(root, 'Info.plist')], { timeout: 10_000 })).stdout.trim();
    const executable = await plist('CFBundleExecutable');
    const executablePath = join(root, executable);
    const jsPath = join(root, 'main.jsbundle');
    const resources = digestFiles(root, [join(root, 'Frameworks'), join(root, 'PlugIns'), join(root, 'Resources')]);
    return {
        path: root,
        sha256: sha256(executablePath),
        jsSha256: sha256(jsPath),
        resourcesSha256: resources.sha256,
        resourceFiles: resources.files,
        bundle: await plist('CFBundleIdentifier'),
        version: await plist('CFBundleShortVersionString'),
        build: await plist('CFBundleVersion'),
        executable,
    };
}

export function runtimeIdentity(cwd = '.') {
    const root = resolve(cwd);
    const roots = [
        join(root, 'apps/host/dist'),
        join(root, 'apps/relay/dist'),
        ...readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, 'packages', entry.name, 'dist')),
        ...readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => filesUnder(join(root, 'plugins', entry.name)).filter((path) => /\.(?:mjs|json|toml)$/.test(path))),
    ];
    return digestFiles(root, roots);
}

export function sourceIdentity(cwd = '.') {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const files = git('ls-files', '-co', '--exclude-standard', '-z', '--', 'apps', 'packages', 'plugins', 'scripts', 'patches', 'package.json', 'yarn.lock', 'tsconfig.base.json', 'tsconfig.json').split('\0').filter(Boolean);
    const hash = createHash('sha256');
    const mobile = createHash('sha256');
    for (const path of [...new Set(files)].sort()) {
        if (path.startsWith('apps/mobile/android/.kotlin/')) continue;
        const bytes = readFileSync(join(cwd, path));
        hash.update(path).update('\0').update(bytes).update('\0');
        if (!/^(apps\/(host|relay|probe)\/|plugins\/|scripts\/)/.test(path)) mobile.update(path).update('\0').update(bytes).update('\0');
    }
    return { revision: git('rev-parse', 'HEAD'), sourceSha256: hash.digest('hex'), mobileSha256: mobile.digest('hex'), dirty: git('status', '--porcelain') !== '' };
}
