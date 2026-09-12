/**
 * Host-local Surface broker (Slice 2A).
 *
 * The CLI talks to the host over an owner-only Unix socket under the host
 * data directory -- the same pattern as the realtime coordinator and the peer
 * broker (owner-only socket, bounded requests, deadlines, stale-socket
 * handling, deterministic close). Filesystem ownership is the authentication:
 * only this UID can connect, so no relay token, tunnel key or capability
 * secret travels in the environment or in any reply.
 *
 * `HERDR_PANE_ID` and the cwd arrive as hints only. The broker resolves them
 * against the live `source.herdrTree()` through canonical realpaths: a
 * stale pane id, a cwd outside the session root and the pane's live
 * directory, a symlink escape, or a cwd matching nothing (or more than one
 * worktree) all fail instead of opening a surface in the wrong place. A
 * hint at the root or in a real subdirectory of it keeps the pane's own
 * context -- an agent that `cd`s into a package is not a moved terminal.
 *
 * Provider resolution is generic: an explicit valid claimant wins, then the
 * sole enabled claimant; missing or ambiguous providers fail visibly.
 * Claimants are plugin ids read from manifest capability declarations via
 * `source.pluginList`; nothing here names one. (There is no saved-selection
 * convention for surfaces yet, so that step is skipped. Per-device approval
 * is enforced later, when the phone leases the offer.)
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
    isPublishableSurfaceSession,
    resolveSurfaceProvider,
    SURFACE_CAPABILITIES,
    type SurfaceCapability,
    type SurfaceOfferInput,
    type SurfaceOffer,
    type SurfacePlacement,
} from '@muxr/contract';
import { createSurfaceOffers, type SurfaceOfferRegistry } from './surfaceOffers.js';
import { openSurfaceOffer } from '../application/openSurfaceOffer.js';
import type { PreviewEndpointRegistry } from './previewEndpoint.js';
import type { SessionSource } from '../../agent/index.js';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_CONNECTIONS = 8;
const ACCEPT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Canonicalize a hint path: symlinks resolved, so a symlink escape cannot
 * read as containment. A path that does not resolve is not a place the
 * broker can bind anyone to: fail rather than guess.
 */
function canonicalHint(value: string): string | undefined {
    if (value === '' || !isAbsolute(value)) return undefined;
    try {
        return realpathSync(value);
    } catch {
        return undefined;
    }
}

/**
 * Canonicalize a possibly-missing target through its nearest existing
 * ancestor: a symlink in the middle of the path still resolves through,
 * so `escape/file.ts` reads as outside even though `file.ts` was never
 * created. Returns undefined when no ancestor exists.
 */
function canonicalTarget(value: string): string | undefined {
    let current = value;
    const rest: string[] = [];
    for (;;) {
        try {
            return rest.length === 0 ? realpathSync(current) : join(realpathSync(current), ...rest.reverse());
        } catch {
            const parent = dirname(current);
            if (parent === current) return undefined;
            rest.push(basename(current));
            current = parent;
        }
    }
}

/**
 * Whether `hint` names `root` itself or a directory strictly inside it.
 * Separator-safe: `/repo2` is not inside `/repo`, and `/repo/..` never
 * reaches here because both sides are canonical realpaths.
 */
function withinRoot(root: string, hint: string): boolean {
    return hint === root || hint.startsWith(root + sep);
}

export type SurfaceBrokerHints = {
    paneId?: string;
    cwd?: string;
};

export interface SurfaceBrokerPorts {
    dataDir: string;
    source: Pick<SessionSource, 'herdrTree' | 'pluginList'>;
    offers?: SurfaceOfferRegistry;
    /** HTTPS preview endpoints. Absent means a local open publishes no preview hostname. */
    endpoints?: PreviewEndpointRegistry;
    snapshot?(): Promise<string>;
    now?: () => number;
}

type BrokerRequest =
    | { method: 'capabilities' }
    | { method: 'browser.open'; target: string; name?: string; placement?: string; provider?: string }
    | { method: 'browser.update'; target?: string; name?: string; placement?: string; provider?: string }
    | { method: 'browser.reload'; name?: string }
    | { method: 'browser.close'; name?: string }
    | { method: 'browser.origin'; name?: string }
    | { method: 'code.open'; target: string; name?: string; placement?: string; provider?: string }
    | { method: 'code.diff'; target?: string; name?: string; placement?: string; provider?: string }
    | { method: 'surface.list' };

