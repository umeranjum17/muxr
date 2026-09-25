import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prefix = 'muxr-host-test-';
const base = tmpdir();
for (const name of readdirSync(base)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(base, name);
    const pid = Number(name.slice(prefix.length).split('-')[0]);
    if (!Number.isSafeInteger(pid)) continue;
    try { process.kill(pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
    let ownerPid;
    let childPid;
    try {
        [ownerPid, childPid] = readFileSync(join(path, 'owner'), 'utf8').trim().split(/\s+/).map(Number);
    } catch { /* no child was started */ }
    if (ownerPid !== pid) continue;
    if (Number.isSafeInteger(childPid) && childPid > 0) {
        try { process.kill(-childPid, 'SIGTERM'); } catch { /* no surviving child group */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
        try { process.kill(-childPid, 'SIGKILL'); } catch { /* group exited */ }
    }
    rmSync(path, { recursive: true, force: true });
}

const root = mkdtempSync(join(base, `${prefix}${process.pid}-`));
writeFileSync(join(root, 'owner'), `${process.pid}\n`);
if (process.env.MUXR_TEST_SCRATCH_INJECT === '1') mkdirSync(join(root, 'leak-check-injected'));
const child = spawn('npx', ['vitest', ...process.argv.slice(2)], {
    stdio: 'inherit', detached: true, env: { ...process.env, TMPDIR: root },
});
writeFileSync(join(root, 'owner'), `${process.pid} ${child.pid}\n`);
let signalExit;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    signalExit = signal === 'SIGINT' ? 130 : 143;
    try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
});
child.once('exit', (code, signal) => {
    const leftovers = readdirSync(root).filter((name) => /^(?:muxr-|desklink-|v-|leak-check-)/.test(name)).map((name) => join(root, name));
    if (leftovers.length) {
        process.stderr.write(`FAIL: host test scratch leftovers:\n${leftovers.join('\n')}\n`);
        rmSync(root, { recursive: true, force: true });
        process.exit(1);
    }
    rmSync(root, { recursive: true, force: true });
    process.exit(signalExit ?? code ?? (signal ? 1 : 0));
});
