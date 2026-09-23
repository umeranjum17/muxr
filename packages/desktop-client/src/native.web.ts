import type { NativeDesklinkModule, NativeEventName, NativeSessionEvent } from './native';
import { observeWebKeyboardMotion } from './webKeyboardMotion';

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

/** Travel in CSS pixels below which a touch is a tap or a hold, not a move. */
const TOUCH_SLOP = 8;

/** A touch held this long without moving arms the right click and the drag. */
const LONG_PRESS_MS = 400;

/** Two taps this close in time are a double click on one desktop point. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 40;

/** Two fingers that land and lift this quickly without moving are a right click. */
const TWO_FINGER_TAP_MS = 300;

/** The closest the picture can be zoomed: CSS pixels per desktop pixel. */
const MAX_SCALE = 2.5;

/**
 * Desktop pixels one wheel detent stands for, so a two-finger scroll moves the
 * content about as far as the fingers moved at any zoom.
 */
const PIXELS_PER_DETENT = 120;

/** Wheel steps smaller than this wait for more movement. */
const MIN_WHEEL_STEP = 0.05;

/** The first picture comes up out of black rather than cutting in. */
const REVEAL = 'opacity 280ms ease-out';

/**
 * The pointer, drawn at a size a phone can see: black with a white edge, so it
 * reads on a light page and a dark one. The tip is the hotspot, 3 px in from
 * the element's corner to leave room for the edge and its shadow.
 */
const POINTER_HOTSPOT = 3;
const POINTER_MARK = '<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">'
    + '<path d="M3 3 L3 22.25 L7.73 17.96 L10.92 25.22 L14 23.9 L10.92 16.86 L17.08 16.86 Z" '
    + 'fill="#000" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" paint-order="stroke"/></svg>';

type Gesture = 'none' | 'pending' | 'pan' | 'armed' | 'drag' | 'two' | 'pinch' | 'scroll' | 'spent' | 'mouse';

const MODIFIER_NAMES = new Set(['Control', 'Shift', 'Alt', 'Meta']);

