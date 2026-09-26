import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RelayConfig {
    port: number;
    host: string;
    dataDir: string;
    advertiseMdns: boolean;
    mdnsMachineId?: string;
    mdnsRelayUrl?: string;
    mdnsConnectionMode?: string;
    mdnsName?: string;
    publicEdge: boolean;
    trustProxy: boolean;
    allowedOrigins: ReadonlySet<string>;
}

const readEnv = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const readBool = (name: string, fallback: boolean): boolean => {
    const raw = readEnv(name)?.toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    return fallback;
};

export function loadRelayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
    const port = Number(readEnv('MUXR_RELAY_PORT') ?? 8792);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MUXR_RELAY_PORT must be a valid port');
    const publicEdge = overrides.publicEdge ?? readBool('MUXR_RELAY_PUBLIC_EDGE', false);
    const mdnsMachineId = overrides.mdnsMachineId ?? readEnv('MUXR_RELAY_MDNS_MACHINE');
    const mdnsRelayUrl = overrides.mdnsRelayUrl ?? readEnv('MUXR_RELAY_MDNS_RELAY');
    const mdnsConnectionMode = overrides.mdnsConnectionMode ?? readEnv('MUXR_RELAY_MDNS_MODE');
    const mdnsName = overrides.mdnsName ?? readEnv('MUXR_RELAY_MDNS_NAME');
    return {
        port: overrides.port ?? port,
        host: overrides.host ?? readEnv('MUXR_RELAY_HOST') ?? '127.0.0.1',
        dataDir: overrides.dataDir ?? readEnv('MUXR_RELAY_DATA_DIR') ?? join(homedir(), '.muxr', 'relay'),
        advertiseMdns: overrides.advertiseMdns ?? readBool('MUXR_RELAY_MDNS', true),
        ...(mdnsMachineId === undefined ? {} : { mdnsMachineId }),
        ...(mdnsRelayUrl === undefined ? {} : { mdnsRelayUrl }),
        ...(mdnsConnectionMode === undefined ? {} : { mdnsConnectionMode }),
        ...(mdnsName === undefined ? {} : { mdnsName }),
        publicEdge,
        trustProxy: overrides.trustProxy ?? readBool('MUXR_TRUST_PROXY', publicEdge),
        allowedOrigins: overrides.allowedOrigins ?? new Set((readEnv('MUXR_ALLOWED_ORIGINS') ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)),
    };
}

export function clientIp(req: import('node:http').IncomingMessage, trustProxy: boolean): string {
    if (trustProxy) {
        const forwarded = req.headers['x-forwarded-for'];
        const chain = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',').map((part) => part.trim());
        const trusted = chain?.at(-1);
        if (trusted !== undefined && /^[0-9a-f:.]{3,64}$/i.test(trusted)) return trusted;
    }
    return req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
}

export function isLoopbackAddress(value: string | undefined): boolean {
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
