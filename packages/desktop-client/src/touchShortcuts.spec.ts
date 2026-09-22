import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

import type { Signaling } from './protocol';
import { useDesktopSession, type DesktopSession } from './useDesktopSession';
import { attachSurface } from './native.web';

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
    setAttribute(): void {}
    setPointerCapture(): void {}
    focus(): void {}
    blur(): void {}
    remove(): void {}
    appendChild(): void {}
    getBoundingClientRect() {
        return { left: 0, top: 0, width: 1280, height: 720 };
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

beforeEach(() => {
    created = [];
    sent = [];
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
    it('taps a click, holds for a right click or a drag, and keeps a moving finger for the view', async () => {
        vi.useFakeTimers();
        const { video } = await liveDesktop();

        touch(video, 'pointerdown', 100, 100);
        touch(video, 'pointerup', 100, 100);
        expect(sent).toEqual(click(100, 100, 1));

        // A second tap close by is a double click on the first tap's point.
        sent = [];
        touch(video, 'pointerdown', 104, 102);
        touch(video, 'pointerup', 104, 102);
        expect(sent).toEqual(click(100, 100, 1));

        // A finger that moves at once moves the view, never the desktop's pointer:
        // at the whole-desktop fit there is nowhere to go, and nothing is sent.
        sent = [];
        vi.advanceTimersByTime(1000);
        touch(video, 'pointerdown', 100, 100);
        touch(video, 'pointermove', 140, 100);
        vi.advanceTimersByTime(1000);
        touch(video, 'pointerup', 140, 100);
        expect(sent).toEqual([]);

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
        dispatch(video, 'pointerdown', { pointerId: 3, pointerType: 'mouse', button: 2, clientX: 50, clientY: 60 });
        dispatch(video, 'pointerup', { pointerId: 3, pointerType: 'mouse', button: 2, clientX: 50, clientY: 60 });
        expect(sent).toEqual(click(50, 60, 3));
    });
});

describe('the keys a phone keyboard lacks', () => {
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
