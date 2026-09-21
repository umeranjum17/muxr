import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finding the engine executable.
 *
 * Three sources, in order, and no fourth:
 *
 *  1. an explicit path, when a consumer or an operator names one;
 *  2. this package's published platform package, which is the normal case once
 *     prebuilts exist;
 *  3. this package's own build output, for a source build.
 *
 * Deliberately not searched: `PATH`. "A program called desklink-host" is not
 * evidence of which program is about to be given control of a desktop.
 */

export interface ResolvedEngine {
    command: string;
    args: string[];
    origin: 'configured' | 'prebuilt' | 'package';
}

export function enginePackageRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The platform package for this machine.
 *
 * `libc` is part of the tag because a glibc binary on a musl system fails in
 * ways that look like a broken install rather than an unsupported one, and
 * because npm's own `libc` selector is not honoured by every client.
 */
export function platformTag(
    platform: string = process.platform,
    arch: string = process.arch,
    glibc: boolean | undefined = hasGlibc(),
): string {
    if (platform === 'linux') return `linux-${arch}-${glibc === false ? 'musl' : 'gnu'}`;
    return `${platform}-${arch}`;
}

/** A Linux Node without a reported glibc runtime is taken to be musl. */
function hasGlibc(): boolean | undefined {
    if (process.platform !== 'linux') return undefined;
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime !== undefined;
}

function prebuiltBinary(): string | null {
    const require = createRequire(import.meta.url);
    const name = `@desklink/host-${platformTag()}`;
    try {
        // The platform package's manifest points at the executable, so the
        // binary's name and location stay that package's business.
        const manifest = require(`${name}/package.json`) as { executable?: string; bin?: Record<string, string> };
        const relative = manifest.executable ?? manifest.bin?.['desklink-host'];
        if (typeof relative !== 'string') return null;
        const path = require.resolve(`${name}/${relative.replace(/^\.\//, '')}`);
        return path;
    } catch {
        return null;
    }
}

function buildCandidates(root: string): string[] {
    return [
        join(root, 'engine', 'target', 'release', 'desklink-host'),
        join(root, 'engine', 'target', 'debug', 'desklink-host'),
        join(root, 'bin', 'desklink-host'),
    ];
}

export function resolveEngine(configured = process.env.MUXR_DESKLINK_ENGINE): ResolvedEngine | null {
    if (configured !== undefined && configured.trim() !== '') {
        if (!isExecutable(configured)) return null;
        return { command: configured, args: ['serve'], origin: 'configured' };
    }
    const prebuilt = prebuiltBinary();
    if (prebuilt !== null && isExecutable(prebuilt)) {
        return { command: prebuilt, args: ['serve'], origin: 'prebuilt' };
    }
    for (const candidate of buildCandidates(enginePackageRoot())) {
        if (isExecutable(candidate)) {
            return { command: candidate, args: ['serve'], origin: 'package' };
        }
    }
    return null;
}

function isExecutable(path: string): boolean {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // A file that is not executable is an install that went wrong, and saying so
    // is more useful than an EACCES three calls later.
    return (stat.mode & 0o111) !== 0;
}

/**
 * Why the engine is missing, in words fit to show a user. `null` means it is
 * there.
 */
export function explainMissingEngine(configured = process.env.MUXR_DESKLINK_ENGINE): string | null {
    const resolved = resolveEngine(configured);
    if (resolved !== null) return null;
    if (configured !== undefined && configured.trim() !== '') {
        if (!existsSync(configured)) {
            return `The desktop engine is not at the configured path (${configured}).`;
        }
        return `The desktop engine at ${configured} is not an executable file.`;
    }
    return `The desktop engine is not installed for ${platformTag()}. This version ships no prebuilt engine: see the @desklink/host README for the native build prerequisites, build it from source, and point MUXR_DESKLINK_ENGINE at the built binary. @desklink/host-${platformTag()} is not published yet.`;
}
