import { homedir } from 'node:os';
import { join } from 'node:path';

export type RelayAuthMode = 'permissive' | 'strict';
export type RelayE2eeMode = 'off' | 'on';

/**
 * Core policy is capability-based. Commercial deployment names and account
 * policy belong to the process embedding the relay, not this OSS package.
 */
export interface RelayConfig {
    port: number;
    host: string;
    dataDir: string;
    authMode: RelayAuthMode;
    e2eeMode: RelayE2eeMode;
    /** Enables the relay's file-backed pairing/ticket/device API. */
    localAuthority: boolean;
    /** Enables the loopback development account/synthetic HTTP fixture. */
    developmentApi: boolean;
    /** Enables LAN mDNS advertisement. */
    advertiseMdns: boolean;
    /** Adds strict public-edge HTTP behavior such as HSTS and request timeout. */
    publicEdge: boolean;
    trustProxy: boolean;
    maxPayloadBytes: number;
    allowedOrigins: ReadonlySet<string>;
    bufferLimit: number;
    bufferTtlMs: number;
    replayLimit: number;
    replayTtlMs: number;
    pushWebhookUrl?: string;
    pushWebhookRetries: number;
    pushWebhookTimeoutMs: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
function readEnv(name: string): string | undefined {
    return process.env[name]?.trim() || undefined;
}

function readInt(name: string, fallback: number): number {
    const raw = readEnv(name);
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
    const raw = readEnv(name)?.toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    return fallback;
}

function readAuthMode(host: string, developmentApi: boolean): RelayAuthMode {
    const raw = readEnv('MUXR_RELAY_AUTH')?.toLowerCase();
    if (raw === 'permissive' || raw === 'strict') return raw;
    return developmentApi && LOOPBACK.has(host) ? 'permissive' : 'strict';
}

function readE2eeMode(developmentApi: boolean): RelayE2eeMode {
    const raw = readEnv('MUXR_RELAY_E2EE')?.toLowerCase();
    if (raw === 'off' && !developmentApi) {
        process.stderr.write('warning: MUXR_RELAY_E2EE=off is ignored outside the explicit development API\n');
        return 'on';
    }
    return raw === 'off' ? 'off' : raw === 'on' ? 'on' : developmentApi ? 'off' : 'on';
}

function readOrigins(value: string | undefined): ReadonlySet<string> {
    return new Set((value ?? '').split(',').map((origin) => origin.trim()).filter(Boolean));
}

function defaultDataDir(): string {
    return join(homedir(), '.muxr', 'relay');
}

export function loadRelayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
    const developmentApi = overrides.developmentApi ?? readBool('MUXR_RELAY_DEVELOPMENT_API', false);
    const localAuthority = overrides.localAuthority ?? readBool('MUXR_RELAY_LOCAL_AUTHORITY', true);
    const publicEdge = overrides.publicEdge ?? readBool('MUXR_RELAY_PUBLIC_EDGE', false);
    const host = overrides.host ?? readEnv('MUXR_RELAY_HOST') ?? '127.0.0.1';
    const authMode = overrides.authMode ?? readAuthMode(host, developmentApi);
    if (developmentApi && !LOOPBACK.has(host)) {
        throw new Error('MUXR_RELAY_DEVELOPMENT_API refuses a non-loopback bind');
    }
    const pushWebhookUrl = overrides.pushWebhookUrl ?? readEnv('MUXR_RELAY_PUSH_WEBHOOK');
    return {
        port: overrides.port ?? readInt('MUXR_RELAY_PORT', publicEdge ? readInt('PORT', 0) : 8792),
        host,
        dataDir: overrides.dataDir ?? readEnv('MUXR_RELAY_DATA_DIR') ?? defaultDataDir(),
        authMode,
        e2eeMode: overrides.e2eeMode ?? readE2eeMode(developmentApi),
        localAuthority,
        developmentApi,
        advertiseMdns: overrides.advertiseMdns ?? readBool('MUXR_RELAY_MDNS', localAuthority),
        publicEdge,
        trustProxy: overrides.trustProxy ?? readBool('MUXR_TRUST_PROXY', publicEdge),
        maxPayloadBytes: overrides.maxPayloadBytes ?? readInt('MUXR_RELAY_MAX_PAYLOAD_BYTES', developmentApi ? 512 * 1024 * 1024 : 4 * 1024 * 1024),
        allowedOrigins: overrides.allowedOrigins ?? readOrigins(readEnv('MUXR_ALLOWED_ORIGINS')),
        bufferLimit: overrides.bufferLimit ?? readInt('MUXR_RELAY_BUFFER_LIMIT', 500),
        bufferTtlMs: overrides.bufferTtlMs ?? readInt('MUXR_RELAY_BUFFER_TTL_MS', 86_400_000),
        replayLimit: overrides.replayLimit ?? readInt('MUXR_RELAY_REPLAY_LIMIT', 1000),
        replayTtlMs: overrides.replayTtlMs ?? readInt('MUXR_RELAY_REPLAY_TTL_MS', 3_600_000),
        ...(pushWebhookUrl === undefined ? {} : { pushWebhookUrl }),
        pushWebhookRetries: overrides.pushWebhookRetries ?? readInt('MUXR_RELAY_PUSH_WEBHOOK_RETRIES', 2),
        pushWebhookTimeoutMs: overrides.pushWebhookTimeoutMs ?? readInt('MUXR_RELAY_PUSH_WEBHOOK_TIMEOUT_MS', 3000),
    };
}

/** Client IP for rate limiting; honors XFF only when trustProxy is set. */
export function clientIp(req: import('node:http').IncomingMessage, trustProxy: boolean): string {
    if (trustProxy) {
        const forwarded = req.headers['x-forwarded-for'];
        const chain = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',').map((part) => part.trim());
        const trusted = chain?.at(-1);
        if (trusted !== undefined && /^[0-9a-f:.]{3,64}$/i.test(trusted)) return trusted;
    }
    return req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
}

export function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) return false;
    const normalized = address.replace(/^::ffff:/, '');
    return LOOPBACK.has(normalized);
}
