/**
 * Scrolling a terminal pane and having it keep scrolling.
 *
 * Nothing in the fast lane covered this: pinning the in-flight gate shut -- so
 * the pane scrolls once and then ignores the finger -- survived the whole
 * estate. It is the defect that makes the app feel broken rather than slow, so
 * a fling is driven through both ways the gate is meant to reopen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCROLL_LINES, SCROLL_ACK_TIMEOUT_MS, createTerminalScrollGate } from './terminalScrollGate';

function harness() {
    const sent: number[] = [];
    const discarded: number[] = [];
    const rows: number[] = [];
    let timedOut = 0;
    let frames: (() => void)[] = [];
    const gate = createTerminalScrollGate({
        send: (lines) => sent.push(lines),
        onDiscarded: (lines) => discarded.push(lines),
        onSent: (lines) => rows.push(lines),
        onTimedOut: () => { timedOut += 1; },
        scheduleFrame: (run) => frames.push(run),
        cancelFrame: (handle) => { frames = frames.filter((_, index) => index !== handle - 1); },
    });
    return {
        gate,
        sent,
        discarded,
        rows,
        timedOut: () => timedOut,
        framesPending: () => frames.length,
        /** Let the surface paint: whatever a frame was scheduled for runs now. */
        paint: () => {
            const due = frames;
            frames = [];
            for (const run of due) run();
        },
    };
}

describe('terminal scroll flow control', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('sends one jump per fling, holds the rest, and reopens on output or on a lost repaint', () => {
        vi.useFakeTimers();
        const { gate, sent, rows, paint, timedOut } = harness();

        // A fling arrives as many small deltas inside one frame.
        for (let index = 0; index < 12; index += 1) gate.queue(-3);
        paint();
        // One message for the whole frame, not twelve.
        expect(sent).toEqual([-36]);
        expect(rows).toEqual([36]);

        // More travel while that repaint is on the wire. It must not go yet:
        // every queued round trip behind a fling is felt as rubber-band lag.
        for (let index = 0; index < 5; index += 1) gate.queue(-4);
        paint();
        expect(sent).toEqual([-36]);

        // herdr repaints; the held travel goes as one jump, and the pane keeps
        // taking new gestures after it.
        gate.release();
        paint();
        gate.release();
        gate.queue(7);
        paint();
        expect(sent).toEqual([-36, -20, 7]);

        // Now a repaint is lost. The finger keeps moving and nothing goes out...
        gate.release();
        gate.queue(-10);
        paint();
        expect(sent).toEqual([-36, -20, 7, -10]);
        gate.queue(-10);
        paint();
        vi.advanceTimersByTime(SCROLL_ACK_TIMEOUT_MS - 1);
        paint();
        expect(sent).toEqual([-36, -20, 7, -10]);
        expect(timedOut()).toBe(0);

        // ...until the budget expires, when the gate opens anyway and says so.
        // Without this the pane is wedged for the rest of the session.
        vi.advanceTimersByTime(1);
        expect(timedOut()).toBe(1);
        paint();
        expect(sent).toEqual([-36, -20, 7, -10, -10]);
    });

    it('counts the travel it throws away, and drops everything when the pane detaches', () => {
        vi.useFakeTimers();
        const { gate, sent, discarded, paint, framesPending, timedOut } = harness();

        // A runaway accumulator is capped, and the remainder is reported rather
        // than vanishing: a scroll that silently eats a gesture feels arbitrary.
        gate.queue(-(MAX_SCROLL_LINES + 60));
        paint();
        expect(sent).toEqual([-MAX_SCROLL_LINES]);
        expect(discarded).toEqual([60]);

        // A new touch abandons the previous gesture's queued travel; it belongs
        // to the pane the finger just left, not to this one.
        gate.release();
        gate.queue(-25);
        gate.beginGesture();
        paint();
        expect(sent).toEqual([-MAX_SCROLL_LINES]);
        expect(discarded).toEqual([60, 25]);

        // Detaching drops what is in flight: no stray timeout fires into a pane
        // that is gone, and queued travel never lands on whatever attaches next.
        gate.queue(-10);
        paint();
        gate.queue(-10);
        gate.reset();
        expect(framesPending()).toBe(0);
        vi.advanceTimersByTime(SCROLL_ACK_TIMEOUT_MS * 4);
        expect(timedOut()).toBe(0);
        paint();
        expect(sent).toEqual([-MAX_SCROLL_LINES, -10]);

        // A reattached pane starts clean and scrolls immediately.
        gate.queue(-5);
        paint();
        expect(sent).toEqual([-MAX_SCROLL_LINES, -10, -5]);
    });
});
