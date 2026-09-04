import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveV2Key, newV2SenderState, sealV2, v2EnvelopeSequence } from '@muxr/crypto';
import type { Envelope } from '@muxr/contract';

interface FakeInput extends EventEmitter {
    destroyed: boolean;
    writable: boolean;
    write: ReturnType<typeof vi.fn>;
}

interface FakeChild extends EventEmitter {
    exitCode: number | null;
    stdin: FakeInput;
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
}

interface FakeSocket extends EventEmitter {
    OPEN: number;
    CLOSED: number;
    readyState: number;
    bufferedAmount: number;
    close: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
}

const fakes = vi.hoisted(() => ({
    children: [] as FakeChild[],
    sockets: [] as FakeSocket[],
    failSpawn: false,
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const { EventEmitter: Emitter } = await import('node:events');
    return {
        ...actual,
        spawn: vi.fn(() => {
            const stdin = new Emitter() as FakeInput;
            stdin.destroyed = false;
            stdin.writable = true;
            stdin.write = vi.fn(() => {
                if (stdin.destroyed || !stdin.writable) {
                    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
                    stdin.emit('error', error);
                    return false;
                }
                return true;
            });
            const child = new Emitter() as FakeChild;
            child.exitCode = null;
            child.stdin = stdin;
            child.stdout = new Emitter();
            child.kill = vi.fn(() => true);
            fakes.children.push(child);
            queueMicrotask(() => child.emit(fakes.failSpawn ? 'error' : 'spawn', new Error('spawn herdr ENOENT')));
            return child;
        }),
    };
});

vi.mock('ws', async () => {
    const { EventEmitter: Emitter } = await import('node:events');
    class MockWebSocket extends Emitter implements FakeSocket {
        static readonly OPEN = 1;
        static readonly CLOSED = 3;
        readonly OPEN = MockWebSocket.OPEN;
        readonly CLOSED = MockWebSocket.CLOSED;
        readyState = this.OPEN;
        readonly send = vi.fn();
        bufferedAmount = 0;
        readonly close = vi.fn(() => {
            if (this.readyState === this.CLOSED) return;
            this.readyState = this.CLOSED;
            this.emit('close');
        });

        constructor() {
            super();
            fakes.sockets.push(this);
            queueMicrotask(() => this.emit('open'));
        }
    }
    return { default: MockWebSocket };
});

import { TerminalManager } from './terminalManager.js';
import { HerdrGraphicsBridge, type HerdrGraphicsRegistration } from './herdrGraphicsBridge.js';

describe('TerminalManager stream exit', () => {
    beforeEach(() => {
        fakes.children.length = 0;
        fakes.sockets.length = 0;
        fakes.failSpawn = false;
        vi.restoreAllMocks();
    });

    it('moves same-pane control to the newest device without dropping observers or stealing back', async () => {
        const resolvePane = vi.fn(async () => 'workspace:pane');
        const root = Buffer.alloc(32).toString('base64');
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane,
            hostedE2ee: {
                machineId: 'machine', keyVersion: 2, dataKey: root,
                ingressKeys: { 'device-a': root, 'device-b': root },
            },
        });

        await manager.attach({ sessionId: 'session', channel: 'phone-a', cols: 100, rows: 30, mode: 'control', deviceId: 'device-a', takeover: true });
        await manager.attach({ sessionId: 'session', channel: 'preview', cols: 50, rows: 15, mode: 'observe', deviceId: 'device-a' });
        await expect(manager.attach({
            sessionId: 'session', channel: 'phone-b-auto', cols: 100, rows: 30,
            mode: 'control', deviceId: 'device-b', takeover: false,
        })).rejects.toThrow(/explicit takeover required/);
        expect(fakes.sockets).toHaveLength(2);
        await manager.attach({ sessionId: 'session', channel: 'phone-b', cols: 100, rows: 30, mode: 'control', deviceId: 'device-b', takeover: true });
        expect(resolvePane).toHaveBeenCalledTimes(4);

        const [phoneA, preview, phoneB] = fakes.sockets;
        const [childA, previewChild, childB] = fakes.children;
        expect(phoneA!.send).toHaveBeenCalledOnce();
        expect(phoneA!.close).toHaveBeenCalledOnce();
        expect(childA!.kill).toHaveBeenCalledOnce();
        expect(preview!.close).not.toHaveBeenCalled();
        expect(previewChild!.kill).not.toHaveBeenCalled();
        expect(() => manager.detach('phone-b', 'device-a')).toThrow(/another device/);
        expect(phoneB!.close).not.toHaveBeenCalled();

        phoneA!.emit('message', Buffer.from(JSON.stringify({ type: 'terminal.input', text: 'stale' })));
        const plaintext = JSON.stringify({ type: 'terminal.input', text: 'live' });
        const payload = sealV2(plaintext, deriveV2Key(root, 'client->host'), {
            machineId: 'machine', senderId: 'device-b', recipientId: 'machine', channel: 'terminal',
            streamId: 'phone-b', keyVersion: 2,
        }, newV2SenderState());
        const envelope: Envelope = {
            header: {
                machineId: 'machine', senderId: 'device-b', recipientId: 'machine', channel: 'terminal',
                streamId: 'phone-b', keyVersion: 2, seq: v2EnvelopeSequence(payload), at: Date.now(),
            },
            payload,
        };
        phoneB!.emit('message', Buffer.from(JSON.stringify(envelope)));
        expect(childA!.stdin.write).not.toHaveBeenCalledWith(expect.stringContaining('stale'));
        expect(childB!.stdin.write).toHaveBeenCalledWith(`${plaintext}\n`);
    });

    it('rejects attach when Herdr cannot start instead of leaving the phone reconnecting', async () => {
        const resolvePane = vi.fn(async () => 'workspace:pane');
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane,
        });
        fakes.failSpawn = true;

        await expect(manager.attach({ sessionId: 'session', channel: 'channel', cols: 100, rows: 30 }))
            .rejects.toThrow('could not start Herdr');
        expect(fakes.sockets[0]?.close).toHaveBeenCalledOnce();
    });

    it('preserves graphics placements and deletes through backpressure and closes on bounded overflow', async () => {
        let writeGraphics!: (frame: string) => void;
        const bridge = {
            register: vi.fn((registration: HerdrGraphicsRegistration) => {
                writeGraphics = registration.write;
                return true;
            }),
            unregister: vi.fn(),
            hasRegistrations: () => false,
            close: vi.fn(),
        };
        vi.spyOn(HerdrGraphicsBridge, 'open').mockResolvedValue(bridge as unknown as HerdrGraphicsBridge);
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test', machineId: 'machine', resolvePane: async () => 'workspace:pane',
        });
        await manager.attach({ sessionId: 'session', channel: 'graphics', cols: 100, rows: 30, cellWidthPx: 8, cellHeightPx: 16 });
        await vi.waitFor(() => expect(bridge.register).toHaveBeenCalled());
        const socket = fakes.sockets[0]!;
        const graphic = (bytes: string, graphics = true) => JSON.stringify({
            type: 'terminal.frame', seq: 0, encoding: 'ansi', width: 100, height: 30,
            full: false, graphics, graphicsSurface: 'inline', bytes: Buffer.from(bytes).toString('base64'),
        });
        const frames = [
            graphic('\x1b_Ga=p,i=1,p=1;\x1b\\'),
            graphic('\x1b_Ga=p,i=2,p=2;\x1b\\'),
            graphic('\x1b_Ga=d,d=i,i=1;\x1b\\', false),
            graphic('\x1b_Ga=p,i=3,p=3;\x1b\\'),
        ];
        vi.useFakeTimers();
        try {
            socket.bufferedAmount = 600 * 1024;
            for (const frame of frames) writeGraphics(frame);
            await vi.advanceTimersByTimeAsync(32);
            expect(socket.send).not.toHaveBeenCalled();
            socket.bufferedAmount = 0;
            // A drain can fill the socket again: preserve the remaining queue.
            socket.send.mockImplementationOnce(() => { socket.bufferedAmount = 600 * 1024; });
            await vi.advanceTimersByTimeAsync(16);
            expect(socket.send.mock.calls.map(([frame]) => frame)).toEqual(frames.slice(0, 1));
            socket.bufferedAmount = 0;
            await vi.advanceTimersByTimeAsync(16);
            expect(socket.send.mock.calls.map(([frame]) => frame)).toEqual(frames);

            socket.send.mockClear();
            socket.bufferedAmount = 600 * 1024;
            const large = graphic('x'.repeat(25 * 1024 * 1024));
            writeGraphics(large);
            expect(socket.close).not.toHaveBeenCalled();
            writeGraphics(large);
            expect(socket.close).toHaveBeenCalledOnce();
            expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({
                type: 'terminal.closed', reason: 'terminal graphics backlog exceeded',
            });
            await vi.advanceTimersByTimeAsync(64);
            expect(socket.send).toHaveBeenCalledOnce();
        } finally {
            manager.closeAll();
            vi.useRealTimers();
        }
    });

    it('does not write a late client frame into a cleanly exited stream', async () => {
        const resolvePane = vi.fn(async () => 'workspace:pane');
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane,
        });

        await manager.attach({ sessionId: 'session', channel: 'channel', cols: 100, rows: 30 });
        const child = fakes.children[0];
        const socket = fakes.sockets[0];
        expect(child).toBeDefined();
        expect(socket).toBeDefined();

        child!.exitCode = 0;
        child!.stdin.writable = false;
        child!.stdin.destroyed = true;
        child!.emit('exit', 0);

        expect(socket!.listenerCount('message')).toBe(0);
        expect(() => socket!.emit('message', Buffer.from('{"type":"terminal.resize"}'))).not.toThrow();
        expect(() => child!.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
        expect(child!.stdin.write).not.toHaveBeenCalled();
    });
});
