/**
 * Agent browser takeover, device half: the ownership machine.
 *
 * The browser service is the sole authority. This use case drives
 * `browser.session.{status,take,pause,resume,return}` with the generation it
 * expects and an idempotent command id, keeps one private WebRTC peer per
 * ownership generation (recreated at every take/resume so an old observer
 * keeps no media keys), and unlocks input only when every gate holds: the
 * seat is this device's, a fresh track for this generation has been
 * presented, the geometry matches, and a live permit is in hand. Nothing
 * is retried or replayed: a dropped reply goes to **Checking who has
 * control** and reconciles from authoritative status.
 *
 * Security: nothing seen or typed here is logged or persisted.
 */

import { randomUUID } from 'expo-crypto';
import type { BrowserSessionState, BrowserSessionStatus } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { enrollBrowserService, getBrowserServiceGrant } from '@/pairing/e2ee';
import { mapDisplayToViewport, type Point, type Size } from '../domain/coordinates';
import {
    HEARTBEAT_MS,
    isServiceMessage,
    ownsSeat,
    permitLive,
    redactUrls,
    type DeviceInput,
    type DeviceMessage,
    type FocusedField,
    type ServiceMessage,
} from '../domain/browserSession';
import { browserSessionSealer, type BrowserSessionSealer } from '../infrastructure/browserSessionCrypto';
import { createBrowserPeer, type BrowserPeer, type PeerStats } from '../infrastructure/browserSessionClient';

export type OpenTakeoverCommand = { machineId: string; session: string };

export type TakeoverTransition = 'take' | 'pause' | 'resume' | 'return';

export interface TakeoverSnapshot {
    /** What the strip shows; derived from authoritative status plus local media gates. */
    state: BrowserSessionState | 'connecting' | 'needs-pairing';
    status: BrowserSessionStatus | undefined;
    /** Every gate holds: input may leave the device. */
    inputUnlocked: boolean;
    field: FocusedField | null;
    /** Media for the current generation; the view re-attaches when `mediaGeneration` changes. */
    media: BrowserPeer['media'] | undefined;
    mediaGeneration: number;
    /** A fresh frame of the current media has been presented. */
    presented: boolean;
    transition: TakeoverTransition | undefined;
    /** Human, id-free failure of the last transition; Retry is the action. */
    failure: string | undefined;
}

export interface TakeoverSession {
    snapshot: () => TakeoverSnapshot;
    subscribe: (listener: () => void) => () => void;
    take: () => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    giveBack: () => Promise<void>;
    /** Authoritative status query (foreground, recovery). */
    refresh: () => Promise<void>;
    /** The view presented a frame of media generation `mediaGeneration`. */
    presented: (mediaGeneration: number) => void;
    /** Current display box and decoded frame size, for tap mapping. */
    displayed: (display: Size, frame: Size) => void;
    tap: (point: Point) => boolean;
    touch: (phase: 'start' | 'move' | 'end', point?: Point) => boolean;
    wheel: (point: Point, deltaX: number, deltaY: number) => boolean;
    key: (key: 'Enter' | 'Backspace' | 'Tab') => boolean;
    commit: (text: string) => boolean;
    insertText: (text: string) => boolean;
    navigate: (direction: 'back' | 'forward') => boolean;
    /** Sampled peer stats; diagnostics only, never displayed. */
    diagnostics: () => PeerStats | undefined;
    close: () => void;
}

const STATS_SAMPLE_MS = 5_000;
/** Three missed service heartbeats: authority is assumed gone until status says otherwise. */
const HEARTBEAT_LOSS_MS = 3 * HEARTBEAT_MS;

function isGrantFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /grant expired|revoked|not paired|re-?pair/i.test(message);
}

