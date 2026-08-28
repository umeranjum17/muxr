import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    class Track {
        kind = 'audio';
        muted = false;
        enabled = true;
        stopped = false;
        onmute: (() => void) | null = null;
        onunmute: (() => void) | null = null;
        onended: (() => void) | null = null;
        stop() { this.stopped = true; }
    }
    class Stream {
        track = new Track();
        getTracks() { return [this.track]; }
        getAudioTracks() { return [this.track]; }
    }
    class Channel {
        readyState = 'connecting';
        bufferedAmount = 0;
        sent: string[] = [];
        closed = false;
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        send(data: string) { this.sent.push(data); }
        close() { this.closed = true; this.readyState = 'closed'; }
    }
    class Peer {
        static latest: Peer;
        connectionState = 'new';
        iceGatheringState = 'complete';
        localDescription: { sdp: string } | null = null;
        remoteDescription: unknown;
        closed = false;
        channel = new Channel();
        onconnectionstatechange: (() => void) | null = null;
        onicegatheringstatechange: (() => void) | null = null;
        ontrack: ((event: { track: Track }) => void) | null = null;
        constructor() { Peer.latest = this; }
        createDataChannel() { return this.channel; }
        addTrack = vi.fn();
        async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=offer' }; }
        async setLocalDescription(description: { sdp: string }) { this.localDescription = description; }
        async setRemoteDescription(description: unknown) { this.remoteDescription = description; }
        close() { this.closed = true; this.connectionState = 'closed'; }
    }
    const stream = new Stream();
    const order: string[] = [];
    const appListeners: Array<(state: string) => void> = [];
    return {
        Track, Stream, Channel, Peer, stream, order, appListeners,
        mediaDevices: { getUserMedia: vi.fn(async () => { order.push('getUserMedia'); return stream; }) },
        service: {
            startVoiceService: vi.fn(() => { order.push('startService'); return true; }),
            isVoiceServiceReady: vi.fn(() => true),
            routeVoiceAudio: vi.fn(() => { order.push('routeAudio'); return true; }),
            releaseVoiceAudio: vi.fn(),
            stopVoiceService: vi.fn(),
        },
    };
});

vi.mock('react-native', () => ({
    AppState: {
        addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
            mocks.appListeners.push(listener);
            return { remove: vi.fn() };
        }),
    },
}));
vi.mock('react-native-webrtc', () => ({
    mediaDevices: mocks.mediaDevices,
    RTCPeerConnection: mocks.Peer,
    RTCSessionDescription: class { constructor(value: unknown) { Object.assign(this, value); } },
}));
vi.mock('@/../modules/voice-overlay', () => mocks.service);

import { startRealtimeWebRtc } from './realtimeWebRtc';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.appListeners.length = 0;
    mocks.stream.track = new mocks.Track();
});

describe('provider-neutral realtime WebRTC kernel', () => {
    it('orders foreground capture, bounds signaling, carries opaque control, plays remote audio, and tears down one active peer', async () => {
        const offers: string[] = [];
        const data: string[] = [];
        const states: string[] = [];
        const remoteAudio: boolean[] = [];
        const interruptions: boolean[] = [];
        const errors: string[] = [];
        const handle = await startRealtimeWebRtc('events-channel', {
            onOffer: (sdp) => offers.push(sdp),
            onData: (value) => data.push(value),
            onConnectionState: (state) => states.push(state),
            onRemoteAudio: (active) => remoteAudio.push(active),
            onInterruption: (interrupted) => interruptions.push(interrupted),
            onError: (error) => errors.push(error.message),
        });
        const peer = mocks.Peer.latest;
        expect(mocks.order).toEqual(['startService', 'routeAudio', 'getUserMedia']);
        expect(offers).toEqual(['v=0\r\na=offer']);
        await expect(startRealtimeWebRtc('other-channel', {
            onOffer: vi.fn(), onData: vi.fn(), onConnectionState: vi.fn(), onRemoteAudio: vi.fn(), onInterruption: vi.fn(), onError: vi.fn(),
        })).rejects.toThrow('already active');

        expect(handle.sendData('{"queued":true}')).toBe(true);
        peer.channel.readyState = 'open';
        peer.channel.onopen?.();
        expect(peer.channel.sent).toEqual(['{"queued":true}']);
        peer.channel.onmessage?.({ data: '{"type":"session.started"}' });
        expect(data).toEqual(['{"type":"session.started"}']);
        await handle.acceptAnswer('v=0\r\na=answer');
        expect(peer.remoteDescription).toMatchObject({ type: 'answer', sdp: 'v=0\r\na=answer' });

        peer.connectionState = 'connected';
        peer.onconnectionstatechange?.();
        const remote = new mocks.Track();
        remote.muted = true;
        peer.ontrack?.({ track: remote });
        remote.muted = false;
        remote.onunmute?.();
        remote.onmute?.();
        expect(states).toContain('connected');
        expect(remoteAudio).toEqual([false, true, false]);

        mocks.stream.track.onmute?.();
        mocks.stream.track.onunmute?.();
        expect(interruptions).toEqual([true, false]);
        handle.setMuted(true);
        expect(mocks.stream.track.enabled).toBe(false);
        peer.connectionState = 'disconnected';
        mocks.appListeners[0]?.('active');
        expect(states.at(-1)).toBe('connecting');

        handle.stop();
        expect(mocks.stream.track.stopped).toBe(true);
        expect(remote.stopped).toBe(true);
        expect(peer.channel.closed).toBe(true);
        expect(peer.closed).toBe(true);
        expect(mocks.service.releaseVoiceAudio).toHaveBeenCalledOnce();
        expect(mocks.service.stopVoiceService).toHaveBeenCalledOnce();
        expect(errors).toEqual([]);
    });
});
