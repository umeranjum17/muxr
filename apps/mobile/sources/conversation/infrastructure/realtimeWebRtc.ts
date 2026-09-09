import { AppState, type AppStateStatus } from 'react-native';
import type { MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import { MAX_REALTIME_SDP_BYTES, MAX_REALTIME_WEBRTC_DATA_BYTES } from '@muxr/contract';
import {
    isVoiceServiceReady,
    releaseVoiceAudio,
    routeVoiceAudio,
    startVoiceService,
    stopVoiceService,
} from '@/../modules/voice-overlay';

const ICE_GATHER_TIMEOUT_MS = 5_000;
const SERVICE_READY_TIMEOUT_MS = 2_000;
const MAX_PENDING_DATA_BYTES = 64 * 1024;
const MAX_DATA_CHANNEL_BUFFER_BYTES = 256 * 1024;

export interface RealtimeWebRtcCallbacks {
    onOffer: (sdp: string) => void;
    onData: (data: string) => void;
    onConnectionState: (state: 'connecting' | 'connected' | 'disconnected') => void;
    onRemoteAudio: (active: boolean) => void;
    onInterruption: (interrupted: boolean) => void;
    onError: (error: Error) => void;
}

export interface RealtimeWebRtcHandle {
    acceptAnswer: (sdp: string) => Promise<void>;
    sendData: (data: string) => boolean;
    setMuted: (muted: boolean) => void;
    stop: () => void;
}

let activeSession: RealtimeWebRtcHandle | undefined;

function promiseWithResolvers<T>() {
    if (typeof Promise.withResolvers === 'function') return Promise.withResolvers<T>();
    // Hermes in the current mobile runtime predates Promise.withResolvers.
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}

function wait(milliseconds: number): Promise<void> {
    const { promise, resolve } = promiseWithResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
}

async function ensureForegroundMicrophoneService(): Promise<void> {
    if (!startVoiceService()) throw new Error('Microphone foreground service could not start.');
    const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
    while (!isVoiceServiceReady()) {
        if (Date.now() >= deadline) throw new Error('Microphone foreground service was not ready before capture.');
        await wait(25);
    }
}

function boundedSdp(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.startsWith('v=0') || value.includes('\u0000')
        || new TextEncoder().encode(value).length > MAX_REALTIME_SDP_BYTES) {
        throw new Error(`Invalid WebRTC ${label}.`);
    }
    return value;
}

