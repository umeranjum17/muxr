import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { NativeDesklinkModule } from './native';
import type {
    ControlMessage,
    IceServerConfig,
    Permission,
    SessionFailure,
    SessionOpenRequest,
    SessionOpenResult,
    SessionSnapshot,
    Signaling,
    SurfaceGeometry,
} from './protocol';
import { PROTOCOL_VERSION, parseControlReply } from './protocol';

/** How long a clipboard round trip may take before it is reported as lost. */
const CLIPBOARD_TIMEOUT_MS = 4000;

/** One reconnect attempt per session; beyond that the caller must ask again. */
const MAX_RECONNECT_ATTEMPTS = 1;

/**
 * Without a relay there is no route between two networks: ICE only ever finds
 * host candidates. A client that cannot reach the desktop is told that plainly
 * rather than left on a spinner.
 */
const UNREACHABLE_DESKTOP =
    'The desktop could not be reached. Connecting from outside the desktop\'s own network is not supported in this version.';

/**
 * The platform module, loaded the first time a desktop is opened.
 *
 * It holds the session, the renderer and the input bridge — the largest thing in
 * this package — and most sessions never open a desktop, so it must not sit in
 * the application's initial bundle. Everything below uses this binding as it did
 * when it was a static import; the only change is when it becomes non-null.
 */
let nativeDesklink: NativeDesklinkModule | null = null;

async function loadPlatform(): Promise<boolean> {
    if (nativeDesklink !== null) return true;
    try {
        nativeDesklink = (await import('./native')).nativeDesklink;
    } catch {
        return false;
    }
    return nativeDesklink !== null;
}

export interface DesktopSessionOptions {
    /**
     * Ask the owning application for a fresh, short-lived authorization and the
     * authenticated channel to the host engine. Called for the first connection
     * and again for a reconnect: the package never reuses authority it was not
     * granted again.
     */
    authorize: () => Promise<{ signaling: Signaling; session: SessionOpenRequest }>;
    onStateChange?: (snapshot: SessionSnapshot) => void;
    onError?: (failure: SessionFailure) => void;
}

export interface DesktopSession {
    snapshot: SessionSnapshot;
    /** The native session handle, or null when nothing is open. */
    nativeId: string | null;
    connect: () => Promise<void>;
    close: (reason?: string) => Promise<void>;
    showKeyboard: () => void;
    hideKeyboard: () => void;
    /** Copy the desktop's clipboard to the phone; the caller places it locally. */
    copyRemoteToLocal: () => Promise<string>;
    /** Send the phone's clipboard text to the desktop. */
    pasteLocalToRemote: (text: string) => Promise<void>;
    /** Release anything the desktop is holding, without ending the session. */
    releaseHeld: () => void;
    send: (message: ControlMessage) => void;
}

const IDLE: SessionSnapshot = {
    status: 'idle',
    geometry: null,
    presented: false,
    failure: null,
    diagnostics: {},
};

/**
 * Desktop session lifecycle.
 *
 * The default is idle: nothing connects until the caller asks, because opening a
 * remote desktop is a user action and also because capture needs the host's
 * consent. The hook owns negotiation, readiness, reconnect and the clipboard
 * round trip; the view owns pixels and gestures.
 */
