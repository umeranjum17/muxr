import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePayload } from '@muxr/contract';
import type { AppStateLike } from '../application/deliverScannedPairing';
import { formatConnectionDiagnosticsForReport, resetConnectionDiagnostics } from '../../catalog/infrastructure/connectionDiagnostics';

vi.mock('react-native', () => ({
    AppState: { currentState: 'active', addEventListener: vi.fn() },
}));
vi.mock('../application/hostedE2ee', () => ({
    refreshHostedGrant: vi.fn(async () => undefined),
    DeviceV2Crypto: class {},
}));

import { MuxrClient } from './muxrClient';

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static current: FakeWebSocket | undefined;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (message: { data: string }) => void;
    onerror?: () => void;
    onclose?: (event: { code: number; reason: string }) => void;

    constructor(_url: string) {
        FakeWebSocket.current = this;
        queueMicrotask(() => {
            this.readyState = FakeWebSocket.OPEN;
            this.onopen?.();
        });
    }

    send(_payload: string): void {}
    close(): void { this.readyState = 0; this.onclose?.({ code: 1000, reason: '' }); }
    failClose(code: number, reason: string): void {
        this.readyState = 3;
        this.onclose?.({ code, reason });
    }
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

describe('scanned pairing delivery', () => {
    it('holds the pairing confirm until the scanner Activity returns the app to the foreground', async () => {
        const { deliverScannedPairingLink } = await import('../application/deliverScannedPairing');
        const handled: string[] = [];
        let dismissReleased: (() => void) | undefined;
        const dismissScanner = vi.fn(() => new Promise<void>((resolve) => { dismissReleased = resolve; }));
        let currentState: AppStateLike['currentState'] = 'inactive';
        const listeners = new Set<(state: AppStateLike['currentState']) => void>();
        const appState: AppStateLike = {
            get currentState() { return currentState; },
            addEventListener(_type, listener) {
                listeners.add(listener);
                return { remove: () => { listeners.delete(listener); } };
            },
        };
        const delivery = deliverScannedPairingLink(
            'ws://10.0.2.2:28793?pair=TESTCODE12',
            (url) => { handled.push(url); },
            { dismissScanner, appState },
        );

        await Promise.resolve();
        expect(handled).toEqual([]);
        dismissReleased?.();
        await Promise.resolve();
        expect(handled).toEqual([]);
        expect(listeners.size).toBe(1);

        currentState = 'active';
        for (const listener of [...listeners]) listener('active');
        await delivery;
        expect(handled).toEqual(['ws://10.0.2.2:28793?pair=TESTCODE12']);
        expect(listeners.size).toBe(0);
    });
});

describe('mobile relay liveness', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        FakeWebSocket.current = undefined;
        vi.useRealTimers();
    });

    it('recovers a silent initial hello, proves host liveness, and replaces closed or half-open routes', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        resetConnectionDiagnostics();
        const client = new MuxrClient({
            mode: 'local',
            relayUrl: 'ws://relay.test',
            machineId: 'machine-1',
            reconnectDelayMs: 10,
            requestTimeoutMs: 25,
        });
        client.connect();
        await Promise.resolve();
        const silent = FakeWebSocket.current!;
        expect(client.isLive()).toBe(false);
        await expect(client.request('herdr.tree', {})).rejects.toThrow('not connected');
        await vi.advanceTimersByTimeAsync(24);
        expect(client.state).toBe('connecting');
        expect(silent.readyState).toBe(FakeWebSocket.OPEN);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.state).toBe('closed');
        expect(silent.readyState).not.toBe(FakeWebSocket.OPEN);
        expect(formatConnectionDiagnosticsForReport()).toMatch(/socket\.fail liveness no-host-frame/);

        await vi.advanceTimersByTimeAsync(10);
        const first = FakeWebSocket.current!;
        expect(first).not.toBe(silent);
        expect(client.isLive()).toBe(false);
        first.onmessage?.({ data: JSON.stringify({
            header: { machineId: 'machine-1', seq: 1, at: Date.now() },
            payload: encodePayload({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['example.ui'] } as never),
        }) });
        await Promise.resolve();
        expect(client.state).toBe('open');
        expect(client.isLive()).toBe(true);
        // A frame already decoding must not revive a socket retired meanwhile.
        first.onmessage?.({ data: JSON.stringify({
            header: { machineId: 'machine-1', seq: 2, at: Date.now() },
            payload: encodePayload({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['example.ui'] } as never),
        }) });
        first.failClose(1012, 'raw relay restart with internal details');
        await Promise.resolve();
        expect(client.state).toBe('closed');
        const report = formatConnectionDiagnosticsForReport();
        expect(report).toMatch(/socket\.fail close socket-closed 1012 service-restart/);
        expect(report).not.toContain('raw relay restart');

        await vi.advanceTimersByTimeAsync(10);
        const second = FakeWebSocket.current!;
        expect(second).not.toBe(first);
        second.onmessage?.({ data: JSON.stringify({
            header: { machineId: 'machine-1', seq: 2, at: Date.now() },
            payload: encodePayload({ type: 'plugins.invalidated', reason: 'changed', pluginIds: ['example.ui'] } as never),
        }) });
        await Promise.resolve();
        expect(client.isLive()).toBe(true);

        const rejection = expect(client.request('herdr.tree', {})).rejects.toThrow(
            'request timed out: herdr.tree (connection reset; try again after muxr reconnects)',
        );
        await vi.advanceTimersByTimeAsync(25);
        await rejection;
        expect(client.state).toBe('closed');
        await vi.advanceTimersByTimeAsync(10);
        expect(FakeWebSocket.current).not.toBe(second);
        expect(client.isLive()).toBe(false);
        client.close();
    });
});

