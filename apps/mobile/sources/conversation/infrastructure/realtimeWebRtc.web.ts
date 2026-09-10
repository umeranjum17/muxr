/**
 * Realtime WebRTC, page half.
 *
 * Only the Codex voice provider speaks this path today: the host plugin
 * emits `realtime.webrtc.start` and signals the offer to chatgpt.com, while
 * media flows directly between the page and the provider. The contract is
 * identical to native -- same data-channel label validation, SDP bounds,
 * pending-data caps, and callback vocabulary -- so `realtimeSession` needs
 * no platform branch; Metro resolves this file on web.
 *
 * Two platform differences, both inherent to the browser: there is no
 * microphone foreground service or audio routing (a tab cannot hold the mic
 * while hidden -- calls stay foreground-only), and the remote audio track
 * needs an element to sound. Playback starts from the call gesture; when the
 * browser blocks it the call fails loudly instead of going silently deaf.
 */

import { MAX_REALTIME_SDP_BYTES, MAX_REALTIME_WEBRTC_DATA_BYTES } from '@muxr/contract';
import type { RealtimeWebRtcCallbacks, RealtimeWebRtcHandle } from './realtimeWebRtc';

const ICE_GATHER_TIMEOUT_MS = 5_000;
const MAX_PENDING_DATA_BYTES = 64 * 1024;
const MAX_DATA_CHANNEL_BUFFER_BYTES = 256 * 1024;

let activeSession: RealtimeWebRtcHandle | undefined;

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
    if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
        throw new Error('Realtime WebRTC needs a browser with microphone capture.');
    }

    let stopped = false;
    let localStream: MediaStream | undefined;
    let remoteAudio: HTMLAudioElement | undefined;
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
        for (const track of localStream?.getTracks() ?? []) track.stop();
        localStream = undefined;
        pendingData.length = 0;
        pendingDataBytes = 0;
        if (remoteAudio !== undefined) {
            remoteAudio.pause();
            remoteAudio.srcObject = null;
            remoteAudio = undefined;
        }
        try { channel.close(); } catch { /* already closed */ }
        try { peer.close(); } catch { /* already closed */ }
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
            await peer.setRemoteDescription({ type: 'answer', sdp: boundedSdp(sdp, 'answer') });
        },
        sendData,
        setMuted: (muted) => {
            for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
        },
        stop,
    };
    activeSession = handle;

    const playRemote = (): void => {
        if (stopped || remoteAudio === undefined) return;
        void remoteAudio.play().catch(() => {
            fail(new Error('Realtime WebRTC audio playback was blocked by the browser. Use the muxr app for voice.'));
        });
    };

    channel.onopen = () => {
        if (stopped) return;
        while (pendingData.length > 0 && channel.bufferedAmount <= MAX_DATA_CHANNEL_BUFFER_BYTES) {
            const data = pendingData.shift()!;
            pendingDataBytes -= new TextEncoder().encode(data).length;
            channel.send(data);
        }
    };
    channel.onmessage = (event: MessageEvent) => {
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
    peer.ontrack = (event: RTCTrackEvent) => {
        const track = event.track;
        if (stopped || track.kind !== 'audio') return;
        if (remoteAudio === undefined) {
            remoteAudio = new Audio();
            remoteAudio.srcObject = new MediaStream();
        }
        const stream = remoteAudio.srcObject;
        if (stream instanceof MediaStream && !stream.getTracks().includes(track)) stream.addTrack(track);
        callbacks.onRemoteAudio(!track.muted);
        track.onmute = () => callbacks.onRemoteAudio(false);
        track.onunmute = () => {
            callbacks.onRemoteAudio(true);
            playRemote();
        };
        track.onended = () => callbacks.onRemoteAudio(false);
        if (!track.muted) playRemote();
    };

    try {
        callbacks.onConnectionState('connecting');
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (stopped) throw new Error('Realtime WebRTC session stopped during microphone startup.');
        const inputTrack = localStream.getAudioTracks()[0];
        if (inputTrack === undefined) throw new Error('Realtime WebRTC microphone track is unavailable.');
        inputTrack.onmute = () => callbacks.onInterruption(true);
        inputTrack.onunmute = () => callbacks.onInterruption(false);
        inputTrack.onended = () => fail(new Error('Realtime WebRTC microphone ended.'));
        peer.addTrack(inputTrack, localStream);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (peer.iceGatheringState !== 'complete') {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    peer.onicegatheringstatechange = null;
                    reject(new Error('Realtime WebRTC ICE gathering timed out.'));
                }, ICE_GATHER_TIMEOUT_MS);
                peer.onicegatheringstatechange = () => {
                    if (peer.iceGatheringState !== 'complete') return;
                    peer.onicegatheringstatechange = null;
                    clearTimeout(timeout);
                    resolve();
                };
            });
        }
        callbacks.onOffer(boundedSdp(peer.localDescription?.sdp, 'offer'));
        return handle;
    } catch (error) {
        stop();
        throw error;
    }
}
