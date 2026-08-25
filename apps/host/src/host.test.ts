import { beforeEach, describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({
    send: vi.fn(),
    close: vi.fn(),
    options: undefined as { onClientFrame: (...args: never[]) => void; onStateChange: (state: 'connecting' | 'open' | 'closed' | 'replaced') => void } | undefined,
}));

vi.mock('./relayLink.js', () => ({
    connectToRelay: vi.fn((options: typeof relay.options) => {
        relay.options = options;
        return { send: relay.send, close: relay.close };
    }),
}));

import { startHost } from './host.js';
import type { SessionSource } from './sessionSource.js';

describe('host machine plugin invalidation flow', () => {
    beforeEach(() => {
        relay.send.mockClear();
        relay.close.mockClear();
    });

    it('forwards a machine frame through the existing relay link and unsubscribes on close', async () => {
        let machineListener: ((frame: unknown) => void) | undefined;
        const unsubscribe = vi.fn();
        const reconnectFrame = { type: 'plugins.invalidated' as const, reason: 'changed' as const, pluginIds: [] };
        const source = {
            subscribe: () => vi.fn(),
            subscribeMachine: (listener: (frame: unknown) => void) => {
                machineListener = listener;
                return unsubscribe;
            },
            resendCumulativeState: () => machineListener?.(reconnectFrame),
            list: async () => [],
            dispose: async () => undefined,
        } as unknown as SessionSource;
        const host = startHost({
            relayUrl: 'ws://relay.test',
            machineId: 'machine-1',
            source,
            domain: { unread: { noteActivity: vi.fn() } } as never,
        });
        const frame = { type: 'plugins.invalidated' as const, reason: 'changed' as const, pluginIds: ['example.ui'] };
        machineListener?.(frame);
        expect(relay.send).toHaveBeenCalledWith(frame);
        relay.options?.onStateChange('open');
        expect(relay.send).toHaveBeenCalledWith(reconnectFrame);
        expect(() => relay.options?.onClientFrame(null as never)).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await host.close();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(relay.close).toHaveBeenCalledOnce();
    });
});
