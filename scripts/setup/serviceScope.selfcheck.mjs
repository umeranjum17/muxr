#!/usr/bin/env node
/**
 * Service-scope regression check: a CLI scoped to a non-default MUXR_HOME
 * must never issue a service command against the default muxr.service.
 *
 * It drives the shared service helper plus the real pair flow with a fake
 * `systemctl`/`launchctl` first on PATH (argv goes to a log file; the real
 * service manager is never touched) and fails if the default unit is ever
 * named in a service command. Default-home behavior is pinned unchanged.
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const fail = (message) => {
    process.stderr.write(`service-scope self-check FAILED: ${message}\n`);
    process.exit(1);
};

const root = mkdtempSync(join(tmpdir(), 'muxr-service-scope-'));
const bin = join(root, 'bin');
const fakeHome = join(root, 'home');
const labHome = join(root, 'muxr-lab');
const callsLog = join(root, 'calls.log');
const passwdHome = (() => { try { return userInfo().homedir; } catch { return undefined; } })();
mkdirSync(bin, { recursive: true });
mkdirSync(fakeHome, { recursive: true });
mkdirSync(labHome, { recursive: true });
for (const command of ['systemctl', 'launchctl', 'journalctl', 'loginctl']) {
    writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callsLog}'\nexit 0\n`, { mode: 0o755 });
}
writeFileSync(callsLog, '');
process.env.HOME = passwdHome ?? fakeHome;
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
delete process.env.MUXR_NO_SERVICE_COMMANDS;

const loggedCalls = () => readFileSync(callsLog, 'utf8');
const resetLog = () => writeFileSync(callsLog, '');
const namesDefaultUnit = (log) => /muxr\.service|com\.muxr\.host/.test(log);

const daemon = await import('./infrastructure/daemon.mjs');

// 1. Shared helper: every service action refuses under a lab MUXR_HOME (HOME is the real one, so only that check runs).
process.env.MUXR_HOME = labHome;
for (const action of ['start', 'restart', 'stop', 'status', 'unload', 'reload']) {
    resetLog();
    const result = daemon.serviceCommand(action);
    if (result.ok) fail(`serviceCommand('${action}') succeeded under a non-default MUXR_HOME`);
    if (namesDefaultUnit(loggedCalls())) fail(`serviceCommand('${action}') named the default unit: ${loggedCalls()}`);
    if (loggedCalls() !== '') fail(`serviceCommand('${action}') spawned a service manager at all: ${loggedCalls()}`);
}
try {
    daemon.daemonDefinition('selfhost');
    fail('daemonDefinition() did not refuse under a non-default MUXR_HOME');
} catch (cause) {
    if (!/never touch muxr\.service/.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
}

// 2. Pair flow: an unhealthy lab relay must not restart the owner service.
// The lab state points at a closed port so health checks fail fast.
writeFileSync(join(labHome, 'selfhost.json'), JSON.stringify({
    version: 1,
    machine: { crypto: {} },
    mintSecret: 'lab-secret-that-is-never-minted',
    relayLocation: 'local',
    relayPort: 1,
}));
resetLog();
const { pairDevice } = await import('./application/pairDevice.mjs');
const code = await pairDevice([]);
if (code === 0) fail('pairDevice() unexpectedly succeeded against a dead lab relay');
if (namesDefaultUnit(loggedCalls())) fail(`pair flow named the default unit: ${loggedCalls()}`);
if (loggedCalls() !== '') fail(`pair flow spawned a service manager at all: ${loggedCalls()}`);

// Without a passwd entry the HOME comparison is skipped, so steps 3 and 4 have nothing to check.
if (passwdHome !== undefined) {
    // 3. An overridden HOME (no MUXR_HOME) is refused too: systemctl --user ignores HOME.
    delete process.env.MUXR_HOME;
    process.env.HOME = fakeHome;
    resetLog();
    const homeOverride = daemon.serviceCommand('restart');
    if (homeOverride.ok || loggedCalls() !== '') fail(`serviceCommand('restart') ran under an overridden HOME: ${loggedCalls()}`);

    // 4. Default home keeps working: restart still targets muxr.service.
    process.env.HOME = passwdHome;
    resetLog();
    const restart = daemon.serviceCommand('restart');
    if (!restart.ok) fail(`serviceCommand('restart') refused for the default MUXR_HOME: ${restart.stderr}`);
    if (!namesDefaultUnit(loggedCalls())) fail('serviceCommand(\'restart\') stopped targeting muxr.service for the default MUXR_HOME');
}

rmSync(root, { recursive: true, force: true });
const defaultHomeNote = passwdHome !== undefined ? 'default home unchanged' : 'overridden-HOME and default-home checks skipped: no passwd home';
process.stdout.write(`service-scope self-check: lab MUXR_HOME never touches muxr.service; ${defaultHomeNote}\n`);