interface WebSession {
    id: string;
    peer: RTCPeerConnection;
    channel: RTCDataChannel | null;
    video: HTMLVideoElement;
    keyboard: HTMLTextAreaElement;
    /** Where the next click lands, drawn over the picture once a touch has put it somewhere. */
    mark: HTMLDivElement;
    /** The desktop point the pointer was last sent to by touch; null hides the mark. */
    pointerAt: { x: number; y: number } | null;
    /** The last press came from a mouse, whose own cursor needs no mark. */
    mouse: boolean;
    surface: HTMLDivElement | null;
    width: number;
    height: number;
    /**
     * The picture's placement in the surface: CSS pixels per desktop pixel and
     * where the desktop's top-left sits. `fitted` keeps a picture that shows
     * the whole desktop showing it when the surface changes size.
     */
    view: { scale: number; originX: number; originY: number; fitted: boolean };
    /**
     * How much of the surface's bottom the phone's keyboard and the app's own
     * controls above it cover, in CSS pixels. The picture is placed in the rest.
     */
    covered: number;
    /** Space the app keeps above the keyboard for its controls. */
    clearance: number;
    gesture: Gesture;
    /** Touches on the surface, by pointer id, in surface coordinates. */
    touches: Map<number, { x: number; y: number }>;
    downX: number;
    downY: number;
    lastX: number;
    lastY: number;
    /** The last desktop point a held button was moved to. */
    dragX: number;
    dragY: number;
    twoStart: number;
    startSpan: number;
    lastSpan: number;
    startFocusX: number;
    startFocusY: number;
    lastFocusX: number;
    lastFocusY: number;
    wheelX: number;
    wheelY: number;
    lastTap: { at: number; x: number; y: number; point: { x: number; y: number } } | null;
    longPress: ReturnType<typeof setTimeout> | null;
    /** While a sticky modifier waits for its key, typing is the session's to chord. */
    captured: boolean;
    /** The word the keyboard is composing, and how much of it has already gone. */
    composition: string;
    compositionSent: string;
    /** Chorded keys that are down on the desktop, by the character sent for them. */
    chordsDown: Set<string>;
    /** Re-measure what the keyboard covers; null until a surface is attached. */
    followKeyboard: (() => void) | null;
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

function createSessionElements(): { video: HTMLVideoElement; keyboard: HTMLTextAreaElement; mark: HTMLDivElement } {
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.style.position = 'absolute';
    video.style.left = '0px';
    video.style.top = '0px';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.touchAction = 'none';
    video.style.display = 'block';
    video.style.opacity = '0';
    video.style.transition = REVEAL;

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
    // No automatic capitals: the desktop decides what a word is, and a shell
    // command that arrives as "Ls" is wrong.
    keyboard.autocapitalize = 'off';

    const mark = document.createElement('div');
    mark.innerHTML = POINTER_MARK;
    mark.style.position = 'absolute';
    mark.style.left = '0px';
    mark.style.top = '0px';
    mark.style.width = '28px';
    mark.style.height = '28px';
    mark.style.pointerEvents = 'none';
    mark.style.display = 'none';
    mark.style.filter = 'drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35))';
    return { video, keyboard, mark };
}

function control(session: WebSession, message: Record<string, unknown>): void {
    if (session.channel?.readyState !== 'open') return;
    session.channel.send(JSON.stringify(message));
}

/**
 * What a composition has typed beyond what already went while the keyboard was
 * captured. A composition the keyboard rewrote (an autocorrection) cannot take
 * back what the desktop already has, so nothing more of it is sent.
 */
function unsentComposition(session: WebSession, data: string): string {
    return data.startsWith(session.compositionSent) ? data.slice(session.compositionSent.length) : '';
}

/** The surface's box on the page; the picture is placed inside it. */
function surfaceRect(session: WebSession): { left: number; top: number; width: number; height: number } {
    return (session.surface ?? session.video).getBoundingClientRect();
}

/**
 * The whole surface decides the fitted size, so the keyboard coming up moves
 * the picture rather than shrinking it.
 */
function fitScale(session: WebSession): number {
    const rect = surfaceRect(session);
    if (session.width === 0 || session.height === 0 || rect.width === 0 || rect.height === 0) return 1;
    return Math.min(rect.width / session.width, rect.height / session.height);
}

/** The height the keyboard leaves uncovered, which is where the picture is placed. */
function visibleHeight(session: WebSession): number {
    return Math.max(1, surfaceRect(session).height - session.covered);
}

/** Centre a picture smaller than what is visible on that axis; keep a larger one covering it. */
function clampOrigin(session: WebSession): void {
    const rect = surfaceRect(session);
    const visible = visibleHeight(session);
    const { view } = session;
    const width = session.width * view.scale;
    const height = session.height * view.scale;
    view.originX = width <= rect.width ? (rect.width - width) / 2 : Math.min(0, Math.max(rect.width - width, view.originX));
    view.originY = height <= visible ? (visible - height) / 2 : Math.min(0, Math.max(visible - height, view.originY));
}

/** Place the video where the view says; the browser scales it on the GPU. */
function layoutPicture(session: WebSession): void {
    if (session.width === 0 || session.height === 0) return;
    const fit = fitScale(session);
    const { view } = session;
    view.scale = view.fitted ? fit : Math.min(Math.max(view.scale, fit), Math.max(fit, MAX_SCALE));
    view.fitted = view.scale <= fit * 1.001;
    clampOrigin(session);
    const { style } = session.video;
    style.objectFit = 'fill';
    style.left = `${view.originX}px`;
    style.top = `${view.originY}px`;
    style.width = `${session.width * view.scale}px`;
    style.height = `${session.height * view.scale}px`;
    placePointer(session);
}

/** Put the pointer mark on the desktop point it was last sent to. */
function placePointer(session: WebSession): void {
    const { mark, pointerAt, view } = session;
    if (pointerAt === null) {
        mark.style.display = 'none';
        return;
    }
    const x = view.originX + (pointerAt.x + 0.5) * view.scale - POINTER_HOTSPOT;
    const y = view.originY + (pointerAt.y + 0.5) * view.scale - POINTER_HOTSPOT;
    mark.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    mark.style.display = 'block';
}

/**
 * The keyboard took (or gave back) the bottom of the surface. A picture that
 * fits what is left is centred in it by the layout; a larger one is moved so
 * the pointer, where a click just put the caret, stays in sight — or, with no
 * pointer yet, so the middle of what was shown stays in the middle.
 */
function coverBottom(session: WebSession, covered: number): void {
    if (Math.abs(covered - session.covered) < 0.5) return;
    const before = visibleHeight(session);
    session.covered = covered;
    const visible = visibleHeight(session);
    const { view, pointerAt } = session;
    if (pointerAt === null || visible > before) view.originY += (visible - before) / 2;
    if (pointerAt !== null) {
        const y = view.originY + (pointerAt.y + 0.5) * view.scale;
        const margin = Math.min(56, visible / 4);
        if (y > visible - margin) view.originY -= y - (visible - margin);
    }
    layoutPicture(session);
}

function zoomAround(session: WebSession, focusX: number, focusY: number, factor: number): void {
    const fit = fitScale(session);
    const { view } = session;
    const next = Math.min(Math.max(view.scale * factor, fit), Math.max(fit, MAX_SCALE));
    const applied = next / view.scale;
    view.originX = focusX - (focusX - view.originX) * applied;
    view.originY = focusY - (focusY - view.originY) * applied;
    view.scale = next;
    view.fitted = next <= fit * 1.001;
    layoutPicture(session);
}

function panBy(session: WebSession, dx: number, dy: number): void {
    session.view.originX += dx;
    session.view.originY += dy;
    layoutPicture(session);
}

/** Page coordinates → the surface's own. */
function local(session: WebSession, clientX: number, clientY: number): { x: number; y: number } {
    const rect = surfaceRect(session);
    return { x: clientX - rect.left, y: clientY - rect.top };
}

/**
 * Surface coordinates → encoded-surface pixels, or null off the picture. With
 * `clamp`, a point off the picture is held to its edge: a drag may leave it and
 * must still end somewhere.
 */
function desktopPoint(session: WebSession, x: number, y: number, clamp = false): { x: number; y: number } | null {
    if (session.width === 0 || session.height === 0) return null;
    const { view } = session;
    let px = Math.floor((x - view.originX) / view.scale);
    let py = Math.floor((y - view.originY) / view.scale);
    if (clamp) {
        px = Math.min(Math.max(px, 0), session.width - 1);
        py = Math.min(Math.max(py, 0), session.height - 1);
    }
    if (px < 0 || py < 0 || px >= session.width || py >= session.height) return null;
    return { x: px, y: py };
}

function cancelLongPress(session: WebSession): void {
    if (session.longPress !== null) clearTimeout(session.longPress);
    session.longPress = null;
}

function pointer(session: WebSession, phase: 'move' | 'down' | 'up' | 'cancel', at: { x: number; y: number }, button?: number): void {
    control(session, { kind: 'pointer', phase, x: at.x, y: at.y, ...(button === undefined ? {} : { button }), seq: seq(session) });
    // A mouse brings its own cursor; a finger leaves nothing on the glass to
    // show where the desktop's pointer went, so the mark does.
    if (session.mouse || phase === 'cancel') return;
    session.pointerAt = { x: at.x, y: at.y };
    placePointer(session);
}

function click(session: WebSession, at: { x: number; y: number }, button: number): void {
    pointer(session, 'down', at, button);
    pointer(session, 'up', at, button);
}

/**
 * Touch gestures, the ones mature remote-desktop viewers settled on — the same
 * as the native view's:
 *
 *  - tap: click where the finger lands; two taps: a double click on one spot;
 *  - press and hold: a right click on release, or drag after it to hold the
 *    left button (select text, move a window);
 *  - one finger: move around a zoomed-in desktop;
 *  - two fingers: scroll the desktop under them, or pinch to zoom (and move)
 *    the picture; a quick two-finger tap is a right click.
 *
 * A mouse keeps a mouse's meaning: its buttons press, its wheel scrolls, and a
 * pinch on a trackpad (the browser's ctrl-wheel) zooms the picture.
 */
function attachGestures(session: WebSession): () => void {
    const { video, keyboard } = session;
    const surface = session.surface ?? video;

    const longPress = (): void => {
        session.longPress = null;
        if (session.gesture !== 'pending') return;
        const at = desktopPoint(session, session.downX, session.downY);
        if (at === null) return;
        session.gesture = 'armed';
        pointer(session, 'move', at);
        globalThis.navigator?.vibrate?.(10);
    };

    const endDrag = (x: number, y: number): void => {
        const at = desktopPoint(session, x, y, true);
        if (at !== null) pointer(session, 'up', at, 1);
        else control(session, { kind: 'pointer', phase: 'cancel', x: 0, y: 0, seq: seq(session) });
    };

    const dragTo = (x: number, y: number): void => {
        session.lastX = x;
        session.lastY = y;
        const at = desktopPoint(session, x, y, true);
        if (at === null) return;
        pointer(session, 'move', at, 1);
        session.dragX = at.x;
        session.dragY = at.y;
    };

    const tap = (x: number, y: number): void => {
        const now = Date.now();
        const last = session.lastTap;
        const repeat = last !== null && now - last.at < DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) < DOUBLE_TAP_SLOP;
        // A second tap goes to the first tap's point, so the desktop counts a
        // double click rather than two clicks a few pixels apart.
        const at = repeat ? last.point : desktopPoint(session, x, y);
        if (at === null) return;
        click(session, at, 1);
        session.lastTap = { at: now, x, y, point: at };
    };

