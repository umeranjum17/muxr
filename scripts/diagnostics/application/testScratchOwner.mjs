import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const scratchBase = () => process.platform === 'darwin' ? '/tmp' : tmpdir();

export function processStart(pid) {
    try {
        if (process.platform === 'darwin') return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || undefined;
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    } catch { return undefined; }
}

export function scratchUnused(root) {
    const match = /^muxr-host-test-([1-9]\d*)-.+$/.exec(basename(root));
    if (!match) return false;
    let owner;
    try { owner = readFileSync(join(root, 'owner'), 'utf8').trim().split('\n'); }
    catch { return false; }
    const [pid, ...parts] = owner[0].split(' ');
    if (pid !== match[1] || !parts.join(' ')) return false;
    if (owner.length > 1) {
        if (owner.length !== 2 || !/^[1-9]\d*$/.test(owner[1])) return false;
        // ponytail: a descendant calling setsid() escapes this group; record new groups if test hosts ever do that.
        try { process.kill(-Number(owner[1]), 0); return false; }
        catch (error) { return error.code === 'ESRCH'; }
    }
    const current = processStart(Number(pid));
    if (current !== undefined) return current !== parts.join(' ');
    try { process.kill(Number(pid), 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
}

export function cleanTestScratch(root) {
    for (const name of readdirSync(root)) {
        if (/^(?:muxr-|desklink-|v-|x-|attention-|node-compile-cache$)/.test(name)) {
            rmSync(join(root, name), { recursive: true, force: true });
        }
    }
}

export function testScratchOwner(base) {
    for (const name of readdirSync(base)) {
        if (!/^muxr-host-test-[1-9]\d*-.+$/.test(name)) continue;
        const path = join(base, name);
        if (scratchUnused(path)) rmSync(path, { recursive: true, force: true });
    }
}
