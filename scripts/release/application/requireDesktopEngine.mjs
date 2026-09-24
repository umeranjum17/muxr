import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GUIDE = 'packages/desktop-host/README.md#building-and-packing-a-release';

function npmView(spec, field) {
    const result = spawnSync('npm', ['view', spec, field, '--json'], { encoding: 'utf8', timeout: 20000 });
    if (result.status === 0) return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
    if (/E404/.test(result.stderr)) return undefined;
    throw new Error(`npm view ${spec} ${field} failed: ${(result.stderr || result.error?.message || 'no output').trim().slice(-400)}`);
}

/** The desktop host version a CLI tarball depends on, read from the tarball itself. */
export function desktopHostOfTarball(path) {
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }));
    return manifest.dependencies?.['@desklink/host'];
}

/** The desktop host version this checkout's CLI would depend on. */
export function desktopHostOfSource(root = process.cwd()) {
    return JSON.parse(readFileSync(join(root, 'packages', 'desktop-host', 'package.json'), 'utf8')).version;
}

/**
 * The CLI depends on `@desklink/host`, whose optional platform package carries
 * the engine. No workflow here publishes either, so a CLI released before them
 * would fail to install, or install with no engine. Refuse unless the registry
 * already serves the host at `version` and every platform package it names.
 */
export function requireDesktopEngine(version, view = npmView) {
    if (typeof version !== 'string' || !version) throw new Error('The CLI declares no @desklink/host dependency');
    const host = `@desklink/host@${version}`;
    if (view(host, 'version') !== version) throw new Error(`${host} is not on npm; publish the desktop engine packages first (${GUIDE})`);
    const platforms = Object.entries(view(host, 'optionalDependencies') ?? {});
    if (platforms.length === 0) throw new Error(`${host} names no prebuilt engine package, so it would install without an engine`);
    for (const [name, pinned] of platforms) {
        if (view(`${name}@${pinned}`, 'version') !== pinned) throw new Error(`${name}@${pinned}, the engine ${host} installs, is not on npm (${GUIDE})`);
    }
    return platforms.map(([name, pinned]) => `${name}@${pinned}`);
}
