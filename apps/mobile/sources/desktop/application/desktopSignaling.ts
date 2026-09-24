import { DESKTOP_CONSENT_WAIT_MS, type DesktopEvent } from '@muxr/contract';
import type { SessionEvent, Signaling } from '@desklink/react-native';

import { sync } from '@/catalog';
import { closeSshForward, openSshForward, sshRouteActive } from '@/connection';

/**
 * The engine's passive ICE-over-TCP candidate on the host's loopback, which a
 * phone on the Direct SSH route can only reach through a forward.
 */
const LOOPBACK_TCP = /^(candidate:\S+ \d+ tcp \d+ )127\.0\.0\.1 (\d+)( typ host tcptype passive.*)$/i;

/**
 * An open may wait on the screen-sharing prompt on the computer. The phone
 * outlasts the host's own wait, so the host's `consent-timeout` arrives rather
 * than a bare request timeout.
 */
const OPEN_TIMEOUT_MS = DESKTOP_CONSENT_WAIT_MS + 10_000;

/** How often the phone asks the host whether the engine has said anything. */
const POLL_INTERVAL_MS = 250;

/** Session setup the host is told about; input never travels this path. */
export interface OpenDesktopOptions {
    permissions: Array<'view' | 'control' | 'clipboard'>;
    maxWidth?: number;
    maxHeight?: number;
    bitrateKbps?: number;
    maxFps?: number;
}

/**
 * The desktop client package's `Signaling`, carried over muxr's own
 * authenticated request path.
 *
 * Only session setup crosses this channel: the offer, the answer and ICE
 * candidates. Pixels and input ride the desktop's own WebRTC session, so this
 * adapter stays tiny and the encrypted request path never sees a stream.
 */
