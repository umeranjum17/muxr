import { describe, expect, it, vi } from 'vitest';
import { startHost } from './host.js';
import type { SessionSource } from './agent/index.js';

describe('host machine event flow', () => {
    it('fans product events out through the link endpoint and unsubscribes on close', async () => {
        let machineListener: ((frame: unknown) => void) | undefined;
        const unsubscribe = vi.fn();
        const reconnectFrame = { type: 'plugins.invalidated' as const, reason: 'changed' as const, pluginIds: [] };
        const source = {
            subscribe: () => vi.fn(),
            subscribeMachine: (listener: (frame: unknown) => void) => { machineListener = listener; return unsubscribe; },
            resendCumulativeState: () => machineListener?.(reconnectFrame),
            list: async () => [],
            dispose: async () => undefined,
        } as unknown as SessionSource;
        const host = startHost({ relayUrl: 'ws://relay.test', machineId: 'machine-1', source,
            domain: { unread: { noteActivity: vi.fn() } } as never });
        const delivered = vi.fn();
        host.onBroadcast(delivered);
        const frame = { type: 'plugins.invalidated' as const, reason: 'changed' as const, pluginIds: ['example.ui'] };
        machineListener?.(frame);
        expect(delivered).toHaveBeenCalledWith(frame);
        host.refreshLinkEnrolment();
        expect(delivered).toHaveBeenCalledWith(reconnectFrame);
        await host.close();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});
