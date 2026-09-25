import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStart, scratchUnused, testScratchOwner } from './testScratchOwner.mjs';

const base = mkdtempSync(join(process.cwd(), '.scratch-check-'));
let orphan;
try {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const npx = join(bin, 'npx');
    writeFileSync(npx, '#!/usr/bin/env node\nimport { mkdirSync } from "node:fs";\nimport { join } from "node:path";\nif (process.env.INJECT_LEFTOVER !== "0") mkdirSync(join(process.env.TMPDIR, "leak-check-injected"));\nif (process.env.NODE_COMPILE_CACHE !== join(process.env.TMPDIR, "node-compile-cache")) process.exit(2);\nmkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });\nconsole.log(process.env.NODE_COMPILE_CACHE);\n');
    chmodSync(npx, 0o755);
    const env = { ...process.env, TMPDIR: base, PATH: `${bin}:${process.env.PATH}` };
    const wrapper = 'scripts/diagnostics/application/checkHostTestScratch.mjs';
    const failure = spawnSync(process.execPath, [wrapper, '--', 'npx', 'vitest', 'run'], { env, encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /FAIL: host test scratch leftovers:\n.*\/leak-check-injected/);
    assert.deepEqual(readdirSync(base), ['bin']);

    const clean = spawnSync(process.execPath, [wrapper, '--', 'npx', 'vitest', 'run'], {
        env: { ...env, INJECT_LEFTOVER: '0' }, encoding: 'utf8',
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /\/node-compile-cache/);
    assert.deepEqual(readdirSync(base), ['bin']);

    const previous = process.env.TMPDIR;
    process.env.TMPDIR = base;
    try {
        const { default: setupHostTestScratch } = await import('../../../apps/host/src/testScratchCleanup.ts');
        const teardown = setupHostTestScratch();
        const direct = process.env.TMPDIR;
        mkdirSync(join(direct, 'muxr-direct'));
        teardown();
        assert.equal(existsSync(direct), false);
    } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
    }

    const empty = spawnSync(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
    assert.equal(empty.status, 0);
    const live = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
    writeFileSync(join(live, 'owner'), `${process.pid} ${processStart(process.pid)}\n${empty.pid}`);
    assert.equal(scratchUnused(live), false);
    assert.equal(scratchUnused(live, true), true);
    const departed = mkdtempSync(join(base, `muxr-host-test-${empty.pid}-`));
    writeFileSync(join(departed, 'owner'), `${empty.pid} departed\n${empty.pid}`);
    assert.equal(scratchUnused(departed), true);
    const partial = mkdtempSync(join(base, `muxr-host-test-${empty.pid}-`));
    writeFileSync(join(partial, 'owner'), `${empty.pid} departed`);
    assert.equal(scratchUnused(partial), false);
    testScratchOwner(base);
    assert.equal(existsSync(departed), false);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(partial), true);

    const leader = spawnSync(process.execPath, ['-e',
        'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(child.pid); process.exit(0)'],
    { detached: true, encoding: 'utf8' });
    assert.equal(leader.status, 0, leader.stderr);
    orphan = Number(leader.stdout.trim());
    const active = mkdtempSync(join(base, `muxr-host-test-${leader.pid}-`));
    writeFileSync(join(active, 'owner'), `${leader.pid} departed\n${leader.pid}`);
    assert.equal(scratchUnused(active), false);
    testScratchOwner(base);
    assert.equal(existsSync(active), true);

    const unknown = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
    writeFileSync(join(unknown, 'owner'), 'unknown');
    testScratchOwner(base);
    assert.equal(existsSync(unknown), true);
} finally {
    if (orphan) {
        try { process.kill(orphan, 'SIGKILL'); } catch {}
    }
    rmSync(base, { recursive: true, force: true });
}
