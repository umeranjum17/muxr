import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finding the engine executable.
 *
 * Deliberately conservative: an explicit path wins, otherwise this package's own
 * build output, otherwise nothing. It never searches `PATH` for a same-named
 * program, because "a binary called desklink-host" is not evidence of which
 * program is about to be given control of the user's desktop.
 */

export interface ResolvedEngine {
    command: string;
    args: string[];
    origin: 'configured' | 'package';
}

export function enginePackageRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Where a source build of the vendored crate leaves its binary. */
function buildCandidates(root: string): string[] {
    return [
        join(root, 'engine', 'target', 'release', 'desklink-host'),
        join(root, 'engine', 'target', 'debug', 'desklink-host'),
        join(root, 'bin', 'desklink-host'),
    ];
}

export function resolveEngine(configured = process.env.MUXR_DESKLINK_ENGINE): ResolvedEngine | null {
    if (configured !== undefined && configured.trim() !== '') {
        if (!existsSync(configured)) return null;
        return { command: configured, args: ['serve'], origin: 'configured' };
    }
    for (const candidate of buildCandidates(enginePackageRoot())) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return { command: candidate, args: ['serve'], origin: 'package' };
        }
    }
    return null;
}

/** A one-line explanation fit to show a user, or null when the engine is there. */
export function explainMissingEngine(configured = process.env.MUXR_DESKLINK_ENGINE): string | null {
    if (resolveEngine(configured) !== null) return null;
    if (configured !== undefined && configured.trim() !== '') {
        return `The desktop engine is not at the configured path (${configured}).`;
    }
    return 'The desktop engine is not installed on this computer.';
}