export function openTakeover(command: OpenTakeoverCommand): TakeoverSession {
    const { machineId, session } = command;
    const inputNonce = randomUUID();
    let inputSequence = 0;
    let closed = false;
    let status: BrowserSessionStatus | undefined;
    let phase: 'connecting' | 'live' | 'needs-pairing' | 'checking' | 'ended' = 'connecting';
    let field: FocusedField | null = null;
    let transition: TakeoverTransition | undefined;
    let failure: string | undefined;
    let sealer: BrowserSessionSealer | undefined;
    let sealerGeneration = -1;
    let peer: BrowserPeer | undefined;
    let mediaGeneration = 0;
    let presentedGeneration = -1;
    let presentedFor = -1;
    let permitIssuedAt: number | undefined;
    let permit = '';
    let geometry: { generation: number; target: number; document: number; width: number; height: number } | undefined;
    let focusGeneration = 0;
    let display: Size = { width: 0, height: 0 };
    let frame: Size = { width: 0, height: 0 };
    let lastStats: PeerStats | undefined;
    let lastServiceHeartbeat = 0;
    const listeners = new Set<() => void>();
    // useSyncExternalStore needs a stable snapshot between notifications.
    let cached: TakeoverSnapshot | undefined;

    const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const notify = (): void => {
        cached = undefined;
        for (const listener of listeners) listener();
    };

    const generation = (): number => status?.generation ?? 0;
    const freshMedia = (): boolean => presentedGeneration === mediaGeneration && presentedFor === generation();
    const geometryCurrent = (): boolean => geometry !== undefined && geometry.generation === generation();
    const inputUnlocked = (): boolean => phase === 'live' && transition === undefined && ownsSeat(status)
        && freshMedia() && geometryCurrent() && permitLive(permitIssuedAt, now());

    const derivedState = (): TakeoverSnapshot['state'] => {
        if (phase === 'needs-pairing') return 'needs-pairing';
        if (phase === 'checking') return 'checking';
        if (phase === 'ended') return 'ended';
        if (status === undefined) return 'connecting';
        // Private is claimed only once the barrier and a fresh private track are both acknowledged.
        if (status.state === 'you-control' && !freshMedia()) return 'taking-control';
        return status.state;
    };

    const closePeer = (): void => {
        peer?.close();
        peer = undefined;
        permitIssuedAt = undefined;
        permit = '';
        geometry = undefined;
        field = null;
    };

    /**
     * `reconnect` is false for status learned inside the media handshake
     * itself (the hello reply): reconnecting from there would cancel the
     * handshake that is delivering it.
     */
    const applyStatus = (next: BrowserSessionStatus, reconnect = true): void => {
        const generationChanged = status === undefined || next.generation !== status.generation;
        status = { ...next, ...(next.reason === undefined ? {} : { reason: redactUrls(next.reason) }) };
        phase = 'live';
        if (next.state === 'ended') closePeer();
        // A paused seat streams nothing; Resume brings fresh media and permits.
        else if (reconnect && next.state !== 'paused' && (generationChanged || peer === undefined)) void connectMedia();
        // A barrier still settling has no private channel to push its outcome: ask again shortly.
        if (next.state === 'taking-control' || next.state === 'giving-back') {
            setTimeout(() => { if (!closed && status?.state === next.state) void refresh(); }, HEARTBEAT_MS);
        }
        notify();
    };

    const handleServiceMessage = (message: ServiceMessage): void => {
        if (message.type === 'status') { applyStatus(message.status); return; }
        if (message.generation !== generation()) return;
        if (message.type === 'permit') {
            const first = permitIssuedAt === undefined;
            permit = message.permit;
            permitIssuedAt = now();
            // Permits are the service's 100 ms pulse: a live permit stream is liveness.
            lastServiceHeartbeat = now();
            // Permits tick every 100 ms; only the first one changes what the view shows.
            if (first) notify();
            return;
        }
        if (message.type === 'heartbeat') { lastServiceHeartbeat = now(); return; }
        if (message.type === 'geometry') {
            geometry = { generation: message.generation, target: message.target, document: message.document, width: message.width, height: message.height };
            notify();
            return;
        }
        if (message.type === 'focus') {
            if (geometry !== undefined && (message.target !== geometry.target || message.document !== geometry.document)) return;
            focusGeneration = message.focus;
            field = message.field;
            notify();
        }
    };

    /** A sealed private round trip for the current generation; the reply is opened and typed. */
    const signal = async (message: unknown): Promise<unknown> => {
        if (sealer === undefined) throw new Error('not paired');
        const reply = await sync.request('browser.session.signal', { session, generation: generation(), message: sealer.seal(message) });
        return reply.message === undefined ? undefined : sealer.open(reply.message);
    };

    const helloMessage = (forGeneration: number): unknown => ({ type: 'hello', generation: forGeneration, viewport: display.width > 0 && display.height > 0
        ? { width: Math.round(display.width), height: Math.round(display.height), scale: Math.min(2, Math.max(1, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)) }
        : undefined });

    /** One private peer per generation: hello, offer, sealed round trips, answer. */
    const connectMedia = async (): Promise<void> => {
        if (closed || status === undefined || status.state === 'ended') return;
        let grant = getBrowserServiceGrant(machineId);
        if (grant === undefined) {
            // An owner device enrolls itself once; a refusal (no service, no
            // control authority, expired pairing) is the honest end state.
            try {
                grant = await enrollBrowserService(machineId);
            } catch {
                grant = undefined;
            }
            if (closed) return;
        }
        if (grant === undefined) {
            phase = 'needs-pairing';
            closePeer();
            notify();
            return;
        }
        closePeer();
        const forGeneration = generation();
        // The scope is generation-bound: a fresh sealer per seat, so nothing
        // sealed for an old generation opens under this one -- and exactly
        // one per seat, because the service tracks replay per generation
        // and a restarted sequence would read as a replay.
        if (sealer === undefined || sealerGeneration !== forGeneration) {
            sealer = browserSessionSealer(grant, session, forGeneration);
            sealerGeneration = forGeneration;
        }
        const thisMedia = ++mediaGeneration;
        const current = (): boolean => !closed && thisMedia === mediaGeneration && forGeneration === generation();
        try {
            // The service sizes the shared target to this device's usable
            // region before capture; a viewport that is not yet measured
            // falls back to the service default.
            const hello = await signal(helloMessage(forGeneration));
            if (!current()) return;
            if (isServiceMessage(hello) && hello.type === 'status') applyStatus(hello.status, false);
            const created = await createBrowserPeer({
                onControl: (text) => {
                    if (!current()) return;
                    let parsed: unknown;
                    try { parsed = JSON.parse(text); } catch { return; }
                    if (isServiceMessage(parsed)) handleServiceMessage(parsed);
                },
                onTrack: () => { if (current()) notify(); },
                onState: (state) => {
                    if (!current()) return;
                    if (state === 'lost') void lostAuthority();
                },
            });
            if (!current()) { created.close(); return; }
            peer = created;
            lastServiceHeartbeat = now();
            notify();
            const offer = await created.offer();
            if (!current()) return;
            const answer = await signal({ type: 'offer', generation: forGeneration, sdp: offer });
            if (!current()) return;
            if (answer === undefined) throw new Error('The browser service did not answer.');
            if (!isServiceMessage(answer) || answer.type !== 'answer' || answer.generation !== forGeneration) {
                throw new Error('The browser service answer did not match this session.');
            }
            await created.accept(answer.sdp);
        } catch (error) {
            if (!current()) return;
            if (isGrantFailure(error)) {
                phase = 'needs-pairing';
                closePeer();
                notify();
                return;
            }
            failure = error instanceof Error ? redactUrls(error.message) : 'The browser stream could not start.';
            closePeer();
            notify();
        }
    };

    /** Transport or heartbeat loss while owning: lock now, reconcile from status. */
    const lostAuthority = async (): Promise<void> => {
        if (closed) return;
        closePeer();
        phase = 'checking';
        notify();
        await refresh();
    };

    let rechecks = 0;
    let refit: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
        if (closed) return;
        failure = undefined;
        try {
            applyStatus(await sync.request('browser.session.status', { session }));
            rechecks = 0;
        } catch (error) {
            if (closed) return;
            if (isGrantFailure(error)) phase = 'needs-pairing';
            // The service no longer knows this session (it restarted or the
            // agent closed it): an ended seat, not a retry loop.
            else if (/has ended/i.test(error instanceof Error ? error.message : String(error))) { phase = 'ended'; closePeer(); }
            else phase = 'checking';
            notify();
            // The control plane itself may be reconnecting (foreground after
            // a background); ask again on a short bounded cadence before
            // leaving it to Retry.
            if (phase === 'checking' && rechecks < 15) {
                rechecks += 1;
                setTimeout(() => { if (!closed && phase === 'checking') void refresh(); }, HEARTBEAT_MS);
            }
        }
    };

    const send = (message: DeviceMessage, lane: 'control' | 'pointer' = 'control'): boolean => {
        if (peer === undefined) return false;
        const text = JSON.stringify(message);
        return lane === 'pointer' ? peer.sendPointer(text) : peer.sendControl(text);
    };

    const release = (): void => {
        if (ownsSeat(status)) send({ type: 'release', generation: generation() });
    };

    const run = async (kind: TakeoverTransition): Promise<void> => {
        if (closed || status === undefined || transition !== undefined) return;
        const expectedGeneration = status.generation;
        transition = kind;
        failure = undefined;
        if (kind === 'pause' || kind === 'return') release();
        notify();
        try {
            const next = await sync.request(`browser.session.${kind}`, { session, expectedGeneration, command: randomUUID() });
            if (closed) return;
            transition = undefined;
            // A paused seat streams nothing to a backgrounded device; resume brings fresh media.
            if (kind === 'pause') closePeer();
            applyStatus(next);
        } catch (error) {
            if (closed) return;
            transition = undefined;
            if (isGrantFailure(error)) {
                phase = 'needs-pairing';
                closePeer();
                notify();
                return;
            }
            // The command may have committed before the reply was lost:
            // never guess, reconcile.
            if (kind === 'take') failure = 'Could not take control';
            phase = 'checking';
            closePeer();
            notify();
            await refresh();
        }
    };

    const input = (message: DeviceInput, lane: 'control' | 'pointer' = 'control'): boolean => {
        if (!inputUnlocked() || geometry === undefined) return false;
        inputSequence += 1;
        return send({
            id: `${inputNonce}:${inputSequence}`,
            permit,
            generation: generation(),
            target: geometry.target,
            document: geometry.document,
            focus: focusGeneration,
            ...message,
        }, lane);
    };

    const mapped = (point: Point): Point | undefined => {
        if (geometry === undefined || !geometryCurrent()) return undefined;
        return mapDisplayToViewport(point, display, frame, geometry);
    };

    const heartbeat = setInterval(() => {
        if (closed || !ownsSeat(status) || peer === undefined) return;
        send({ type: 'heartbeat', generation: generation() });
        // The service's pulse (permits) starts once the seat is live; a
        // handshake still negotiating is bounded by the service, not here.
        if (freshMedia() && lastServiceHeartbeat > 0 && now() - lastServiceHeartbeat > HEARTBEAT_LOSS_MS) void lostAuthority();
    }, HEARTBEAT_MS);
    const sampler = setInterval(() => {
        if (closed || peer === undefined) return;
        void peer.stats().then((stats) => { lastStats = stats; }).catch(() => undefined);
    }, STATS_SAMPLE_MS);

    void refresh();

    return {
        snapshot: () => {
            cached ??= {
                state: derivedState(),
                status,
                inputUnlocked: inputUnlocked(),
                field,
                media: peer?.media,
                mediaGeneration,
                presented: freshMedia(),
                transition,
                failure,
            };
            return cached;
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        take: () => run('take'),
        pause: () => run('pause'),
        resume: () => run('resume'),
        giveBack: () => run('return'),
        refresh,
        presented: (forMedia) => {
            if (forMedia !== mediaGeneration) return;
            const firstForSeat = presentedGeneration !== forMedia || presentedFor !== generation();
            presentedGeneration = forMedia;
            presentedFor = generation();
            // A fresh frame is the service answering; the permit pulse that
            // keeps liveness starts only after this frame is acknowledged.
            lastServiceHeartbeat = now();
            notify();
            // The service moves the seat to you-control only once this
            // device has actually shown a frame of the private track.
            if (firstForSeat && status?.state === 'taking-control') {
                void signal({ type: 'presented', generation: generation() })
                    .then((reply) => { if (!closed && isServiceMessage(reply) && reply.type === 'status') applyStatus(reply.status); })
                    .catch(() => { if (!closed) void refresh(); });
            }
        },
        displayed: (nextDisplay, nextFrame) => {
            // Width is what rotation and a moving split change; the composer
            // or keyboard only take height, and the frame letterboxes for that.
            const resized = display.width > 0 && nextDisplay.width > 0 && Math.round(display.width) !== Math.round(nextDisplay.width);
            display = nextDisplay;
            frame = nextFrame;
            // The seat holder's viewport follows its display: a fresh hello
            // lets the service resize and recapture in place, same peer,
            // same generation.
            if (!resized || status?.state !== 'you-control' || !ownsSeat(status) || peer === undefined) return;
            clearTimeout(refit);
            refit = setTimeout(() => {
                if (closed || status?.state !== 'you-control' || peer === undefined) return;
                void signal(helloMessage(generation()))
                    .then((reply) => { if (!closed && isServiceMessage(reply) && reply.type === 'status') applyStatus(reply.status, false); })
                    .catch(() => undefined);
            }, 250);
        },
        tap: (point) => {
            const target = mapped(point);
            return target !== undefined && input({ type: 'tap', ...target });
        },
        touch: (phaseName, point) => {
            if (phaseName === 'end') return input({ type: 'touch', phase: 'end' });
            const target = point === undefined ? undefined : mapped(point);
            if (target === undefined) return false;
            return input({ type: 'touch', phase: phaseName, ...target }, phaseName === 'move' ? 'pointer' : 'control');
        },
        wheel: (point, deltaX, deltaY) => {
            const target = mapped(point);
            return target !== undefined && input({ type: 'wheel', ...target, deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) });
        },
        key: (key) => input({ type: 'key', key }),
        commit: (text) => field !== null && input({ type: 'commit', text }),
        insertText: (text) => field !== null && input({ type: 'insertText', text }),
        navigate: (direction) => input({ type: 'navigate', direction }),
        diagnostics: () => lastStats,
        close: () => {
            if (closed) return;
            release();
            closed = true;
            clearInterval(heartbeat);
            clearInterval(sampler);
            clearTimeout(refit);
            closePeer();
            listeners.clear();
        },
    };
}
