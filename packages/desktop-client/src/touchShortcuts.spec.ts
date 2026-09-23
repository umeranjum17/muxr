import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

import type { Signaling } from './protocol';
import { useDesktopSession, type DesktopSession } from './useDesktopSession';
import { attachSurface, nativeDesklink, setKeyboardClearance } from './native.web';
import { observeWebKeyboardMotion } from './webKeyboardMotion';

/** `act` refuses to flush state updates unless React is told this is a test. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A phone has no right button and no Ctrl, and copying and pasting on a desktop
 * needs one or the other. This drives the real session hook and the real
 * browser client — its gestures, its keyboard and its control channel — and
 * reads the exact messages the desktop receives. Only the browser underneath
 * is stood in for: elements are bare event targets, and the peer connection
 * hands over a data channel that records what it is asked to send.
 */

vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('./native', async () => await import('./native.web'));

class FakeElement extends EventTarget {
    style: Record<string, string> = {};
    value = '';
    autocapitalize = '';
    height = 720;
    setAttribute(): void {}
    setPointerCapture(): void {}
    focus(): void {}
    blur(): void {}
    remove(): void {}
    appendChild(): void {}
    getBoundingClientRect() {
        return { left: 0, top: 0, width: 1280, height: this.height };
    }
}

class FakePeer {
    static last: FakePeer | null = null;
    ondatachannel: ((event: { channel: unknown }) => void) | null = null;
    constructor() {
        FakePeer.last = this;
    }
    close(): void {}
}

let created: FakeElement[] = [];
let sent: Record<string, unknown>[] = [];
let sessionIds: string[] = [];
let stopObservation: (() => void) | null = null;

beforeEach(() => {
    created = [];
    sent = [];
    sessionIds = [];
    vi.stubGlobal('document', {
        createElement: () => {
            const element = new FakeElement();
            created.push(element);
            return element;
        },
    });
    vi.stubGlobal('RTCPeerConnection', FakePeer);
});

afterEach(() => {
    stopObservation?.();
    stopObservation = null;
    for (const id of sessionIds) nativeDesklink.closeSession(id);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const GEOMETRY = {
    source: { width: 2560, height: 1440 },
    encoded: { width: 1280, height: 720 },
    origin: { x: 0, y: 0 },
};

const signaling: Signaling = {
    async request<T>(method: string): Promise<T> {
        if (method === 'session.open') {
            return {
                sessionId: 'engine-1',
                generation: 1,
                source: { kind: 'monitor', width: 2560, height: 1440, origin: { x: 0, y: 0 } },
                geometry: GEOMETRY,
            } as T;
        }
        return { accepted: true } as T;
    },
    subscribe: () => () => undefined,
};

/** A live session on the browser client, its surface mounted and the control channel open. */
async function liveDesktop() {
    const held: { current: DesktopSession | null } = { current: null };
    const rejected: string[] = [];
    function Harness() {
        held.current = useDesktopSession({
            authorize: async () => ({ signaling, session: { permissions: ['view', 'control'] } }),
            onRejected: ({ code }) => rejected.push(code),
        });
        return null;
    }
    await TestRenderer.act(async () => {
        TestRenderer.create(React.createElement(Harness));
    });
    await TestRenderer.act(async () => {
        await held.current?.connect();
    });
    const session = held as { current: DesktopSession };
    sessionIds.push(session.current.nativeId!);
    const channel = {
        readyState: 'open',
        onmessage: null as ((message: { data: string }) => void) | null,
        onclose: null,
        send: (raw: string) => {
            const { seq: _seq, ...message } = JSON.parse(raw) as Record<string, unknown>;
            sent.push(message);
        },
        close(): void {},
    };
    FakePeer.last?.ondatachannel?.({ channel });
    const [, keyboard] = created;
    // Gestures land on the surface the picture is placed in, letterbox included.
    const video = new FakeElement();
    attachSurface(session.current.nativeId!, video as unknown as HTMLElement);
    // The engine's hello carries the geometry every touch is mapped through.
    const reply = (message: Record<string, unknown>) => TestRenderer.act(() => {
        channel.onmessage?.({ data: JSON.stringify(message) });
    });
    reply({ kind: 'hello', protocol: 2, geometry: GEOMETRY });
    sent = [];
    return { session, video, keyboard, reply, rejected };
}

function dispatch(target: EventTarget, type: string, fields: Record<string, unknown>): void {
    TestRenderer.act(() => {
        target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields));
    });
}

