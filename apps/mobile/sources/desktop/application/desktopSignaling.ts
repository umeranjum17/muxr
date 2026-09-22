import type { DesktopEvent } from '@muxr/contract';
import type { SessionEvent, Signaling } from '@desklink/react-native';

import { sync } from '@/catalog';

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
    let desktopId: string | null = null;
    let cursor = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let polling = false;

    const emit = (event: SessionEvent): void => {
        for (const listener of listeners) listener(event);
    };

    const toClientEvent = (event: DesktopEvent): SessionEvent | null => {
        switch (event.kind) {
            case 'offer':
                return { kind: 'description', description: { type: 'offer', sdp: event.sdp } };
            case 'candidate':
                return {
                    kind: 'candidate',
                    candidate: {
                        candidate: event.candidate,
                        sdpMid: event.sdpMid,
                        sdpMLineIndex: event.sdpMLineIndex,
                    },
                };
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
            cursor = result.cursor;
            for (const raw of result.events) {
                const mapped = toClientEvent(raw);
                if (mapped === null) continue;
                emit(mapped);
                if (mapped.kind === 'revoked') {
                    // The session is over: every later poll would only fail against
                    // a desktopId the host has already dropped.
                    stopPolling();
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
                    const opened = await sync.request('desktop.open', {
                        permissions: options.permissions,
                        ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
                        ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
                        ...(options.bitrateKbps === undefined ? {} : { bitrateKbps: options.bitrateKbps }),
                        ...(options.maxFps === undefined ? {} : { maxFps: options.maxFps }),
                    });
                    desktopId = opened.desktopId;
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
                    desktopId = null;
                    if (id === null) return { closed: true } as T;
                    return await sync.request('desktop.close', { desktopId: id }) as T;
                }
                default:
                    throw new Error(`the desktop client asked for an unsupported method: ${method}`);
            }
        },
        subscribe(handler: (event: SessionEvent) => void): () => void {
            listeners.add(handler);
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