export function createDesktopSignaling(options: OpenDesktopOptions): Signaling {
    const listeners = new Set<(event: SessionEvent) => void>();
    const pending: SessionEvent[] = [];
    let desktopId: string | null = null;
    let cursor = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let polling = false;
    /**
     * On the Direct SSH route the phone has no UDP path it can count on, so it
     * asks for the picture over TCP too and carries that port through the SSH
     * connection it already has: engine port -> device-local port.
     */
    let forwardOverSsh = false;
    const forwards = new Map<number, Promise<number>>();

    const closeForwards = (): void => {
        for (const forward of forwards.values()) void forward.then(closeSshForward, () => undefined);
        forwards.clear();
    };

    /** The candidate as this phone can dial it, or null for one it cannot. */
    const reachable = async (candidate: string): Promise<string | null> => {
        const loopback = LOOPBACK_TCP.exec(candidate);
        if (loopback === null) return candidate;
        if (!forwardOverSsh) return null;
        const enginePort = Number(loopback[2]);
        let forward = forwards.get(enginePort);
        if (forward === undefined) {
            forward = openSshForward(enginePort);
            forwards.set(enginePort, forward);
        }
        try {
            return `${loopback[1]}127.0.0.1 ${await forward}${loopback[3]}`;
        } catch {
            return null;
        }
    };

    const emit = (event: SessionEvent): void => {
        if (listeners.size === 0) pending.push(event);
        else for (const listener of listeners) listener(event);
    };

    const toClientEvent = async (event: DesktopEvent): Promise<SessionEvent | null> => {
        switch (event.kind) {
            case 'offer':
                // A loopback candidate inlined in the offer names a port on the
                // computer, not on this phone; only its forwarded twin is dialled.
                return {
                    kind: 'description',
                    description: {
                        type: 'offer',
                        sdp: event.sdp.split('\r\n').filter((line) => !LOOPBACK_TCP.test(line.replace(/^a=/, ''))).join('\r\n'),
                    },
                };
            case 'candidate': {
                const candidate = await reachable(event.candidate);
                if (candidate === null) return null;
                return {
                    kind: 'candidate',
                    candidate: {
                        candidate,
                        sdpMid: event.sdpMid,
                        sdpMLineIndex: event.sdpMLineIndex,
                    },
                };
            }
            case 'state':
                return { kind: 'state', capture: event.capture, transport: event.transport, firstFrame: event.firstFrame };
            case 'revoked':
                return { kind: 'revoked', reason: event.reason };
            default:
                return null;
        }
    };

    const poll = async (): Promise<void> => {
        if (polling || desktopId === null) return;
        polling = true;
        const id = desktopId;
        try {
            const result = await sync.request('desktop.poll', { desktopId: id, cursor });
            if (id !== desktopId) return;
            cursor = result.cursor;
            for (const raw of result.events) {
                const mapped = await toClientEvent(raw);
                if (id !== desktopId) return;
                if (mapped === null) continue;
                emit(mapped);
                if (mapped.kind === 'revoked') {
                    // The session is over: every later poll would only fail against
                    // a desktopId the host has already dropped.
                    stopPolling();
                    closeForwards();
                    desktopId = null;
                    return;
                }
            }
        } catch {
            // A poll failure is not fatal by itself: the media connection has its
            // own state, and the next tick retries. Reporting it as a revocation
            // would end a session that is still working.
        } finally {
            polling = false;
        }
    };

    const stopPolling = (): void => {
        if (timer !== null) clearInterval(timer);
        timer = null;
    };

    return {
        async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
            switch (method) {
                case 'session.open': {
                    forwardOverSsh = sshRouteActive();
                    const opened = await sync.request('desktop.open', {
                        permissions: options.permissions,
                        awaitConsent: true,
                        ...(forwardOverSsh ? { loopbackTcp: true } : {}),
                        ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
                        ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
                        ...(options.bitrateKbps === undefined ? {} : { bitrateKbps: options.bitrateKbps }),
                        ...(options.maxFps === undefined ? {} : { maxFps: options.maxFps }),
                    }, OPEN_TIMEOUT_MS);
                    desktopId = opened.desktopId;
                    pending.length = 0;
                    cursor = 0;
                    stopPolling();
                    timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
                    // The engine already queued the offer; one immediate poll keeps
                    // the first frame from waiting a whole interval.
                    void poll();
                    return { sessionId: opened.desktopId, generation: opened.generation, source: opened.source, geometry: opened.geometry } as T;
                }
                case 'session.description': {
                    const id = requireDesktopId(desktopId);
                    const description = params?.description as { type: string; sdp: string } | undefined;
                    return await sync.request('desktop.answer', {
                        desktopId: id,
                        ...(typeof params?.generation === 'number' ? { generation: params.generation } : {}),
                        sdp: description?.sdp ?? '',
                    }) as T;
                }
                case 'session.candidate': {
                    const id = requireDesktopId(desktopId);
                    return await sync.request('desktop.candidate', {
                        desktopId: id,
                        ...(typeof params?.generation === 'number' ? { generation: params.generation } : {}),
                        candidate: String(params?.candidate ?? ''),
                        sdpMid: (params?.sdpMid as string | null | undefined) ?? null,
                        sdpMLineIndex: (params?.sdpMLineIndex as number | null | undefined) ?? null,
                    }) as T;
                }
                case 'session.close': {
                    const id = desktopId;
                    stopPolling();
                    closeForwards();
                    desktopId = null;
                    pending.length = 0;
                    if (id === null) return { closed: true } as T;
                    return await sync.request('desktop.close', { desktopId: id }) as T;
                }
                default:
                    throw new Error(`the desktop client asked for an unsupported method: ${method}`);
            }
        },
        subscribe(handler: (event: SessionEvent) => void): () => void {
            listeners.add(handler);
            for (const event of pending.splice(0)) handler(event);
            return () => {
                listeners.delete(handler);
            };
        },
    };
}

function requireDesktopId(id: string | null): string {
    if (id === null) throw new Error('no desktop session is open');
    return id;
}