export function useDesktopSession(options: DesktopSessionOptions): DesktopSession {
    const [snapshot, setSnapshot] = useState<SessionSnapshot>(IDLE);
    const [nativeId, setNativeId] = useState<string | null>(null);

    const opened = useRef<SessionOpenResult | null>(null);
    const signaling = useRef<Signaling | null>(null);
    const nativeRef = useRef<string | null>(null);
    const pendingClipboard = useRef(new Map<string, (reply: { text: string; error?: string }) => void>());
    const attempts = useRef(0);
    /**
     * The pending reconnect attempt. It lives here rather than in the effect
     * that schedules it: that effect's own `reconnecting` update changes one of
     * its dependencies, so React would run its cleanup and cancel the retry.
     */
    const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const diagnostics = useRef<Record<string, string | number | boolean>>({});
    /** Guards every asynchronous callback against a session that already ended. */
    const generationToken = useRef(0);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const update = useCallback((patch: Partial<SessionSnapshot>) => {
        setSnapshot((current) => {
            const next = { ...current, ...patch };
            optionsRef.current.onStateChange?.(next);
            return next;
        });
    }, []);

    const fail = useCallback((failure: SessionFailure) => {
        update({ status: 'failed', failure });
        optionsRef.current.onError?.(failure);
    }, [update]);

    const refuse = useCallback((message: string, code: SessionFailure['code'] = 'platform') => {
        fail({ code, message });
    }, [fail]);

    const send = useCallback((message: ControlMessage) => {
        const id = nativeRef.current;
        if (id == null || nativeDesklink === null) return;
        nativeDesklink.sendControl(id, JSON.stringify(message));
    }, []);

    const releaseHeld = useCallback(() => {
        send({ kind: 'release_all' });
    }, [send]);

    const showKeyboard = useCallback(() => {
        const id = nativeRef.current;
        if (id != null) nativeDesklink?.showKeyboard(id);
    }, []);

    const hideKeyboard = useCallback(() => {
        const id = nativeRef.current;
        if (id != null) nativeDesklink?.hideKeyboard(id);
    }, []);

    /** Drop everything this process holds for a session the engine has ended. */
    const discardSession = useCallback(() => {
        generationToken.current += 1;
        const id = nativeRef.current;
        nativeRef.current = null;
        for (const resolve of pendingClipboard.current.values()) resolve({ text: '', error: 'the session ended' });
        pendingClipboard.current.clear();
        opened.current = null;
        signaling.current = null;
        setNativeId(null);
        if (id != null) nativeDesklink?.closeSession(id);
    }, []);

    /** Tell the host a session is over; a failure is nothing the user can act on. */
    const endRemote = useCallback(async (
        openedRef: SessionOpenResult | null,
        owner: Signaling | null,
    ): Promise<void> => {
        if (openedRef == null || owner == null) return;
        try {
            await owner.request('session.close', {
                session_id: openedRef.sessionId,
                generation: openedRef.generation,
            });
        } catch {
            // The engine already dropped it; nothing useful to report.
        }
    }, []);

    const teardown = useCallback(async (reason: string, closeRemote: boolean) => {
        const openedRef = opened.current;
        const owner = signaling.current;
        discardSession();
        if (closeRemote) await endRemote(openedRef, owner);
        update({ status: 'ended', presented: false, failure: null });
        void reason;
    }, [endRemote, discardSession, update]);

    const connect = useCallback(async () => {
        if (!(await loadPlatform())) {
            refuse('this build cannot show a desktop surface');
            return;
        }
        if (nativeRef.current != null) return;
        const token = ++generationToken.current;
        update({ status: 'opening', failure: null, presented: false });

        let authorization: { signaling: Signaling; session: SessionOpenRequest };
        try {
            authorization = await optionsRef.current.authorize();
        } catch (error) {
            refuse(error instanceof Error ? error.message : 'the desktop was not authorized', 'permission');
            return;
        }
        if (token !== generationToken.current) return;
        signaling.current = authorization.signaling;

        let openedResult: SessionOpenResult;
        try {
            openedResult = await authorization.signaling.request<SessionOpenResult>('session.open', {
                permissions: authorization.session.permissions,
                max_width: authorization.session.maxWidth,
                max_height: authorization.session.maxHeight,
                bitrate_kbps: authorization.session.bitrateKbps,
                max_fps: authorization.session.maxFps,
                ice_servers: serializeIceServers(authorization.session.iceServers),
                relay_only: authorization.session.relayOnly ?? false,
                restore_token: authorization.session.restoreToken,
                ttl_seconds: authorization.session.ttlSeconds,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'the desktop could not start';
            refuse(message, /permission|not authorized/i.test(message) ? 'permission' : 'transport');
            return;
        }
        if (token !== generationToken.current) return;
        opened.current = openedResult;
        update({ geometry: openedResult.geometry, status: 'connecting' });

        // `loadPlatform` above guarantees this, but the compiler cannot see
        // through the assignment inside it.
        const platform = nativeDesklink;
        const id = platform === null ? null : platform.createSession(
            JSON.stringify(authorization.session.iceServers ?? []),
            authorization.session.relayOnly ?? false,
        );
        if (id == null) {
            refuse('the native session could not be created');
            return;
        }
        nativeRef.current = id;
        setNativeId(id);

        // The engine's notifications arrive through the same authenticated
        // channel the application already owns.
        authorization.signaling.subscribe((event) => {
            if (token !== generationToken.current) return;
            const native = nativeRef.current;
            if (native == null) return;
            switch (event.kind) {
                case 'description':
                    if (event.description.type !== 'offer') return;
                    nativeDesklink?.setRemoteDescription(native, 'offer', event.description.sdp);
                    return;
                case 'candidate':
                    nativeDesklink?.addRemoteCandidate(
                        native,
                        event.candidate.candidate,
                        event.candidate.sdpMid ?? null,
                        event.candidate.sdpMLineIndex ?? null,
                    );
                    return;
                case 'state':
                    diagnostics.current.transport = event.transport;
                    update({ diagnostics: { ...diagnostics.current } });
                    return;
                case 'revoked':
                    void teardown(event.reason, false);
                    update({ status: 'ended', failure: { code: 'revoked', message: event.reason } });
                    return;
                default:
                    return;
            }
        });
    }, [refuse, teardown, update]);

    // Native events: answer, candidates, control replies, presentation, failure.
    useEffect(() => {
        let dropped = false;
        let subscription: { remove: () => void } | null = null;
        const subscribe = async (): Promise<void> => {
            // The platform module is loaded on first use, which may be after this
            // effect runs; subscribing before it resolves would drop the listener.
            if (!(await loadPlatform())) return;
            if (dropped) return;
            const platform = nativeDesklink;
            if (platform?.addListener == null) return;
            subscription = platform.addListener('onSessionEvent', (event) => {
                if (dropped) return;
                if (event.sessionId !== nativeRef.current) return;
                const openedRef = opened.current;
                const channel = signaling.current;
                switch (event.name) {
                    case 'answer': {
                        const sdp = String(event.payload.sdp ?? '');
                        if (openedRef == null || channel == null || sdp === '') return;
                        channel.request('session.description', {
                            session_id: openedRef.sessionId,
                            generation: openedRef.generation,
                            description: { type: 'answer', sdp },
                        }).catch(() => refuse('the desktop refused our answer', 'transport'));
                        return;
                    }
                    case 'candidate': {
                        if (openedRef == null || channel == null) return;
                        channel.request('session.candidate', {
                            session_id: openedRef.sessionId,
                            generation: openedRef.generation,
                            candidate: String(event.payload.candidate ?? ''),
                            sdpMid: (event.payload.sdpMid as string | null) ?? null,
                            sdpMLineIndex: (event.payload.sdpMLineIndex as number | null) ?? null,
                        }).catch(() => undefined);
                        return;
                    }
                    case 'track':
                        // Readiness is not "a track arrived": it is a frame on screen.
                        return;
                    case 'presented':
                        attempts.current = 0;
                        update({ status: 'live', presented: true, failure: null });
                        return;
                    case 'control': {
                        const reply = parseControlReply(String(event.payload.message ?? ''));
                        if (reply == null) return;
                        if (reply.kind === 'hello') {
                            diagnostics.current.protocol = reply.protocol;
                            if (reply.protocol !== PROTOCOL_VERSION) {
                                refuse('this app and the host engine speak different protocol versions', 'incompatible-version');
                                void teardown('protocol mismatch', true);
                                return;
                            }
                            update({ geometry: reply.geometry });
                            // The native view needs the surface size to map touches.
                            const id = nativeRef.current;
                            if (id != null) {
                                nativeDesklink?.setSurfaceSize(id, reply.geometry.encoded.width, reply.geometry.encoded.height);
                            }
                            return;
                        }
                        if (reply.kind === 'clipboard') {
                            pendingClipboard.current.get(reply.request)?.({ text: reply.text, error: reply.error });
                            pendingClipboard.current.delete(reply.request);
                            return;
                        }
                        if (reply.kind === 'rejected') {
                            diagnostics.current.lastRejection = `${reply.code}: ${reply.message}`;
                            update({ diagnostics: { ...diagnostics.current } });
                            return;
                        }
                        if (reply.kind === 'revoked') {
                            // The engine ends the data channel with a revocation when
                            // the session is replaced or closed; it is the only notice
                            // the client gets, so it has to end the session here.
                            void teardown(reply.reason, false);
                            update({ status: 'ended', failure: { code: 'revoked', message: reply.reason } });
                            return;
                        }
                        return;
                    }
                    case 'failure':
                        refuse(UNREACHABLE_DESKTOP, 'transport');
                        return;
                    case 'closed':
                        return;
                    default:
                        return;
                }
            });
        };
        void subscribe();
        return () => {
            dropped = true;
            subscription?.remove();
        };
    }, [refuse, teardown, update]);

    const copyRemoteToLocal = useCallback(async () => {
        const id = nativeRef.current;
        if (id == null || nativeDesklink == null) throw new Error('No desktop session is open.');
        const request = randomId();
        const answer = new Promise<{ text: string; error?: string }>((resolve) => {
            pendingClipboard.current.set(request, resolve);
            setTimeout(() => {
                if (pendingClipboard.current.delete(request)) resolve({ text: '', error: 'the desktop did not answer' });
            }, CLIPBOARD_TIMEOUT_MS);
        });
        nativeDesklink.sendControl(id, JSON.stringify({ kind: 'clipboard_read', request }));
        const reply = await answer;
        if (reply.error != null) throw new Error(reply.error);
        return reply.text;
    }, []);

    const pasteLocalToRemote = useCallback(async (text: string) => {
        const id = nativeRef.current;
        if (id == null || nativeDesklink == null) throw new Error('No desktop session is open.');
        const request = randomId();
        const answer = new Promise<{ text: string; error?: string }>((resolve) => {
            pendingClipboard.current.set(request, resolve);
            setTimeout(() => {
                if (pendingClipboard.current.delete(request)) resolve({ text: '', error: 'the desktop did not answer' });
            }, CLIPBOARD_TIMEOUT_MS);
        });
        nativeDesklink.sendControl(id, JSON.stringify({ kind: 'clipboard_write', request, text }));
        const reply = await answer;
        if (reply.error != null) throw new Error(reply.error);
    }, []);

    const cancelReconnect = useCallback(() => {
        if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
    }, []);

    const close = useCallback(async (reason = 'closed by the user') => {
        cancelReconnect();
        attempts.current = 0;
        await teardown(reason, true);
    }, [cancelReconnect, teardown]);

    // Reconnect once after a transport failure, with fresh authority: a session
    // that was revoked must not be reopened on the strength of the old grant.
    useEffect(() => {
        if (snapshot.status !== 'failed') return;
        if (snapshot.failure?.code !== 'transport') return;
        // The failed session is dead on the engine side. Drop its handle and
        // close the remote session whether or not another attempt is left: a
        // failure the user can retry by hand must not sit behind a stale
        // native handle that makes `connect()` a no-op.
        const owner = signaling.current;
        const openedRef = opened.current;
        discardSession();
        void endRemote(openedRef, owner);
        if (attempts.current >= MAX_RECONNECT_ATTEMPTS) return;
        attempts.current += 1;
        update({ status: 'reconnecting' });
        reconnectTimer.current = setTimeout(() => {
            reconnectTimer.current = null;
            void connect();
        }, 800);
    }, [connect, discardSession, endRemote, snapshot.status, snapshot.failure, update]);

    useEffect(() => cancelReconnect, [cancelReconnect]);

    // A phone that goes to the background must not leave a remote button held:
    // the desktop cannot know the finger left the glass. This is the same
    // release path a lost control channel takes.
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (status) => {
            if (status !== 'active') releaseHeld();
        });
        return () => subscription.remove();
    }, [releaseHeld]);

    return useMemo<DesktopSession>(() => ({
        snapshot,
        nativeId,
        connect,
        close,
        showKeyboard,
        hideKeyboard,
        copyRemoteToLocal,
        pasteLocalToRemote,
        releaseHeld,
        send,
    }), [
        snapshot,
        nativeId,
        connect,
        close,
        showKeyboard,
        hideKeyboard,
        copyRemoteToLocal,
        pasteLocalToRemote,
        releaseHeld,
        send,
    ]);
}

function serializeIceServers(servers: IceServerConfig[] | undefined): Array<Record<string, unknown>> {
    return (servers ?? []).map((server) => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential,
    }));
}

function randomId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The permissions a normal remote-control session asks for. */
export const CONTROL_PERMISSIONS: Permission[] = ['view', 'control', 'clipboard'];
