import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStart, scratchUnused, testScratchOwner } from './testScratchOwner.mjs';

const base = mkdtempSync(join(process.cwd(), '.scratch-check-'));
try {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const npx = join(bin, 'npx');
    writeFileSync(npx, '#!/usr/bin/env node\nimport { mkdirSync } from "node:fs";\nimport { join } from "node:path";\nif (process.env.INJECT_LEFTOVER !== "0") mkdirSync(join(process.env.TMPDIR, "leak-check-injected"));\nif (process.env.NODE_COMPILE_CACHE !== join(process.env.TMPDIR, "node-compile-cache")) process.exit(2);\nmkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });\nconsole.log(process.env.NODE_COMPILE_CACHE);\n');
    chmodSync(npx, 0o755);
    const lsof = join(bin, 'lsof');
    writeFileSync(lsof, '#!/bin/sh\nexit 1\n');
    chmodSync(lsof, 0o755);
    const env = { ...process.env, TMPDIR: base, PATH: `${bin}:${process.env.PATH}` };
    const wrapper = 'scripts/diagnostics/application/checkHostTestScratch.mjs';
    const failure = spawnSync(process.execPath, [wrapper, '--', 'npx', 'vitest', 'run'], { env, encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /FAIL: host test scratch leftovers:\n.*\/leak-check-injected/);
    assert.match(failure.stdout, /\/node-compile-cache/);
    assert.deepEqual(readdirSync(base), ['bin']);

    const clean = spawnSync(process.execPath, [wrapper, '--', 'npx', 'vitest', 'run'], {
        env: { ...env, INJECT_LEFTOVER: '0' }, encoding: 'utf8',
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /\/node-compile-cache/);
    assert.deepEqual(readdirSync(base), ['bin']);

    const node = spawnSync(process.execPath, [wrapper, '--', process.execPath, '-e',
        'require("node:fs").mkdirSync(require("node:path").join(process.env.TMPDIR, "muxr-pairing-leak"))'],
    { env, encoding: 'utf8' });
    assert.equal(node.status, 0, node.stderr);
    assert.deepEqual(readdirSync(base), ['bin']);

    writeFileSync(lsof, '#!/bin/sh\necho "lsof: incomplete filesystem information" >&2\nexit 1\n');
    const uncertain = spawnSync(process.execPath, [wrapper, '--', process.execPath, '-e',
        'const fs=require("node:fs"),p=require("node:path");fs.mkdirSync(p.join(process.env.TMPDIR,"muxr-unknown"));console.log(process.env.TMPDIR)'],
    { env, encoding: 'utf8' });
    assert.equal(uncertain.status, 0, uncertain.stderr);
    const retained = uncertain.stdout.trim();
    assert.ok(existsSync(join(retained, 'muxr-unknown')));
    rmSync(retained, { recursive: true, force: true });

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
        testScratchOwner(base);
        assert.deepEqual(readdirSync(base).sort(), ['bin', live.split('/').at(-1)].sort());
        const owner = spawnSync(process.execPath, ['--input-type=module', '-e',
            'import { mkdtempSync, writeFileSync } from "node:fs"; import { join } from "node:path"; import { processStart } from "./scripts/diagnostics/application/testScratchOwner.mjs"; const root = mkdtempSync(join(process.env.ROOT, `muxr-host-test-${process.pid}-`)); writeFileSync(join(root, "owner"), `${process.pid} ${processStart(process.pid)}`); console.log(root)'],
        { env: { ...process.env, ROOT: base }, encoding: 'utf8' });
        assert.equal(owner.status, 0, owner.stderr);
        const departed = owner.stdout.trim();
        assert.ok(existsSync(departed));
        testScratchOwner(base);
        assert.equal(existsSync(departed), false);
        holder.kill('SIGKILL');
        await new Promise((resolve) => holder.once('exit', resolve));
        writeFileSync(lsof, '#!/bin/sh\necho "lsof: incomplete filesystem information" >&2\nexit 1\n');
        const staleAgain = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
        writeFileSync(join(staleAgain, 'owner'), `${process.pid} ${birth}-stale`);
        assert.equal(scratchUnused(staleAgain), false);
        const unknown = mkdtempSync(join(base, `muxr-host-test-${process.pid}-`));
        writeFileSync(join(unknown, 'owner'), 'unknown');
        testScratchOwner(base);
        assert.deepEqual(readdirSync(base).sort(), ['bin', live.split('/').at(-1), staleAgain.split('/').at(-1), unknown.split('/').at(-1)].sort());
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