function record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[]): void {
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('invalid surface broker request fields');
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`${field} must be text`);
    const clean = value.replace(/[\0-\x1F\x7F]/g, '').trim();
    if (clean === '' || clean.length > max) throw new Error(`${field} is invalid`);
    return clean;
}

function requiredText(value: unknown, field: string, max: number): string {
    const clean = optionalText(value, field, max);
    if (clean === undefined) throw new Error(`${field} is required`);
    return clean;
}

const BROKER_METHODS = [
    'capabilities',
    'browser.open',
    'browser.update',
    'browser.reload',
    'browser.close',
    'browser.origin',
    'code.open',
    'code.diff',
    'surface.list',
] as const;

function parseRequest(value: unknown): BrokerRequest {
    const request = record(value, 'surface broker request');
    if (typeof request.method !== 'string' || !(BROKER_METHODS as readonly string[]).includes(request.method)) {
        throw new Error('unknown surface broker method');
    }
    switch (request.method) {
        case 'capabilities':
        case 'surface.list':
            only(request, ['method']);
            return { method: request.method };
        case 'browser.open':
            only(request, ['method', 'target', 'name', 'placement', 'provider']);
            return {
                method: 'browser.open',
                target: requiredText(request.target, 'target', 2048),
                ...(request.name === undefined ? {} : { name: requiredText(request.name, 'name', 64) }),
                ...(request.placement === undefined ? {} : { placement: requiredText(request.placement, 'placement', 16) }),
                ...(request.provider === undefined ? {} : { provider: requiredText(request.provider, 'provider', 64) }),
            };
        case 'browser.update':
            only(request, ['method', 'target', 'name', 'placement', 'provider']);
            return {
                method: 'browser.update',
                ...(request.target === undefined ? {} : { target: requiredText(request.target, 'target', 2048) }),
                ...(request.name === undefined ? {} : { name: requiredText(request.name, 'name', 64) }),
                ...(request.placement === undefined ? {} : { placement: requiredText(request.placement, 'placement', 16) }),
                ...(request.provider === undefined ? {} : { provider: requiredText(request.provider, 'provider', 64) }),
            };
        case 'browser.reload':
        case 'browser.close':
        case 'browser.origin':
            only(request, ['method', 'name']);
            return {
                method: request.method,
                ...(request.name === undefined ? {} : { name: requiredText(request.name, 'name', 64) }),
            };
        case 'code.open':
            only(request, ['method', 'target', 'name', 'placement', 'provider']);
            return {
                method: 'code.open',
                target: requiredText(request.target, 'target', 1024),
                ...(request.name === undefined ? {} : { name: requiredText(request.name, 'name', 64) }),
                ...(request.placement === undefined ? {} : { placement: requiredText(request.placement, 'placement', 16) }),
                ...(request.provider === undefined ? {} : { provider: requiredText(request.provider, 'provider', 64) }),
            };
        case 'code.diff':
            only(request, ['method', 'target', 'name', 'placement', 'provider']);
            return {
                method: 'code.diff',
                ...(request.target === undefined ? {} : { target: requiredText(request.target, 'target', 1024) }),
                ...(request.name === undefined ? {} : { name: requiredText(request.name, 'name', 64) }),
                ...(request.placement === undefined ? {} : { placement: requiredText(request.placement, 'placement', 16) }),
                ...(request.provider === undefined ? {} : { provider: requiredText(request.provider, 'provider', 64) }),
            };
        default:
            throw new Error('unknown surface broker method');
    }
}

export function surfaceSocketPath(dataDir: string): string {
    return `${dataDir}/surface/broker.sock`;
}

/**
 * Human titles for unnamed offers: dock copy, never identity. An explicit
 * name still becomes the title, exactly as before. Bounded to the
 * contract's title length so a long hostname or filename cannot fail
 * validation downstream.
 */
function directTitle(url: string): string {
    if (url === 'about:blank') return 'Blank tab';
    try {
        return new URL(url).hostname.slice(0, 120);
    } catch {
        return url.slice(0, 64);
    }
}

function codeTitle(path: string, line?: number): string {
    if (path === '.') return 'Worktree root';
    const base = (path.split('/').pop() ?? path).slice(0, 100);
    if (base === '') return 'Worktree root';
    return line === undefined || line < 1 ? base : `${base}:${line}`.slice(0, 120);
}

