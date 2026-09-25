import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function processStart(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    } catch { return undefined; }
}

export function reclaimScratch(base) {
    for (const name of readdirSync(base)) {
        const match = /^muxr-host-test-([1-9]\d*)-.+$/.exec(name);
        if (!match) continue;
        const path = join(base, name);
        let owner;
        try { owner = readFileSync(join(path, 'owner'), 'utf8').trim(); }
        catch { continue; }
        const [pid, birth] = owner.split(' ');
        if (pid !== match[1] || !/^\d+$/.test(birth ?? '')) continue;
        const current = processStart(Number(pid));
        if (current === birth) continue;
        if (current === undefined) {
            try { process.kill(Number(pid), 0); continue; }
            catch (error) { if (error.code !== 'ESRCH') continue; }
        }
        rmSync(path, { recursive: true, force: true });
    }
}
