import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveV2Key, newV2ReplayTracker, newV2SenderState, openV2, sealV2, v2EnvelopeSequence } from '@muxr/crypto';
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
    stderr: EventEmitter;
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
            child.stderr = new Emitter();
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

describe('TerminalManager stream exit', () => {
    beforeEach(() => {
        fakes.children.length = 0;
        fakes.sockets.length = 0;
        fakes.failSpawn = false;
        vi.restoreAllMocks();
    });

    it('rejects an ended or revoked pending link and seals the surviving attach result', async () => {
        const root = Buffer.alloc(32).toString('base64');
        const pending: Array<(pane: string) => void> = [];
        let authorized = true;
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test', machineId: 'machine',
            resolvePane: () => new Promise((resolve) => pending.push(resolve)),
            focusSession: vi.fn(async () => undefined),
            hostedE2ee: { machineId: 'machine', keyVersion: 2, dataKey: root, ingressKeys: { phone: root } },
        });
        const pipe = () => {
            let open = true;
            let receiveLine: (line: string) => void = () => undefined;
            const sent: string[] = [];
            return {
                get isOpen() { return open; }, sent,
                send: (line: string) => { sent.push(line); },
                receive: (line: string) => receiveLine(line),
                onLine: (listener: (line: string) => void) => { receiveLine = listener; return () => { receiveLine = () => undefined; }; },
                onEnd: () => () => undefined,
                close: () => { open = false; },
            };
        };
        const ended = pipe();
        const first = manager.attach({ sessionId: 'session', channel: 'ended', cols: 80, rows: 24,
            deviceId: 'phone', socket: ended, assertAuthorized: () => undefined });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        ended.close();
        pending.shift()!('pane');
        await expect(first).rejects.toThrow(/stream ended/);
        expect(fakes.children).toHaveLength(0);

        const revoked = pipe();
        const second = manager.attach({ sessionId: 'session', channel: 'revoked', cols: 80, rows: 24,
            deviceId: 'phone', socket: revoked, assertAuthorized: () => { if (!authorized) throw new Error('revoked'); } });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        authorized = false;
        pending.shift()!('pane');
        await expect(second).rejects.toThrow(/revoked/);
        expect(fakes.children).toHaveLength(0);

        authorized = true;
        const live = pipe();
        const third = manager.attach({ sessionId: 'session', channel: 'live', cols: 80, rows: 24,
            deviceId: 'phone', socket: live, assertAuthorized: () => { if (!authorized) throw new Error('revoked'); } });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        pending.shift()!('pane');
        expect(await third).toEqual({ paneId: 'pane' });
        manager.sendResult(live, 'live', { type: 'result', requestId: 'lt-1', ok: true });
        const envelope = JSON.parse(live.sent[0]!) as Envelope;
        expect(openV2(envelope.payload, deriveV2Key(root, 'host->client'), {
            machineId: 'machine', senderId: 'machine', recipientId: '*', channel: 'terminal',
            streamId: 'live', keyVersion: 2,
        }, newV2ReplayTracker())).toBe(JSON.stringify({ type: 'result', requestId: 'lt-1', ok: true }));
        authorized = false;
        live.receive(JSON.stringify({ type: 'terminal.input', text: 'revoked input' }));
        expect(live.isOpen).toBe(false);
        expect(fakes.children[0]!.stdin.write).not.toHaveBeenCalledWith(expect.stringContaining('revoked input'));

        authorized = true;
        const output = pipe();
        const fourth = manager.attach({ sessionId: 'session', channel: 'output', cols: 80, rows: 24,
            deviceId: 'phone', socket: output, assertAuthorized: () => { if (!authorized) throw new Error('revoked'); } });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        pending.shift()!('pane');
        await fourth;
        authorized = false;
        fakes.children[1]!.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'terminal.frame', full: true, bytes: 'eA==' }) + '\n'));
        expect(output.sent).toHaveLength(0);
        expect(output.isOpen).toBe(false);
        manager.closeAll();
    });

    it('moves same-pane control to the newest device without dropping observers or stealing back', async () => {
        const resolvePane = vi.fn(async () => 'workspace:pane');
        const root = Buffer.alloc(32).toString('base64');
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane,
            focusSession: async () => undefined,
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
        await expect(manager.detach('phone-b', 'device-a')).rejects.toThrow(/another device/);
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

    it('serializes detach behind an attach that has not acquired its socket yet', async () => {
        let release!: (paneId: string) => void;
        const resolvePane = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane,
            focusSession: async () => undefined,
        });

        const attaching = manager.attach({ sessionId: 'session', channel: 'channel', cols: 100, rows: 30 });
        await vi.waitFor(() => expect(resolvePane).toHaveBeenCalledOnce());
        const detaching = manager.detach('channel');
        expect(fakes.sockets).toHaveLength(0);
        release('workspace:pane');

        await attaching;
        await detaching;
        expect(fakes.sockets[0]?.close).toHaveBeenCalledOnce();
    });

    it('rejects attach when Herdr cannot start instead of leaving the phone reconnecting', async () => {
        const resolvePane = vi.fn(async () => 'workspace:pane');
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane,
            focusSession: async () => undefined,
        });
        fakes.failSpawn = true;

        await expect(manager.attach({ sessionId: 'session', channel: 'channel', cols: 100, rows: 30 }))
            .rejects.toThrow('could not start Herdr');
        expect(fakes.sockets[0]?.close).toHaveBeenCalledOnce();
    });

    it('reattaches after a handshake transport failure without ending the terminal', async () => {
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane: async () => 'workspace:pane',
            focusSession: async () => undefined,
        });

        await manager.attach({ sessionId: 'session', channel: 'channel', cols: 100, rows: 30 });
        const failed = fakes.children[0]!;
        const firstSocket = fakes.sockets[0]!;
        // Herdr's client lost the server before it ever framed a screen; stderr
        // arrives after 'exit', which is why classification may not run early.
        failed.exitCode = 1;
        failed.emit('exit', 1);
        failed.stderr.emit('data', Buffer.from('herdr: lost connection to server: Resource temporarily unavailable (os error 11)\n'));
        failed.stderr.emit('end');
        await vi.waitFor(() => expect(firstSocket.close).toHaveBeenCalled());
        // The pane is untouched, so the phone must keep its normal reattach path.
        expect(firstSocket.send).not.toHaveBeenCalled();

        await manager.attach({ sessionId: 'session', channel: 'channel', cols: 100, rows: 30 });
        const child = fakes.children[1]!;
        const socket = fakes.sockets[1]!;
        // A closed record must never be mistaken for the initial screen.
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'terminal.closed', reason: 'noise' })}\n`));
        const screen = JSON.stringify({
            type: 'terminal.frame', seq: 1, encoding: 'ansi', width: 100, height: 30,
            full: true, bytes: Buffer.from('\x1b[2Jready').toString('base64'),
        });
        child.stdout.emit('data', Buffer.from(`${screen}\n`));
        expect(socket.send.mock.calls.map(([frame]) => frame)).toEqual([
            JSON.stringify({ type: 'terminal.closed', reason: 'noise' }),
            screen,
        ]);

        socket.emit('message', Buffer.from(JSON.stringify({ type: 'terminal.input', text: 'hi' })));
        expect(child.stdin.write).toHaveBeenCalledWith(`${JSON.stringify({ type: 'terminal.input', text: 'hi' })}\n`);

        // A real termination still ends the terminal for good.
        child.exitCode = 0;
        child.emit('exit', 0);
        child.stderr.emit('end');
        await vi.waitFor(() => expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({ type: 'terminal.closed' }));
        manager.closeAll();
    });

    it('tells the phone where the viewport went after each scroll, not only at the next attach', async () => {
        // Herdr's viewport, as a desk reader or the phone's own scrolls move it.
        let viewport = { offsetFromBottom: 0, maxOffsetFromBottom: 400 };
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane: async () => 'workspace:pane',
            focusSession: async () => undefined,
            readPaneScroll: async () => viewport,
        });
        await manager.attach({ sessionId: 'session', channel: 'channel', cols: 100, rows: 30 });
        const child = fakes.children[0]!;
        const socket = fakes.sockets[0]!;
        const reported = (): unknown[] => socket.send.mock.calls
            .map(([frame]) => JSON.parse(String(frame)) as { type: string })
            .filter((frame) => frame.type === 'terminal.scroll-state');
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'terminal.frame', full: true, bytes: 'c2NyZWVu' })}\n`));
        await vi.waitFor(() => expect(reported()).toEqual([{ type: 'terminal.scroll-state', offsetFromBottom: 0, maxOffsetFromBottom: 400 }]));

        // Scrolled away from the live edge: the Latest control depends on
        // hearing it now, before any further output or re-attach.
        viewport = { offsetFromBottom: 120, maxOffsetFromBottom: 400 };
        socket.emit('message', Buffer.from(JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 120 })));
        await vi.waitFor(() => expect(reported().at(-1)).toEqual({ type: 'terminal.scroll-state', offsetFromBottom: 120, maxOffsetFromBottom: 400 }));

        // And back at the bottom, it hears that too.
        viewport = { offsetFromBottom: 0, maxOffsetFromBottom: 400 };
        socket.emit('message', Buffer.from(JSON.stringify({ type: 'terminal.scroll', direction: 'down', lines: 120 })));
        await vi.waitFor(() => expect(reported().at(-1)).toEqual({ type: 'terminal.scroll-state', offsetFromBottom: 0, maxOffsetFromBottom: 400 }));
        manager.closeAll();
    });

    it('does not write a late client frame into a cleanly exited stream', async () => {
        const resolvePane = vi.fn(async () => 'workspace:pane');
        const manager = new TerminalManager({
            relayUrl: 'ws://relay.test',
            machineId: 'machine',
            resolvePane,
            focusSession: async () => undefined,
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

        // The input listener is retired with the stream: a late client frame
        // must not reach the dead stdin (asserted by the write spy below).
        expect(() => socket!.emit('message', Buffer.from('{"type":"terminal.resize"}'))).not.toThrow();
        expect(() => child!.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
        expect(child!.stdin.write).not.toHaveBeenCalled();
    });
});
