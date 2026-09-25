import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function processStart(pid) {
    try {
        if (process.platform === 'darwin') return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || undefined;
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    } catch { return undefined; }
}

export function scratchUnused(root) {
    if (process.platform === 'darwin') {
        const result = spawnSync('lsof', ['-n', '+D', root], { encoding: 'utf8' });
        return result.status === 1 && !result.stderr;
    }
    if (process.platform !== 'linux') return false;
    try {
        const path = realpathSync(root);
        for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
            for (const entry of ['cwd', ...readdirSync(`/proc/${pid}/fd`).map((fd) => `fd/${fd}`)]) {
                const target = readlinkSync(`/proc/${pid}/${entry}`);
                if (target === path || target.startsWith(`${path}/`)) return false;
            }
        }
        return true;
    } catch { return false; }
}

export function reclaimScratch(base) {
    for (const name of readdirSync(base)) {
        const match = /^muxr-host-test-([1-9]\d*)-.+$/.exec(name);
        if (!match) continue;
        const path = join(base, name);
        let owner;
        try { owner = readFileSync(join(path, 'owner'), 'utf8').trim(); }
        catch { continue; }
        const [pid, ...parts] = owner.split(' ');
        const birth = parts.join(' ');
        if (pid !== match[1] || !birth) continue;
        const current = processStart(Number(pid));
        if (current === birth) continue;
        if (current === undefined) {
            try { process.kill(Number(pid), 0); continue; }
            catch (error) { if (error.code !== 'ESRCH') continue; }
        }
        if (scratchUnused(path)) rmSync(path, { recursive: true, force: true });
    }
}