interface ResolvedContext {
    /** Worktree root the offer is bound to. Never a subdirectory, never a guess. */
    context: string;
    /** The exact live agent session. Never a shell route, never a guess. */
    sessionId: string;
    /**
     * Validated invocation directory: the exact hint, or the pane's live
     * directory when no hint was given. Always exact or separator-safe
     * inside the canonical boundary. Kept separately from `context` so
     * relative targets resolve against where the caller stood, while the
     * offer itself stays bound to the root.
     */
    invocationCwd: string;
    /** Canonical session/worktree boundary the invocation was checked against. */
    boundary: string;
}

interface LivePane {
    paneId: string;
    cwd?: string;
    workspaceId?: string;
    sessionId?: string;
}

interface LiveWorkspace {
    workspaceId: string;
    worktreePath?: string;
}

export class SurfaceBroker {
    private server: Server | undefined;
    private readonly sockets = new Set<Socket>();
    readonly socketPath: string;
    private readonly offers: SurfaceOfferRegistry;
    private readonly source: Pick<SessionSource, 'herdrTree' | 'pluginList'>;
    private readonly snapshot: (() => Promise<string>) | undefined;
    private readonly endpoints: PreviewEndpointRegistry | undefined;

    constructor(private readonly ports: SurfaceBrokerPorts) {
        this.socketPath = surfaceSocketPath(ports.dataDir);
        this.offers = ports.offers ?? createSurfaceOffers(ports.now === undefined ? {} : { now: ports.now });
        this.source = ports.source;
        this.snapshot = ports.snapshot;
        this.endpoints = ports.endpoints;
    }

    get registry(): SurfaceOfferRegistry {
        return this.offers;
    }

    async start(): Promise<void> {
        if (this.server !== undefined) return;
        mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
        chmodSync(dirname(this.socketPath), 0o700);
        if (existsSync(this.socketPath)) {
            const info = lstatSync(this.socketPath);
            if (!info.isSocket() || info.isSymbolicLink()) throw new Error('surface broker path is not a socket');
            unlinkSync(this.socketPath);
        }
        const server = createServer((socket) => this.accept(socket));
        this.server = server;
        await new Promise<void>((resolvePromise, reject) => {
            server.once('error', reject);
            server.listen(this.socketPath, () => {
                server.off('error', reject);
                chmodSync(this.socketPath, 0o600);
                resolvePromise();
            });
        });
    }

