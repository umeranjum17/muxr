import { accepted, rejected, type Result } from './result.js';

export function publicRelayUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    try {
        const parsed = new URL(value);
        if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') return undefined;
        return parsed.origin;
    } catch {
        return undefined;
    }
}

export type RelayLocation = 'local' | 'remote';
export type RelayRole = 'shared' | 'single-machine';

export type Connection = {
    mode: string | undefined;
    location: RelayLocation;
    role: RelayRole | undefined;
    relayUrl: string | undefined;
    relayPort: number | undefined;
    webEnabled: boolean;
    isRemote: boolean;
    isSharedRelay: boolean;
    usesCloudflare: boolean;
    usesExternal: boolean;
    secureWebSocket: boolean;
    canEnableBrowserHosting: () => boolean;
    browserHostingReady: () => boolean;
    rejectionForBrowserHosting: () => string | undefined;
    controlBase: (remoteOverride?: string) => string;
    credential: () => unknown;
    reconfigureArgs: () => string[];
    bindLoopback: (options: { tailscale?: unknown; tunnel?: boolean; web?: boolean; advertise?: string }) => string;
    ingressExemptFromSelfProbe: () => boolean;
    webUrl: () => string | undefined;
    sameAs: (options: { port: number; connectionMode: unknown; web: boolean; explicitAdvertise?: string }) => boolean;
    credentialDaysRemaining: (now?: number) => number | undefined;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    return value as Record<string, unknown>;
}

export function parseConnection(state: unknown): Result<Connection> {
    const record = asRecord(state);
    if (record === undefined) return rejected('self-host is not configured');
    const relayUrl = publicRelayUrl(record.relayUrl);
    const location: RelayLocation = record.relayLocation === 'remote' ? 'remote' : 'local';
    let role: RelayRole | undefined;
    if (record.relayRole === 'shared') role = 'shared';
    else if (record.relayRole === 'single-machine') role = 'single-machine';
    const mode = typeof record.connectionMode === 'string' ? record.connectionMode : undefined;
    const webEnabled = record.webEnabled === true;
    const secure = relayUrl?.startsWith('wss://') === true;
    const relayPort = Number.isInteger(record.relayPort) ? record.relayPort as number : undefined;
    return accepted(Object.freeze({
        mode,
        location,
        role,
        relayUrl,
        relayPort,
        webEnabled,
        isRemote: location === 'remote',
        isSharedRelay: role === 'shared',
        usesCloudflare: mode === 'cloudflare',
        usesExternal: mode === 'external',
        secureWebSocket: secure,
        canEnableBrowserHosting() {
            return location !== 'remote' && mode !== 'cloudflare' && secure;
        },
        browserHostingReady() {
            return webEnabled && secure;
        },
        rejectionForBrowserHosting() {
            if (location === 'remote') {
                return 'Browser hosting must be enabled by the shared-relay owner, then this computer must reconnect with a fresh enrollment.';
            }
            if (mode === 'cloudflare') {
                return 'The current quick Cloudflare URL is temporary. Change setup to Tailscale Serve or your own stable WSS endpoint before enabling browser access.';
            }
            if (!secure) {
                return 'Browser access needs a secure HTTPS connection. Change this setup to Tailscale Serve or your own WSS endpoint first.';
            }
            return undefined;
        },
        controlBase(remoteOverride?: string) {
            if (location === 'remote' && remoteOverride) return remoteOverride.replace(/\/$/, '');
            if (location === 'remote' && relayUrl !== undefined) {
                return relayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
            }
            return `http://127.0.0.1:${record.relayPort}`;
        },
        credential() {
            return typeof record.mintSecret === 'string' ? record.mintSecret : record.machineCredential;
        },
        reconfigureArgs() {
            const args: string[] = [];
            if (typeof mode === 'string') args.push('--connection-mode', mode);
            if (mode === 'external' || mode === 'private' || mode === 'cloudflare') args.push('--advertise', String(record.relayUrl));
            return args;
        },
        bindLoopback({ tailscale, tunnel, web, advertise }) {
            if (tailscale || tunnel || web || advertise?.startsWith('wss://')) return '127.0.0.1';
            return '0.0.0.0';
        },
        ingressExemptFromSelfProbe() {
            return mode === 'external';
        },
        webUrl() {
            return webEnabled ? relayUrl?.replace(/^ws/, 'http') : undefined;
        },
        sameAs({ port, connectionMode, web, explicitAdvertise }) {
            if (record.relayPort !== port || record.connectionMode !== connectionMode || record.webEnabled !== web) return false;
            if (connectionMode === 'external' || connectionMode === 'private' || connectionMode === 'lan') return record.relayUrl === explicitAdvertise;
            return true;
        },
        credentialDaysRemaining(now = Date.now()) {
            if (typeof record.credentialExpiresAt !== 'string') return undefined;
            const expires = Date.parse(record.credentialExpiresAt);
            if (!Number.isFinite(expires)) return undefined;
            return Math.ceil((expires - now) / (24 * 60 * 60_000));
        },
    }));
}