const touch = (video: EventTarget, type: string, x: number, y: number) =>
    dispatch(video, type, { pointerId: 1, pointerType: 'touch', button: 0, clientX: x, clientY: y });

const click = (x: number, y: number, button: number) => [
    { kind: 'pointer', phase: 'down', x, y, button },
    { kind: 'pointer', phase: 'up', x, y, button },
];

describe('touch on the desktop', () => {
    it('taps a click, holds for a right click or a drag, and lets a moving finger carry the pointer', async () => {
        vi.useFakeTimers();
        const { session, video } = await liveDesktop();

        touch(video, 'pointerdown', 100, 100);
        touch(video, 'pointerup', 100, 100);
        expect(sent).toEqual(click(100, 100, 1));

        // A second tap close by is a double click on the first tap's point.
        sent = [];
        touch(video, 'pointerdown', 104, 102);
        touch(video, 'pointerup', 104, 102);
        expect(sent).toEqual(click(100, 100, 1));

        sent = [];
        touch(video, 'pointerdown', 115, 100);
        touch(video, 'pointermove', 130, 100);
        touch(video, 'pointerup', 125, 100);
        touch(video, 'pointerdown', 125, 100);
        touch(video, 'pointerup', 125, 100);
        expect(sent).toEqual([
            { kind: 'pointer', phase: 'move', x: 130, y: 100 },
            { kind: 'pointer', phase: 'move', x: 125, y: 100 },
            ...click(125, 100, 1),
        ]);

        // On the whole desktop a finger that moves at once carries the pointer,
        // every move as it comes and without a button; lifting it clicks nothing.
        sent = [];
        vi.advanceTimersByTime(1000);
        touch(video, 'pointerdown', 100, 100);
        touch(video, 'pointermove', 140, 100);
        touch(video, 'pointermove', 150, 104);
        vi.advanceTimersByTime(1000);
        touch(video, 'pointerup', 180, 104);
        expect(sent).toEqual([
            { kind: 'pointer', phase: 'move', x: 140, y: 100 },
            { kind: 'pointer', phase: 'move', x: 150, y: 104 },
            { kind: 'pointer', phase: 'move', x: 180, y: 104 },
        ]);

        // Zoomed in, the same finger moves the view instead, and sends nothing.
        dispatch(video, 'wheel', { ctrlKey: true, deltaY: -200, deltaX: 0, deltaMode: 0, clientX: 640, clientY: 360 });
        sent = [];
        touch(video, 'pointerdown', 100, 100);
        touch(video, 'pointermove', 140, 100);
        touch(video, 'pointerup', 140, 100);
        expect(sent).toEqual([]);
        nativeDesklink.fitToView(session.current.nativeId!);

        video.height = 800;
        nativeDesklink.fitToView(session.current.nativeId!);
        sent = [];
        touch(video, 'pointerdown', 100, 10);
        touch(video, 'pointermove', 100, 100);
        touch(video, 'pointerup', 100, 100);
        expect(sent).toEqual([]);
        touch(video, 'pointerdown', 100, 10);
        video.height = 720;
        nativeDesklink.fitToView(session.current.nativeId!);
        touch(video, 'pointermove', 100, 100);
        touch(video, 'pointerup', 100, 100);
        expect(sent).toEqual([]);
        video.height = 800;
        nativeDesklink.fitToView(session.current.nativeId!);
        touch(video, 'pointerdown', 600, 10);
        dispatch(video, 'pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 90 });
        dispatch(video, 'pointermove', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 140 });
        dispatch(video, 'pointermove', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 170 });
        expect(Number.parseFloat(created[0]!.style.width)).toBeGreaterThan(1280);
        dispatch(video, 'pointerup', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 170 });
        touch(video, 'pointerup', 600, 10);
        expect(sent).toEqual([]);
        nativeDesklink.fitToView(session.current.nativeId!);
        touch(video, 'pointerdown', 600, 10);
        dispatch(video, 'pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 90 });
        touch(video, 'pointermove', 600, 20);
        dispatch(video, 'pointermove', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 100 });
        touch(video, 'pointermove', 600, 30);
        dispatch(video, 'pointermove', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 110 });
        dispatch(video, 'pointerup', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 600, clientY: 110 });
        touch(video, 'pointerup', 600, 30);
        expect(sent.some((message) => message.kind === 'wheel')).toBe(true);
        sent = [];
        touch(video, 'pointerdown', 100, 90);
        touch(video, 'pointermove', 140, 90);
        touch(video, 'pointerup', 180, 90);
        expect(sent).toEqual([
            { kind: 'pointer', phase: 'move', x: 140, y: 50 },
            { kind: 'pointer', phase: 'move', x: 180, y: 50 },
        ]);
        sent = [];
        touch(video, 'pointerdown', 100, 90);
        touch(video, 'pointermove', 140, 90);
        touch(video, 'pointercancel', 180, 90);
        expect(sent).toEqual([{ kind: 'pointer', phase: 'move', x: 140, y: 50 }]);
        video.height = 720;
        nativeDesklink.fitToView(session.current.nativeId!);
        sent = [];

        // Hold, then drag: the left button is held from where the finger rested.
        touch(video, 'pointerdown', 300, 200);
        touch(video, 'pointermove', 303, 202);
        vi.advanceTimersByTime(400);
        expect(sent).toEqual([{ kind: 'pointer', phase: 'move', x: 300, y: 200 }]);
        touch(video, 'pointermove', 360, 200);
        touch(video, 'pointerup', 360, 200);
        expect(sent).toEqual([
            { kind: 'pointer', phase: 'move', x: 300, y: 200 },
            { kind: 'pointer', phase: 'down', x: 300, y: 200, button: 1 },
            { kind: 'pointer', phase: 'move', x: 360, y: 200, button: 1 },
            { kind: 'pointer', phase: 'up', x: 360, y: 200, button: 1 },
        ]);

        // Hold and let go without moving: a right click where the finger rested.
        sent = [];
        touch(video, 'pointerdown', 500, 400);
        vi.advanceTimersByTime(400);
        touch(video, 'pointerup', 500, 400);
        expect(sent).toEqual([{ kind: 'pointer', phase: 'move', x: 500, y: 400 }, ...click(500, 400, 3)]);

        // Two fingers that land and lift at once are a right click too.
        sent = [];
        dispatch(video, 'pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 600, clientY: 300 });
        dispatch(video, 'pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 640, clientY: 300 });
        dispatch(video, 'pointerup', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 640, clientY: 300 });
        dispatch(video, 'pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 600, clientY: 300 });
        expect(sent).toEqual(click(620, 300, 3));

        // Two fingers travelling together scroll the desktop under them, the
        // content following the fingers, in fractions of a wheel detent.
        sent = [];
        vi.advanceTimersByTime(1000);
        dispatch(video, 'pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 600, clientY: 400 });
        dispatch(video, 'pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 640, clientY: 400 });
        dispatch(video, 'pointermove', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 600, clientY: 370 });
        dispatch(video, 'pointermove', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 640, clientY: 370 });
        dispatch(video, 'pointermove', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 600, clientY: 310 });
        dispatch(video, 'pointermove', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 640, clientY: 310 });
        dispatch(video, 'pointerup', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 640, clientY: 310 });
        dispatch(video, 'pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 600, clientY: 310 });
        expect(sent[0]).toEqual({ kind: 'pointer', phase: 'move', x: 620, y: 385 });
        const scrolled = sent.slice(1).reduce((sum, message) => sum + (message.dy as number), 0);
        expect(sent.slice(1).every((message) => message.kind === 'wheel')).toBe(true);
        expect(scrolled).toBeCloseTo(75 / 120, 2);

        // A mouse has its own right button.
        sent = [];
        const mark = created[2]!;
        expect(mark.style.display).toBe('block');
        dispatch(video, 'pointermove', { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 50, clientY: 60 });
        expect(mark.style.display).toBe('none');
        dispatch(video, 'pointerdown', { pointerId: 3, pointerType: 'mouse', button: 2, clientX: 50, clientY: 60 });
        dispatch(video, 'pointerup', { pointerId: 3, pointerType: 'mouse', button: 2, clientX: 50, clientY: 60 });
        expect(sent).toEqual(click(50, 60, 3));
        expect(mark.style.display).toBe('none');
        touch(video, 'pointerdown', 80, 90);
        touch(video, 'pointerup', 80, 90);
        expect(mark.style.display).toBe('block');
    });
});

