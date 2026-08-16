import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    openStream: vi.fn(),
    liveAudio: { init: vi.fn(async () => true), start: vi.fn(async () => true), stop: vi.fn(async () => true), on: vi.fn() },
    pcm: {
        startRealtimePcm: vi.fn(() => true),
        playRealtimePcm: vi.fn(),
        clearRealtimePcm: vi.fn(),
        stopRealtimePcm: vi.fn(),
        routeVoiceAudio: vi.fn(),
    },
}));

vi.mock('@/plugins/openPluginStream', () => ({ openPluginStream: mocks.openStream }));
vi.mock('react-native-live-audio-stream', () => ({ default: mocks.liveAudio }));
vi.mock('@/../modules/voice-overlay', () => mocks.pcm);

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

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('generic realtime stream session', () => {
    it('opens the semantic stream, starts audio on ready, forwards frames, and tears down once', async () => {
        const stream = fakeStream();
        const reconnected = fakeStream();
        mocks.openStream
            .mockResolvedValueOnce(asPluginStream(stream))
            .mockResolvedValueOnce(asPluginStream(reconnected));
        const statuses: Array<[string, string | undefined]> = [];
        const turns: Array<[string, string]> = [];
        const handle = startRealtimeSession({
            sessionId: 's1',
            onStatus: (status, detail) => { statuses.push([status, detail]); },
            onTurn: (role, text) => { turns.push([role, text]); },
        });
        expect(statuses).toEqual([['connecting', undefined]]);
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledWith('voice.session', { sessionId: 's1' }));

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

        // A transient mid-reply transport close reconnects without reopening the microphone.
        stream.closes.forEach((listener) => listener('stream disconnected'));
        await vi.waitFor(() => expect(mocks.openStream).toHaveBeenCalledTimes(2));
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

    it('does not reconnect an intentional provider hang-up', async () => {
        const stream = fakeStream();
        mocks.openStream.mockResolvedValue(asPluginStream(stream));
        const statuses: Array<[string, string | undefined]> = [];
        startRealtimeSession({ sessionId: 's1', onStatus: (s, d) => { statuses.push([s, d]); }, onTurn: vi.fn() });
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
        startRealtimeSession({ sessionId: 's1', onStatus: (s, d) => { statuses.push([s, d]); }, onTurn: vi.fn() });
        await vi.waitFor(() => expect(statuses.at(-1)?.[0]).toBe('disconnected'));
        expect(statuses.at(-1)?.[1]).toContain('unavailable');
        expect(mocks.liveAudio.start).not.toHaveBeenCalled();
    });
});
