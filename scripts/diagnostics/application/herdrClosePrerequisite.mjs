/**
 * Live-Herdr close-contract prerequisite for the loop/worktree e2e checks.
 *
 * The host trusts exactly one workspace-hierarchy root (the packaged copy
 * from its own build); a live server carrying a different build's copy
 * fails the Agent close RPC by design. Compare the live install root with
 * the packaged root so callers skip the close tail honestly — no failing
 * on environment, no fake pass, no user-state mutation.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function packagedRoot() {
    const candidate = join(ROOT, 'plugins', 'workspace-hierarchy');
    if (!existsSync(candidate)) return undefined;
    try {
        return realpathSync(candidate);
    } catch {
        return undefined;
    }
}

export function herdrClosePrerequisite() {
    const packaged = packagedRoot();
    if (packaged === undefined) {
        return { ok: false, packagedRoot: undefined, installedRoot: undefined, reason: 'packaged plugins/workspace-hierarchy missing from this checkout' };
    }
    let listing;
    try {
        listing = execFileSync(process.env.HERDR_BIN || 'herdr', ['plugin', 'list'], { encoding: 'utf8', timeout: 30_000 });
    } catch (error) {
        return { ok: false, packagedRoot: packaged, installedRoot: undefined, reason: `herdr plugin list unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const line = listing.split('\n').find((candidate) => candidate.includes('muxr.workspace-hierarchy'));
    const installed = line === undefined ? undefined : /\[local:([^\]]+)\]/.exec(line)?.[1];
    if (line === undefined || installed === undefined || !/\benabled\b/.test(line)) {
        return { ok: false, packagedRoot: packaged, installedRoot: installed, reason: 'live Herdr has no enabled local muxr.workspace-hierarchy install' };
    }
    let resolved;
    try {
        resolved = realpathSync(installed);
    } catch {
        return { ok: false, packagedRoot: packaged, installedRoot: installed, reason: `live Herdr workspace-hierarchy path unreadable: ${installed}` };
    }
    if (resolved !== packaged) {
        return { ok: false, packagedRoot: packaged, installedRoot: resolved, reason: `live Herdr workspace-hierarchy root differs from packaged root (live: ${resolved})` };
    }
    return { ok: true, packagedRoot: packaged, installedRoot: resolved, reason: '' };
}