export async function startRealtimeWebRtc(
    dataChannelLabel: string,
    callbacks: RealtimeWebRtcCallbacks,
): Promise<RealtimeWebRtcHandle> {
    if (activeSession !== undefined) throw new Error('A realtime WebRTC session is already active.');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(dataChannelLabel)) throw new Error('Invalid WebRTC data channel.');
    // Platform-specific native module: PCM and web paths must not initialize WebRTC at app startup.
    const { mediaDevices, RTCPeerConnection, RTCSessionDescription } = await import('react-native-webrtc');

    let stopped = false;
    let localStream: MediaStream | undefined;
    let remoteTrack: MediaStreamTrack | undefined;
    let appStateSubscription: { remove: () => void } | undefined;
    let pendingDataBytes = 0;
    const pendingData: string[] = [];
    const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const channel = peer.createDataChannel(dataChannelLabel);

    const fail = (cause: unknown): void => {
        if (stopped) return;
        callbacks.onError(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        appStateSubscription?.remove();
        appStateSubscription = undefined;
        for (const track of localStream?.getTracks() ?? []) track.stop();
        remoteTrack?.stop();
        remoteTrack = undefined;
        localStream = undefined;
        pendingData.length = 0;
        pendingDataBytes = 0;
        try { channel.close(); } catch { /* already closed */ }
        try { peer.close(); } catch { /* already closed */ }
        releaseVoiceAudio();
        stopVoiceService();
        if (activeSession === handle) activeSession = undefined;
        callbacks.onRemoteAudio(false);
        callbacks.onConnectionState('disconnected');
    };
    const sendData = (data: string): boolean => {
        const bytes = new TextEncoder().encode(data).length;
        if (stopped || bytes === 0 || bytes > MAX_REALTIME_WEBRTC_DATA_BYTES || data.includes('\u0000')) return false;
        if (channel.readyState === 'open') {
            if (channel.bufferedAmount > MAX_DATA_CHANNEL_BUFFER_BYTES) return false;
            channel.send(data);
            return true;
        }
        if (channel.readyState !== 'connecting' || pendingDataBytes + bytes > MAX_PENDING_DATA_BYTES) return false;
        pendingData.push(data);
        pendingDataBytes += bytes;
        return true;
    };
    const handle: RealtimeWebRtcHandle = {
        acceptAnswer: async (sdp) => {
            if (stopped) throw new Error('Realtime WebRTC session is closed.');
            await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: boundedSdp(sdp, 'answer') }));
        },
        sendData,
        setMuted: (muted) => {
            for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
        },
        stop,
    };
    activeSession = handle;

    channel.onopen = () => {
        if (stopped) return;
        while (pendingData.length > 0 && channel.bufferedAmount <= MAX_DATA_CHANNEL_BUFFER_BYTES) {
            const data = pendingData.shift()!;
            pendingDataBytes -= new TextEncoder().encode(data).length;
            channel.send(data);
        }
    };
    channel.onmessage = (event: { data: unknown }) => {
        if (stopped || typeof event.data !== 'string') return;
        const bytes = new TextEncoder().encode(event.data).length;
        if (bytes > 0 && bytes <= MAX_REALTIME_WEBRTC_DATA_BYTES && !event.data.includes('\u0000')) callbacks.onData(event.data);
    };
    channel.onerror = () => fail(new Error('Realtime WebRTC data channel failed.'));
    channel.onclose = () => { if (!stopped) fail(new Error('Realtime WebRTC data channel closed.')); };

    peer.onconnectionstatechange = () => {
        if (stopped) return;
        if (peer.connectionState === 'connected') callbacks.onConnectionState('connected');
        else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') fail(new Error(`Realtime WebRTC ${peer.connectionState}.`));
        else if (peer.connectionState === 'disconnected') callbacks.onConnectionState('connecting');
    };
    peer.ontrack = (event: { track: MediaStreamTrack | null }) => {
        const track = event.track;
        if (stopped || track?.kind !== 'audio') return;
        remoteTrack = track;
        callbacks.onRemoteAudio(!track.muted);
        track.onmute = () => callbacks.onRemoteAudio(false);
        track.onunmute = () => callbacks.onRemoteAudio(true);
        track.onended = () => callbacks.onRemoteAudio(false);
    };

    appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
        if (stopped) return;
        if (state === 'active' && peer.connectionState === 'disconnected') callbacks.onConnectionState('connecting');
    });

    try {
        callbacks.onConnectionState('connecting');
        await ensureForegroundMicrophoneService();
        if (!routeVoiceAudio()) throw new Error('This device could not route realtime audio.');
        localStream = await mediaDevices.getUserMedia({ audio: true, video: false });
        if (stopped) throw new Error('Realtime WebRTC session stopped during microphone startup.');
        const inputTrack = localStream.getAudioTracks()[0];
        if (!inputTrack) throw new Error('Realtime WebRTC microphone track is unavailable.');
        inputTrack.onmute = () => callbacks.onInterruption(true);
        inputTrack.onunmute = () => callbacks.onInterruption(false);
        inputTrack.onended = () => fail(new Error('Realtime WebRTC microphone ended.'));
        peer.addTrack(inputTrack, localStream);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (peer.iceGatheringState !== 'complete') {
            const gathering = promiseWithResolvers<void>();
            const timeout = setTimeout(() => {
                peer.onicegatheringstatechange = null;
                gathering.reject(new Error('Realtime WebRTC ICE gathering timed out.'));
            }, ICE_GATHER_TIMEOUT_MS);
            peer.onicegatheringstatechange = () => {
                if (peer.iceGatheringState !== 'complete') return;
                peer.onicegatheringstatechange = null;
                gathering.resolve();
            };
            await gathering.promise.finally(() => clearTimeout(timeout));
        }
        callbacks.onOffer(boundedSdp(peer.localDescription?.sdp, 'offer'));
        return handle;
    } catch (error) {
        stop();
        throw error;
    }
}