describe('the pointer above the keyboard', () => {
    it('keeps the painted picture, taps and pointer together while the keyboard moves', async () => {
        const viewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 720 });
        vi.stubGlobal('visualViewport', viewport);
        vi.stubGlobal('innerHeight', 720);
        let phase = 0;
        stopObservation = observeWebKeyboardMotion((motion) => { phase = motion.phase; });
        const { session, video, keyboard } = await liveDesktop();
        vi.useFakeTimers();
        const [picture, , mark] = created;
        const tip = () => {
            const [x, y] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(mark!.style.transform)!.slice(1).map(Number);
            return { x: x! + 3, y: y! + 3 };
        };

        // Nothing is marked until a finger has put the desktop's pointer somewhere.
        expect(mark!.style.display).toBe('none');
        touch(video, 'pointerdown', 640, 600);
        touch(video, 'pointerup', 640, 600);
        expect(mark!.style.display).toBe('block');
        expect(tip()).toEqual({ x: 640.5, y: 600.5 });

        setKeyboardClearance(session.current.nativeId!, 50);
        (document as unknown as { activeElement: unknown }).activeElement = keyboard;
        dispatch(keyboard, 'focus', {});
        expect(picture!.style.top).toBe('0px');

        viewport.height = 600;
        dispatch(viewport, 'resize', {});
        const firstTop = Number.parseFloat(picture!.style.top);
        expect(firstTop).toBeLessThan(0);
        expect(phase).toBe(1);
        viewport.height = 510;
        dispatch(viewport, 'resize', {});
        const paintedTop = Number.parseFloat(picture!.style.top);
        expect(paintedTop).toBeLessThan(firstTop);
        expect(tip().y).toBeLessThan(720 - 260);
        sent = [];
        touch(video, 'pointerdown', 400, 200);
        touch(video, 'pointerup', 400, 200);
        const clickedY = Math.floor(200 - paintedTop);
        expect(sent).toEqual(click(400, clickedY, 1));
        expect(tip().y).toBeCloseTo(paintedTop + clickedY + 0.5, 5);
        viewport.height = 420;
        dispatch(viewport, 'resize', {});
        expect(tip().y).toBeCloseTo(Number.parseFloat(picture!.style.top) + clickedY + 0.5, 5);
        vi.advanceTimersByTime(180);
        viewport.height = 470;
        dispatch(viewport, 'resize', {});
        expect(phase).toBeCloseTo(250 / 300, 5);
        viewport.height = 469;
        dispatch(viewport, 'resize', {});
        const reboundTop = picture!.style.top;
        vi.advanceTimersByTime(180);
        expect(phase).toBeCloseTo(251 / 300, 5);
        expect(picture!.style.top).toBe(reboundTop);
        viewport.height = 420;
        dispatch(viewport, 'resize', {});

        (document as unknown as { activeElement: unknown }).activeElement = null;
        const beforeBlur = Number.parseFloat(picture!.style.top);
        dispatch(keyboard, 'blur', {});
        expect(Number.parseFloat(picture!.style.top)).toBe(beforeBlur);
        viewport.height = 510;
        dispatch(viewport, 'resize', {});
        const returningTop = Number.parseFloat(picture!.style.top);
        expect(returningTop).toBeGreaterThan(beforeBlur);
        expect(phase).toBeCloseTo(210 / 300, 5);
        vi.advanceTimersByTime(180);
        expect(phase).toBeCloseTo(210 / 300, 5);
        sent = [];
        touch(video, 'pointerdown', 500, 220);
        touch(video, 'pointerup', 500, 220);
        const returningY = Math.floor(220 - returningTop);
        expect(sent).toEqual(click(500, returningY, 1));
        expect(tip().y).toBeCloseTo(returningTop + returningY + 0.5, 5);
        viewport.height = 600;
        dispatch(viewport, 'resize', {});
        expect(phase).toBeCloseTo(120 / 300, 5);
        viewport.height = 720;
        dispatch(viewport, 'resize', {});
        expect(picture!.style.top).toBe('0px');
        expect(tip()).toEqual({ x: 500.5, y: returningY + 0.5 });

        touch(video, 'pointerdown', 600, 600);
        touch(video, 'pointerup', 600, 600);
        (document as unknown as { activeElement: unknown }).activeElement = keyboard;
        dispatch(keyboard, 'focus', {});
        viewport.height = 600;
        dispatch(viewport, 'resize', {});
        const shorterOpening = Number.parseFloat(picture!.style.top);
        expect(phase).toBeCloseTo(0.4, 5);
        expect(shorterOpening).toBeCloseTo(-76.5, 5);
        vi.advanceTimersByTime(179);
        expect(phase).toBeCloseTo(0.4, 5);
        vi.advanceTimersByTime(1);
        expect(phase).toBe(1);
        expect(Number.parseFloat(picture!.style.top)).toBeCloseTo(-106.5, 5);
        viewport.height = 640;
        dispatch(viewport, 'resize', {});
        expect(phase).toBeCloseTo(80 / 120, 5);
        vi.advanceTimersByTime(180);
        expect(phase).toBeCloseTo(80 / 120, 5);
        viewport.height = 720;
        dispatch(viewport, 'resize', {});
        viewport.height = 640;
        dispatch(viewport, 'resize', {});
        expect(phase).toBeCloseTo(80 / 120, 5);
        vi.advanceTimersByTime(180);
        expect(phase).toBe(1);
    });
});

