import type { NativeDesklinkModule, NativeEventName, NativeSessionEvent } from './native';

/**
 * The browser implementation of the client's session interface.
 *
 * Metro resolves `./native` to this file on web, so `useDesktopSession` and the
 * app's screen are unchanged: the same states, the same control messages, the
 * same lifecycle. What differs is underneath — the browser's own
 * `RTCPeerConnection` instead of the native binding, a `<video>` element instead
 * of a native renderer, and DOM keyboard and pointer handling instead of the
 * platform's.
 *
 * The gestures live here rather than in the view for the same reason they live
 * in the native view: a drag produces tens of events a second, and routing each
 * one through a React render would add jitter to the interaction the user judges
 * the whole feature by.
 */

/** Drag threshold in CSS pixels below which a touch is a tap. */
const DRAG_SLOP = 6;

/** Two-finger travel before a scroll is emitted. */
const SCROLL_SLOP = 18;

interface WebSession {
    id: string;
    peer: RTCPeerConnection;
    channel: RTCDataChannel | null;
    video: HTMLVideoElement;
    keyboard: HTMLTextAreaElement;
    surface: HTMLDivElement | null;
    width: number;
    height: number;
    dragging: boolean;
    downX: number;
    downY: number;
    dragX: number;
    dragY: number;
    lastScrollY: number;
    pointers: number;
    /** True once the active gesture became two-finger, so its end is not a tap. */
    multiPointer: boolean;
    /** Chorded keys that are down on the desktop, by the character sent for them. */
    chordsDown: Set<string>;
    /** Candidates that arrived before the offer; applied once it is set. */
    remoteDescriptionSet: boolean;
    pendingCandidates: RTCIceCandidateInit[];
    detach: (() => void) | null;
}

const sessions = new Map<string, WebSession>();
const listeners = new Set<(event: NativeSessionEvent) => void>();
let counter = 0;

function emit(sessionId: string, name: NativeEventName, payload: Record<string, unknown>): void {
    for (const listener of listeners) listener({ sessionId, name, payload });
}

const NAMED_KEYS: Record<string, string> = {
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    Delete: 'Delete',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Control: 'Control',
    Shift: 'Shift',
    Alt: 'Alt',
    Meta: 'Meta',
};

/** The modifiers a keyboard event says are held, in the engine's own names. */
function heldModifiers(event: KeyboardEvent): string[] {
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.altKey) modifiers.push('Alt');
    if (event.metaKey) modifiers.push('Meta');
    if (event.shiftKey) modifiers.push('Shift');
    return modifiers;
}

function createSessionElements(): { video: HTMLVideoElement; keyboard: HTMLTextAreaElement } {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.touchAction = 'none';
    video.style.display = 'block';

    // A real focusable element is what raises the platform keyboard on a phone
    // browser and what owns the composing region; it is invisible because the
    // desktop shows the text, not this.
    const keyboard = document.createElement('textarea');
    keyboard.setAttribute('aria-label', 'Remote keyboard');
    keyboard.style.position = 'absolute';
    keyboard.style.width = '1px';
    keyboard.style.height = '1px';
    keyboard.style.opacity = '0.01';
    keyboard.style.border = '0';
    keyboard.autocapitalize = 'sentences';
    return { video, keyboard };
}

function control(session: WebSession, message: Record<string, unknown>): void {
    if (session.channel?.readyState !== 'open') return;
    session.channel.send(JSON.stringify(message));
}

/** CSS pixels → encoded-surface coordinates, or null when outside the picture. */
function surfacePoint(session: WebSession, clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = session.video.getBoundingClientRect();
    if (session.width === 0 || session.height === 0 || rect.width === 0) return null;
    const scale = Math.min(rect.width / session.width, rect.height / session.height);
    const drawnWidth = session.width * scale;
    const drawnHeight = session.height * scale;
    const left = rect.left + (rect.width - drawnWidth) / 2;
    const top = rect.top + (rect.height - drawnHeight) / 2;
    const x = Math.floor((clientX - left) / scale);
    const y = Math.floor((clientY - top) / scale);
    if (x < 0 || y < 0 || x >= session.width || y >= session.height) return null;
    return { x, y };
}

