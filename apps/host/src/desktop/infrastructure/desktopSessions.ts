import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EngineClient, EngineRefused, explainMissingEngine, resolveEngine } from '@desklink/host';
import type { SourceRequest } from '@desklink/host';
import type { DesktopCapabilities, DesktopEvent, DesktopPermission, DesktopSurfaceGeometry } from '@muxr/contract';

import { nextDesktopId, type DesktopSessionRecord } from '../domain/desktopSession.js';
import { PortalGrant } from './portalGrant.js';

/**
 * Which desktop this host offers.
 *
 * The portal is the default: on a Wayland desktop it is the backend that carries
 * the user's consent, and nothing else can substitute for that. `x11` exists for
 * a host whose screen-cast portal does not work — a headless or remote X session
 * — and is a host decision rather than something a client may choose, because a
 * client asking for a different desktop must not be able to reach one the host
 * did not offer. `MUXR_DESKTOP_SOURCE` (`x11` or `portal`) settles it; without
 * it, a machine with no Wayland session at all, such as a cloud server running
 * Xvfb, offers its X display.
 */
function configuredSource(env: NodeJS.ProcessEnv, x11SocketDirectory: string): SourceRequest | undefined {
    const kind = env.MUXR_DESKTOP_SOURCE?.trim();
    if (kind === 'x11') {
        const display = env.MUXR_DESKTOP_X11_DISPLAY?.trim();
        return display === undefined || display === '' ? { kind: 'x11' } : { kind: 'x11', display };
    }
    if ((kind !== undefined && kind !== '') || waylandSession(env)) return undefined;
    const display = env.DISPLAY?.trim() || firstXDisplay(x11SocketDirectory);
    return display === undefined || display === '' ? undefined : { kind: 'x11', display };
}

/**
 * Any sign of Wayland, including a compositor socket when the service was
 * started without its variables: there, an X display is XWayland's, not the
 * desktop.
 */
