import { EngineClient, EngineRefused, explainMissingEngine, resolveEngine } from '@desklink/host';
import type { SourceRequest } from '@desklink/host';
import type { DesktopCapabilities, DesktopEvent, DesktopPermission, DesktopSurfaceGeometry } from '@muxr/contract';

import { nextDesktopId, type DesktopSessionRecord } from '../domain/desktopSession.js';

/**
 * Which desktop this host offers.
 *
 * The portal is the default: on a Wayland desktop it is the backend that carries
 * the user's consent, and nothing else can substitute for that. `x11` exists for
 * a host whose screen-cast portal does not work — a headless or remote X session
 * — and is an operator setting rather than something a client may choose,
 * because a client asking for a different desktop must not be able to reach one
 * the host did not offer.
 */
function configuredSource(env: NodeJS.ProcessEnv): SourceRequest | undefined {
    const kind = env.MUXR_DESKTOP_SOURCE?.trim();
    if (kind === 'x11') {
        const display = env.MUXR_DESKTOP_X11_DISPLAY?.trim();
        return display === undefined || display === '' ? { kind: 'x11' } : { kind: 'x11', display };
    }
    return undefined;
}

export interface DesktopEngineOptions {
    /** Overrides the configured engine executable. */
    enginePath?: string;
    /** Overrides the arguments passed to it; production always uses `serve`. */
    engineArguments?: string[];
    onDiagnostic?: (line: string) => void;
}

interface LiveSession extends DesktopSessionRecord {
    client: EngineClient;
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

    private readonly environment: NodeJS.ProcessEnv;

    constructor(options: DesktopEngineOptions = {}, environment: NodeJS.ProcessEnv = process.env) {
        this.options = options;
        this.environment = environment;
    }

    async capabilities(): Promise<DesktopCapabilities> {
        if (this.capabilitiesCache !== null) return this.capabilitiesCache;
        const client = await this.ensureClient();
        if (client === null) {
            this.capabilitiesCache = { available: false, unavailableReason: this.missingEngineReason(), input: false, clipboard: false };
            return this.capabilitiesCache;
        }
        try {
            const reported = await client.capabilities();
            this.capabilitiesCache = {
                available: true,
                input: reported.input.pointer && reported.input.keyboard,
                ...(reported.input.unavailable_reason === null
                    ? {}
                    : { inputUnavailableReason: reported.input.unavailable_reason.reason }),
                clipboard: reported.clipboard.read && reported.clipboard.write,
                codec: reported.encode.codecs[0] ?? 'unknown',
            };
        } catch (error) {
            this.capabilitiesCache = {
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
    }): Promise<{ desktopId: string; generation: number; geometry: DesktopSurfaceGeometry; source: LiveSession['source'] }> {
        const capabilities = await this.capabilities();
        if (!capabilities.available) {
            throw new EngineRefused('desktop-unavailable', capabilities.unavailableReason ?? 'the desktop engine is unavailable');
        }
        if (request.permissions.includes('control') && !capabilities.input) {
            // Refuse rather than hand back a surface whose controls do nothing.
            throw new EngineRefused('input-unavailable', capabilities.inputUnavailableReason ?? UNAVAILABLE_INPUT);
        }
        const client = await this.ensureClient();
        if (client === null) {
            throw new EngineRefused('desktop-unavailable', this.missingEngineReason());
        }
        const source = configuredSource(this.environment);
        const opened = await client.openSession({
            permissions: request.permissions,
            ...(source === undefined ? {} : { source }),
            ...(request.maxWidth === undefined ? {} : { maxWidth: request.maxWidth }),
            ...(request.maxHeight === undefined ? {} : { maxHeight: request.maxHeight }),
            ...(request.bitrateKbps === undefined ? {} : { bitrateKbps: request.bitrateKbps }),
            ...(request.maxFps === undefined ? {} : { maxFps: request.maxFps }),
            ttlSeconds: DESKTOP_SESSION_LEASE_SECONDS,
        });
        const desktopId = nextDesktopId();
        // The engine serves one session at a time and closes the previous one as
        // `replaced`. The replaced client is told once, and from here on the
        // engine's notifications belong to the new session alone.
        for (const existing of this.sessions.values()) {
            existing.revoked = true;
            existing.appended += 1;
            existing.events.push({ kind: 'revoked', reason: 'another device opened this computer' });
        }
        this.sessions.set(desktopId, {
            desktopId,
            engineSessionId: opened.sessionId,
            generation: opened.generation,
            permissions: request.permissions,
            geometry: opened.geometry,
            source: opened.source,
            openedAt: Date.now(),
            client,
            events: [],
            appended: 0,
            revoked: false,
        });
        // The offer is already queued on the engine client; the first poll
        // delivers it, which keeps one delivery path instead of two.
        this.drain(desktopId);
        return { desktopId, generation: opened.generation, geometry: opened.geometry, source: opened.source };
    }

    async answer(desktopId: string, sdp: string): Promise<{ accepted: boolean }> {
        const session = this.require(desktopId);
        return session.client.acceptAnswer(session.engineSessionId, session.generation, sdp);
    }

    async candidate(
        desktopId: string,
        candidate: string,
        sdpMid: string | null,
        sdpMLineIndex: number | null,
    ): Promise<{ accepted: boolean }> {
        const session = this.require(desktopId);
        return session.client.addCandidate(session.engineSessionId, session.generation, candidate, sdpMid, sdpMLineIndex);
    }

    async poll(desktopId: string, cursor: number): Promise<{ cursor: number; events: DesktopEvent[] }> {
        const session = this.require(desktopId);
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
        }
        return answer;
    }