    const flushWheel = (force: boolean): void => {
        if (!force && Math.abs(session.wheelX) < MIN_WHEEL_STEP && Math.abs(session.wheelY) < MIN_WHEEL_STEP) return;
        if (session.wheelX === 0 && session.wheelY === 0) return;
        const round = (value: number) => Math.round(Math.min(Math.max(value, -10), 10) * 1000) / 1000;
        control(session, { kind: 'wheel', dx: round(session.wheelX), dy: round(session.wheelY), seq: seq(session) });
        session.wheelX = 0;
        session.wheelY = 0;
    };

    const pair = (): [{ x: number; y: number }, { x: number; y: number }] => {
        const [a, b] = [...session.touches.values()];
        return [a!, b!];
    };

    const twoFingers = (): void => {
        const [a, b] = pair();
        const span = Math.hypot(a.x - b.x, a.y - b.y);
        const fx = (a.x + b.x) / 2;
        const fy = (a.y + b.y) / 2;
        if (session.gesture === 'two') {
            // Fingers that spread or close are zooming; fingers that travel
            // together are scrolling. Decided once, so a scroll never turns
            // into a zoom halfway.
            if (Math.abs(span - session.startSpan) > TOUCH_SLOP * 2) {
                session.gesture = 'pinch';
            } else if (Math.hypot(fx - session.startFocusX, fy - session.startFocusY) > TOUCH_SLOP) {
                session.gesture = 'scroll';
                // The desktop scrolls whatever is under its pointer.
                const at = desktopPoint(session, fx, fy);
                if (at !== null) pointer(session, 'move', at);
            }
        } else if (session.gesture === 'pinch') {
            if (session.lastSpan > 0 && span > 0) zoomAround(session, fx, fy, span / session.lastSpan);
            panBy(session, fx - session.lastFocusX, fy - session.lastFocusY);
        } else if (session.gesture === 'scroll') {
            // Content follows the fingers: moving them up scrolls the page down.
            session.wheelX -= (fx - session.lastFocusX) / session.view.scale / PIXELS_PER_DETENT;
            session.wheelY -= (fy - session.lastFocusY) / session.view.scale / PIXELS_PER_DETENT;
            flushWheel(false);
        }
        session.lastSpan = span;
        session.lastFocusX = fx;
        session.lastFocusY = fy;
    };