function waylandSession(env: NodeJS.ProcessEnv): boolean {
    if (env.WAYLAND_DISPLAY?.trim() || env.XDG_SESSION_TYPE?.trim() === 'wayland') return true;
    const uid = process.getuid?.();
    const runtime = env.XDG_RUNTIME_DIR?.trim() || (uid === undefined ? undefined : `/run/user/${uid}`);
    if (runtime === undefined) return false;
    try {
        return readdirSync(runtime).some((name) => {
            if (!/^wayland-\d+$/.test(name)) return false;
            try {
                return statSync(join(runtime, name)).isSocket();
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

function firstXDisplay(directory: string): string | undefined {
    try {
        const uid = process.getuid?.();
        if (uid === undefined) return undefined;
        const numbers = readdirSync(directory).flatMap((name) => {
            const number = /^X(\d+)$/.exec(name)?.[1];
            if (number === undefined) return [];
            try {
                const socket = statSync(join(directory, name));
                return socket.isSocket() && socket.uid === uid ? [Number(number)] : [];
            } catch {
                return [];
            }
        });
        return numbers.length === 0 ? undefined : `:${Math.min(...numbers)}`;
    } catch {
        return undefined;
    }
}

export interface DesktopEngineOptions {
    /** Overrides the configured engine executable. */
    enginePath?: string;
    /** Overrides the arguments passed to it; production always uses `serve`. */
    engineArguments?: string[];
    onDiagnostic?: (line: string) => void;
    /** Existing host state root. Without one, portal grants are not retained. */
    stateRoot?: string;
}

interface LiveSession extends DesktopSessionRecord {
    client: EngineClient;
    owner?: string;
    /** Retained notifications, oldest first, bounded to [`MAX_BACKLOG`]. */
    events: DesktopEvent[];
    /** How many notifications this session has ever appended to the backlog. */
    appended: number;
    /** The engine closed this session because another one replaced it. */
    revoked: boolean;
}

/** How many notifications one session keeps for a client that fell behind. */
const MAX_BACKLOG = 512;

/**
 * How long one desktop session may stay open before the engine ends it. The
 * host states this rather than inheriting the engine's default: expiry stops
 * capture and releases held input, so it is a product decision, not a fallback.
 */
const DESKTOP_SESSION_LEASE_SECONDS = 3600;

/**
 * How long the engine may take to answer, which bounds how long a portal consent
 * prompt waits on the desktop. It must stay below the phone's 20s request
 * timeout: the host has to answer `desktop.open` first, with the typed
 * `consent-timeout`, or the phone shows its own timeout and a consent given
 * after it opens a session nobody is waiting for.
 */
const ENGINE_REQUEST_TIMEOUT_MS = 15_000;

const UNAVAILABLE_INPUT = 'This computer cannot inject input, so there is nothing to control.';

/**
 * Host-side owner of the desktop engine.
 *
 * One engine process serves whatever session is open, and the process is started
 * lazily: a host that never opens a desktop never spawns it. Authority is the
 * caller's business — this class only refuses to start when the machine cannot
 * do what was asked, and it is the *only* place that talks to the engine.
 */
export class DesktopSessions {
    private readonly options: DesktopEngineOptions;
    private client: EngineClient | null = null;
    private capabilitiesCache: DesktopCapabilities | null = null;
    private sessions = new Map<string, LiveSession>();
    private starting: Promise<EngineClient | null> | null = null;
    private opening = 0;
    /** The reason the last start attempt failed, when the engine resolved but did not come up. */
    private startFailure: string | null = null;

    private readonly environment: NodeJS.ProcessEnv;
    private readonly portalGrant: PortalGrant | undefined;

    constructor(options: DesktopEngineOptions = {}, environment: NodeJS.ProcessEnv = process.env, private readonly x11SocketDirectory = '/tmp/.X11-unix') {
        this.options = options;
        this.environment = environment;
        this.portalGrant = options.stateRoot === undefined ? undefined : new PortalGrant(options.stateRoot);
    }

    async capabilities(): Promise<DesktopCapabilities> {
        if (this.capabilitiesCache !== null) return this.capabilitiesCache;
        const client = await this.ensureClient();
        if (client === null) {
            // A probe that failed is not cached: the engine may be built or
            // fixed while the host keeps running, and the next request must ask
            // again rather than replaying the first answer forever.
            return {
                available: false,
                unavailableReason: this.startFailure ?? this.missingEngineReason(),
                input: false,
                clipboard: false,
            };
        }
        try {
            const reported = await client.capabilities();
            // The engine's input probe only knows about uinput; the X11 backend
            // injects through XTest and needs none, so the host's own configured
            // source is the only side that can answer for that machine.
            const x11 = configuredSource(this.environment, this.x11SocketDirectory)?.kind === 'x11';
            this.capabilitiesCache = {
                available: true,
                input: x11 || (reported.input.pointer && reported.input.keyboard),
                ...(x11 || reported.input.unavailable_reason === null
                    ? {}
                    : { inputUnavailableReason: reported.input.unavailable_reason.reason }),
                clipboard: !x11 && reported.clipboard.read && reported.clipboard.write,
                codec: reported.encode.codecs[0] ?? 'unknown',
            };
        } catch (error) {
            return {
                available: false,
                unavailableReason: error instanceof Error ? error.message : 'the desktop engine did not answer',
                input: false,
                clipboard: false,
            };
        }
        return this.capabilitiesCache;
    }

    async open(request: {
        permissions: DesktopPermission[];
        maxWidth?: number;
        maxHeight?: number;
        bitrateKbps?: number;
        maxFps?: number;
    }, owner?: { connectionId: string; isConnected: () => boolean }): Promise<{ desktopId: string; generation: number; geometry: DesktopSurfaceGeometry; source: LiveSession['source'] }> {
        if (owner !== undefined && !owner.isConnected()) throw new EngineRefused('session', 'the requesting phone disconnected');
        const capabilities = await this.capabilities();
        if (!capabilities.available) {
            throw new EngineRefused('desktop-unavailable', capabilities.unavailableReason ?? 'the desktop engine is unavailable');
        }
        if (request.permissions.includes('control') && !capabilities.input) {
            // Refuse rather than hand back a surface whose controls do nothing.
            throw new EngineRefused('input-unavailable', capabilities.inputUnavailableReason ?? UNAVAILABLE_INPUT);
        }
        if (request.permissions.includes('clipboard') && !capabilities.clipboard) {
            throw new EngineRefused('clipboard-unsupported', 'clipboard is unavailable for this desktop source');
        }
        const client = await this.ensureClient();
        if (client === null) {
            throw new EngineRefused('desktop-unavailable', this.startFailure ?? this.missingEngineReason());
        }
        const source = configuredSource(this.environment, this.x11SocketDirectory);
        let restoreToken: string | undefined;
        if (source?.kind !== 'x11') {
            try {
                restoreToken = this.portalGrant?.take();
            } catch {
                // Never send a token we could not safely consume. Normal portal
                // consent remains available even when local storage is broken.
                this.options.onDiagnostic?.('Desktop grant could not be read; requesting portal consent.');
            }
        }
        this.opening += 1;
        const opened = await client.openSession({
            permissions: request.permissions,
            ...(restoreToken === undefined ? {} : { restoreToken }),
            ...(source === undefined ? {} : { source }),
            ...(request.maxWidth === undefined ? {} : { maxWidth: request.maxWidth }),
            ...(request.maxHeight === undefined ? {} : { maxHeight: request.maxHeight }),
            ...(request.bitrateKbps === undefined ? {} : { bitrateKbps: request.bitrateKbps }),
            ...(request.maxFps === undefined ? {} : { maxFps: request.maxFps }),
            ttlSeconds: DESKTOP_SESSION_LEASE_SECONDS,
        }).finally(() => {
            for (const existing of this.sessions.values()) {
                if (existing.revoked || existing.client !== client) continue;
                existing.revoked = true;
                existing.client.drainEvents(existing.engineSessionId);
                existing.appended += 1;
                existing.events.push({ kind: 'revoked', reason: 'another device opened this computer' });
            }
        }).catch(async (error: unknown) => {
            this.opening -= 1;
            await this.stopIfIdle();
            throw error;
        });
        if (owner !== undefined && !owner.isConnected()) {
            client.drainEvents(opened.sessionId);
            await client.closeSession(opened.sessionId).catch(() => undefined);
            this.opening -= 1;
            await this.stopIfIdle();
            throw new EngineRefused('session', 'the requesting phone disconnected');
        }
        const desktopId = nextDesktopId();
        this.sessions.set(desktopId, {
            desktopId,
            engineSessionId: opened.sessionId,
            generation: opened.generation,
            permissions: request.permissions,
            geometry: opened.geometry,
            source: opened.source,
            openedAt: Date.now(),
            client,
            ...(owner === undefined ? {} : { owner: owner.connectionId }),
            events: [],
            appended: 0,
            revoked: false,
        });
        // The offer is already queued on the engine client; the first poll
        // delivers it, which keeps one delivery path instead of two.
        this.drain(desktopId);
        this.opening -= 1;
        return { desktopId, generation: opened.generation, geometry: opened.geometry, source: opened.source };
    }

    async answer(desktopId: string, sdp: string, connectionId?: string): Promise<{ accepted: boolean }> {
        const session = this.require(desktopId, connectionId);
        return session.client.acceptAnswer(session.engineSessionId, session.generation, sdp);
    }

    async candidate(
        desktopId: string,
        candidate: string,
        sdpMid: string | null,
        sdpMLineIndex: number | null,
        connectionId?: string,
    ): Promise<{ accepted: boolean }> {
        const session = this.require(desktopId, connectionId);
        return session.client.addCandidate(session.engineSessionId, session.generation, candidate, sdpMid, sdpMLineIndex);
    }

    async poll(desktopId: string, cursor: number, connectionId?: string): Promise<{ cursor: number; events: DesktopEvent[] }> {
        const session = this.require(desktopId, connectionId);
        this.drain(desktopId);
        // The oldest notification still retained. A client that has seen
        // everything gets exactly what arrived since; a client whose cursor
        // predates the backlog (or belongs to an earlier session) is given the
        // whole backlog rather than silence.
        const oldest = session.appended - session.events.length;
        const events = cursor >= oldest && cursor <= session.appended
            ? session.events.slice(cursor - oldest)
            : session.events.slice();
        const answer = { cursor: session.appended, events };
        if (session.revoked) {
            // The replaced client has now been told; nothing further is owed to
            // it, and its record must not outlive the notification.
            this.sessions.delete(desktopId);
            await this.stopIfIdle();
        }
        return answer;
    }

    async close(desktopId: string, connectionId?: string): Promise<{ closed: boolean }> {
        const session = this.sessions.get(desktopId);
        if (session === undefined) return { closed: true };
        if (connectionId !== undefined && session.owner !== connectionId) {
            throw new EngineRefused('session', 'that desktop session belongs to another connection');
        }
        this.sessions.delete(desktopId);
        session.client.drainEvents(session.engineSessionId);
        try {
            await session.client.closeSession(session.engineSessionId);
        } catch {
            // The session is already gone on the engine side; the client stays
            // usable for the next session, which is what matters.
        }
        await this.stopIfIdle();
        return { closed: true };
    }

    async closeConnection(connectionId: string): Promise<void> {
        for (const session of [...this.sessions.values()]) {
            if (session.owner === connectionId) await this.close(session.desktopId);
        }
    }

    /** Close every session this host owns; called when the host shuts down. */
    async closeAll(): Promise<void> {
        for (const desktopId of [...this.sessions.keys()]) {
            await this.close(desktopId);
        }
        await this.stopIfIdle();
    }

    private async stopIfIdle(): Promise<void> {
        if (this.sessions.size !== 0 || this.opening !== 0) return;
        const client = this.client;
        this.client = null;
        this.capabilitiesCache = null;
        await client?.stop().catch(() => undefined);
    }

    private missingEngineReason(): string {
        return explainMissingEngine(this.options.enginePath) ?? 'The desktop engine is unavailable.';
    }

    private require(desktopId: string, connectionId?: string): LiveSession {
        const session = this.sessions.get(desktopId);
        if (session === undefined) {
            throw new EngineRefused('session', 'that desktop session is not open');
        }
        if (connectionId !== undefined && session.owner !== connectionId) {
            throw new EngineRefused('session', 'that desktop session belongs to another connection');
        }
        return session;
    }

    /** Move everything the engine queued into this session's event list. */
    private drain(desktopId: string): void {
        const session = this.sessions.get(desktopId);
        // The engine's queue belongs to the session it is currently serving; a
        // replaced session must never drain another session's notifications.
        if (session === undefined || session.revoked) return;
        for (const event of session.client.drainEvents(session.engineSessionId)) {
            const translated = toDesktopEvent(event);
            if (translated === null) continue;
            if (translated.kind === 'revoked') {
                // The engine ended this session on its own (a lease expiry). The
                // poll delivering this notification must also forget the record,
                // the same way a replaced session does.
                session.revoked = true;
            }
            session.appended += 1;
            session.events.push(translated);
            // A client that fell further behind than the backlog is worth cannot
            // be served an exact delta, so only the most recent notifications are
            // kept and its cursor is corrected on the next poll.
            if (session.events.length > MAX_BACKLOG) {
                session.events.splice(0, session.events.length - MAX_BACKLOG);
            }
        }
    }

    private async ensureClient(): Promise<EngineClient | null> {
        if (this.client !== null) return this.client;
        if (this.starting !== null) return this.starting;
        this.starting = (async () => {
            const resolved = resolveEngine(this.options.enginePath);
            if (resolved === null) {
                this.startFailure = null;
                return null;
            }
            try {
                const client = await EngineClient.start(
                    resolved.command,
                    this.options.engineArguments ?? resolved.args,
                    {
                        requestTimeoutMs: ENGINE_REQUEST_TIMEOUT_MS,
                        ...(this.options.onDiagnostic === undefined ? {} : { onDiagnostic: this.options.onDiagnostic }),
                        onEvent: (event) => {
                            if (event.event !== 'session.restoreToken') return;
                            if (typeof event.params.token !== 'string' || event.params.token === '') return;
                            // Save immediately, including before session.open answers:
                            // polling/closing the phone must not lose a rotated token.
                            try {
                                this.portalGrant?.replace(event.params.token);
                            } catch {
                                this.options.onDiagnostic?.('Desktop grant could not be saved; next open will require portal consent.');
                            }
                        },
                        onExit: () => {
                            // The engine died: tell every attached client the
                            // session is gone, and keep the record so the next
                            // poll can deliver that before it is forgotten.
                            this.client = null;
                            this.capabilitiesCache = null;
                            for (const session of this.sessions.values()) {
                                session.revoked = true;
                                session.appended += 1;
                                session.events.push({ kind: 'revoked', reason: 'the desktop engine stopped' });
                            }
                        },
                    },
                );
                this.client = client;
                this.startFailure = null;
                return client;
            } catch (error) {
                this.startFailure = error instanceof Error ? error.message : String(error);
                this.options.onDiagnostic?.(`could not start the desktop engine: ${this.startFailure}`);
                return null;
            } finally {
                this.starting = null;
            }
        })();
        return this.starting;
    }
}

function toDesktopEvent(event: { event: string; params: Record<string, unknown> }): DesktopEvent | null {
    switch (event.event) {
        case 'session.description':
            return {
                kind: 'offer',
                generation: Number(event.params.generation ?? 0),
                sdp: String((event.params.description as { sdp?: string } | undefined)?.sdp ?? ''),
            };
        case 'session.candidate':
            return {
                kind: 'candidate',
                generation: Number(event.params.generation ?? 0),
                candidate: String(event.params.candidate ?? ''),
                sdpMid: (event.params.sdpMid as string | null) ?? null,
                sdpMLineIndex: (event.params.sdpMLineIndex as number | null) ?? null,
            };
        case 'session.state':
            return {
                kind: 'state',
                capture: String(event.params.capture ?? 'unknown'),
                transport: String(event.params.transport ?? 'unknown'),
                firstFrame: event.params.firstFrame === true,
            };
        case 'session.revoked':
            return { kind: 'revoked', reason: String(event.params.reason ?? 'the desktop session ended') };
        default:
            // A notification this host does not know — a restore token, or a
            // newer engine's addition — is not a reason to end the session.
            return null;
    }
}
