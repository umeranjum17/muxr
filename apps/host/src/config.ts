import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Agent-editable host settings in `$MUXR_HOME/config.json` (beside
 * selfhost.json). Plain JSON, no schema library. Absent or partial
 * is normal and falls back per key; anything malformed throws
 * MuxrConfigError naming the file path and the offending key, so the caller
 * can refuse to start instead of half-applying the file.
 *
 * Precedence per key: explicit flag > environment > config file > default.
 * Credentials never live here; pairing authority stays in the owner-only
 * selfhost.json state file.
 */

export const MUXR_CONFIG_FILENAME = 'config.json';

const CONFIG_KEYS = ['mode', 'relayUrl', 'machineId', 'machineName', 'dataDir', 'hostHttpPort'] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface MuxrFileConfig {
    mode?: 'selfhost' | 'local';
    relayUrl?: string;
    machineId?: string;
    machineName?: string;
    dataDir?: string;
    hostHttpPort?: number;
}

export interface ResolvedHostConfig {
    mode: 'selfhost' | 'local' | undefined;
    relayUrl: string;
    machineId: string;
    machineName: string;
    dataDir: string;
    hostHttpPort: number;
}

export class MuxrConfigError extends Error {
    readonly path: string;
    readonly key: string;
    constructor(path: string, key: string, reason: string) {
        super(`${path}: key "${key}": ${reason}`);
        this.name = 'MuxrConfigError';
        this.path = path;
        this.key = key;
    }
}

export function muxrHomeDir(env: Record<string, string | undefined>): string {
    const override = env.MUXR_HOME?.trim();
    if (override !== undefined && override !== '') return override;
    return join(env.HOME?.trim() || homedir(), '.muxr');
}

export function muxrConfigPath(env: Record<string, string | undefined>): string {
    return join(muxrHomeDir(env), MUXR_CONFIG_FILENAME);
}

function fail(path: string, key: string, reason: string): never {
    throw new MuxrConfigError(path, key, reason);
}

function validRelayUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'ws:' || url.protocol === 'wss:';
    } catch {
        return false;
    }
}

/** Validate a parsed file fully before returning anything: never half-apply. */
export function parseMuxrConfigFile(path: string, text: string): MuxrFileConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const configError = new MuxrConfigError(path, '(file)', `contains malformed JSON (${detail})`);
        throw configError;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fail(path, '(file)', 'must be a JSON object');
    }
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!(CONFIG_KEYS as readonly string[]).includes(key)) fail(path, key, 'unknown setting');
    }
    const config: MuxrFileConfig = {};
    const raw = (key: ConfigKey): unknown => record[key];
    if (raw('mode') !== undefined) {
        const mode = raw('mode');
        if (mode !== 'selfhost' && mode !== 'local') {
            fail(path, 'mode', 'must be "selfhost" or "local"');
        }
        config.mode = mode;
    }
    if (raw('relayUrl') !== undefined) {
        if (typeof raw('relayUrl') !== 'string' || !validRelayUrl((raw('relayUrl') as string).trim())) {
            fail(path, 'relayUrl', 'must be a ws:// or wss:// URL');
        }
        config.relayUrl = (raw('relayUrl') as string).trim();
    }
    for (const key of ['machineId', 'machineName'] as const) {
        if (raw(key) !== undefined) {
            if (typeof raw(key) !== 'string' || (raw(key) as string).trim() === '') {
                fail(path, key, 'must be a non-empty string');
            }
            config[key] = (raw(key) as string).trim();
        }
    }
    if (raw('dataDir') !== undefined) {
        if (typeof raw('dataDir') !== 'string' || (raw('dataDir') as string).trim() === '') {
            fail(path, 'dataDir', 'must be a non-empty absolute path');
        }
        const dir = (raw('dataDir') as string).trim();
        if (!isAbsolute(dir)) fail(path, 'dataDir', 'must be a non-empty absolute path');
        config.dataDir = dir;
    }
    if (raw('hostHttpPort') !== undefined) {
        if (!Number.isInteger(raw('hostHttpPort')) || (raw('hostHttpPort') as number) < 1 || (raw('hostHttpPort') as number) > 65535) {
            fail(path, 'hostHttpPort', 'must be an integer from 1 to 65535');
        }
        config.hostHttpPort = raw('hostHttpPort') as number;
    }
    return config;
}

/** Absent file is normal: every key falls back. Unreadable file is fatal. */
export function readMuxrConfigFile(path: string): MuxrFileConfig {
    if (!existsSync(path)) return {};
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EACCES' || code === 'EPERM') {
            throw new MuxrConfigError(path, '(file)', 'cannot be read; restore owner read permission');
        }
        throw error;
    }
    return parseMuxrConfigFile(path, text);
}

function flagValue(argv: string[], name: string): string | undefined {
    const inline = argv.find((arg) => arg.startsWith(`${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    return argv[index + 1];
}

function clean(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function portFrom(source: string, raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${source} must be an integer from 1 to 65535`);
    }
    return port;
}

/**
 * One precedence chain per key: flag > environment > config file > default.
 * The `defaults` carry today's fallbacks (setup state, hostname, builtin
 * ports); mode may stay undefined so the caller keeps its "not configured"
 * error.
 */
export function resolveHostConfig(options: {
    argv: string[];
    env: Record<string, string | undefined>;
    file: MuxrFileConfig;
    defaults: {
        mode: 'selfhost' | 'local' | undefined;
        relayUrl: string;
        machineId: string;
        machineName: string;
        dataDir: string;
        hostHttpPort: number;
    };
}): ResolvedHostConfig {
    const { argv, env, file, defaults } = options;
    const flagMode = clean(flagValue(argv, '--mode'))?.toLowerCase();
    if (flagMode !== undefined && flagMode !== 'selfhost' && flagMode !== 'local') {
        throw new Error('--mode must be selfhost or local');
    }
    const envMode = clean(env.MUXR_MODE)?.toLowerCase();
    if (envMode !== undefined && envMode !== 'selfhost' && envMode !== 'local') {
        throw new Error('MUXR_MODE must be selfhost or local');
    }
    const mode = (flagMode ?? envMode ?? file.mode ?? defaults.mode) as ResolvedHostConfig['mode'];
    return {
        mode,
        relayUrl: clean(flagValue(argv, '--relay-url')) ?? clean(env.MUXR_RELAY_URL) ?? file.relayUrl ?? defaults.relayUrl,
        machineId: clean(flagValue(argv, '--machine-id')) ?? clean(env.MUXR_MACHINE_ID) ?? file.machineId ?? defaults.machineId,
        machineName: clean(flagValue(argv, '--machine-name')) ?? clean(env.MUXR_MACHINE_NAME) ?? file.machineName ?? defaults.machineName,
        dataDir: clean(flagValue(argv, '--data-dir')) ?? clean(env.MUXR_DATA_DIR) ?? file.dataDir ?? defaults.dataDir,
        hostHttpPort: portFrom('--host-http-port', clean(flagValue(argv, '--host-http-port')))
            ?? portFrom('MUXR_HOST_HTTP_PORT', clean(env.MUXR_HOST_HTTP_PORT))
            ?? file.hostHttpPort
            ?? defaults.hostHttpPort,
    };
}
