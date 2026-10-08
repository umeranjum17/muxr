import { describe, expect, it, vi } from 'vitest';
import { startHost } from './host.js';
import type { SessionSource } from './agent/index.js';
import type { PreviewScreens } from './desktop/index.js';

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

    it("keeps an open browser's presence on Herdr's own session updates until the window closes", async () => {
        vi.useFakeTimers();
        try {
            const session = { id: 'sess-1', paneId: 'pane-1', name: 'agent' };
            let forward: ((id: string, body: unknown) => void) | undefined;
            let windows: ((paneId: string, list: unknown[]) => void) | undefined;
            const source = {
                subscribe: (listener: typeof forward) => { forward = listener; return vi.fn(); },
                list: async () => [session],
                dispose: async () => undefined,
            } as unknown as SessionSource;
            const paneScreens = {
                onWindows: (listener: typeof windows) => { windows = listener; return vi.fn(); },
                screenFor: () => undefined,
                stop: vi.fn(),
            } as unknown as PreviewScreens & { stop(): void };
            const host = startHost({ relayUrl: 'ws://relay.test', machineId: 'machine-1', source, paneScreens,
                domain: { unread: { noteActivity: vi.fn() } } as never });
            const frames: unknown[] = [];
            host.onBroadcast((frame) => frames.push(frame));
            const lastPreview = () => (frames.at(-1) as { event: { session: { preview?: unknown } } }).event.session.preview;

            windows?.('pane-1', [{ class: 'Google-chrome', title: 'Example Domain - Google Chrome', width: 1280, height: 800 }]);
            await vi.advanceTimersByTimeAsync(1500);
            expect(lastPreview()).toMatchObject({ kind: 'browser', title: 'Example Domain' });

            // The agent's next turn: Herdr reports its state, the browser is still open.
            forward?.('sess-1', { type: 'session.updated', session: { ...session, name: 'agent (working)' } });
            expect(lastPreview()).toMatchObject({ kind: 'browser', title: 'Example Domain' });

            windows?.('pane-1', []);
            await vi.advanceTimersByTimeAsync(3000);
            forward?.('sess-1', { type: 'session.updated', session });
            expect(lastPreview()).toBeUndefined();
            await host.close();
        } finally {
            vi.useRealTimers();
        }
    });
});
