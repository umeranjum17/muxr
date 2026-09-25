import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prefix = 'muxr-host-test-';
const base = tmpdir();
const started = (pid) => {
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').match(/^.*\) .*$/)?.[0].split(' ')[19]; }
    catch { return undefined; }
};
for (const name of readdirSync(base)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(base, name);
    let pid;
    let birth;
    try { [pid, birth] = readFileSync(join(path, 'owner'), 'utf8').trim().split(' '); }
    catch { continue; }
    if (!/^[1-9]\d*$/.test(pid) || !name.startsWith(`${prefix}${pid}-`) || !birth) continue;
    const current = started(Number(pid));
    if (current === birth) continue;
    if (current === undefined) {
        try { process.kill(Number(pid), 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
    }
    rmSync(path, { recursive: true, force: true });
}

const root = mkdtempSync(join(base, `${prefix}${process.pid}-`));
writeFileSync(join(root, 'owner'), `${process.pid} ${started(process.pid) ?? 'unknown'}`);
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const vitest = args[0] === 'npx' && args[1] === 'vitest';
const child = spawn(args[0], args.slice(1), { stdio: 'inherit', env: { ...process.env, TMPDIR: root } });
let signalExit;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    signalExit = signal === 'SIGINT' ? 130 : 143;
    child.kill(signal);
});
child.once('error', (error) => {
    process.stderr.write(`${error}\n`);
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
});
child.once('exit', (code, signal) => {
    const leftovers = readdirSync(root).filter((name) => name !== 'owner').map((name) => join(root, name));
    if (vitest && leftovers.length) process.stderr.write(`FAIL: host test scratch leftovers:\n${leftovers.join('\n')}\n`);
    rmSync(root, { recursive: true, force: true });
    process.exit(vitest && leftovers.length ? 1 : signalExit ?? code ?? (signal ? 1 : 0));
});