    const useMouse = (): void => {
        session.mouse = true;
        if (session.pointerAt === null) return;
        session.pointerAt = null;
        placePointer(session);
    };

    const pointerDown = (event: PointerEvent): void => {
        // A press on the desktop is the desktop's: it must not take focus from
        // the remote keyboard, or the phone's keyboard closes under a tap that
        // only meant to put the caret somewhere.
        event.preventDefault();
        try {
            (surface as Element).setPointerCapture(event.pointerId);
        } catch {
            // A synthetic event has no real pointer behind it.
        }
        const { x, y } = local(session, event.clientX, event.clientY);
        if (event.pointerType === 'mouse') useMouse();
        else session.mouse = false;
        if (event.pointerType === 'mouse') {
            const at = desktopPoint(session, x, y);
            if (at === null) return;
            if (event.button === 2) {
                pointer(session, 'down', at, 3);
                return;
            }
            if (event.button !== 0) return;
            session.gesture = 'mouse';
            pointer(session, 'down', at, 1);
            session.dragX = at.x;
            session.dragY = at.y;
            return;
        }
        session.touches.set(event.pointerId, { x, y });
        if (session.touches.size === 1) {
            session.gesture = 'pending';
            session.downX = x;
            session.downY = y;
            session.lastX = x;
            session.lastY = y;
            cancelLongPress(session);
            session.longPress = setTimeout(longPress, LONG_PRESS_MS);
            return;
        }
        cancelLongPress(session);
        if (session.gesture === 'drag') endDrag(session.lastX, session.lastY);
        if (session.touches.size === 2 && ['pending', 'pan', 'armed', 'drag'].includes(session.gesture)) {
            const [a, b] = pair();
            session.gesture = 'two';
            session.twoStart = Date.now();
            session.startSpan = Math.hypot(a.x - b.x, a.y - b.y);
            session.lastSpan = session.startSpan;
            session.startFocusX = (a.x + b.x) / 2;
            session.startFocusY = (a.y + b.y) / 2;
            session.lastFocusX = session.startFocusX;
            session.lastFocusY = session.startFocusY;
            session.wheelX = 0;
            session.wheelY = 0;
            return;
        }
        session.gesture = 'spent';
    };

