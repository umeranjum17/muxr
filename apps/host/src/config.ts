import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { decodeKeyBytes } from '@muxr/contract';
import type { TerminalKeyDefinition } from '@muxr/contract';

/**
 * Agent-editable host settings in `$MUXR_HOME/config.json` (beside
 * auth.json/selfhost.json). Plain JSON, no schema library. Absent or partial
 * is normal and falls back per key; anything malformed throws
 * MuxrConfigError naming the file path and the offending key, so the caller
 * can refuse to start instead of half-applying the file.
 *
 * Precedence per key: explicit flag > environment > config file > default.
 * Credentials never live here; pairing authority stays in the owner-only
 * auth.json/selfhost.json state files.
 */

export const MUXR_CONFIG_FILENAME = 'config.json';

const CONFIG_KEYS = ['mode', 'relayUrl', 'machineId', 'machineName', 'dataDir', 'hostHttpPort', 'terminalKeys', 'quickReplies'] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface MuxrFileConfig {
    mode?: 'hosted' | 'selfhost' | 'local';
    relayUrl?: string;
    machineId?: string;
    machineName?: string;
    dataDir?: string;
    hostHttpPort?: number;
    /** Operator-declared terminal key row: replaces the built-in row on every phone. */
    terminalKeys?: TerminalKeyDefinition[];
    /** Operator-declared quick replies: replace the built-in three. */
    quickReplies?: { label: string; text: string }[];
}

export interface ResolvedHostConfig {
    mode: 'hosted' | 'selfhost' | 'local' | undefined;
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
        if (mode !== 'hosted' && mode !== 'selfhost' && mode !== 'local') {
            fail(path, 'mode', 'must be "hosted", "selfhost", or "local"');
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
    if (raw('terminalKeys') !== undefined) config.terminalKeys = parseTerminalKeys(path, raw('terminalKeys'));
    if (raw('quickReplies') !== undefined) config.quickReplies = parseQuickReplies(path, raw('quickReplies'));
    return config;
}

const MAX_TERMINAL_KEYS = 24;
const MAX_QUICK_REPLIES = 8;

function parseTerminalKeys(path: string, value: unknown): TerminalKeyDefinition[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TERMINAL_KEYS) {
        fail(path, 'terminalKeys', `must be an array of 1 to ${MAX_TERMINAL_KEYS} keys`);
    }
    return value.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(path, 'terminalKeys', 'each key must be an object');
        const { label, accessibilityLabel, send, repeat } = entry as Record<string, unknown>;
        if (typeof label !== 'string' || label.trim() === '' || label.length > 12) fail(path, 'terminalKeys', 'each key needs a label of 1 to 12 characters');
        if (typeof send !== 'string' || send === '' || send.length > 512) fail(path, 'terminalKeys', 'each key needs a send of 1 to 512 characters (use \\e, \\n, \\t, \\xHH, \\\\ escapes)');
        if (accessibilityLabel !== undefined && (typeof accessibilityLabel !== 'string' || accessibilityLabel === '' || accessibilityLabel.length > 64)) fail(path, 'terminalKeys', 'accessibilityLabel must be a non-empty string of 1 to 64 characters');
        if (repeat !== undefined && typeof repeat !== 'boolean') fail(path, 'terminalKeys', 'repeat must be true or false');
        const bytes = decodeKeyBytes(send);
        if (bytes === null || bytes === '') fail(path, 'terminalKeys', `send "${send}" holds an incomplete escape (use \\\\ for a literal backslash)`);
        return {
            label: label.trim(),
            ...(accessibilityLabel === undefined ? {} : { accessibilityLabel: accessibilityLabel as string }),
            send: bytes,
            ...(repeat === true ? { repeat: true } : {}),
        };
    });
}

function parseQuickReplies(path: string, value: unknown): NonNullable<MuxrFileConfig['quickReplies']> {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUICK_REPLIES) {
        fail(path, 'quickReplies', `must be an array of 1 to ${MAX_QUICK_REPLIES} replies`);
    }
    return value.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(path, 'quickReplies', 'each reply must be an object');
        const { label, text } = entry as Record<string, unknown>;
        if (typeof label !== 'string' || label.trim() === '' || label.length > 24) fail(path, 'quickReplies', 'each reply needs a label of 1 to 24 characters');
        if (typeof text !== 'string' || text.trim() === '' || text.length > 500) fail(path, 'quickReplies', 'each reply needs text of 1 to 500 characters');
        return { label: label.trim(), text };
    });
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
        mode: 'hosted' | 'selfhost' | 'local' | undefined;
        relayUrl: string;
        machineId: string;
        machineName: string;
        dataDir: string;
        hostHttpPort: number;
    };
}): ResolvedHostConfig {
    const { argv, env, file, defaults } = options;
    const flagMode = clean(flagValue(argv, '--mode'))?.toLowerCase();
    if (flagMode !== undefined && flagMode !== 'hosted' && flagMode !== 'selfhost' && flagMode !== 'local') {
        throw new Error('--mode must be hosted, selfhost, or local');
    }
    const envMode = clean(env.MUXR_MODE)?.toLowerCase();
    if (envMode !== undefined && envMode !== 'hosted' && envMode !== 'selfhost' && envMode !== 'local') {
        throw new Error('MUXR_MODE must be hosted, selfhost, or local');
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
