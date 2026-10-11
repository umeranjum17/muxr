import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanTestScratch, processStart, removeTestScratch, scratchBase, scratchEntries, scratchUnused, testScratchOwner } from './testScratchOwner.mjs';

if (process.argv[2] !== '--' || !process.argv[3]) throw new Error('Expected -- followed by a command');
const base = scratchBase();
testScratchOwner(base);
const birth = processStart(process.pid);
if (!birth) throw new Error('Cannot identify test scratch owner');
const root = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
writeFileSync(join(root, 'owner'), `${process.pid} ${birth}`);
const args = process.argv.slice(3);
const vitest = args[0] === 'npx' && args[1] === 'vitest';
const child = spawn(args[0], args.slice(1), { stdio: ['inherit', 'pipe', 'pipe'], detached: true, env: { ...process.env, TMPDIR: root, NODE_COMPILE_CACHE: join(root, 'node-compile-cache') } });
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
if (child.pid) writeFileSync(join(root, 'owner'), `${process.pid} ${birth}\n${child.pid}`);
let signalExit;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    signalExit = signal === 'SIGINT' ? 130 : 143;
    if (child.pid) {
        try { process.kill(-child.pid, signal); } catch {}
        if (signal === 'SIGTERM') setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }, 1800);
    }
});
child.once('error', (error) => {
    process.stderr.write(`${error}\n`);
    if (!child.pid) removeTestScratch(root);
    else if (scratchUnused(root, true)) removeTestScratch(root);
    process.exit(1);
});
// Stay available to forward deadline signals while descendants hold output open.
child.once('close', (code, signal) => {
    const finish = () => {
        const unused = scratchUnused(root, true);
        if (vitest && unused) cleanTestScratch(root);
        const leftovers = scratchEntries(root).filter((name) => name !== 'owner').map((name) => join(root, name));
        if (vitest && unused && leftovers.length) process.stderr.write(`FAIL: host test scratch leftovers:\n${leftovers.join('\n')}\n`);
        if (unused) removeTestScratch(root);
        process.exitCode = vitest && unused && leftovers.length ? 1 : signalExit ?? code ?? (signal ? 1 : 0);
    };
    if (signalExit === 143) setTimeout(finish, 2500);
    else finish();
});
