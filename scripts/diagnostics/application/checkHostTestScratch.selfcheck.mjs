import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStart, reclaimScratch, scratchUnused } from './testScratchOwner.mjs';

const base = mkdtempSync(join(process.cwd(), '.scratch-check-'));
try {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const npx = join(bin, 'npx');
    writeFileSync(npx, '#!/usr/bin/env node\nimport { mkdirSync } from "node:fs";\nimport { join } from "node:path";\nmkdirSync(join(process.env.TMPDIR, "leak-check-injected"));\n');
    chmodSync(npx, 0o755);
    const lsof = join(bin, 'lsof');
    writeFileSync(lsof, '#!/bin/sh\necho "lsof: incomplete filesystem information" >&2\nexit 1\n');
    chmodSync(lsof, 0o755);
    const env = { ...process.env, TMPDIR: base, PATH: `${bin}:${process.env.PATH}` };
    const wrapper = 'scripts/diagnostics/application/checkHostTestScratch.mjs';
    const failure = spawnSync(process.execPath, [wrapper, '--', 'npx', 'vitest', 'run'], { env, encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /FAIL: host test scratch leftovers:\n.*\/leak-check-injected/);
    assert.deepEqual(readdirSync(base), ['bin']);

    const node = spawnSync(process.execPath, [wrapper, '--', process.execPath, '-e',
        'require("node:fs").mkdirSync(require("node:path").join(process.env.TMPDIR, "muxr-pairing-leak"))'],
    { env, encoding: 'utf8' });
    assert.equal(node.status, 0, node.stderr);
    assert.deepEqual(readdirSync(base), ['bin']);

    const live = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
    const birth = processStart(process.pid);
    assert.ok(birth);
    writeFileSync(join(live, 'owner'), `${process.pid} ${birth}`);
    const stale = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
    writeFileSync(join(stale, 'owner'), `${process.pid} ${birth}-stale`);
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: live, stdio: 'ignore' });
    writeFileSync(lsof, `#!/bin/sh
for target do :; done
if [ "$target" = ${JSON.stringify(live)} ] && kill -0 ${holder.pid} 2>/dev/null; then printf 'p%s\\n' ${holder.pid}; exit 0; fi
exit 1
`);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
        const scan = spawnSync('lsof', ['-n', '-F', 'p', '+D', live], { encoding: 'utf8' });
        assert.equal(scan.status, 0, scan.stderr);
        assert.ok(scan.stdout.split('\n').includes(`p${holder.pid}`), scan.stdout);
        reclaimScratch(base);
        assert.deepEqual(readdirSync(base).sort(), ['bin', live.split('/').at(-1)].sort());
        holder.kill('SIGKILL');
        await new Promise((resolve) => holder.once('exit', resolve));
        writeFileSync(lsof, '#!/bin/sh\necho "lsof: incomplete filesystem information" >&2\nexit 1\n');
        const staleAgain = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
        writeFileSync(join(staleAgain, 'owner'), `${process.pid} ${birth}-stale`);
        assert.equal(scratchUnused(staleAgain), false);
        const unknown = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
        writeFileSync(join(unknown, 'owner'), 'unknown');
        reclaimScratch(base);
        assert.deepEqual(readdirSync(base).sort(), ['bin', live.split('/').at(-1), unknown.split('/').at(-1)].sort());
    } finally {
        if (holder.exitCode === null && holder.signalCode === null) {
            holder.kill('SIGKILL');
            await new Promise((resolve) => holder.once('exit', resolve));
        }
        process.env.PATH = originalPath;
    }
} finally {
    rmSync(base, { recursive: true, force: true });
}
