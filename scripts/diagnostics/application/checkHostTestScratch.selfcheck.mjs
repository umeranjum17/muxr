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
    writeFileSync(lsof, '#!/bin/sh\nexit 1\n');
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
    assert.match(birth, /^\d+$/);
    writeFileSync(join(live, 'owner'), `${process.pid} ${birth}`);
    const stale = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
    writeFileSync(join(stale, 'owner'), `${process.pid} ${Number(birth) + 1}`);
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: stale, stdio: 'ignore' });
    try {
        reclaimScratch(base);
        assert.deepEqual(readdirSync(base).sort(), ['bin', live.split('/').at(-1), stale.split('/').at(-1)].sort());
    } finally {
        holder.kill('SIGKILL');
        await new Promise((resolve) => holder.once('exit', resolve));
    }
    const unused = scratchUnused(stale);
    reclaimScratch(base);
    assert.equal(readdirSync(base).includes(stale.split('/').at(-1)), !unused);
    assert.ok(readdirSync(base).includes(live.split('/').at(-1)));
} finally {
    rmSync(base, { recursive: true, force: true });
}
