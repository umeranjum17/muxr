import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EngineClient, EngineRefused, explainMissingEngine, resolveEngine } from '@desklink/host';
import type { EngineCapabilities, EngineEvent, SourceRequest } from '@desklink/host';
import { DESKTOP_CONSENT_WAIT_MS, DESKTOP_LOOPBACK_TCP, DESKTOP_NO_PICTURE, desktopPortalBusy } from '@trymuxr/contract';
import type { DesktopCapabilities, DesktopEvent, DesktopIceServer, DesktopPermission, DesktopSurfaceGeometry } from '@trymuxr/contract';

import { nextDesktopId, type DesktopSessionRecord } from '../domain/desktopSession.js';
import { silentPortalBackends } from './portalBackends.js';
import { PortalGrant } from './portalGrant.js';
import { VirtualDisplay } from './virtualDisplay.js';

function explicitDesktopSource(env: NodeJS.ProcessEnv): string | undefined {
    const kind = env.MUXR_DESKTOP_SOURCE?.trim();
    return kind === undefined || kind === '' ? undefined : kind;
}

/**
 * Which desktop this host offers.
 *
 * A Wayland desktop needs the consent-bearing portal, not its XWayland display.
 * Without an explicit host override, a non-Wayland host offers its inherited
 * DISPLAY or an X socket owned by its uid. Only the host selects the source;
 * a client cannot ask to reach another desktop.
 */