    const pointerMove = (event: PointerEvent): void => {
        const { x, y } = local(session, event.clientX, event.clientY);
        if (event.pointerType === 'mouse') {
            useMouse();
            if (session.gesture !== 'mouse') return;
            const at = desktopPoint(session, x, y, true);
            if (at === null) return;
            pointer(session, 'move', at, 1);
            session.dragX = at.x;
            session.dragY = at.y;
            return;
        }
        if (!session.touches.has(event.pointerId)) return;
        session.touches.set(event.pointerId, { x, y });
        switch (session.gesture) {
            case 'pending':
                if (Math.hypot(x - session.downX, y - session.downY) > TOUCH_SLOP) {
                    cancelLongPress(session);
                    session.gesture = 'pan';
                    session.lastX = x;
                    session.lastY = y;
                }
                return;
            case 'pan':
                panBy(session, x - session.lastX, y - session.lastY);
                session.lastX = x;
                session.lastY = y;
                return;
            case 'armed':
                if (Math.hypot(x - session.downX, y - session.downY) > TOUCH_SLOP) {
                    const start = desktopPoint(session, session.downX, session.downY, true);
                    if (start === null) return;
                    pointer(session, 'down', start, 1);
                    session.gesture = 'drag';
                    dragTo(x, y);
                }
                return;
            case 'drag':
                dragTo(x, y);
                return;
            case 'two':
            case 'pinch':
            case 'scroll':
                if (session.touches.size >= 2) twoFingers();
                return;
            default:
                return;
        }
    };