describe('connection diagnostic codes', () => {
    it('maps socket, attach, and agent-not-ready failures without identifiers', async () => {
        const {
            resetConnectionDiagnostics,
            recordSocketReconnect,
            recordTrackedRpc,
            recordTerminalChannel,
            recordAgentGate,
            recordTerminalScrollLatency,
            recordTerminalGraphicsFrame,
            readConnectionDiagnostics,
            formatConnectionDiagnosticsForReport,
            connectionDiagnosticCode,
        } = await import('../../catalog/infrastructure/connectionDiagnostics');
        resetConnectionDiagnostics();
        expect(connectionDiagnosticCode(new Error('not connected'))).toBe('not-connected');
        expect(connectionDiagnosticCode(Object.assign(new Error('Agent is not ready yet'), { code: 'agent-not-ready' }))).toBe('agent-not-ready');
        expect(connectionDiagnosticCode(new Error('terminal: relay did not accept the channel'))).toBe('connection-lost');
        recordSocketReconnect('open', false);
        recordTrackedRpc('terminal.attach', { ok: false, error: new Error('request timed out: terminal.attach') }, 12);
        recordTrackedRpc('session.prompt', {
            ok: false,
            error: Object.assign(new Error('Agent is not ready yet'), { code: 'agent-not-ready' }),
        }, 0);
        recordTrackedRpc('session.start', {
            ok: false,
            error: Object.assign(new Error('Agent could not start.'), { code: 'start-launch-failed' }),
        }, 30373);
        recordTerminalChannel('disconnected', { ok: false, code: 'disconnected' });
        recordAgentGate({ kind: 'omp', lifecycle: 'idle', promptable: false, gate: 'not-interactive' });
        recordAgentGate({ kind: 'w1EW:pH', lifecycle: 'idle', promptable: false, gate: 'missing' });
        expect(readConnectionDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ event: 'socket.reconnect', reason: 'dead-socket' }),
            expect.objectContaining({ event: 'rpc', request: 'terminal.attach', outcome: 'timeout', code: 'request-timeout' }),
            expect.objectContaining({ event: 'rpc', request: 'session.prompt', outcome: 'rejected', code: 'agent-not-ready' }),
            expect.objectContaining({ event: 'rpc', request: 'session.start', outcome: 'rejected', code: 'start-launch-failed' }),
            expect.objectContaining({ event: 'terminal.channel', phase: 'disconnected', outcome: 'unavailable', code: 'disconnected' }),
            expect.objectContaining({ event: 'agent.gate', kind: 'omp', lifecycle: 'idle', promptable: false, gate: 'not-interactive' }),
            expect.objectContaining({ event: 'agent.gate', lifecycle: 'idle', promptable: false, gate: 'missing' }),
        ]));
        expect(readConnectionDiagnostics().some((event) => event.event === 'agent.gate' && 'kind' in event && event.kind === 'w1ew:ph')).toBe(false);
        recordTerminalScrollLatency(42);
        recordTerminalGraphicsFrame(2048);
        const report = formatConnectionDiagnosticsForReport();
        expect(report).toMatch(/socket\.reconnect dead-socket/);
        expect(report).toMatch(/rpc session\.prompt rejected agent-not-ready/);
        expect(report).toMatch(/rpc session\.start rejected start-launch-failed/);
        expect(report).toMatch(/agent\.gate omp idle promptable=false not-interactive/);
        expect(report).toMatch(/graphics frames=1 p95=2048B scroll->frame p95=42ms/);
        expect(report).not.toMatch(/pp_|pwt-|devtok_|machine-|session-|w1EW:pH/);
    });

});
