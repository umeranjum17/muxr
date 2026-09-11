import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRealtimeRecorder, encodePcm16Chunk } from './realtimeCapture.web';

/**
 * Web capture adapter through the real module with hardware fakes standing
 * in at the boundary only: exact PCM16 framing, full start/stop lifecycle
 * with nothing leaked, and permission denial that fails clean.
 */
function fakeAudioStack() {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    const getUserMedia = vi.fn(async () => stream);
    const processor = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onaudioprocess: null as null | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const gain = { gain: { value: 1 }, connect: vi.fn() };
    const context = {
        sampleRate: 24000,
        state: 'running',
        destination: {},
        resume: vi.fn(async () => undefined),
        createMediaStreamSource: vi.fn(() => source),
        createScriptProcessor: vi.fn(() => processor),
        createGain: vi.fn(() => gain),
        close: vi.fn(async () => undefined),
    };
    const AudioContext = vi.fn(() => context);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, userAgent: 'test' });
    vi.stubGlobal('AudioContext', AudioContext);
    return { track, getUserMedia, processor, context, AudioContext };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('web realtime capture', () => {
    it('frames exact PCM16 mono, releases everything on stop, and fails clean on denial', async () => {
        const hardware = fakeAudioStack();
        const recorder = openRealtimeRecorder();
        const frames: string[] = [];
        const release = recorder.onData((frame) => { frames.push(frame); });
        await recorder.init(24000);
        await recorder.start();
        expect(hardware.getUserMedia).toHaveBeenCalledOnce();
        expect(hardware.AudioContext).toHaveBeenCalledOnce();

        // Exact contract framing: [-1, -0.5, 0, 0.5, 1, clamped] round-trips
        // through little-endian int16 with no drift.
        hardware.processor.onaudioprocess?.({
            inputBuffer: { getChannelData: () => new Float32Array([-1, -0.5, 0, 0.5, 1, 2]) },
        });
        expect(frames).toHaveLength(1);
        const bytes = Uint8Array.from(atob(frames[0]!), (char) => char.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        expect([...Array(bytes.length / 2).keys()].map((index) => view.getInt16(index * 2, true)))
            .toEqual([-32768, -16384, 0, 16384, 32767, 32767]);

        release();
        await recorder.stop();
        expect(hardware.track.stop).toHaveBeenCalledOnce();
        expect(hardware.context.close).toHaveBeenCalledOnce();
        const framesAfterStop = frames.length;
        hardware.processor.onaudioprocess?.({
            inputBuffer: { getChannelData: () => new Float32Array([1, 1, 1]) },
        });
        // Detached listener plus closed recorder: silence, not a crash.
        expect(frames).toHaveLength(framesAfterStop);

        // Permission denial propagates with its platform identity and leaks
        // nothing: no context, no tracks, stop stays safe.
        const denied = fakeAudioStack();
        denied.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' }));
        const refused = openRealtimeRecorder();
        await expect(refused.init(24000)).rejects.toMatchObject({ name: 'NotAllowedError' });
        expect(denied.AudioContext).not.toHaveBeenCalled();
        await refused.stop();
    });

    it('bounds a resume() that never settles and releases the microphone on stop at once', async () => {
        vi.useFakeTimers();
        try {
            const suspended = fakeAudioStack();
            suspended.context.state = 'suspended';
            suspended.context.resume = vi.fn(() => new Promise<void>(() => undefined));
            const recorder = openRealtimeRecorder();
            await recorder.init(24000);
            const start = recorder.start();
            let settled = false;
            void start.catch(() => undefined).finally(() => { settled = true; });
            // Owner gives up mid-startup: tracks stop immediately, not behind resume().
            await recorder.stop();
            expect(suspended.track.stop).toHaveBeenCalledOnce();
            expect(suspended.context.close).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(200);
            expect(settled).toBe(true);
            await expect(start).rejects.toThrow(/closed/);

            // Without a stop, the deadline alone ends the wait with the suspended reason.
            const stuck = fakeAudioStack();
            stuck.context.state = 'suspended';
            stuck.context.resume = vi.fn(() => new Promise<void>(() => undefined));
            const waiting = openRealtimeRecorder();
            await waiting.init(24000);
            const pending = waiting.start();
            let outcome: unknown;
            pending.catch((error: unknown) => { outcome = error; });
            await vi.advanceTimersByTimeAsync(1700);
            expect(outcome).toBeInstanceOf(Error);
            expect(String((outcome as Error).message)).toMatch(/suspended/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('encodes silence and full-scale edges without drift', () => {
        expect(encodePcm16Chunk(new Float32Array([0, 0, 0]))).toBe('AAAAAAAA');
        const full = Uint8Array.from(atob(encodePcm16Chunk(new Float32Array([1, -1]))), (char) => char.charCodeAt(0));
        const view = new DataView(full.buffer);
        expect([view.getInt16(0, true), view.getInt16(2, true)]).toEqual([32767, -32768]);
    });
});
