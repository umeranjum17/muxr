/**
 * The one Herdr-plugin runtime record: `~/.muxr/herdr-plugin.runtime`,
 * owner-only JSON `{ bin, version, source, recordedAt }` naming the exact
 * muxr executable every plugin action runs.
 *
 * Written by the plugin build (install) and refreshed by `muxr update`, the
 * single update owner. Every write verifies the executable really reports
 * the version being recorded and lands atomically, so a failed update or
 * an interrupted write leaves the previous working record untouched.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PLUGIN_SOURCE = 'umeranjum17/muxr/plugins/control';

export const stateDir = () => process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
export const runtimePath = () => join(stateDir(), 'herdr-plugin.runtime');

/** The only supported install/repair command: full GitHub source, pinned to the release. */
export function installCommand(version) {
    const ref = typeof version === 'string' && version !== '' ? ` --ref v${version}` : '';
    return `herdr plugin install ${PLUGIN_SOURCE}${ref}`;
}

export function muxrVersion(bin) {
    try {
        const check = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 15_000 });
        return check.status === 0 ? check.stdout.trim().split('\n').pop() : undefined;
    } catch {
        return undefined;
    }
}

export function readRuntimeRecord() {
    try {
        const record = JSON.parse(readFileSync(runtimePath(), 'utf8'));
        return typeof record?.bin === 'string' && record.bin !== '' && typeof record?.version === 'string' ? record : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Verify, then replace the record in one rename. Throws without touching the
 * existing record when `bin` does not report `version`.
 */
export function writeRuntimeRecord({ bin, version, source }) {
    const reported = muxrVersion(bin);
    if (reported !== version) {
        throw new Error(`runtime ${bin} reports ${reported ?? 'nothing'}; expected ${version} (source: ${source})`);
    }
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const path = runtimePath();
    const temporary = `${path}.tmp-${process.pid}`;
    try {
        writeFileSync(temporary, `${JSON.stringify({ bin, version, source, recordedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
    return { bin, version, source };
}
