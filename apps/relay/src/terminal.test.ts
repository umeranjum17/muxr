import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RawData, WebSocket } from 'ws';
import { TerminalChannels } from './terminal.js';

class FakeSocket extends EventEmitter {
    readonly OPEN = 1;
    readonly CLOSED = 3;
    readyState = this.OPEN;
    readonly sent: string[] = [];
    readonly close = vi.fn(() => {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.CLOSED;
        this.emit('close');
    });
    readonly terminate = vi.fn(() => this.close());

    send(data: RawData | string): void {
        this.sent.push(String(data));
    }

    asWebSocket(): WebSocket {
        return this as unknown as WebSocket;
    }
}

describe('TerminalChannels reconnect ownership', () => {
    it('keeps one client binding under reconnect load and ignores stale cleanup', async () => {
        const channels = new TerminalChannels();
        const upstream = new FakeSocket();
        channels.joinMachine('machine:channel', upstream.asWebSocket());

        const clients: FakeSocket[] = [];
        for (let attempt = 0; attempt < 16; attempt += 1) {
            const client = new FakeSocket();
            clients.push(client);
            await channels.joinClient('machine:channel', client.asWebSocket());
        }

        const latest = clients.at(-1);
        const stale = clients.at(-2);
        expect(latest).toBeDefined();
        expect(stale).toBeDefined();
        expect(clients.slice(0, -1).every((client) => client.readyState === client.CLOSED)).toBe(true);
        // One listener buffers pre-client frames; one forwards to the sole owner.
        expect(upstream.listenerCount('message')).toBe(2);
        expect(upstream.listenerCount('close')).toBe(3);
        expect(upstream.listenerCount('error')).toBe(1);

        stale?.emit('close');
        expect(upstream.readyState).toBe(upstream.OPEN);

        upstream.emit('message', Buffer.from('fresh-frame'));
        expect(latest?.sent).toEqual(['fresh-frame']);
        expect(stale?.sent).toEqual([]);
    });
});
