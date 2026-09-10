#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const packageCli = resolve(root, '../../cli.mjs');
const bundledCli = existsSync(packageCli) ? packageCli : resolve(root, '../../scripts/cli.mjs');
const command = process.argv[2];

/** Durable record of the invoking Herdr instance (state stays in ~/.muxr). */
function persistHerdrInstance() {
    const home = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
    const binPath = process.env.HERDR_BIN_PATH?.trim() || process.env.HERDR_BIN?.trim();
    if (!socketPath && !binPath) return;
    try {
        mkdirSync(home, { recursive: true, mode: 0o700 });
        const lines = [
            '# Invoking Herdr instance, recorded by the muxr control plugin.',
            '# Restart and setup flows target this instance, not a guessed one.',
            ...(socketPath ? [`HERDR_SOCKET_PATH=${socketPath}`] : []),
            ...(binPath ? [`HERDR_BIN_PATH=${binPath}`] : []),
            '',
        ];
        const path = join(home, 'herdr-plugin.env');
        writeFileSync(path, lines.join('\n'), { mode: 0o600 });
        chmodSync(path, 0o600);
    } catch {
        // best-effort: the pane still works against the live environment
    }
}

function runCli(argv, extraEnv = {}) {
    const executable = process.env.MUXR_BIN?.trim();
    const env = {
        ...process.env,
        // Invoking instance wins over guesses elsewhere in the setup stack.
        ...(process.env.HERDR_BIN_PATH?.trim() && !process.env.HERDR_BIN?.trim()
            ? { HERDR_BIN: process.env.HERDR_BIN_PATH.trim() }
            : {}),
        ...extraEnv,
    };
    const result = executable
        ? spawnSync(executable, argv, { stdio: 'inherit', env })
        : spawnSync(process.execPath, [bundledCli, ...argv], { stdio: 'inherit', env });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    return result.status ?? 1;
}

/** Idempotent startup: kick the configured service, never configure. */
function startIfConfigured() {
    const home = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    let configured = false;
    try {
        const state = JSON.parse(readFileSync(join(home, 'selfhost.json'), 'utf8'));
        configured = typeof state?.machine?.id === 'string';
    } catch { configured = false; }
    if (!configured) return 0;
    if (runCli(['daemon', 'status', '--quiet']) === 0) return 0;
    return runCli(['daemon', 'start', '--quiet']);
}

persistHerdrInstance();

const commands = new Map([
    ['setup', ['setup', '--from-plugin']],
    ['pair', ['pair']],
    ['devices', ['devices', 'list']],
    ['doctor', ['doctor']],
    ['service', ['daemon', 'status']],
    ['selfhost', ['self-host', '--web']],
]);

if (command === 'start-if-configured') {
    process.exitCode = startIfConfigured();
} else {
    const argv = commands.get(command);
    if (!argv) {
        process.stderr.write(`unknown muxr control action: ${command ?? ''}\n`);
        process.exitCode = 1;
    } else {
        process.exitCode = runCli(argv);
    }
}
