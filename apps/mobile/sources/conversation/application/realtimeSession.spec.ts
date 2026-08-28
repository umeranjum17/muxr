import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    openStream: vi.fn(),
    refreshStream: vi.fn(async (snapshot: Record<string, unknown>) => snapshot),
    captureStream: vi.fn(async (_capability: string, machineId: string) => ({
        capability: 'voice.session', machineId, relayUrl: 'wss://relay-a', mode: 'hosted', token: 'grant-a',
        pluginId: 'voice-a', manifestHash: 'manifest-a', contributionId: 'session',
    })),
    liveAudio: { init: vi.fn(async () => true), start: vi.fn(async () => true), stop: vi.fn(async () => true), on: vi.fn() },
    vad: {
        acquireRealtimeCapture: vi.fn((_rate: number, _onData: (data: string) => void) => ({
            pending: [] as string[], ready: Promise.resolve(), release: vi.fn(),
        })),
    },
    controlRequest: vi.fn(async () => undefined),
    pcm: {
        startRealtimePcm: vi.fn(() => true),
        playRealtimePcm: vi.fn((_data: string) => true),
        finishRealtimePcm: vi.fn(() => true),
        isRealtimePcmDrained: vi.fn(() => true),
        clearRealtimePcm: vi.fn(),
        stopRealtimePcm: vi.fn(() => ({ underruns: 0, peakQueuedMs: 0 })),
        routeVoiceAudio: vi.fn(() => true),
        releaseVoiceAudio: vi.fn(),
        startVoiceService: vi.fn(() => true),
        stopVoiceService: vi.fn(),
    },
}));

vi.mock('react-native', () => ({ AppState: { addEventListener: vi.fn() } }));
vi.mock('@/plugins/openPluginStream', () => ({
    capturePluginStreamSnapshot: mocks.captureStream,
    openPluginStream: mocks.openStream,
    refreshPluginStreamSnapshot: mocks.refreshStream,
}));
vi.mock('react-native-live-audio-stream', () => ({ default: mocks.liveAudio }));
vi.mock('@/../modules/voice-overlay', () => mocks.pcm);
vi.mock('./vadStandby', () => mocks.vad);
vi.mock('@/catalog/sync', () => ({ sync: { request: mocks.controlRequest } }));

import { startRealtimeSession } from './realtimeSession';

interface FakeStream {
    send: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    frames: ((frame: Record<string, unknown>) => void)[];
    closes: ((reason?: string) => void)[];
}

function fakeStream(): FakeStream {
    const stream: FakeStream = {
        send: vi.fn(() => true),
        start: vi.fn(),
        close: vi.fn(),
        frames: [],
        closes: [],
    };
    return stream;
}