function attachGestures(session: WebSession): () => void {
    const { video, keyboard } = session;

    const pointerDown = (event: PointerEvent): void => {
        try {
            video.setPointerCapture(event.pointerId);
        } catch {
            // A synthetic event has no real pointer behind it.
        }
        if (session.pointers === 0) {
            const at = surfacePoint(session, event.clientX, event.clientY);
            session.pointers = 1;
            session.multiPointer = false;
            session.downX = event.clientX;
            session.downY = event.clientY;
            session.dragging = false;
            if (at !== null) control(session, { kind: 'pointer', phase: 'move', x: at.x, y: at.y, seq: seq(session) });
            return;
        }
        // A second finger makes this a scroll: release anything the drag already
        // pressed and stop driving the pointer.
        if (session.dragging) {
            control(session, { kind: 'pointer', phase: 'up', x: session.dragX, y: session.dragY, button: 1, seq: seq(session) });
            session.dragging = false;
        }
        session.pointers += 1;
        session.multiPointer = true;
        session.lastScrollY = event.clientY;
    };

    const pointerMove = (event: PointerEvent): void => {
        if (session.pointers > 1) {
            if (Math.abs(event.clientY - session.lastScrollY) > SCROLL_SLOP) {
                control(session, { kind: 'wheel', dx: 0, dy: event.clientY < session.lastScrollY ? 1 : -1, seq: seq(session) });
                session.lastScrollY = event.clientY;
            }
            return;
        }
        if (session.pointers === 0) return;
        if (session.multiPointer) return;
        const travelled = Math.hypot(event.clientX - session.downX, event.clientY - session.downY);
        if (!session.dragging && travelled > DRAG_SLOP) {
            const start = surfacePoint(session, session.downX, session.downY);
            if (start === null) return;
            control(session, { kind: 'pointer', phase: 'down', x: start.x, y: start.y, button: 1, seq: seq(session) });
            session.dragX = start.x;
            session.dragY = start.y;
            session.dragging = true;
        }
        if (session.dragging) {
            const at = surfacePoint(session, event.clientX, event.clientY);
            if (at !== null) {
                control(session, { kind: 'pointer', phase: 'move', x: at.x, y: at.y, button: 1, seq: seq(session) });
                session.dragX = at.x;
                session.dragY = at.y;
            }
        }
    };

    const pointerUp = (event: PointerEvent): void => {
        if (session.pointers > 1) {
            session.pointers -= 1;
            return;
        }
        if (session.multiPointer) {
            // The gesture was a two-finger scroll; the last finger lifting must
            // not turn it into a click.
            session.pointers = 0;
            session.multiPointer = false;
            session.dragging = false;
            return;
        }
        session.pointers = 0;
        const at = surfacePoint(session, event.clientX, event.clientY);
        if (session.dragging) {
            if (at !== null) control(session, { kind: 'pointer', phase: 'up', x: at.x, y: at.y, button: 1, seq: seq(session) });
            else control(session, { kind: 'pointer', phase: 'cancel', x: 0, y: 0, seq: seq(session) });
        } else if (at !== null) {
            // A tap is a click at the touched point: press and release on the
            // same coordinates, so the desktop sees the click where the user aimed.
            control(session, { kind: 'pointer', phase: 'down', x: at.x, y: at.y, button: 1, seq: seq(session) });
            control(session, { kind: 'pointer', phase: 'up', x: at.x, y: at.y, button: 1, seq: seq(session) });
        }
        session.dragging = false;
    };

    const wheel = (event: WheelEvent): void => {
        event.preventDefault();
        control(session, { kind: 'wheel', dx: 0, dy: Math.sign(event.deltaY), seq: seq(session) });
    };

    let composing = false;
    const compositionStart = (): void => {
        composing = true;
    };
    const compositionEnd = (event: CompositionEvent): void => {
        composing = false;
        if (event.data !== '') control(session, { kind: 'text', text: event.data, seq: seq(session) });
        keyboard.value = '';
    };
    const beforeInput = (event: InputEvent): void => {
        if (composing || event.isComposing) return;
        if (event.inputType === 'insertText' && event.data != null) {
            event.preventDefault();
            control(session, { kind: 'text', text: event.data, seq: seq(session) });
        } else if (event.inputType === 'deleteContentBackward') {
            event.preventDefault();
            control(session, { kind: 'key', name: 'Backspace', down: true, seq: seq(session) });
            control(session, { kind: 'key', name: 'Backspace', down: false, seq: seq(session) });
        } else if (event.inputType === 'insertLineBreak') {
            event.preventDefault();
            control(session, { kind: 'key', name: 'Enter', down: true, seq: seq(session) });
            control(session, { kind: 'key', name: 'Enter', down: false, seq: seq(session) });
        }
    };
    const keyEvent = (event: KeyboardEvent, down: boolean): void => {
        if (composing) return;
        const name = NAMED_KEYS[event.key];
        if (name !== undefined) {
            event.preventDefault();
            // A modifier the user is holding belongs to this key too, or a
            // chorded arrow/tab after Ctrl+C would arrive as a plain key once
            // the chord's own key-up released the shared modifier.
            control(session, { kind: 'key', name, modifiers: heldModifiers(event), down, seq: seq(session) });
            return;
        }
        // A chorded letter never reaches `beforeinput`: the browser turns Ctrl+C
        // into a copy command on the hidden textarea. Alt is deliberately not a
        // chord here — it composes a character with the layout (macOS Option,
        // Windows AltGr), and that has to stay on the text path.
        const modifiers = heldModifiers(event);
        const chord = (event.ctrlKey || event.metaKey) && /^[a-zA-Z0-9]$/.test(event.key);
        if (chord) {
            event.preventDefault();
            control(session, { kind: 'key', character: event.key, modifiers, down, seq: seq(session) });
            if (down) session.chordsDown.add(event.key.toLowerCase());
            else session.chordsDown.delete(event.key.toLowerCase());
            return;
        }
        // The modifier can be released before the chord key. The desktop is
        // still holding the chord key, so its up must go even without the
        // modifier that made it a chord. The identity is the unshifted key,
        // because the release event reports whatever modifiers are left.
        if (!down && session.chordsDown.delete(event.key.toLowerCase())) {
            event.preventDefault();
            control(session, { kind: 'key', character: event.key, modifiers: [], down: false, seq: seq(session) });
        }
    };
    const keyDown = (event: KeyboardEvent): void => keyEvent(event, true);
    const keyUp = (event: KeyboardEvent): void => keyEvent(event, false);

    video.addEventListener('pointerdown', pointerDown);
    video.addEventListener('pointermove', pointerMove);
    video.addEventListener('pointerup', pointerUp);
    video.addEventListener('pointercancel', pointerUp);
    video.addEventListener('wheel', wheel, { passive: false });
    keyboard.addEventListener('compositionstart', compositionStart);
    keyboard.addEventListener('compositionend', compositionEnd);
    keyboard.addEventListener('beforeinput', beforeInput);
    keyboard.addEventListener('keydown', keyDown);
    keyboard.addEventListener('keyup', keyUp);

    return () => {
        video.removeEventListener('pointerdown', pointerDown);
        video.removeEventListener('pointermove', pointerMove);
        video.removeEventListener('pointerup', pointerUp);
        video.removeEventListener('pointercancel', pointerUp);
        video.removeEventListener('wheel', wheel);
        keyboard.removeEventListener('compositionstart', compositionStart);
        keyboard.removeEventListener('compositionend', compositionEnd);
        keyboard.removeEventListener('beforeinput', beforeInput);
        keyboard.removeEventListener('keydown', keyDown);
        keyboard.removeEventListener('keyup', keyUp);
    };
}

