import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RawData, WebSocket } from 'ws';
import { TerminalChannels } from './terminal.js';

class FakeSocket extends EventEmitter {
    readonly OPEN = 1;
    readonly CONNECTING = 0;
    readonly CLOSED = 3;
    readyState = this.OPEN;
    bufferedAmount = 0;
    paused = false;
    readonly sent: string[] = [];
    readonly pause = vi.fn(() => { this.paused = true; });
    readonly resume = vi.fn(() => { this.paused = false; });
    readonly close = vi.fn(() => {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.CLOSED;
        this.emit('close');
    });
    readonly terminate = vi.fn(() => this.close());

    send(data: RawData | string): void {
        const frame = String(data);
        this.sent.push(frame);
        this.bufferedAmount += Buffer.byteLength(frame);
    }

    asWebSocket(): WebSocket {
        return this as unknown as WebSocket;
    }
}

describe('TerminalChannels reconnect ownership', () => {
    it('preserves a byte-bounded pre-pair burst and both flow-control directions across replacement', async () => {
        vi.useFakeTimers();
        const channels = new TerminalChannels();
        const upstream = new FakeSocket();
        channels.joinMachine('machine:channel', upstream.asWebSocket());

        // More than the former 512-frame limit arrives before the client. The
        // relay pauses by bytes but retains every already-delivered frame.
        const burst = Array.from({ length: 700 }, (_, index) => `${index}:${'x'.repeat(1024)}`);
        for (const frame of burst) upstream.emit('message', Buffer.from(frame));
        expect(upstream.pause).toHaveBeenCalled();

        const stale = new FakeSocket();
        await channels.joinClient('machine:channel', stale.asWebSocket());
        expect(stale.sent).toEqual(burst);
        expect(upstream.paused).toBe(true);
        stale.bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(25);
        expect(upstream.paused).toBe(false);

        // A congested upstream pauses client ingress until its low-water mark.
        upstream.bufferedAmount = 1024 * 1024;
        stale.emit('message', Buffer.from('client-frame'));
        expect(stale.paused).toBe(true);
        upstream.bufferedAmount = 0;
        await vi.advanceTimersByTimeAsync(25);
        expect(stale.paused).toBe(false);

        // Replacement releases both flow controllers before stale close can
        // affect the new owner or leave a source paused.
        stale.bufferedAmount = 1024 * 1024;
        upstream.emit('message', Buffer.from('before-replacement'));
        expect(upstream.paused).toBe(true);
        const latest = new FakeSocket();
        await channels.joinClient('machine:channel', latest.asWebSocket());
        expect(stale.readyState).toBe(stale.CLOSED);
        expect(upstream.paused).toBe(false);
        stale.emit('close');
        expect(upstream.readyState).toBe(upstream.OPEN);

        upstream.emit('message', Buffer.from('fresh-frame'));
        expect(latest.sent).toEqual(['fresh-frame']);
        expect(stale.sent.at(-1)).toBe('before-replacement');
        expect(upstream.listenerCount('message')).toBe(1);
        expect(upstream.listenerCount('close')).toBe(1);
        expect(upstream.listenerCount('error')).toBe(1);

        channels.closeAll();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });
});