    const pointerUp = (event: PointerEvent): void => {
        const { x, y } = local(session, event.clientX, event.clientY);
        if (event.pointerType === 'mouse') {
            if (event.button === 2) {
                const at = desktopPoint(session, x, y, true);
                if (at !== null) pointer(session, 'up', at, 3);
                return;
            }
            if (session.gesture !== 'mouse') return;
            session.gesture = 'none';
            endDrag(x, y);
            return;
        }
        if (!session.touches.delete(event.pointerId)) return;
        cancelLongPress(session);
        const cancelled = event.type === 'pointercancel';
        if (session.touches.size > 0) {
            if (session.gesture === 'two' && !cancelled && Date.now() - session.twoStart < TWO_FINGER_TAP_MS) {
                // Two fingers that landed and lifted without moving: a right
                // click, on the picture only — the letterbox is not its edge.
                const at = desktopPoint(session, session.startFocusX, session.startFocusY);
                if (at !== null) click(session, at, 3);
            }
            if (session.gesture === 'scroll') flushWheel(true);
            // What the remaining finger does next is not a new gesture.
            session.gesture = 'spent';
            return;
        }
        const gesture = session.gesture;
        session.gesture = 'none';
        if (cancelled) {
            if (gesture === 'drag') control(session, { kind: 'pointer', phase: 'cancel', x: 0, y: 0, seq: seq(session) });
            return;
        }
        if (gesture === 'pending') tap(x, y);
        else if (gesture === 'armed') {
            const at = desktopPoint(session, session.downX, session.downY);
            if (at !== null) click(session, at, 3);
        } else if (gesture === 'drag') endDrag(x, y);
    };

    const wheel = (event: WheelEvent): void => {
        event.preventDefault();
        const { x, y } = local(session, event.clientX, event.clientY);
        if (event.ctrlKey) {
            // A trackpad pinch arrives as a ctrl-wheel: zoom the picture.
            zoomAround(session, x, y, Math.exp(-event.deltaY / 200));
            return;
        }
        // Pixels, lines or pages, to detents: a notch is about 100 pixels.
        const unit = event.deltaMode === 1 ? 1 / 3 : event.deltaMode === 2 ? 3 : 1 / 100;
        session.wheelX += event.deltaX * unit;
        session.wheelY += event.deltaY * unit;
        flushWheel(false);
    };

    // The picture keeps its place when the surface changes size.
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const resize = Observer === undefined ? null : new Observer(() => layoutPicture(session));
    resize?.observe(surface as Element);

    // A phone browser lays its keyboard over the page rather than resizing it,
    // so the covered part is what the visual viewport no longer shows.
    const viewport = (globalThis as { visualViewport?: VisualViewport }).visualViewport;
    let phase = 0;
    const followKeyboard = (): void => {
        const rect = surfaceRect(session);
        const shown = viewport === undefined ? rect.top + rect.height : viewport.offsetTop + viewport.height;
        const overlap = Math.max(0, rect.top + rect.height - shown);
        coverBottom(session, overlap > 0 ? overlap + session.clearance * phase : 0);
    };
    session.followKeyboard = followKeyboard;
    const stopFollowing = observeWebKeyboardMotion((motion) => {
        phase = motion.phase;
        followKeyboard();
    });

    // What the phone types goes to the desktop, or, while a sticky modifier
    // waits for its key, to the session, which sends it as that key's chord.
    const typeText = (text: string): void => {
        if (session.captured) emit(session.id, 'keyboard', { text });
        else control(session, { kind: 'text', text, seq: seq(session) });
    };
    const tapKey = (name: string): void => {
        if (session.captured) {
            emit(session.id, 'keyboard', { key: name });
            return;
        }
        control(session, { kind: 'key', name, down: true, seq: seq(session) });
        control(session, { kind: 'key', name, down: false, seq: seq(session) });
    };

