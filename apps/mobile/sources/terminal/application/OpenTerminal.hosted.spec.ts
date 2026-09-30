import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openTerminalLink: vi.fn(), request: vi.fn(async () => null) }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ mode: 'hosted', machineId: 'machine' }) }));
vi.mock('@/pairing/e2ee', () => ({ getCachedHostedGrant: () => ({ expiresAt: Date.now() + 60_000 }) }));
vi.mock('@/catalog/sync', () => ({ sync: mocks }));
vi.mock('@/catalog/store', async () => {
    const { create } = await import('zustand');
    return { storage: create<{ socketStatus: string }>()(() => ({ socketStatus: 'connected' })) };
});

import { openTerminal, type TerminalBottomState } from './OpenTerminal';

/** The phone-side pane really uses only link streams across attach, input and reconnect. */
describe('terminal link cutover', () => {
    it('paints, writes and reattaches after a dropped stream without opening a relay socket', { timeout: 10_000 }, async () => {
        const socket = vi.fn(() => { throw new Error('old relay socket opened'); });
        vi.stubGlobal('WebSocket', socket);
        const streams: Array<{ line: (value: string) => void; end: () => void; write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
        mocks.openTerminalLink.mockImplementation((args: { requestId: string }) => {
            let line!: (value: string) => void;
            let end!: () => void;
            const transport = {
                write: vi.fn(async (_value: string) => undefined),
                close: vi.fn(),
                onLine: (listener: (value: string) => void) => { line = listener; return () => undefined; },
                onEnd: (listener: () => void) => { end = listener; return () => undefined; },
            };
            streams.push({ line: (value) => line(value), end: () => end(), write: transport.write, close: transport.close });
            setTimeout(() => {
                line(JSON.stringify({ type: 'result', requestId: args.requestId, ok: true, data: { paneId: 'pane' } }));
                line(JSON.stringify({ type: 'terminal.frame', bytes: 'aGk=' }));
            }, 0);
            return Promise.resolve(transport);
        });
        const channel = await openTerminal({ agentRoute: 'session', size: { cols: 80, rows: 24 } });
        const painted: string[] = [];
        channel.onData((bytes) => painted.push(bytes));
        await vi.waitFor(() => expect(painted).toEqual(['aGk=']));
        channel.sendText('hello');
        await vi.waitFor(() => expect(streams[0]!.write).toHaveBeenCalledWith(JSON.stringify({ type: 'terminal.input', text: 'hello' })));
        channel.scroll(30, { column: 10, row: 6 });
        expect(streams[0]!.write).toHaveBeenCalledWith(JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 30, column: 10, row: 6 }));
        const statuses: TerminalBottomState[] = [];
        channel.onBottomState((status) => statuses.push(status));
        const requestBottom = () => {
            channel.bottom();
            const sent = streams[0]!.write.mock.calls.map(([line]) => JSON.parse(line as string) as { type: string; requestId?: string });
            return sent.filter((frame) => frame.type === 'terminal.bottom').at(-1)!.requestId!;
        };
        const reply = (requestId: string, state: 'complete' | 'catching-up') => {
            streams[0]!.line(JSON.stringify({ type: 'terminal.bottom-state', requestId, state }));
        };
        const firstBottom = requestBottom();
        expect(statuses.at(-1)).toBe('catching-up');
        channel.sendText('interrupt');
        expect(statuses.at(-1)).toBe('cancelled');
        reply(firstBottom, 'catching-up');
        reply(firstBottom, 'complete');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(statuses).toEqual(['catching-up', 'cancelled']);
        const secondBottom = requestBottom();
        reply(firstBottom, 'complete');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(statuses.at(-1)).toBe('catching-up');
        channel.resize(40, 12);
        expect(statuses.at(-1)).toBe('cancelled');
        reply(secondBottom, 'catching-up');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(statuses.at(-1)).toBe('cancelled');
        const timeoutBottom = requestBottom();
        reply(timeoutBottom, 'catching-up');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(statuses.slice(-2)).toEqual(['catching-up', 'catching-up']);
        channel.repaint();
        expect(statuses.at(-1)).toBe('cancelled');
        reply(timeoutBottom, 'catching-up');
        await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 4000 });
        expect(statuses.at(-1)).toBe('cancelled');
        await vi.waitFor(() => expect(painted).toEqual(['aGk=', 'aGk=']));
        streams[1]!.end();
        await vi.waitFor(() => expect(streams).toHaveLength(3), { timeout: 4000 });
        await vi.waitFor(() => expect(painted).toEqual(['aGk=', 'aGk=', 'aGk=']));
        expect(socket).not.toHaveBeenCalled();
        channel.close();
        vi.unstubAllGlobals();
    });
});