    async close(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        for (const socket of [...this.sockets]) socket.destroy();
        this.sockets.clear();
        if (server !== undefined) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        if (existsSync(this.socketPath)) {
            try {
                if (lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
            } catch {
                /* already gone */
            }
        }
    }

    /** Resolve hints against the live tree. Hints only; the tree decides. */
    async resolveContext(hints: SurfaceBrokerHints): Promise<ResolvedContext> {
        const tree = await this.source.herdrTree();
        const panes: LivePane[] = tree.workspaces.flatMap((workspace) =>
            workspace.tabs.flatMap((tab) =>
                tab.panes.map((pane) => ({
                    paneId: pane.paneId,
                    ...(pane.cwd === undefined ? {} : { cwd: pane.cwd }),
                    workspaceId: workspace.workspaceId,
                    ...(pane.sessionId === undefined ? {} : { sessionId: pane.sessionId }),
                })),
            ),
        );
        const workspaces: LiveWorkspace[] = tree.workspaces.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            ...(workspace.worktree?.path === undefined ? {} : { worktreePath: workspace.worktree.path }),
        }));
        const contextOf = (pane: LivePane): string | undefined =>
            workspaces.find((workspace) => workspace.workspaceId === pane.workspaceId)?.worktreePath
            ?? pane.cwd;
        /**
         * The single canonical session boundary: the session worktree when
         * one owns the pane, else the pane's own live directory. There is
         * exactly one trust root per pane -- the pane's live directory is
         * never a second one. A pane that has moved outside its worktree
         * is rejected outright rather than bound to the old repository,
         * and a hint is accepted only exact or separator-safe inside the
         * same root.
         */
        const boundaryOf = (pane: LivePane): string | undefined => {
            const raw = workspaces.find((workspace) => workspace.workspaceId === pane.workspaceId)?.worktreePath
                ?? pane.cwd;
            if (raw === undefined) return undefined;
            return canonicalHint(raw);
        };
        const liveDirOf = (pane: LivePane): string | undefined =>
            pane.cwd === undefined ? undefined : canonicalHint(pane.cwd);
        if (hints.paneId !== undefined) {
            const pane = panes.find((entry) => entry.paneId === hints.paneId);
            if (pane === undefined) throw new Error('that terminal is no longer open; run from an open one');
            if (!isPublishableSurfaceSession(pane.sessionId)) {
                throw new Error('that terminal has no live agent session; open one first');
            }
            const context = contextOf(pane);
            if (context === undefined) throw new Error('that terminal has no working directory');
            const boundary = boundaryOf(pane);
            if (boundary === undefined) throw new Error('that terminal has no working directory');
            // The pane's own live directory must stand inside the session
            // boundary. A pane moved outside its worktree -- or parked at
            // an escaping symlink -- is not bound to the old repository
            // on the strength of a second root; it fails.
            const liveDir = liveDirOf(pane);
            if (liveDir === undefined || !withinRoot(boundary, liveDir)) {
                throw new Error('that terminal moved; run from the current one');
            }
            let invocationCwd = liveDir;
            if (hints.cwd !== undefined) {
                const hint = canonicalHint(hints.cwd);
                // Outside the one boundary -- another repo, a stale
                // worktree, or a symlink escape -- fails rather than
                // opening a surface in the wrong repository.
                // Compatibility launchers normalize context at their own
                // trusted boundary and pass the original root.
                if (hint === undefined || !withinRoot(boundary, hint)) {
                    throw new Error('that terminal moved; run from the current one');
                }
                invocationCwd = hint;
            }
            return { context, sessionId: pane.sessionId, invocationCwd, boundary };
        }
        if (hints.cwd !== undefined) {
            const hint = canonicalHint(hints.cwd);
            if (hint === undefined) throw new Error('no open agent session matches this directory');
            const matches = panes.filter((pane) => {
                if (!isPublishableSurfaceSession(pane.sessionId)) return false;
                const boundary = boundaryOf(pane);
                if (boundary === undefined) return false;
                const liveDir = liveDirOf(pane);
                if (liveDir === undefined || !withinRoot(boundary, liveDir)) return false;
                return withinRoot(boundary, hint);
            });
            const sessions = [...new Set(matches.map((pane) => pane.sessionId as string))];
            if (sessions.length === 0) throw new Error('no open agent session matches this directory');
            if (sessions.length > 1) {
                throw new Error('more than one agent session shares this directory; run from the terminal that owns it');
            }
            const sessionId = sessions[0]!;
            const pane = matches.find((entry) => entry.sessionId === sessionId)!;
            return { context: contextOf(pane) ?? hints.cwd, sessionId, invocationCwd: hint, boundary: boundaryOf(pane) ?? hint };
        }
        throw new Error('no terminal context; run with HERDR_PANE_ID set from an open terminal');
    }

    private async claimantsFor(capability: SurfaceCapability): Promise<string[]> {
        const listed = await this.source.pluginList('local');
        return listed
            .filter((plugin) => plugin.capabilities?.[capability] !== undefined)
            .map((plugin) => plugin.pluginId)
            .sort();
    }

    private async snapshotDigest(): Promise<string> {
        if (this.snapshot !== undefined) return this.snapshot();
        const listed = await this.source.pluginList('local');
        return listed
            .map((plugin) => `${plugin.pluginId}:${plugin.manifestHash ?? ''}`)
            .sort()
            .join('|');
    }
    private async resolveProvider(capability: SurfaceCapability, explicit?: string): Promise<string> {
        const claimants = await this.claimantsFor(capability);
        return resolveSurfaceProvider({
            capability,
            claimants,
            ...(explicit === undefined ? {} : { explicit }),
        });
    }

    /** Classify a browser target. Remote anything-but-HTTPS and credentialed URLs fail. */
    private classifyBrowserTarget(target: string): { kind: 'direct'; url: string } | { kind: 'local'; port: number; path: string } {
        // The honest blank tab: no host, no credentials, no arbitrary site.
        if (target === 'about:blank') return { kind: 'direct', url: 'about:blank' };
        let parsed: URL;
        try {
            parsed = new URL(target);
        } catch {
            throw new Error('that URL is not supported; use public HTTPS or host-local HTTP');
        }
        if (parsed.username !== '' || parsed.password !== '') throw new Error('URLs must not carry credentials');
        const host = parsed.hostname.toLowerCase();
        const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.');
        if (isLoopback) {
            if (parsed.protocol !== 'http:') throw new Error('host-local targets use plain HTTP loopback URLs');
            const port = parsed.port === '' ? NaN : Number(parsed.port);
            if (!Number.isInteger(port) || port < 1 || port > 65_535) {
                throw new Error('a host-local target names its port; that authority is ambiguous');
            }
            if (target.length > 2048) throw new Error('that URL is too long');
            const path = `${parsed.pathname}${parsed.search}`;
            if (path.length > 1024) throw new Error('that path is too long');
            return { kind: 'local', port, path: path === '' ? '/' : path };
        }
        if (parsed.protocol !== 'https:') {
            if (parsed.protocol === 'http:') throw new Error('remote URLs must be HTTPS; plain HTTP reaches no host-local app from here');
            throw new Error('that URL scheme is not supported');
        }
        if (target.length > 2048) throw new Error('that URL is too long');
        return { kind: 'direct', url: parsed.toString() };
    }

    private parseCodeTarget(target: string): { path: string; line?: number; column?: number } {
        const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(target);
        const rawPath = (match?.[1] ?? target).trim();
        if (rawPath === '' || rawPath.length > 1024) throw new Error('that path is invalid');
        const line = match?.[2] === undefined ? undefined : Number(match[2]);
        const column = match?.[3] === undefined ? undefined : Number(match[3]);
        if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error('that line is invalid');
        if (column !== undefined && (!Number.isInteger(column) || column < 1)) throw new Error('that column is invalid');
        return {
            path: rawPath,
            ...(line === undefined ? {} : { line }),
            ...(column === undefined ? {} : { column }),
        };
    }

    /**
     * Keep Code offers inside the session boundary. Relative targets
     * resolve against the validated invocation directory -- where the
     * caller actually stood -- never against the bare root, so a monorepo
     * subdir target stays a subdir path. Absolute targets must land
     * inside the boundary too. A target that exists outside the boundary
     * through a symlink fails even when its lexical path reads as inside.
     */
    private bindCodePath(rawPath: string, invocationCwd: string, boundary: string): string {
        const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(invocationCwd, rawPath);
        if (!withinRoot(boundary, resolved)) {
            throw new Error('that path is outside the current worktree');
        }
        // A symlink in the middle of the path still resolves through:
        // the true location must also stand inside the boundary.
        const canonical = canonicalTarget(resolved);
        if (canonical === undefined || !withinRoot(boundary, canonical)) {
            throw new Error('that path is outside the current worktree');
        }
        const relativePath = relative(boundary, resolved);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
            throw new Error('that path is outside the current worktree');
        }
        // The worktree root itself reviews as '.'.
        return relativePath === '' ? '.' : relativePath;
    }

    private placementOf(value: string): SurfacePlacement {
        if (value !== 'replace' && value !== 'beside' && value !== 'focus') throw new Error('placement is --beside or --focus');
        return value;
    }

    async invoke(request: BrokerRequest, hints: SurfaceBrokerHints): Promise<unknown> {
        if (request.method === 'capabilities') {
            // Honest host availability per capability: installed claimants
            // only, never a provider nobody installed. Approval stays
            // device-specific and is checked when the phone leases.
            const capabilities = [];
            for (const capability of SURFACE_CAPABILITIES) {
                const installed = await this.claimantsFor(capability);
                capabilities.push({
                    capability,
                    available: installed.length > 0,
                    ambiguous: installed.length > 1,
                });
            }
            return { capabilities };
        }
        if (request.method === 'surface.list') {
            const resolved = await this.resolveContext(hints);
            return {
                outcome: 'visible' as const,
                surfaces: this.offers
                    .list({ context: resolved.context, sessionId: resolved.sessionId })
                    .map((offer) => this.visible(offer)),
            };
        }
        if (request.method === 'browser.close') {
            const resolved = await this.resolveContext(hints);
            this.offers.close(request.name ?? 'browser', resolved.context, resolved.sessionId);
            return { outcome: 'closed' as const, name: request.name ?? 'browser' };
        }
        if (request.method === 'browser.origin') {
            // Re-print the public preview hostname of an open local app so
            // the agent can configure the framework's allowed dev origins.
            const resolved = await this.resolveContext(hints);
            const current = this.offers.current(request.name ?? 'browser', resolved.context, resolved.sessionId);
            if (current === undefined) throw new Error('no open surface by that name; open one first');
            const hostname = this.previewHostname(current.offer);
            if (hostname === undefined) throw new Error('that surface has no HTTPS preview origin');
            return { outcome: 'visible' as const, name: current.offer.name, hostname };
        }
        if (request.method === 'browser.reload') {
            // Re-emitted, not visible: no device acknowledgement exists yet.
            // The frame carries the same handle and revision to the phone.
            const resolved = await this.resolveContext(hints);
            const current = this.offers.current(request.name ?? 'browser', resolved.context, resolved.sessionId);
            if (current === undefined) throw new Error('no open surface by that name; open one first');
            const record = this.offers.refresh(current.handle);
            return { outcome: 'accepted' as const, surface: this.visible(record.offer) };
        }
        if (request.method === 'browser.open' || request.method === 'browser.update') {
            const resolved = await this.resolveContext(hints);
            const name = request.name ?? 'browser';
            if (request.method === 'browser.update' && request.target === undefined) {
                const current = this.offers.current(name, resolved.context, resolved.sessionId);
                if (current === undefined) throw new Error('no open surface by that name; open one first');
                const record = this.offers.refresh(current.handle);
                return { outcome: 'accepted' as const, surface: this.visible(record.offer) };
            }
            const classified = this.classifyBrowserTarget(request.target ?? '');
            let input: SurfaceOfferInput;
            if (classified.kind === 'direct') {
                // The resolved claimant is stored, not discarded: the mobile
                // admits the surface only when this exact provider is still
                // approved and still claims the capability.
                const provider = await this.resolveInstalledProvider('surface.browser.open', request.provider);
                input = {
                    kind: 'browser-direct',
                    capability: 'surface.browser.open',
                    name,
                    ...(request.placement === undefined ? {} : { placement: this.placementOf(request.placement) }),
                    // Human titles, not the logical name: an unnamed direct
                    // open docks as its hostname, the blank tab as itself.
                    ...(request.name === undefined ? { title: directTitle(classified.url) } : {}),
                    url: classified.url,
                    provider,
                };
            } else {
                const provider = await this.resolveProvider('surface.browser.open', request.provider);
                // Register the loopback endpoint under this exact context and
                // provider: the public origin is allocated here, on the host,
                // and the reply names its hostname (never the port).
                this.endpoints?.register({ context: resolved.context, provider, port: classified.port });
                input = {
                    kind: 'browser-local',
                    capability: 'surface.browser.open',
                    name,
                    ...(request.placement === undefined ? {} : { placement: this.placementOf(request.placement) }),
                    // Unnamed local opens dock as a local app; a port never
                    // appears in chrome, even the one the operator typed.
                    ...(request.name === undefined ? { title: classified.path === '/' ? 'Local app' : `Local app ${classified.path}` } : {}),
                    port: classified.port,
                    path: classified.path,
                    label: name,
                    context: resolved.context,
                    provider,
                };
            }
            const record = await openSurfaceOffer(
                {
                    offers: this.offers,
                    snapshot: () => this.snapshotDigest(),
                    claimants: (capability) => this.claimantsFor(capability),
                },
                { offer: input, context: resolved.context, sessionId: resolved.sessionId },
            );
            return { outcome: 'accepted' as const, surface: this.visible(record.offer) };
        }
        const resolved = await this.resolveContext(hints);
        const name = request.name ?? 'code';
        // `code diff` is an opening command, not an update: a targetless
        // invocation opens the canonical worktree's Changes as a delta
        // (create-or-replace), so a fresh session with no open offer still
        // succeeds. It binds to the boundary itself, never to the
        // invocation directory -- `code diff` from a package directory is
        // still the worktree's changes. Explicit targets stay relative to
        // the validated invocation cwd. Only `browser update` keeps the
        // refresh-an-existing-offer semantics.
        const targetless = request.method === 'code.diff' && request.target === undefined;
        const parsed = targetless ? { path: '.' } : this.parseCodeTarget(request.target ?? '');
        const codeProvider = await this.resolveInstalledProvider('surface.code.open', request.provider);
        const boundPath = this.bindCodePath(parsed.path, targetless ? resolved.boundary : resolved.invocationCwd, resolved.boundary);
        const input: SurfaceOfferInput = {
            kind: 'code-review',
            capability: 'surface.code.open',
            name,
            ...(request.placement === undefined ? {} : { placement: this.placementOf(request.placement) }),
            ...(request.name === undefined ? { title: codeTitle(boundPath, parsed.line) } : {}),
            path: boundPath,
            ...(parsed.line === undefined ? {} : { line: parsed.line }),
            ...(parsed.column === undefined ? {} : { column: parsed.column }),
            // The invoked command is the destination: `code open` reviews a
            // file, `code diff` reviews a delta. It is preserved explicitly
            // so the phone never infers intent from a revision string.
            destination: request.method === 'code.diff' ? 'diff' : 'file',
            provider: codeProvider,
        };
        const record = await openSurfaceOffer(
            {
                offers: this.offers,
                snapshot: () => this.snapshotDigest(),
                claimants: (capability) => this.claimantsFor(capability),
            },
            { offer: input, context: resolved.context, sessionId: resolved.sessionId },
        );
        return { outcome: 'accepted' as const, surface: this.visible(record.offer) };
    }

    /**
     * Direct and Code targets need a host-installed claimant for their
     * capability -- an accepted offer nobody installed is a lie -- and the
     * resolved claimant is stored on the offer so the mobile can admit it
     * only while that exact provider stays approved and claiming. Explicit
     * selection resolves generically; ambiguity without one fails visibly.
     */
    private async resolveInstalledProvider(capability: SurfaceCapability, explicit?: string): Promise<string> {
        const installed = await this.claimantsFor(capability);
        if (installed.length === 0) throw new Error('no surface provider is installed on this computer');
        return resolveSurfaceProvider({
            capability,
            claimants: installed,
            ...(explicit === undefined ? {} : { explicit }),
        });
    }

    /** Public face of an offer. Handles and internal ids never leave the host. */
    private visible(offer: SurfaceOffer): Record<string, unknown> {
        const base = {
            name: offer.name,
            title: offer.title,
            placement: offer.placement,
            revision: offer.revision,
            capability: offer.capability,
            kind: offer.kind,
        };
        if (offer.kind === 'browser-direct') return { ...base, url: offer.url };
        // Ports and provider ids stay on the host: a reply names the logical
        // surface, its path and its worktree only.
        if (offer.kind === 'browser-local') {
            const hostname = this.previewHostname(offer);
            return { ...base, path: offer.path, label: offer.label, context: offer.context, ...(hostname === undefined ? {} : { hostname }) };
        }
        // The session handle stays on the host; a reply names the site only.
        if (offer.kind === 'browser-session') {
            return { ...base, site: offer.site, context: offer.context };
        }
        return {
            ...base,
            path: offer.path,
            ...(offer.line === undefined ? {} : { line: offer.line }),
            ...(offer.column === undefined ? {} : { column: offer.column }),
            ...(offer.endLine === undefined ? {} : { endLine: offer.endLine }),
            ...(offer.revisionText === undefined ? {} : { revisionText: offer.revisionText }),
            destination: offer.destination,
            mode: 'review',
        };
    }

    /** Public preview hostname of a local offer's registered endpoint, if the gateway runs. */
    private previewHostname(offer: SurfaceOffer): string | undefined {
        if (offer.kind !== 'browser-local' || this.endpoints === undefined) return undefined;
        return this.endpoints.get(this.endpoints.idFor({ context: offer.context, provider: offer.provider, port: offer.port }))?.hostname;
    }

    private accept(socket: Socket): void {
        if (this.sockets.size >= MAX_CONNECTIONS) {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        let input = '';
        socket.setTimeout(ACCEPT_TIMEOUT_MS, () => socket.destroy());
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
                socket.destroy();
                return;
            }
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            socket.removeAllListeners('data');
            void (async () => {
                let id = '';
                try {
                    const message = record(JSON.parse(input.slice(0, newline)), 'surface broker message');
                    only(message, ['id', 'request', 'paneId', 'cwd']);
                    id = typeof message.id === 'string' ? message.id.slice(0, 120) : '';
                    if (id === '') throw new Error('surface broker request id is required');
                    const request = parseRequest(message.request);
                    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
                    const data = await this.invoke(request, {
                        ...(typeof message.paneId === 'string' && message.paneId !== '' ? { paneId: message.paneId } : {}),
                        ...(typeof message.cwd === 'string' && message.cwd !== '' ? { cwd: message.cwd } : {}),
                    });
                    if (!socket.destroyed) socket.end(`${JSON.stringify({ id, ok: true, data })}\n`);
                } catch (error) {
                    if (!socket.destroyed) {
                        socket.end(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : 'surface request failed' })}\n`);
                    }
                }
            })();
        });
    }
}