function configuredSource(env: NodeJS.ProcessEnv, x11SocketDirectory: string): SourceRequest | undefined {
    const kind = explicitDesktopSource(env);
    if (kind === 'x11') {
        const display = env.MUXR_DESKTOP_X11_DISPLAY?.trim();
        return display === undefined || display === '' ? { kind: 'x11' } : { kind: 'x11', display };
    }
    if (kind !== undefined || waylandSession(env)) return undefined;
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

/** Nothing set, no Wayland session and no DISPLAY: a server, whose screen, if any, the host finds or starts. */
function headless(env: NodeJS.ProcessEnv): boolean {
    return explicitDesktopSource(env) === undefined && !waylandSession(env) && !env.DISPLAY?.trim();
}

/** A headless machine with no X display at all: a server without a screen. */
function screenless(env: NodeJS.ProcessEnv, x11SocketDirectory: string): boolean {
    return headless(env) && firstXDisplay(x11SocketDirectory) === undefined;
}

/**
 * The desktop a pane on this host should use, from the host's explicit
 * configuration only. An X socket is not consulted: Computer's own virtual
 * screen lives on one, and panes never share it.
 */
export function hostDesktopForPanes(env: NodeJS.ProcessEnv): { screen: boolean; x11Display?: string | undefined } {
    const source = explicitDesktopSource(env);
    if (source === 'x11') {
        const x11Display = env.MUXR_DESKTOP_X11_DISPLAY?.trim() || env.DISPLAY?.trim() || undefined;
        return x11Display === undefined ? { screen: false } : { screen: true, x11Display };
    }
    const x11Display = source === undefined ? env.DISPLAY?.trim() || undefined : undefined;
    if (x11Display !== undefined) return { screen: true, x11Display };
    return env.WAYLAND_DISPLAY?.trim() ? { screen: true } : { screen: false };
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
    /** The owner's own STUN/TURN servers, freshly credentialed; absent means none. */
    iceServers?: () => Promise<DesktopIceServer[]>;
}

interface LiveSession extends DesktopSessionRecord {
    client: EngineClient;
    /** Stable authenticated device identity owns signaling across link stream replacement and reconnects. */
    ownerDeviceId?: string;
    /** Retained notifications, oldest first, bounded to [`MAX_BACKLOG`]. */
    events: DesktopEvent[];
    /** How many notifications this session has ever appended to the backlog. */
    appended: number;
    /** The engine closed this session because another one replaced it. */
    revoked: boolean;
    /** The loopback TCP ports this session's own candidates named: the only ones a `desktop.tcp` stream may dial. */
    loopbackPorts: Set<number>;
}

export const X11_SOCKET_DIRECTORY = '/tmp/.X11-unix';
/** How many notifications one session keeps for a client that fell behind. */
const MAX_BACKLOG = 512;
const LINK_DISCONNECT_GRACE_MS = 20_000;

/**
 * How long one desktop session may stay open before the engine ends it. The
 * host states this rather than inheriting the engine's default: expiry stops
 * capture and releases held input, so it is a product decision, not a fallback.
 */
const DESKTOP_SESSION_LEASE_SECONDS = 3600;

/** How long the engine may take to answer anything but a portal open. */
const ENGINE_REQUEST_TIMEOUT_MS = 15_000;

const UNAVAILABLE_INPUT = 'This computer cannot inject input, so there is nothing to control.';
const NO_SCREEN = 'This computer has no screen to share, and Xvfb is not installed to give it one.';

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
    private engineCapabilities: EngineCapabilities | null = null;
    private sessions = new Map<string, LiveSession>();
    private starting: Promise<EngineClient | null> | null = null;
    private opening = 0;
    private silentPortal: ReturnType<typeof silentPortalBackends> | null = null;
    private readonly connectedLinkDevices = new Set<string>();
    private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** The reason the last start attempt failed, when the engine resolved but did not come up. */
    private startFailure: string | null = null;
    /**
     * Engine events that arrived before their session was registered, in
     * arrival order. The client delivers every event through `onEvent`, so an
     * event racing the `open` that created its session waits here until the
     * record exists; the first poll then delivers it. Bounded with the backlog.
     */
    private readonly pendingEngineEvents: EngineEvent[] = [];

    private readonly environment: NodeJS.ProcessEnv = process.env;
    private readonly portalGrant: PortalGrant | undefined;
    /** The grant the portal returned for the latest open, saved only once that open succeeds. */
    private earnedGrant: { sessionId: string; token: string } | undefined;
    private readonly virtualDisplay: VirtualDisplay;

    constructor(options: DesktopEngineOptions = {}, private readonly x11SocketDirectory = X11_SOCKET_DIRECTORY) {
        this.options = options;
        this.portalGrant = options.stateRoot === undefined ? undefined : new PortalGrant(options.stateRoot);
        this.virtualDisplay = new VirtualDisplay(this.environment, x11SocketDirectory);
    }

    /** Stop the screen this host started, if any; the host calls this as it stops. */
    stopVirtualDisplay(): void {
        this.virtualDisplay.stop();
    }

    /**
     * The owner's STUN/TURN servers for one side of a session. Each side gets
     * its own credentials; a relay that cannot mint them leaves the picture to
     * the direct and link paths, and the reason goes to the host log.
     */
    async iceServers(): Promise<DesktopIceServer[]> {
        try {
            return await this.options.iceServers?.() ?? [];
        } catch (error) {
            this.options.onDiagnostic?.(`no TURN servers for this desktop: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /** No sessions and nothing opening: the target reaper may drop this instance. */
    get idle(): boolean {
        return this.sessions.size === 0 && this.opening === 0;
    }

    /** A server without a screen that this host can give one. */
    private startsOwnDisplay(): boolean {
        return screenless(this.environment, this.x11SocketDirectory) && this.virtualDisplay.installed();
    }

    async capabilities(): Promise<DesktopCapabilities> {
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
            const reported = this.engineCapabilities ?? await client.capabilities();
            this.engineCapabilities = reported;
            // The engine's input probe only knows about uinput; the X11 backend
            // injects through XTest and needs none, so the host's selected
            // source is the only side that can answer for that machine.
            this.virtualDisplay.reap();
            const x11 = configuredSource(this.environment, this.x11SocketDirectory)?.kind === 'x11' || this.startsOwnDisplay();
            return {
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
    }

    async open(request: {
        permissions: DesktopPermission[];
        maxWidth?: number;
        maxHeight?: number;
        bitrateKbps?: number;
        maxFps?: number;
        loopbackTcp?: boolean;
        awaitConsent?: boolean;
    }, owner?: { connectionId: string; isConnected: () => boolean; deviceId?: string }): Promise<{ desktopId: string; generation: number; geometry: DesktopSurfaceGeometry; source: LiveSession['source'] }> {
        if (owner !== undefined && !owner.isConnected()) throw new EngineRefused('session', 'the requesting phone disconnected');
        // Before the engine: on a bare server its libraries are missing too, and
        // the one step that fixes both is the one this refusal carries.
        this.virtualDisplay.reap();
        if (screenless(this.environment, this.x11SocketDirectory) && !this.virtualDisplay.installed()) throw new EngineRefused('no-screen', NO_SCREEN);
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
        let source = configuredSource(this.environment, this.x11SocketDirectory);
        const takeGrant = (): string | undefined => {
            if (source?.kind === 'x11') return undefined;
            try {
                return this.portalGrant?.take();
            } catch {
                // Never send a token we could not safely consume.
                this.options.onDiagnostic?.('Desktop grant could not be read; requesting portal consent.');
                return undefined;
            }
        };
        if (this.opening === 0) this.silentPortal = null;
        this.opening += 1;
        let client: EngineClient;
        let restoreToken: string | undefined;
        let iceServers: DesktopIceServer[];
        try {
            const acquired = await this.ensureClient();
            if (acquired === null) {
                throw new EngineRefused('desktop-unavailable', this.startFailure ?? this.missingEngineReason());
            }
            client = acquired;
            if (source === undefined && this.startsOwnDisplay()) {
                try {
                    source = { kind: 'x11', display: await this.virtualDisplay.ensure() };
                } catch (error) {
                    throw new EngineRefused('desktop-unavailable', error instanceof Error ? error.message : 'the virtual screen did not start');
                }
            }
            if (source?.kind !== 'x11') {
                // A portal backend that cannot answer a ping cannot show a prompt
                // either: say so now rather than after the whole consent wait.
                this.silentPortal ??= silentPortalBackends();
                const [silent] = await this.silentPortal;
                if (silent !== undefined) {
                    this.options.onDiagnostic?.(`desktop open refused: ${silent.name} does not answer (${silent.restartCommand})`);
                    throw new EngineRefused('portal-busy', desktopPortalBusy(silent.restartCommand));
                }
            }
            restoreToken = takeGrant();
            iceServers = await this.iceServers();
        } catch (error) {
            this.opening -= 1;
            await this.stopIfIdle();
            throw error;
        }
        const openParams = {
            permissions: request.permissions,
            ...(iceServers.length === 0 ? {} : { iceServers }),
            ...(restoreToken === undefined ? {} : { restoreToken }),
            ...(source === undefined ? {} : { source }),
            ...(request.maxWidth === undefined ? {} : { maxWidth: request.maxWidth }),
            ...(request.maxHeight === undefined ? {} : { maxHeight: request.maxHeight }),
            ...(request.bitrateKbps === undefined ? {} : { bitrateKbps: request.bitrateKbps }),
            ...(request.maxFps === undefined ? {} : { maxFps: request.maxFps }),
            ...(request.loopbackTcp === true ? { loopbackTcp: true } : {}),
            ttlSeconds: DESKTOP_SESSION_LEASE_SECONDS,
            // A portal open may be waiting on a person at the computer. The
            // engine stays up for the whole wait when the caller waits that
            // long too, so an approval that takes a minute still opens the
            // desktop and saves the grant that stops later opens asking.
        };
        const timeout = source?.kind !== 'x11' && request.awaitConsent === true ? DESKTOP_CONSENT_WAIT_MS : undefined;
        // A grant the portal hands back is kept only once its open succeeds,
        // which the engine allows only after capture delivers a first frame: a
        // share that never showed anything still earns one, and saving it would
        // restore the same failing source on every later open.
        this.earnedGrant = undefined;
        const started = Date.now();
        this.options.onDiagnostic?.(`desktop open: ${source?.kind ?? 'portal'} source, ${restoreToken === undefined ? 'no saved grant' : 'saved grant'}${timeout === undefined ? '' : `, waits up to ${timeout} ms for approval`}`);
        const opened = await client.openSession(openParams, timeout).catch(async (error: unknown) => {
            if (!captureNeverStarted(error)) throw error;
            // A restored grant whose capture never started points at a source
            // that is gone: ask again, so the portal shows its picker. A fresh
            // choice may have lost to another screencast starving PipeWire;
            // the grant it just earned gets one more go without a second picker.
            const retryToken = restoreToken === undefined ? this.earnedGrant?.token : undefined;
            this.earnedGrant = undefined;
            if (restoreToken !== undefined || retryToken !== undefined) {
                const { restoreToken: _spent, ...fresh } = openParams;
                try {
                    return await client.openSession(retryToken === undefined ? fresh : { ...fresh, restoreToken: retryToken }, timeout);
                } catch (retryError) {
                    if (!captureNeverStarted(retryError)) throw retryError;
                }
            }
            throw new EngineRefused('source', DESKTOP_NO_PICTURE);
        }).finally(() => {
            for (const existing of this.sessions.values()) {
                if (existing.revoked || existing.client !== client) continue;
                existing.revoked = true;
                existing.appended += 1;
                existing.events.push({ kind: 'revoked', reason: 'another device opened this computer' });
            }
        }).catch(async (error: unknown) => {
            this.options.onDiagnostic?.(`desktop open failed after ${Date.now() - started} ms: ${(error as { code?: unknown }).code ?? 'error'}`);
            this.earnedGrant = undefined;
            this.opening -= 1;
            await this.stopIfIdle();
            throw error;
        });
        this.options.onDiagnostic?.(`desktop open: engine opened in ${Date.now() - started} ms`);
        this.saveGrant(opened.sessionId);
        if (owner !== undefined && !owner.isConnected()) {
            await client.closeSession(opened.sessionId).catch(() => undefined);
            this.opening -= 1;
            await this.stopIfIdle();
            throw new EngineRefused('session', 'the requesting phone disconnected');
        }
        const desktopId = nextDesktopId();
        const ownerFields: Pick<LiveSession, 'ownerDeviceId'> = {};
        if (owner?.deviceId !== undefined) ownerFields.ownerDeviceId = owner.deviceId;
        this.sessions.set(desktopId, {
            desktopId,
            engineSessionId: opened.sessionId,
            generation: opened.generation,
            permissions: request.permissions,
            geometry: opened.geometry,
            source: opened.source,
            openedAt: Date.now(),
            client,
            ...ownerFields,
            events: [],
            appended: 0,
            revoked: false,
            loopbackPorts: new Set(),
        });
        // The offer arrives through `onEvent` into the session backlog; the
        // first poll delivers it, which keeps one delivery path instead of two.
        this.deliverPending(desktopId);
        this.opening -= 1;
        return { desktopId, generation: opened.generation, geometry: opened.geometry, source: opened.source };
    }

    async answer(desktopId: string, sdp: string, connectionId?: string, deviceId?: string): Promise<{ accepted: boolean }> {
        const session = this.require(desktopId, connectionId, deviceId);
        return session.client.acceptAnswer(session.engineSessionId, session.generation, sdp);
    }

    async candidate(
        desktopId: string,
        candidate: string,
        sdpMid: string | null,
        sdpMLineIndex: number | null,
        connectionId?: string,
        deviceId?: string,
    ): Promise<{ accepted: boolean }> {
        const session = this.require(desktopId, connectionId, deviceId);
        return session.client.addCandidate(session.engineSessionId, session.generation, candidate, sdpMid, sdpMLineIndex);
    }

    async poll(desktopId: string, cursor: number, connectionId?: string, deviceId?: string): Promise<{ cursor: number; events: DesktopEvent[] }> {
        const session = this.require(desktopId, connectionId, deviceId);
        this.deliverPending(desktopId);
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

    async close(desktopId: string, connectionId?: string, deviceId?: string): Promise<{ closed: boolean }> {
        const session = this.sessions.get(desktopId);
        if (session === undefined) return { closed: true };
        if (connectionId !== undefined && (deviceId === undefined || session.ownerDeviceId !== deviceId)) {
            throw new EngineRefused('session', 'that desktop session belongs to another device');
        }
        this.sessions.delete(desktopId);
        this.forgetPending(session.engineSessionId);
        try {
            await session.client.closeSession(session.engineSessionId);
        } catch {
            // The session is already gone on the engine side; the client stays
            // usable for the next session, which is what matters.
        }
        await this.stopIfIdle();
        return { closed: true };
    }

    /** Whether `deviceId` may carry a TCP connection to `port`: a loopback candidate of its own live session. */
    loopbackPort(desktopId: string, port: number, deviceId: string): boolean {
        const session = this.sessions.get(desktopId);
        return session !== undefined && !session.revoked && session.ownerDeviceId === deviceId && session.loopbackPorts.has(port);
    }

    /** A device owns its desktop sessions across replacement streams and link reconnects. */
    setLinkDeviceConnected(deviceId: string, connected: boolean): void {
        const timer = this.disconnectTimers.get(deviceId);
        if (connected) {
            this.connectedLinkDevices.add(deviceId);
            if (timer !== undefined) clearTimeout(timer);
            this.disconnectTimers.delete(deviceId);
            return;
        }
        this.connectedLinkDevices.delete(deviceId);
        if (timer !== undefined || ![...this.sessions.values()].some((session) => session.ownerDeviceId === deviceId)) return;
        this.disconnectTimers.set(deviceId, setTimeout(() => {
            this.disconnectTimers.delete(deviceId);
            if (!this.connectedLinkDevices.has(deviceId)) {
                void this.closeDeviceSessions(deviceId).catch(() => {
                    this.options.onDiagnostic?.('could not close desktop sessions after the device link ended');
                });
            }
        }, LINK_DISCONNECT_GRACE_MS));
    }

    async revokeDevice(deviceId: string, clearGrant = false): Promise<void> {
        this.setLinkDeviceConnected(deviceId, false);
        const timer = this.disconnectTimers.get(deviceId);
        if (timer !== undefined) clearTimeout(timer);
        this.disconnectTimers.delete(deviceId);
        await this.closeDeviceSessions(deviceId);
        if (clearGrant) this.portalGrant?.clear();
    }

    /** Close every session this host owns; called when the host shuts down. */
    async closeAll(): Promise<void> {
        for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
        this.disconnectTimers.clear();
        this.connectedLinkDevices.clear();
        for (const desktopId of [...this.sessions.keys()]) {
            await this.close(desktopId);
        }
        await this.stopIfIdle();
    }

    private async closeDeviceSessions(deviceId: string): Promise<void> {
        for (const session of [...this.sessions.values()]) {
            if (session.ownerDeviceId === deviceId) await this.close(session.desktopId);
        }
    }

    private async stopIfIdle(): Promise<void> {
        if (this.sessions.size !== 0 || this.opening !== 0) return;
        const client = this.client;
        this.client = null;
        this.engineCapabilities = null;
        await client?.stop().catch(() => undefined);
    }

    /** Persist the grant `sessionId` earned, now that its open has succeeded. */
    private saveGrant(sessionId: string): void {
        const earned = this.earnedGrant;
        if (earned?.sessionId !== sessionId) return;
        this.earnedGrant = undefined;
        try {
            this.portalGrant?.replace(earned.token);
        } catch {
            this.options.onDiagnostic?.('Desktop grant could not be saved; next open will require portal consent.');
        }
    }

    private missingEngineReason(): string {
        return explainMissingEngine(this.options.enginePath) ?? 'The desktop engine is unavailable.';
    }

    private require(desktopId: string, connectionId?: string, deviceId?: string): LiveSession {
        const session = this.sessions.get(desktopId);
        if (session === undefined) {
            throw new EngineRefused('session', 'that desktop session is not open');
        }
        if (connectionId !== undefined && (deviceId === undefined || session.ownerDeviceId !== deviceId)) {
            throw new EngineRefused('session', 'that desktop session belongs to another device');
        }
        return session;
    }

    /**
     * Move the events the engine pushed before their session was registered
     * into that session's backlog, oldest first. A replaced session must never
     * receive another session's notifications, so only its own move.
     */
    private deliverPending(desktopId: string): void {
        const session = this.sessions.get(desktopId);
        if (session === undefined || session.revoked || this.pendingEngineEvents.length === 0) return;
        const rest: EngineEvent[] = [];
        for (const event of this.pendingEngineEvents) {
            if (engineSessionIdOf(event) === session.engineSessionId) this.appendEngineEvent(session, event);
            else rest.push(event);
        }
        this.pendingEngineEvents.length = 0;
        this.pendingEngineEvents.push(...rest);
    }

    /** Drop the stragglers of a session that will never be registered now. */
    private forgetPending(engineSessionId: string): void {
        for (let index = this.pendingEngineEvents.length - 1; index >= 0; index -= 1) {
            const event = this.pendingEngineEvents[index];
            if (event !== undefined && engineSessionIdOf(event) === engineSessionId) this.pendingEngineEvents.splice(index, 1);
        }
    }

    /**
     * File one pushed engine event into its session's backlog. The client no
     * longer retains events once `onEvent` is set, so this push path is the
     * only delivery; an event for no live session waits in the pending buffer
     * instead of being lost to the race with `open`.
     */
    private routeEngineEvent(event: EngineEvent): void {
        const sessionId = engineSessionIdOf(event);
        const session = sessionId === undefined
            ? undefined
            : [...this.sessions.values()].find((candidate) => !candidate.revoked && candidate.engineSessionId === sessionId);
        if (session === undefined) {
            this.pendingEngineEvents.push(event);
            if (this.pendingEngineEvents.length > MAX_BACKLOG) {
                this.pendingEngineEvents.splice(0, this.pendingEngineEvents.length - MAX_BACKLOG);
            }
            return;
        }
        this.appendEngineEvent(session, event);
    }

    private appendEngineEvent(session: LiveSession, event: EngineEvent): void {
        const translated = toDesktopEvent(event);
        if (translated === null) return;
        const loopback = translated.kind === 'candidate' ? DESKTOP_LOOPBACK_TCP.exec(translated.candidate) : null;
        if (loopback !== null) session.loopbackPorts.add(Number(loopback[2]));
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
                            if (event.event === 'session.restoreToken') {
                                if (typeof event.params.token !== 'string' || event.params.token === '') return;
                                const sessionId = String(event.params.sessionId ?? '');
                                this.earnedGrant = { sessionId, token: event.params.token };
                                return;
                            }
                            this.routeEngineEvent(event);
                        },
                        onExit: () => {
                            // The engine died: tell every attached client the
                            // session is gone, and keep the record so the next
                            // poll can deliver that before it is forgotten.
                            this.client = null;
                            this.engineCapabilities = null;
                            for (const session of this.sessions.values()) {
                                session.revoked = true;
                                session.appended += 1;
                                session.events.push({ kind: 'revoked', reason: 'the desktop engine stopped' });
                            }
                        },
                    },
                    // The engine reaches this host's own screen with its cookie. A
                    // headless host may start that screen after the engine, so
                    // the engine always carries it there — even when the service
                    // inherited a cookie for some other display.
                    {
                        ...process.env,
                        ...(headless(this.environment) ? { XAUTHORITY: this.virtualDisplay.authorityFile } : {}),
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

function engineSessionIdOf(event: EngineEvent): string | undefined {
    const sessionId = (event.params as { sessionId?: unknown }).sessionId;
    return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * The portal granted a source but no picture came from it. A refused or
 * cancelled picker is a `source` error too, and is never retried.
 */
function captureNeverStarted(error: unknown): boolean {
    return error instanceof EngineRefused && error.code === 'source' && error.message.startsWith('capture ');
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
            return {
                kind: 'revoked',
                reason: String(event.params.reason ?? 'the desktop session ended'),
                ...(typeof event.params.code === 'string' ? { code: event.params.code } : {}),
            };
        default:
            // A notification this host does not know — a restore token, or a
            // newer engine's addition — is not a reason to end the session.
            return null;
    }
}