export type AdvertiseContext = {
    mode: string;
    found: { private?: { address: string }; lan?: string; tailscale: { ip?: string; dnsName?: string } };
    current?: { connectionMode?: string; relayUrl?: string; relayPort?: number; webEnabled?: boolean; ingressHealthy?: boolean };
    port: number;
    endpoint?: string;
    web: boolean;
    tailscalePlanned: boolean;
};

export function advertisedUrlForMode(context: AdvertiseContext): string | undefined {
    const { mode, found, current, port, endpoint, web, tailscalePlanned } = context;
    if (mode === 'lan') return found.lan === undefined ? undefined : `ws://${found.lan}:${port}`;
    if (mode === 'private') return endpoint ?? (found.private === undefined ? undefined : `ws://${found.private.address}:${port}`);
    if (mode === 'external') return endpoint;
    if (mode === 'tailscale-direct' && found.tailscale.ip) return `ws://${found.tailscale.ip}:${port}`;
    if (mode === 'tailscale-direct' && tailscalePlanned && current?.connectionMode === mode) return current.relayUrl;
    if (mode === 'tailscale' && found.tailscale.dnsName) return `wss://${found.tailscale.dnsName}`;
    if (mode === 'tailscale' && tailscalePlanned && current?.connectionMode === mode) return current.relayUrl;
    const reuseCloudflare = mode === 'cloudflare'
        && current?.connectionMode === 'cloudflare'
        && current.relayPort === port
        && current.webEnabled === web
        && current.ingressHealthy === true;
    if (reuseCloudflare) return current.relayUrl;
    return undefined;
}

export function ingressPlan(mode: string, tailscalePlanned: boolean, { shared = false } = {}): string {
    if (mode === 'tailscale') {
        const connect = tailscalePlanned ? 'connect Tailscale, then ' : '';
        if (shared) return `${connect}create a muxr-owned Tailscale Serve route`;
        return `${connect}persist a muxr-owned Tailscale Serve route`;
    }
    if (mode === 'cloudflare') return 'start a tracked temporary Cloudflare tunnel';
    if (mode === 'external') {
        if (shared) return 'your stable external reverse proxy or named Cloudflare tunnel';
        return 'bind loopback for your external reverse proxy';
    }
    if (shared) return 'your stable external reverse proxy or named Cloudflare tunnel';
    return 'no proxy or public tunnel changes';
}

export function connectionLabel(mode: string, endpoint: string | undefined, port: number): string {
    if (mode === 'tailscale') return `Tailscale Serve on local port ${port}`;
    if (mode === 'tailscale-direct') return `Direct Tailscale on port ${port}`;
    if (mode === 'private') return `Private network on port ${port}`;
    if (mode === 'lan') return `Trusted LAN on port ${port}`;
    if (mode === 'cloudflare') return `Cloudflare quick tunnel to local port ${port}`;
    return `External ${endpoint ?? ''}`;
}

export function modeAllowsBrowserHosting(mode: string): boolean {
    return mode === 'tailscale' || mode === 'external' || mode === 'cloudflare';
}