const asPluginStream = (stream: FakeStream) => ({
    send: stream.send,
    start: stream.start,
    close: stream.close,
    onFrame: (listener: (frame: Record<string, unknown>) => void) => {
        stream.frames.push(listener);
        return () => undefined;
    },
    onClose: (listener: (reason?: string) => void) => {
        stream.closes.push(listener);
        return () => undefined;
    },
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureStream.mockImplementation(async (_capability: string, machineId: string) => ({
        capability: 'voice.session', machineId, relayUrl: 'wss://relay-a', mode: 'hosted', token: 'grant-a',
        pluginId: 'voice-a', manifestHash: 'manifest-a', contributionId: 'session',
    }));
    mocks.refreshStream.mockImplementation(async (snapshot) => snapshot);
    mocks.pcm.playRealtimePcm.mockReturnValue(true);
    mocks.pcm.finishRealtimePcm.mockReturnValue(true);
    mocks.pcm.isRealtimePcmDrained.mockReturnValue(true);
    mocks.pcm.routeVoiceAudio.mockReturnValue(true);
    mocks.pcm.startRealtimePcm.mockReturnValue(true);
    mocks.vad.acquireRealtimeCapture.mockImplementation((_rate, onData) => ({
        pending: [],
        ready: (async () => {
            await mocks.liveAudio.init();
            mocks.liveAudio.on('data', onData);
            await mocks.liveAudio.start();
        })(),
        release: vi.fn(() => { void mocks.liveAudio.stop(); }),
    }));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('generic realtime stream session', () => {
    it('opens the semantic stream, starts audio on ready, forwards frames, and tears down once', async () => {
        const stream = fakeStream();
        const reconnected = fakeStream();
        stream.start.mockImplementation(() => {
            stream.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        });
        let grantGeneration = 0;
        mocks.refreshStream.mockImplementation(async (snapshot) => ({ ...snapshot, token: `grant-generation-${++grantGeneration}` }));
        mocks.openStream
            .mockResolvedValueOnce(asPluginStream(stream))
            .mockResolvedValueOnce(asPluginStream(reconnected));
        const statuses: Array<[string, string | undefined]> = [];
        const turns: Array<[string, string]> = [];
        const handle = startRealtimeSession({
            target: { machineId: 'machine-a', sessionId: 's1' },
            onStatus: (status, detail) => { statuses.push([status, detail]); },
            onTurn: (role, text) => { turns.push([role, text]); },
        });
        handle.speak('agent finished');
        expect(statuses).toEqual([['connecting', undefined]]);
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledWith('voice.session', {
            sessionId: 's1',
            snapshot: expect.objectContaining({ machineId: 'machine-a', relayUrl: 'wss://relay-a', pluginId: 'voice-a' }),
            requestControl: expect.any(Function),
        }));
        expect(stream.start).toHaveBeenCalledOnce();
        expect(stream.frames).toHaveLength(1);
        expect(stream.closes).toHaveLength(1);
        const requestControl = mocks.openStream.mock.calls[0]?.[1].requestControl as (params: Record<string, unknown>) => Promise<unknown>;
        await requestControl({ pluginId: 'voice-a', manifestHash: 'manifest-a', contributionId: 'session', channel: 'rs_voice' });
        expect(mocks.controlRequest).toHaveBeenCalledWith('plugin.stream', {
            pluginId: 'voice-a', manifestHash: 'manifest-a', contributionId: 'session', channel: 'rs_voice',
        });

        await vi.waitFor(() => expect(mocks.liveAudio.start).toHaveBeenCalled());
        expect(mocks.liveAudio.init).toHaveBeenCalledOnce();
        expect(mocks.pcm.startRealtimePcm).toHaveBeenCalledWith(24_000);
        expect(statuses.at(-1)).toEqual(['connected', undefined]);
        // speak() before audio was live queues; the ready flush sends it once.
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.say', text: 'agent finished' });

        const mic = mocks.liveAudio.on.mock.calls.find((call) => call[0] === 'data')![1] as (data: string) => void;
        mic('bWljIQ==');
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.audio', data: 'bWljIQ==' });
        stream.send.mockImplementationOnce(() => false);
        mic('b25lIQ==');
        mic('dHdvIQ==');
        expect(stream.send.mock.calls.filter(([frame]) => frame.type === 'realtime.audio').slice(-3).map(([frame]) => frame.data))
            .toEqual(['b25lIQ==', 'b25lIQ==', 'dHdvIQ==']);

        handle.setMuted(true);
        mic('bXV0ZWQh');
        expect(stream.send).not.toHaveBeenCalledWith({ type: 'realtime.audio', data: 'bXV0ZWQh' });
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.control', action: 'mute' });

        mocks.pcm.playRealtimePcm.mockImplementationOnce(() => false);
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data: 'b25lIQ==' }));
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data: 'dHdvIQ==' }));
        expect(mocks.pcm.playRealtimePcm.mock.calls.slice(-3).map(([data]) => data)).toEqual(['b25lIQ==', 'b25lIQ==', 'dHdvIQ==']);
        expect(statuses.at(-1)).toEqual(['speaking', undefined]);
        stream.frames.forEach((listener) => listener({ type: 'realtime.state', state: 'connected' }));
        expect(mocks.pcm.finishRealtimePcm).toHaveBeenCalledOnce();
        const clearsBeforeReconnectReady = mocks.pcm.clearRealtimePcm.mock.calls.length;
        stream.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        await tick();
        expect(mocks.pcm.clearRealtimePcm).toHaveBeenCalledTimes(clearsBeforeReconnectReady);
        expect(mocks.liveAudio.init).toHaveBeenCalledOnce();
        stream.frames.forEach((listener) => listener({ type: 'realtime.transcript', role: 'agent', text: 'done' }));
        expect(turns).toEqual([['agent', 'done']]);

        mocks.pcm.playRealtimePcm.mockImplementationOnce(() => false);
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data: 'c3RhbGUh' }));
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio.clear' }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(mocks.pcm.playRealtimePcm.mock.calls.filter(([data]) => data === 'c3RhbGUh')).toHaveLength(1);

        const burst = Array.from({ length: 4 }, (_, index) => Buffer.alloc(20_000, index + 1).toString('base64'));
        const pausesBefore = stream.send.mock.calls.filter(([frame]) => frame.action === 'pause_output').length;
        const resumesBefore = stream.send.mock.calls.filter(([frame]) => frame.action === 'resume_output').length;
        mocks.pcm.playRealtimePcm.mockReturnValue(false);
        for (const data of burst) stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data }));
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'pause_output')).toHaveLength(pausesBefore + 1);
        const admitted: string[] = [];
        let admissionsBeforeNextRejection = 2;
        mocks.pcm.playRealtimePcm.mockImplementation((data) => {
            if (admissionsBeforeNextRejection-- <= 0) return false;
            admitted.push(data);
            return true;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(admitted).toEqual(burst.slice(0, 2));
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'resume_output')).toHaveLength(resumesBefore);
        mocks.pcm.playRealtimePcm.mockImplementation((data) => { admitted.push(data); return true; });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'resume_output')).toHaveLength(resumesBefore + 1);
        expect(admitted).toEqual(burst);

        mocks.pcm.isRealtimePcmDrained.mockReturnValue(false);
        const connectedBeforeDrain = statuses.filter(([status]) => status === 'connected').length;
        stream.frames.forEach((listener) => listener({ type: 'realtime.state', state: 'connected', detail: 'first boundary' }));
        stream.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        await tick();
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeDrain);
        const afterFinish = Buffer.alloc(4, 9).toString('base64');
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data: afterFinish }));
        expect(mocks.pcm.playRealtimePcm).not.toHaveBeenCalledWith(afterFinish);
        const drainAcksBefore = stream.send.mock.calls.filter(([frame]) => frame.action === 'output_drained').length;
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(drainAcksBefore);
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeDrain);
        mocks.pcm.isRealtimePcmDrained.mockReturnValue(true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(drainAcksBefore + 1);
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeDrain);
        expect(mocks.pcm.playRealtimePcm).toHaveBeenCalledWith(afterFinish);
        mocks.pcm.isRealtimePcmDrained.mockReturnValue(false);
        stream.frames.forEach((listener) => listener({ type: 'realtime.state', state: 'connected', detail: 'newest boundary' }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeDrain);
        mocks.pcm.isRealtimePcmDrained.mockReturnValue(true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(drainAcksBefore + 2);
        expect(statuses.filter(([status]) => status === 'connected').slice(connectedBeforeDrain)).toEqual([
            ['connected', 'first boundary'],
            ['connected', undefined],
            ['connected', 'newest boundary'],
        ]);

        mocks.pcm.isRealtimePcmDrained.mockReturnValue(false);
        const connectedBeforeClear = statuses.filter(([status]) => status === 'connected').length;
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data: Buffer.alloc(4, 7).toString('base64') }));
        stream.frames.forEach((listener) => listener({ type: 'realtime.state', state: 'connected', detail: 'cleared boundary' }));
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio.clear' }));
        mocks.pcm.isRealtimePcmDrained.mockReturnValue(true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(drainAcksBefore + 2);
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeClear);

        // A global machine switch cannot change the call's captured host/provider on reconnect.
        mocks.captureStream.mockImplementation(async () => ({
            capability: 'voice.session', machineId: 'machine-b', relayUrl: 'wss://relay-b', mode: 'hosted', token: 'grant-b',
            pluginId: 'voice-b', manifestHash: 'manifest-b', contributionId: 'session',
        }));
        mocks.pcm.playRealtimePcm.mockImplementationOnce(() => false);
        mocks.pcm.isRealtimePcmDrained.mockReturnValue(false);
        stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data: 'dGFpbA==' }));
        const clearsBeforeTransportClose = mocks.pcm.clearRealtimePcm.mock.calls.length;
        const finishesBeforeTransportClose = mocks.pcm.finishRealtimePcm.mock.calls.length;
        const connectedBeforeTransportReady = statuses.filter(([status]) => status === 'connected').length;
        stream.closes.forEach((listener) => listener('stream disconnected'));
        handle.speak('first after reconnect');
        handle.speak('second after reconnect');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(mocks.pcm.clearRealtimePcm).toHaveBeenCalledTimes(clearsBeforeTransportClose);
        expect(mocks.pcm.playRealtimePcm.mock.calls.filter(([data]) => data === 'dGFpbA==')).toHaveLength(2);
        expect(mocks.pcm.finishRealtimePcm).toHaveBeenCalledTimes(finishesBeforeTransportClose + 1);
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledTimes(2));
        expect(mocks.captureStream).toHaveBeenCalledOnce();
        expect(mocks.openStream.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            sessionId: 's1',
            snapshot: expect.objectContaining({ machineId: 'machine-a', relayUrl: 'wss://relay-a', pluginId: 'voice-a', token: 'grant-generation-2' }),
        }));
        expect(mocks.refreshStream).toHaveBeenCalledTimes(2);
        reconnected.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        reconnected.frames.forEach((listener) => listener({ type: 'realtime.state', state: 'connected' }));
        await tick();
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeTransportReady);
        expect(reconnected.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(0);
        expect(reconnected.send.mock.calls.filter(([frame]) => frame.type === 'realtime.say')).toHaveLength(0);
        expect(mocks.pcm.finishRealtimePcm).toHaveBeenCalledTimes(finishesBeforeTransportClose + 1);
        mocks.pcm.isRealtimePcmDrained.mockReturnValue(true);
        await vi.waitFor(() => expect(reconnected.send.mock.calls.filter(([frame]) => frame.type === 'realtime.say').map(([frame]) => frame.text)).toEqual([
            'first after reconnect',
            'second after reconnect',
        ]));
        expect(reconnected.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(0);
        expect(stream.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(drainAcksBefore + 2);
        expect(stream.send).not.toHaveBeenCalledWith({ type: 'realtime.say', text: 'first after reconnect' });
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeTransportReady);

        mocks.pcm.isRealtimePcmDrained.mockReturnValue(false);
        reconnected.frames.forEach((listener) => listener({ type: 'realtime.audio', data: Buffer.alloc(4, 8).toString('base64') }));
        reconnected.frames.forEach((listener) => listener({ type: 'realtime.state', state: 'connected', detail: 'queued say drained' }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(statuses.filter(([status]) => status === 'connected')).toHaveLength(connectedBeforeTransportReady);
        mocks.pcm.isRealtimePcmDrained.mockReturnValue(true);
        await vi.waitFor(() => expect(reconnected.send.mock.calls.filter(([frame]) => frame.action === 'output_drained')).toHaveLength(1));
        expect(statuses.filter(([status]) => status === 'connected').slice(connectedBeforeTransportReady)).toEqual([
            ['connected', 'queued say drained'],
        ]);
        expect(mocks.liveAudio.start).toHaveBeenCalledOnce();

        handle.stop('bye');
        expect(reconnected.send).toHaveBeenCalledWith({ type: 'realtime.control', action: 'stop' });
        expect(reconnected.close).toHaveBeenCalledOnce();
        expect(mocks.liveAudio.stop).toHaveBeenCalled();
        expect(mocks.pcm.stopRealtimePcm).toHaveBeenCalledOnce();
        expect(statuses.at(-1)).toEqual(['disconnected', 'bye']);
        expect(console.info).toHaveBeenCalledOnce();
        const statsLine = (console.info as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
        expect(statsLine).toMatch(/^realtime_voice_stats(?: [a-z_]+=[0-9]+)+$/);
        expect(statsLine).toContain('provider_reconnects=2');

        // A late provider close after stop must not re-notify.
        reconnected.closes.forEach((listener) => listener('late'));
        await tick();
        expect(mocks.pcm.stopRealtimePcm).toHaveBeenCalledOnce();
    });

    it('arms locally after two speech-energy chunks and keeps silence off the provider path', async () => {
        const vad = await vi.importActual<typeof import('./vadStandby')>('./vadStandby');
        const wake = vi.fn();
        await expect(vad.startVadStandby(wake, vi.fn())).resolves.toBe(true);
        const inspect = mocks.liveAudio.on.mock.calls.at(-1)![1] as (data: string) => void;
        inspect(Buffer.alloc(4_800).toString('base64'));
        expect(wake).not.toHaveBeenCalled();
        const speech = Buffer.alloc(4_800);
        for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(7_000, offset);
        inspect(speech.toString('base64'));
        expect(wake).not.toHaveBeenCalled();
        inspect(speech.toString('base64'));
        expect(wake).toHaveBeenCalledOnce();
        vad.stopVadStandby();

        let finishInit!: () => void;
        mocks.liveAudio.init.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            finishInit = () => resolve(true);
        }));
        const startsBeforeCancellation = mocks.liveAudio.start.mock.calls.length;
        const arming = vad.startVadStandby(vi.fn(), vi.fn());
        await vi.waitFor(() => expect(finishInit).toBeTypeOf('function'));
        vad.cancelVadStandbyStart();
        const newerArming = vad.startVadStandby(vi.fn(), vi.fn());
        finishInit();
        await expect(arming).resolves.toBe(false);
        await expect(newerArming).resolves.toBe(true);
        expect(mocks.liveAudio.start).toHaveBeenCalledTimes(startsBeforeCancellation + 1);
        const stopsAfterNewOwnerStarted = mocks.liveAudio.stop.mock.calls.length;
        await tick();
        expect(mocks.liveAudio.stop).toHaveBeenCalledTimes(stopsAfterNewOwnerStarted);
        vad.stopVadStandby();
    });

    it('hands an armed local VAD recording to realtime without losing its buffered opening', async () => {
        const stream = fakeStream();
        mocks.openStream.mockResolvedValue(asPluginStream(stream));
        mocks.vad.acquireRealtimeCapture.mockReturnValue({
            pending: ['cHJlcm9sbCE=', 'c3BlZWNo'], ready: Promise.resolve(), release: vi.fn(),
        });
        const handle = startRealtimeSession({ target: { machineId: 'machine-a', sessionId: 's1' }, onStatus: vi.fn(), onTurn: vi.fn() });
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledOnce());
        stream.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        await vi.waitFor(() => expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.audio', data: 'c3BlZWNo' }));
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.audio', data: 'cHJlcm9sbCE=' });
        expect(mocks.liveAudio.init).not.toHaveBeenCalled();
        expect(mocks.liveAudio.start).not.toHaveBeenCalled();
        handle.stop();
    });

    it('does not reconnect an intentional provider hang-up', async () => {
        const stream = fakeStream();
        mocks.openStream.mockResolvedValue(asPluginStream(stream));
        const statuses: Array<[string, string | undefined]> = [];
        startRealtimeSession({ target: { machineId: 'machine-a', sessionId: 's1' }, onStatus: (s, d) => { statuses.push([s, d]); }, onTurn: vi.fn() });
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledOnce());
        stream.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        await vi.waitFor(() => expect(mocks.liveAudio.start).toHaveBeenCalled());
        stream.closes.forEach((listener) => listener('ended'));
        await tick();
        expect(mocks.openStream).toHaveBeenCalledOnce();
        expect(statuses.at(-1)).toEqual(['disconnected', 'ended']);
    });

    it('fails cleanly when the stream cannot open', async () => {
        mocks.openStream.mockRejectedValue(new Error('voice.session plugin is unavailable or not approved'));
        const statuses: Array<[string, string | undefined]> = [];
        startRealtimeSession({ target: { machineId: 'machine-a', sessionId: 's1' }, onStatus: (s, d) => { statuses.push([s, d]); }, onTurn: vi.fn() });
        await vi.waitFor(() => expect(statuses.at(-1)?.[0]).toBe('disconnected'));
        expect(statuses.at(-1)?.[1]).toContain('unavailable');
        expect(mocks.liveAudio.start).not.toHaveBeenCalled();
    });
});