describe('the keys a phone keyboard lacks', () => {
    it('sends a shifted digit chord with its physical key and releases it after modifiers lift', async () => {
        const { keyboard } = await liveDesktop();
        dispatch(keyboard, 'keydown', { key: '$', code: 'Digit4', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false });
        dispatch(keyboard, 'keyup', { key: '4', code: 'Digit4', ctrlKey: false, shiftKey: false, metaKey: false, altKey: false });
        expect(sent).toEqual([
            { kind: 'key', character: '4', modifiers: ['Control', 'Shift'], down: true },
            { kind: 'key', character: '4', modifiers: [], down: false },
        ]);
    });

    it('chords the next typed key with a sticky Ctrl, then lets it go', async () => {
        const { session, keyboard, reply, rejected } = await liveDesktop();

        TestRenderer.act(() => session.current.tapModifier('Control'));
        expect(session.current.modifiers).toEqual({ Control: 'once', Shift: 'off' });

        // The phone's keyboard capitalises on its own; Ctrl+V is still Ctrl+V.
        dispatch(keyboard, 'beforeinput', { inputType: 'insertText', data: 'V' });
        expect(sent).toEqual([
            { kind: 'key', character: 'v', modifiers: ['Control'], down: true },
            { kind: 'key', character: 'v', modifiers: ['Control'], down: false },
        ]);
        expect(session.current.modifiers).toEqual({ Control: 'off', Shift: 'off' });

        // Spent: the next character is plain text again.
        sent = [];
        dispatch(keyboard, 'beforeinput', { inputType: 'insertText', data: 'x' });
        expect(sent).toEqual([{ kind: 'text', text: 'x' }]);

        // A keyboard that composes words hands the chord over as it is typed,
        // and the word it later finishes does not type the key a second time.
        sent = [];
        TestRenderer.act(() => session.current.tapModifier('Control'));
        dispatch(keyboard, 'compositionstart', {});
        dispatch(keyboard, 'compositionupdate', { data: 'c' });
        const copy = [
            { kind: 'key', character: 'c', modifiers: ['Control'], down: true },
            { kind: 'key', character: 'c', modifiers: ['Control'], down: false },
        ];
        expect(sent).toEqual(copy);
        dispatch(keyboard, 'compositionend', { data: 'c' });
        expect(sent).toEqual(copy);

        // The engine refusing a character is reported, and the session goes on.
        reply({ kind: 'rejected', seq: 9, code: 'text-unsupported', message: 'the active layout cannot produce' });
        expect(rejected).toEqual(['text-unsupported']);
        expect(session.current.snapshot.failure).toBeNull();
    });

    it('keeps a locked Shift across keys, and releases a held key with the modifiers it went down with', async () => {
        const { session } = await liveDesktop();

        TestRenderer.act(() => session.current.tapModifier('Shift'));
        TestRenderer.act(() => session.current.tapModifier('Shift'));
        expect(session.current.modifiers.Shift).toBe('lock');

        TestRenderer.act(() => session.current.pressKey('ArrowRight')());
        TestRenderer.act(() => session.current.pressKey('ArrowRight')());
        let release = () => undefined as void;
        TestRenderer.act(() => {
            release = session.current.pressKey('ArrowLeft');
        });
        // Unlocking Shift while the arrow is held must not strand Shift down.
        TestRenderer.act(() => session.current.tapModifier('Shift'));
        TestRenderer.act(() => release());

        const shifted = (name: string, down: boolean) => ({ kind: 'key', name, modifiers: ['Shift'], down });
        expect(sent).toEqual([
            shifted('ArrowRight', true), shifted('ArrowRight', false),
            shifted('ArrowRight', true), shifted('ArrowRight', false),
            shifted('ArrowLeft', true), shifted('ArrowLeft', false),
        ]);
        expect(session.current.modifiers.Shift).toBe('off');
    });
});
