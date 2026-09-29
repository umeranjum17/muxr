/**
 * Guard: tests that launch a real pi must never touch the user's real
 * ~/.pi/agent. Runs a real `pi --offline -p` with its cwd in a sentinel temp
 * dir and its agent home pointed at another temp dir, then asserts the
 * sentinel left no trace under the real agent home while the temp home
 * captured the run. Also asserts every known real-pi launcher routes through
 * the shared isolation helper (isolatePiAgentDir.mjs).
 *
 * Exits 0 with SKIP when no pi binary is available.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatePiAgentDir, releasePiAgentDir } from './isolatePiAgentDir.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
    process.stderr.write(`FAIL: ${message}\n`);
    process.exit(1);
};

let piBin = process.env.PI_BIN?.trim();
if (!piBin) {
    const found = spawnSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' });
    piBin = found.status === 0 ? found.stdout.trim() : '';
}
if (!piBin) {
    process.stdout.write('SKIP: no pi binary on PATH; cannot prove real-pi isolation\n');
    process.exit(0);
}

// Every launcher that starts a real pi must isolate it through the helper;
// the host forwards a set PI_CODING_AGENT_DIR into every pane it creates.
const root = join(here, '..', '..', '..');
const wiring = [
    ['scripts/diagnostics/application/checkWorktreeE2E.mjs', 'isolatePiAgentDir.mjs'],
    ['scripts/diagnostics/application/checkHerdrE2E.mjs', 'isolatePiAgentDir.mjs'],
    ['scripts/diagnostics/application/checkRealtimeAgentHealth.sh', 'PI_CODING_AGENT_DIR'],
    ['apps/host/src/agent/infrastructure/herdrSessionSource.ts', 'PI_CODING_AGENT_DIR'],
];
for (const [file, marker] of wiring) {
    let body;
    try {
        body = readFileSync(join(root, file), 'utf8');
    } catch {
        fail(`cannot read ${file}`);
    }
    if (!body.includes(marker)) fail(`${file} no longer routes real-pi runs through the isolated agent home (missing ${marker})`);
}
process.stdout.write('ok: every real-pi launcher routes through the isolated agent home\n');

const realAgentHome = join(homedir(), '.pi', 'agent');
const sentinel = `pock-pi-isolation-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const sentinelCwd = join(tmpdir(), sentinel);
const namesUnder = (dir) => {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
};
const leaks = () => [
    ...namesUnder(join(realAgentHome, 'projects-memory')).filter((name) => name.includes(sentinel)),
    ...namesUnder(join(realAgentHome, 'sessions')).filter((name) => name.includes(sentinel)),
];
if (leaks().length > 0) fail(`sentinel already present under the real agent home: ${leaks().join(', ')}`);

const isolation = isolatePiAgentDir();
try {
    rmSync(sentinelCwd, { recursive: true, force: true });
    mkdirSync(sentinelCwd, { recursive: true });
    // --offline avoids startup network; -p exits after the run attempt (no API
    // key here), which is after pi writes its agent-home state for this cwd.
    execFileSync(piBin, ['--offline', '-p', 'reply with exactly: hi'], {
        cwd: sentinelCwd,
        timeout: 90_000,
        encoding: 'utf8',
        env: { ...process.env, PI_CODING_AGENT_DIR: isolation.dir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
} catch (error) {
    // Expected: no provider credential in the temp home, so the run itself
    // fails. Startup file writes happen first; the assertions below decide.
    const status = error?.status;
    if (status === undefined || status === null) fail(`pi did not run to its auth gate: ${error?.message}`);
} finally {
    rmSync(sentinelCwd, { recursive: true, force: true });
}
const sessionCaptured = namesUnder(join(isolation.dir, 'sessions')).some((name) => name.includes(sentinel));
const homeTouched = existsSync(join(isolation.dir, 'auth.json')) || sessionCaptured;
releasePiAgentDir(isolation);
if (!homeTouched) {
    // The temp home must show the run happened, or this test proves nothing.
    fail('temp agent home captured no pi state for the sentinel run; isolation unproven');
}
const leaked = leaks();
if (leaked.length > 0) fail(`real-pi run leaked under the real agent home: ${leaked.join(', ')}`);
process.stdout.write('PASS e2e: real-pi runs stay inside the isolated agent home\n');