    async close(desktopId: string): Promise<{ closed: boolean }> {
        const session = this.sessions.get(desktopId);
        if (session === undefined) return { closed: true };
        this.sessions.delete(desktopId);
        try {
            await session.client.closeSession(session.engineSessionId);
        } catch {
            // The session is already gone on the engine side; the client stays
            // usable for the next session, which is what matters.
        }
        if (this.sessions.size === 0) {
            const client = this.client;
            this.client = null;
            this.capabilitiesCache = null;
            await client?.stop().catch(() => undefined);
        }
        return { closed: true };
    }

    /** Close every session this host owns; called when the host shuts down. */
    async closeAll(): Promise<void> {
        for (const desktopId of [...this.sessions.keys()]) {
            await this.close(desktopId);
        }
        const client = this.client;
        this.client = null;
        this.capabilitiesCache = null;
        await client?.stop().catch(() => undefined);
    }

    private missingEngineReason(): string {
        return explainMissingEngine(this.options.enginePath) ?? 'The desktop engine is unavailable.';
    }

    private require(desktopId: string): LiveSession {
        const session = this.sessions.get(desktopId);
        if (session === undefined) {
            throw new EngineRefused('session', 'that desktop session is not open');
        }
        return session;
    }

    /** Move everything the engine queued into this session's event list. */
    private drain(desktopId: string): void {
        const session = this.sessions.get(desktopId);
        // The engine's queue belongs to the session it is currently serving; a
        // replaced session must never drain another session's notifications.
        if (session === undefined || session.revoked) return;
        for (const event of session.client.drainEvents()) {
            const translated = toDesktopEvent(event);
            if (translated === null) continue;
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
            if (resolved === null) return null;
            try {
                const client = await EngineClient.start(
                    resolved.command,
                    this.options.engineArguments ?? resolved.args,
                    {
                    ...(this.options.onDiagnostic === undefined ? {} : { onDiagnostic: this.options.onDiagnostic }),
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
                return client;
            } catch (error) {
                this.options.onDiagnostic?.(`could not start the desktop engine: ${error instanceof Error ? error.message : error}`);
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
