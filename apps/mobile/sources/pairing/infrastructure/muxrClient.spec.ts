import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePayload } from '@muxr/contract';

vi.mock('../application/hostedE2ee', () => ({
    refreshHostedGrant: vi.fn(async () => undefined),
    DeviceV2Crypto: class {},
}));

import { MuxrClient } from './muxrClient';

class FakeWebSocket {
    static OPEN = 1;
    static current: FakeWebSocket | undefined;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (message: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;

    constructor(_url: string) {
        FakeWebSocket.current = this;
        queueMicrotask(() => {
            this.readyState = FakeWebSocket.OPEN;
            this.onopen?.();
        });
    }

    send(_payload: string): void {}
    close(): void { this.readyState = 0; this.onclose?.(); }
}

describe('mobile plugin invalidation dispatch', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        FakeWebSocket.current = undefined;
    });

    it('accepts valid frames and ignores malformed or oversized frames without reconnecting', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = new MuxrClient({ mode: 'local', relayUrl: 'ws://relay.test', machineId: 'machine-1' });
        const received: unknown[] = [];
        client.onPluginsInvalidated((frame) => received.push(frame));
        client.connect();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const socket = FakeWebSocket.current!;
        const deliver = (frame: unknown, seq: number) => socket.onmessage?.({ data: JSON.stringify({ header: { machineId: 'machine-1', seq, at: Date.now() }, payload: encodePayload(frame as never) }) });
        deliver({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['example.ui'] }, 1);
        deliver({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['bad id'] }, 2);
        deliver({ type: 'plugins.invalidated', reason: 'changed', pluginIds: Array.from({ length: 33 }, () => 'example.ui') }, 3);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(received).toEqual([{ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['example.ui'] }]);
        expect(client.state).toBe('open');
        client.close();
    });
});