    let composing = false;
    const compositionStart = (): void => {
        composing = true;
        session.composition = '';
        session.compositionSent = '';
    };
    const compositionUpdate = (event: CompositionEvent): void => {
        session.composition = event.data;
        if (!session.captured) return;
        // A chord is one key, not the end of a word: it goes as it is typed.
        const typed = unsentComposition(session, event.data);
        session.compositionSent = event.data;
        if (typed !== '') typeText(typed);
    };
    const compositionEnd = (event: CompositionEvent): void => {
        composing = false;
        const typed = unsentComposition(session, event.data);
        session.composition = '';
        session.compositionSent = '';
        if (typed !== '') typeText(typed);
        keyboard.value = '';
    };
    const beforeInput = (event: InputEvent): void => {
        if (composing || event.isComposing) return;
        if (event.inputType === 'insertText' && event.data != null) {
            event.preventDefault();
            typeText(event.data);
        } else if (event.inputType === 'deleteContentBackward') {
            event.preventDefault();
            tapKey('Backspace');
        } else if (event.inputType === 'insertLineBreak') {
            event.preventDefault();
            tapKey('Enter');
        }
    };
    const keyEvent = (event: KeyboardEvent, down: boolean): void => {
        if (composing) return;
        const name = NAMED_KEYS[event.key];
        if (name !== undefined) {
            event.preventDefault();
            // A plain key pressed while a sticky modifier waits is the
            // session's to chord. Only the press is held back: a release still
            // goes, so a key that was down before the capture cannot stick.
            if (session.captured && down && heldModifiers(event).length === 0 && !MODIFIER_NAMES.has(name)) {
                tapKey(name);
                return;
            }
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
        const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
        const character = (physical?.[1] ?? physical?.[2])?.toLowerCase();
        if (character === undefined) return;
        if ((event.ctrlKey || event.metaKey) && (down || session.chordsDown.has(event.code))) {
            event.preventDefault();
            control(session, { kind: 'key', character, modifiers, down, seq: seq(session) });
            if (down) session.chordsDown.add(event.code);
            else session.chordsDown.delete(event.code);
            return;
        }
        if (!down && session.chordsDown.delete(event.code)) {
            event.preventDefault();
            control(session, { kind: 'key', character, modifiers: [], down: false, seq: seq(session) });
        }
    };
    const keyDown = (event: KeyboardEvent): void => keyEvent(event, true);
    const keyUp = (event: KeyboardEvent): void => keyEvent(event, false);

    // The browser's own menu for the video would cover the desktop's.
    const contextMenu = (event: Event): void => event.preventDefault();

    surface.addEventListener('pointerdown', pointerDown as EventListener);
    surface.addEventListener('pointermove', pointerMove as EventListener);
    surface.addEventListener('pointerup', pointerUp as EventListener);
    surface.addEventListener('pointercancel', pointerUp as EventListener);
    surface.addEventListener('wheel', wheel as EventListener, { passive: false });
    surface.addEventListener('contextmenu', contextMenu);
    keyboard.addEventListener('compositionstart', compositionStart);
    keyboard.addEventListener('compositionupdate', compositionUpdate);
    keyboard.addEventListener('compositionend', compositionEnd);
    keyboard.addEventListener('beforeinput', beforeInput);
    keyboard.addEventListener('keydown', keyDown);
    keyboard.addEventListener('keyup', keyUp);

    return () => {
        cancelLongPress(session);
        resize?.disconnect();
        stopFollowing();
        session.followKeyboard = null;
        surface.removeEventListener('pointerdown', pointerDown as EventListener);
        surface.removeEventListener('pointermove', pointerMove as EventListener);
        surface.removeEventListener('pointerup', pointerUp as EventListener);
        surface.removeEventListener('pointercancel', pointerUp as EventListener);
        surface.removeEventListener('wheel', wheel as EventListener);
        surface.removeEventListener('contextmenu', contextMenu);
        keyboard.removeEventListener('compositionstart', compositionStart);
        keyboard.removeEventListener('compositionupdate', compositionUpdate);
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

    createSession(iceServersJson: string): string | null {
        counter += 1;
        const id = `web-${counter}`;
        const { video, keyboard, mark } = createSessionElements();
        const servers = JSON.parse(iceServersJson === '' ? '[]' : iceServersJson) as Array<{
            urls: string[];
            username?: string;
            credential?: string;
        }>;
        const peer = new RTCPeerConnection({ iceServers: servers });
        const session: WebSession = {
            id,
            peer,
            channel: null,
            video,
            keyboard,
            mark,
            pointerAt: null,
            mouse: false,
            surface: null,
            width: 0,
            height: 0,
            view: { scale: 1, originX: 0, originY: 0, fitted: true },
            covered: 0,
            clearance: 0,
            followKeyboard: null,
            gesture: 'none',
            touches: new Map(),
            downX: 0,
            downY: 0,
            lastX: 0,
            lastY: 0,
            dragX: 0,
            dragY: 0,
            twoStart: 0,
            startSpan: 0,
            lastSpan: 0,
            startFocusX: 0,
            startFocusY: 0,
            lastFocusX: 0,
            lastFocusY: 0,
            wheelX: 0,
            wheelY: 0,
            lastTap: null,
            longPress: null,
            captured: false,
            composition: '',
            compositionSent: '',
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
                if (sessions.get(id) !== session) return;
                video.style.opacity = '1';
                emit(id, 'presented', {});
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
        if (session.width === width && session.height === height) return true;
        // A resize invalidates a held drag: releasing it at coordinates the user
        // never pointed at is worse than letting go.
        if (session.gesture === 'drag' || session.gesture === 'mouse') {
            control(session, { kind: 'pointer', phase: 'cancel', x: 0, y: 0, seq: seq(session) });
        }
        cancelLongPress(session);
        session.gesture = 'none';
        session.touches.clear();
        session.width = width;
        session.height = height;
        session.view.fitted = true;
        // A point on the old geometry says nothing about the new one.
        session.pointerAt = null;
        layoutPicture(session);
        return true;
    },

    // A page cannot hold the screen's orientation outside full screen; the
    // browser follows the phone.
    setOrientation: () => false,

    fitToView(id: string): boolean {
        const session = sessions.get(id);
        if (session === undefined) return false;
        session.view.fitted = true;
        layoutPicture(session);
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

    captureKeyboard(id: string, captured: boolean): boolean {
        const session = sessions.get(id);
        if (session === undefined) return false;
        if (captured && !session.captured) {
            // A word still being composed was typed before the modifier was
            // armed: it goes first, as text, and only what follows is chorded.
            const pending = unsentComposition(session, session.composition);
            if (pending !== '') control(session, { kind: 'text', text: pending, seq: seq(session) });
            session.compositionSent = session.composition;
        }
        session.captured = captured;
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
        session.mark.remove();
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
    // The mount point is already positioned (absolutely, by the view) and is
    // what gives the surface its size; making it relative would collapse it
    // to nothing, since everything inside it is absolutely placed.
    container.style.overflow = 'hidden';
    // Pinches and pans are the desktop's, not the page's.
    container.style.touchAction = 'none';
    container.appendChild(session.video);
    container.appendChild(session.mark);
    container.appendChild(session.keyboard);
    session.surface = container;
    session.detach = attachGestures(session);
    layoutPicture(session);
}

/**
 * How much room the app keeps above the keyboard for its own controls; while
 * the desktop's keyboard is up, the picture sits above that too.
 */
export function setKeyboardClearance(id: string, clearance: number): void {
    const session = sessions.get(id);
    if (session === undefined || session.clearance === clearance) return;
    session.clearance = clearance;
    session.followKeyboard?.();
}
