/**
 * Registry of project preview endpoints.
 *
 * An endpoint is one host-approved loopback listener seen from one project
 * context through one provider. Its identity is `context + provider + port`,
 * and each identity gets one stable, separate public HTTPS origin, so app
 * cookies and storage stay with the project across dev-server restarts while
 * two projects never share an origin.
 *
 * The process generation is what stops a reused port from silently becoming
 * another app: it moves whenever the upstream listener changes. The listener
 * is identified through its socket inode in `/proc/net/tcp{,6}` -- a fresh
 * `listen()` is a fresh inode -- and the gateway closes every connection of
 * the endpoint when the generation moves, so a lease bound to the old
 * generation admits nothing on the new process.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface PreviewEndpointIdentity {
    context: string;
    provider: string;
    /** Host-approved loopback port. Never renderer-supplied. */
    port: number;
}

export interface PreviewEndpoint extends PreviewEndpointIdentity {
    id: string;
    /** Moves when the upstream listener changes. */
    generation: number;
    /** Public preview hostname. Safe to print. */
    hostname: string;
    /** Public HTTPS origin the renderer loads. */
    origin: string;
}

/** Small interface so the PWA lane (Caddy/frp) can own the real route later. */
export interface PreviewOriginAllocator {
    hostnameFor(endpoint: { id: string } & PreviewEndpointIdentity): string;
}

export interface PreviewEndpointRegistryOptions {
    allocator?: PreviewOriginAllocator;
    /** Public port of the HTTPS origin; 443 behind Caddy, the gateway's own in dev TLS mode (read at registration). */
    publicPort: number | (() => number);
    /** Injected by tests. Production reads the listening socket identity. */
    fingerprint?: (port: number) => string | undefined;
    /** Re-fingerprint cadence for endpoints in use. */
    pollMs?: number;
}

export interface PreviewEndpointRegistry {
    /** Idempotent. Refreshes the listener fingerprint and moves the generation if it changed. */
    register(identity: PreviewEndpointIdentity): PreviewEndpoint;
    get(id: string): PreviewEndpoint | undefined;
    byHostname(hostname: string): PreviewEndpoint | undefined;
    idFor(identity: PreviewEndpointIdentity): string;
    /** Re-read every listener now; generations move where the listener changed. */
    refresh(): void;
    /** Subscribed by the gateway: close every connection of that endpoint. */
    onGenerationMoved: ((endpoint: PreviewEndpoint) => void) | undefined;
    dispose(): void;
}

const DEFAULT_POLL_MS = 2_000;
const MAX_ENDPOINTS = 32;

/**
 * Default allocator: `<label>.<base>` where the base comes from
 * `MUXR_PREVIEW_ORIGIN_BASE` (`preview.localhost` in dev: Chromium resolves
 * `*.localhost` to loopback without DNS and treats it as a secure context)
 * and the label is a short stable digest of the endpoint identity.
 */
export function defaultOriginAllocator(base = process.env.MUXR_PREVIEW_ORIGIN_BASE?.trim() || 'preview.localhost'): PreviewOriginAllocator {
    const cleanBase = base.toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!/^[a-z0-9.-]+$/.test(cleanBase)) throw new Error('preview: the preview origin base is not a hostname');
    return { hostnameFor: (endpoint) => `${endpoint.id}.${cleanBase}` };
}

/**
 * Identity of the listener on a loopback port: the inode(s) of its LISTEN
 * socket(s) in /proc. Undefined when nothing listens (or off Linux).
 */
// ponytail: Linux /proc only; macOS would need `lsof -iTCP:PORT -sTCP:LISTEN -Fn` -- add when a paired macOS host exists.
export function listenerFingerprint(port: number): string | undefined {
    const wanted = port.toString(16).toUpperCase().padStart(4, '0');
    const inodes: string[] = [];
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let text: string;
        try {
            text = readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        for (const line of text.split('\n').slice(1)) {
            const columns = line.trim().split(/\s+/);
            const local = columns[1];
            if (local === undefined || columns[3] !== '0A') continue;
            if (local.slice(local.lastIndexOf(':') + 1) !== wanted) continue;
            const inode = columns[9];
            if (inode !== undefined) inodes.push(`${columns[7] ?? ''}:${inode}`);
        }
    }
    return inodes.length === 0 ? undefined : inodes.sort().join(',');
}

export function createPreviewEndpoints(options: PreviewEndpointRegistryOptions): PreviewEndpointRegistry {
    const allocator = options.allocator ?? defaultOriginAllocator();
    const fingerprint = options.fingerprint ?? listenerFingerprint;
    const endpoints = new Map<string, PreviewEndpoint & { fingerprint: string | undefined }>();
    const byHost = new Map<string, string>();

    const idFor = (identity: PreviewEndpointIdentity): string =>
        createHash('sha256')
            .update(`${identity.context}\0${identity.provider}\0${identity.port}`)
            .digest('hex')
            .slice(0, 16);

    const originOf = (hostname: string): string => {
        const port = typeof options.publicPort === 'function' ? options.publicPort() : options.publicPort;
        return `https://${hostname}${port === 443 ? '' : `:${port}`}`;
    };

    const pub = ({ fingerprint: _fingerprint, ...endpoint }: PreviewEndpoint & { fingerprint: string | undefined }): PreviewEndpoint => endpoint;

    const observe = (endpoint: PreviewEndpoint & { fingerprint: string | undefined }): void => {
        const current = fingerprint(endpoint.port);
        // No listener is not a new listener: a stopped dev server keeps its
        // last generation until something else actually listens.
        if (current === undefined || current === endpoint.fingerprint) return;
        const first = endpoint.fingerprint === undefined;
        endpoint.fingerprint = current;
        if (first) return;
        endpoint.generation += 1;
        try {
            registry.onGenerationMoved?.(pub(endpoint));
        } catch {
            /* closing is best effort */
        }
    };

    const registry: PreviewEndpointRegistry = {
        onGenerationMoved: undefined,
        idFor,
        register(identity) {
            if (!Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65_535) {
                throw new Error('preview: that is not a port on this machine');
            }
            const id = idFor(identity);
            let endpoint = endpoints.get(id);
            if (endpoint === undefined) {
                if (endpoints.size >= MAX_ENDPOINTS) throw new Error('preview: too many registered apps; close one and try again');
                const hostname = allocator.hostnameFor({ id, ...identity }).toLowerCase();
                endpoint = { id, ...identity, generation: 1, hostname, origin: originOf(hostname), fingerprint: undefined };
                endpoints.set(id, endpoint);
                byHost.set(hostname, id);
            }
            observe(endpoint);
            return pub(endpoint);
        },
        get(id) {
            const endpoint = endpoints.get(id);
            return endpoint === undefined ? undefined : pub(endpoint);
        },
        byHostname(hostname) {
            const id = byHost.get(hostname.toLowerCase());
            return id === undefined ? undefined : registry.get(id);
        },
        refresh() {
            for (const endpoint of endpoints.values()) observe(endpoint);
        },
        dispose() {
            clearInterval(timer);
            endpoints.clear();
            byHost.clear();
        },
    };
    const timer = setInterval(() => registry.refresh(), options.pollMs ?? DEFAULT_POLL_MS);
    timer.unref?.();
    return registry;
}