/** Sequence numbers are per session and monotonic; the engine refuses replays. */
function seq(session: WebSession): number {
    const next = (sequence.get(session.id) ?? 0) + 1;
    sequence.set(session.id, next);
    return next;
}

const sequence = new Map<string, number>();

/** A browser is always able to show a desktop: it has its own WebRTC stack. */
export const desktopAvailable = true;

export const nativeDesklink: NativeDesklinkModule = {
    isAvailable: () => true,

    createSession(iceServersJson: string, relayOnly: boolean): string | null {
        counter += 1;
        const id = `web-${counter}`;
        const { video, keyboard } = createSessionElements();
        const servers = JSON.parse(iceServersJson === '' ? '[]' : iceServersJson) as Array<{
            urls: string[];
            username?: string;
            credential?: string;
        }>;
        const peer = new RTCPeerConnection({
            iceServers: servers,
            ...(relayOnly ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
        });
        const session: WebSession = {
            id,
            peer,
            channel: null,
            video,
            keyboard,
            surface: null,
            width: 0,
            height: 0,
            dragging: false,
            downX: 0,
            downY: 0,
            dragX: 0,
            dragY: 0,
            lastScrollY: 0,
            pointers: 0,
            multiPointer: false,
            chordsDown: new Set<string>(),
            remoteDescriptionSet: false,
            pendingCandidates: [],
            detach: null,
        };
        sessions.set(id, session);

        peer.onicecandidate = (event) => {
            if (event.candidate === null || sessions.get(id) !== session) return;
            emit(id, 'candidate', {
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
            });
        };
        peer.ontrack = (event) => {
            if (sessions.get(id) !== session) return;
            video.srcObject = event.streams[0] ?? null;
            emit(id, 'track', {});
            // Readiness is a rendered frame, not a track: a decoder can accept a
            // track and produce nothing.
            const presented = (): void => {
                if (sessions.get(id) === session) emit(id, 'presented', {});
            };
            if (typeof video.requestVideoFrameCallback === 'function') {
                video.requestVideoFrameCallback(presented);
            } else {
                video.addEventListener('loadeddata', presented, { once: true });
            }
        };
        peer.ondatachannel = (event) => {
            if (sessions.get(id) !== session) return;
            session.channel = event.channel;
            event.channel.onmessage = (message) => {
                emit(id, 'control', { message: String(message.data) });
            };
            event.channel.onclose = () => emit(id, 'closed', {});
        };
        peer.onconnectionstatechange = () => {
            if (sessions.get(id) !== session) return;
            if (peer.connectionState === 'failed') {
                emit(id, 'failure', { code: 'transport', message: 'the connection to the desktop was lost' });
            }
        };
        return id;
    },

    setRemoteDescription(id: string, type: string, sdp: string): boolean {
        const session = sessions.get(id);
        if (session === undefined) return false;
        if (type !== 'offer') {
            emit(id, 'failure', { code: 'transport', message: 'the engine must send an offer' });
            return false;
        }
        void (async () => {
            try {
                await session.peer.setRemoteDescription({ type: 'offer', sdp });
                session.remoteDescriptionSet = true;
                for (const candidate of session.pendingCandidates.splice(0)) {
                    await session.peer.addIceCandidate(candidate).catch(() => undefined);
                }
                const answer = await session.peer.createAnswer();
                await session.peer.setLocalDescription(answer);
                if (sessions.get(id) !== session) return;
                emit(id, 'answer', { sdp: answer.sdp ?? '' });
            } catch (error) {
                emit(id, 'failure', {
                    code: 'transport',
                    message: error instanceof Error ? error.message : 'the desktop refused our answer',
                });
            }
        })();
        return true;
    },

    addRemoteCandidate(id, candidate, sdpMid, sdpMLineIndex): boolean {
        const session = sessions.get(id);
        if (session === undefined) return false;
        const init: RTCIceCandidateInit = {
            candidate,
            sdpMid: sdpMid ?? undefined,
            sdpMLineIndex: sdpMLineIndex ?? undefined,
        };
        // The engine announces each candidate exactly once, so a candidate that
        // arrives before the offer has to be held until the offer is set.
        if (!session.remoteDescriptionSet) {
            session.pendingCandidates.push(init);
            return true;
        }
        void session.peer.addIceCandidate(init).catch(() => undefined);
        return true;
    },

    sendControl(id: string, message: string): boolean {
        const session = sessions.get(id);
        if (session === undefined) return false;
        // The session owns the one sequence every control message draws from.
        control(session, { ...(JSON.parse(message) as Record<string, unknown>), seq: seq(session) });
        return true;
    },

    setSurfaceSize(id: string, width: number, height: number): boolean {
        const session = sessions.get(id);
        if (session === undefined) return false;
        // A resize invalidates a held drag: releasing it at coordinates the user
        // never pointed at is worse than letting go.
        if (session.dragging) control(session, { kind: 'pointer', phase: 'cancel', x: 0, y: 0, seq: seq(session) });
        session.dragging = false;
        session.width = width;
        session.height = height;
        return true;
    },

    showKeyboard(id: string): boolean {
        sessions.get(id)?.keyboard.focus();
        return true;
    },

    hideKeyboard(id: string): boolean {
        sessions.get(id)?.keyboard.blur();
        return true;
    },

    closeSession(id: string): boolean {
        const session = sessions.get(id);
        if (session === undefined) return true;
        sessions.delete(id);
        sequence.delete(id);
        session.detach?.();
        session.channel?.close();
        session.peer.close();
        session.video.srcObject = null;
        session.video.remove();
        session.keyboard.remove();
        return true;
    },

    addListener(_name: 'onSessionEvent', handler: (event: NativeSessionEvent) => void) {
        listeners.add(handler);
        return { remove: () => listeners.delete(handler) };
    },
};

/**
 * Mount a session's surface into the page.
 *
 * Attaching to a second container moves it: the session owns exactly one
 * surface, and removing the old one is what keeps a re-render from leaving two
 * live videos behind.
 */
export function attachSurface(id: string, container: HTMLElement | null): void {
    const session = sessions.get(id);
    if (session === undefined) return;
    session.detach?.();
    session.detach = null;
    if (session.surface !== null) session.surface.remove();
    session.surface = null;
    if (container === null) return;
    container.style.position = 'relative';
    container.appendChild(session.video);
    container.appendChild(session.keyboard);
    session.surface = container;
    session.detach = attachGestures(session);
}
