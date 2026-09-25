import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processStart, reclaimScratch, scratchUnused } from './testScratchOwner.mjs';

const base = tmpdir();
reclaimScratch(base);
const birth = processStart(process.pid);
if (!birth) throw new Error('Cannot identify test scratch owner');
const root = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
writeFileSync(join(root, 'owner'), `${process.pid} ${birth}`);
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
    if (scratchUnused(root)) rmSync(root, { recursive: true, force: true });
    process.exit(1);
});
child.once('exit', (code, signal) => {
    const finish = () => {
        const unused = scratchUnused(root);
        const leftovers = readdirSync(root).filter((name) => name !== 'owner').map((name) => join(root, name));
        if (vitest && unused && leftovers.length) process.stderr.write(`FAIL: host test scratch leftovers:\n${leftovers.join('\n')}\n`);
        if (unused) rmSync(root, { recursive: true, force: true });
        process.exit(vitest && unused && leftovers.length ? 1 : signalExit ?? code ?? (signal ? 1 : 0));
    };
    if (signalExit === 143) setTimeout(finish, 2500);
    else finish();
});
