import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    openStream: vi.fn(),
    refreshStream: vi.fn(async (snapshot: Record<string, unknown>) => snapshot),
    captureStream: vi.fn(async (_capability: string, machineId: string) => ({
        capability: 'voice.session', machineId, relayUrl: 'wss://relay-a', mode: 'hosted', token: 'grant-a',
        pluginId: 'voice-a', manifestHash: 'manifest-a', contributionId: 'session',
    })),
    liveAudio: { init: vi.fn(async () => true), start: vi.fn(async () => true), stop: vi.fn(async () => true), on: vi.fn() },
    vad: { claimVadCapture: vi.fn(() => null as string[] | null) },
    controlRequest: vi.fn(async () => undefined),
    pcm: {
        startRealtimePcm: vi.fn(() => true),
        playRealtimePcm: vi.fn(),
        clearRealtimePcm: vi.fn(),
        stopRealtimePcm: vi.fn(),
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
vi.mock('@/voice/vadStandby', () => mocks.vad);
vi.mock('@/sync/sync', () => ({ sync: { request: mocks.controlRequest } }));

import { startRealtimeSession } from './realtimeSession';

interface FakeStream {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    frames: ((frame: Record<string, unknown>) => void)[];
    closes: ((reason?: string) => void)[];
}

function fakeStream(): FakeStream {
    const stream: FakeStream = {
        send: vi.fn(),
        close: vi.fn(),
        frames: [],
        closes: [],
    };
    return stream;
}

const asPluginStream = (stream: FakeStream) => ({
    send: stream.send,
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
    mocks.vad.claimVadCapture.mockReturnValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('generic realtime stream session', () => {
    it('opens the semantic stream, starts audio on ready, forwards frames, and tears down once', async () => {
        const stream = fakeStream();
        const reconnected = fakeStream();
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
        expect(statuses).toEqual([['connecting', undefined]]);
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledWith('voice.session', {
            sessionId: 's1',
            snapshot: expect.objectContaining({ machineId: 'machine-a', relayUrl: 'wss://relay-a', pluginId: 'voice-a' }),
            requestControl: expect.any(Function),
        }));
        const requestControl = mocks.openStream.mock.calls[0]?.[1].requestControl as (params: Record<string, unknown>) => Promise<unknown>;
        await requestControl({ pluginId: 'voice-a', manifestHash: 'manifest-a', contributionId: 'session', channel: 'rs_voice' });
        expect(mocks.controlRequest).toHaveBeenCalledWith('plugin.stream', {
            pluginId: 'voice-a', manifestHash: 'manifest-a', contributionId: 'session', channel: 'rs_voice',
        });

        handle.speak('agent finished');
        stream.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        await vi.waitFor(() => expect(mocks.liveAudio.start).toHaveBeenCalled());
        expect(mocks.pcm.startRealtimePcm).toHaveBeenCalledWith(24_000);
        expect(statuses.at(-1)).toEqual(['connected', undefined]);
        // speak() before audio was live queues; the ready flush sends it once.
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.say', text: 'agent finished' });

        const mic = mocks.liveAudio.on.mock.calls.find((call) => call[0] === 'data')![1] as (data: string) => void;
        mic('bWlj');
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.audio', data: 'bWlj' });

        handle.setMuted(true);
        mic('bXV0ZWQ=');
        expect(stream.send).not.toHaveBeenCalledWith({ type: 'realtime.audio', data: 'bXV0ZWQ=' });
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.control', action: 'mute' });

        stream.frames.forEach((listener) => listener({ type: 'realtime.audio', data: 'cmVwbHk=' }));
        expect(mocks.pcm.playRealtimePcm).toHaveBeenCalledWith('cmVwbHk=');
        expect(statuses.at(-1)).toEqual(['speaking', undefined]);
        stream.frames.forEach((listener) => listener({ type: 'realtime.transcript', role: 'agent', text: 'done' }));
        expect(turns).toEqual([['agent', 'done']]);

        // A global machine switch cannot change the call's captured host/provider on reconnect.
        mocks.captureStream.mockImplementation(async () => ({
            capability: 'voice.session', machineId: 'machine-b', relayUrl: 'wss://relay-b', mode: 'hosted', token: 'grant-b',
            pluginId: 'voice-b', manifestHash: 'manifest-b', contributionId: 'session',
        }));
        stream.closes.forEach((listener) => listener('stream disconnected'));
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledTimes(2));
        expect(mocks.captureStream).toHaveBeenCalledOnce();
        expect(mocks.openStream.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
            sessionId: 's1',
            snapshot: expect.objectContaining({ machineId: 'machine-a', relayUrl: 'wss://relay-a', pluginId: 'voice-a', token: 'grant-generation-2' }),
        }));
        expect(mocks.refreshStream).toHaveBeenCalledTimes(2);
        reconnected.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        await vi.waitFor(() => expect(statuses.at(-1)).toEqual(['connected', 'Voice stream reconnected']));
        expect(mocks.liveAudio.start).toHaveBeenCalledOnce();

        handle.stop('bye');
        expect(reconnected.send).toHaveBeenCalledWith({ type: 'realtime.control', action: 'stop' });
        expect(reconnected.close).toHaveBeenCalledOnce();
        expect(mocks.liveAudio.stop).toHaveBeenCalled();
        expect(mocks.pcm.stopRealtimePcm).toHaveBeenCalledTimes(2);
        expect(statuses.at(-1)).toEqual(['disconnected', 'bye']);

        // A late provider close after stop must not re-notify.
        reconnected.closes.forEach((listener) => listener('late'));
        await tick();
        expect(mocks.pcm.stopRealtimePcm).toHaveBeenCalledTimes(2);
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
        finishInit();
        await expect(arming).resolves.toBe(false);
        expect(mocks.liveAudio.start).toHaveBeenCalledTimes(startsBeforeCancellation);
    });

    it('hands an armed local VAD recording to realtime without losing its buffered opening', async () => {
        const stream = fakeStream();
        mocks.openStream.mockResolvedValue(asPluginStream(stream));
        mocks.vad.claimVadCapture.mockReturnValue(['cHJlcm9sbA==', 'c3BlZWNo']);
        const handle = startRealtimeSession({ target: { machineId: 'machine-a', sessionId: 's1' }, onStatus: vi.fn(), onTurn: vi.fn() });
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledOnce());
        stream.frames.forEach((listener) => listener({ type: 'realtime.ready', inputRate: 24_000, outputRate: 24_000 }));
        await vi.waitFor(() => expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.audio', data: 'c3BlZWNo' }));
        expect(stream.send).toHaveBeenCalledWith({ type: 'realtime.audio', data: 'cHJlcm9sbA==' });
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
