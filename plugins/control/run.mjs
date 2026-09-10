#!/usr/bin/env node
/**
 * Herdr control-plane entrypoint. Every action executes ONE resolved muxr
 * runtime — never a checkout-relative script:
 *
 *   MUXR_BIN (explicit dev override, always wins and is always reported) >
 *   ~/.muxr/herdr-plugin.runtime recorded by build.mjs (re-verified) >
 *   `muxr` on PATH (version-checked against the recorded pin when present)
 *
 * The invoking Herdr instance travels with every action: live
 * HERDR_SOCKET_PATH/HERDR_BIN_PATH win, else the values persisted here per
 * invocation, so restart and setup target the invoking instance.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const stateDir = () => process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const runtimePath = () => join(stateDir(), 'herdr-plugin.runtime');
const instancePath = () => join(stateDir(), 'herdr-plugin.env');
const command = process.argv[2];

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

function muxrVersion(bin) {
    try {
        const check = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 15_000 });
        return check.status === 0 ? check.stdout.trim().split('\n').pop() : undefined;
    } catch {
        return undefined;
    }
}

/** Durable record of the invoking Herdr instance (state stays in ~/.muxr). */
function persistHerdrInstance() {
    const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
    const binPath = process.env.HERDR_BIN_PATH?.trim() || process.env.HERDR_BIN?.trim();
    if (!socketPath && !binPath) return;
    try {
        mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
        const lines = [
            '# Invoking Herdr instance, recorded by the muxr control plugin.',
            '# Restart and setup flows target this instance, not a guessed one.',
            ...(socketPath ? [`HERDR_SOCKET_PATH=${socketPath}`] : []),
            ...(binPath ? [`HERDR_BIN_PATH=${binPath}`] : []),
            '',
        ];
        writeFileSync(instancePath(), lines.join('\n'), { mode: 0o600 });
        chmodSync(instancePath(), 0o600);
    } catch {
        // best-effort: the pane still works against the live environment
    }
}

function persistedInstanceEnv() {
    const env = {};
    try {
        const raw = readFileSync(instancePath(), 'utf8');
        for (const line of raw.split('\n')) {
            const match = /^(HERDR_SOCKET_PATH|HERDR_BIN_PATH)=(.*)$/.exec(line.trim());
            if (match?.[1] !== undefined && match[2] !== undefined && match[2].trim() !== '') {
                env[match[1]] = match[2].trim();
            }
        }
    } catch {
        // No record yet: callers fall back to their own resolution.
    }
    return env;
}

/** Resolve the single verified runtime all actions execute. */
function resolveRuntime() {
    const devBin = process.env.MUXR_BIN?.trim();
    if (devBin) {
        process.stderr.write(`muxr control: using MUXR_BIN dev override ${devBin}\n`);
        return devBin;
    }
    const recorded = readJson(runtimePath());
    if (typeof recorded?.bin === 'string' && recorded.bin !== '') {
        const version = muxrVersion(recorded.bin);
        if (version === recorded.version) return recorded.bin;
        process.stderr.write(`muxr control: recorded runtime ${recorded.bin} reports ${version ?? 'nothing'} (expected ${recorded.version}); falling back to PATH\n`);
    }
    const probe = spawnSync('sh', ['-c', 'command -v muxr'], { encoding: 'utf8', timeout: 10_000 });
    const onPath = probe.status === 0 ? probe.stdout.trim().split('\n').pop()?.trim() : undefined;
    if (onPath === undefined || onPath === '') throw new Error('no muxr runtime: rerun `herdr plugin install muxr` (or set MUXR_BIN to a dev checkout CLI)');
    if (typeof recorded?.version === 'string' && muxrVersion(onPath) !== recorded.version) {
        throw new Error(`muxr on PATH is not the pinned ${recorded.version}; rerun \`herdr plugin install muxr\` to repair (or set MUXR_BIN)`);
    }
    return onPath;
}

function runCli(argv) {
    const persisted = persistedInstanceEnv();
    const socketPath = process.env.HERDR_SOCKET_PATH?.trim() || persisted.HERDR_SOCKET_PATH;
    const binPath = process.env.HERDR_BIN_PATH?.trim() || process.env.HERDR_BIN?.trim() || persisted.HERDR_BIN_PATH;
    const env = {
        ...process.env,
        ...(socketPath ? { HERDR_SOCKET_PATH: socketPath } : {}),
        ...(binPath ? { HERDR_BIN: binPath, HERDR_BIN_PATH: binPath } : {}),
    };
    const executable = resolveRuntime();
    const result = spawnSync(executable, argv, { stdio: 'inherit', env });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    return result.status ?? 1;
}

/** Idempotent startup: kick the configured service, never configure. */
function startIfConfigured() {
    const home = stateDir();
    let configured = false;
    try {
        const state = JSON.parse(readFileSync(join(home, 'selfhost.json'), 'utf8'));
        configured = typeof state?.machine?.id === 'string';
    } catch { configured = false; }
    if (!configured) return 0;
    if (existsSync(runtimePath()) && runCli(['daemon', 'status', '--quiet']) === 0) return 0;
    try {
        return runCli(['daemon', 'start', '--quiet']);
    } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        return 1;
    }
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
        try {
            process.exitCode = runCli(argv);
        } catch (cause) {
            process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
            process.exitCode = 1;
        }
    }
}
