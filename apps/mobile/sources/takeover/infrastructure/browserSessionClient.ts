/**
 * Agent-browser peer, native half (react-native-webrtc). Same shape and
 * protocol as the page half: one received video track, `control` and
 * `pointer` data channels, an ICE-complete offer, a bounded answer, stats
 * for diagnostics only. The view renders `media.streamURL` in an RTCView
 * with `objectFit="contain"` and reports first presentation through the
 * patched `onFirstFrameRendered`; input stays locked upstream until then.
 * The native module loads lazily so the app never initializes WebRTC at
 * startup.
 */

import { MAX_REALTIME_SDP_BYTES } from '@muxr/contract';
import type { MediaStreamTrack, RTCRtpTransceiver } from 'react-native-webrtc';

const ICE_GATHER_TIMEOUT_MS = 5_000;
const MAX_CHANNEL_BUFFER_BYTES = 256 * 1024;

export interface PeerStats {
    codec?: string | undefined;
    framesDecoded?: number | undefined;
    framesDropped?: number | undefined;
    packetsLost?: number | undefined;
    /** Mean jitter-buffer residency per emitted frame. */
    jitterBufferDelayMs?: number | undefined;
    decodeMs?: number | undefined;
    rttMs?: number | undefined;
}

export interface BrowserPeerCallbacks {
    onControl: (text: string) => void;
    onTrack: () => void;
    onState: (state: 'control-open' | 'connected' | 'lost') => void;
}

export interface BrowserPeer {
    /** Web: a MediaStream for `<video>`; native: the stream URL for RTCView. */
    media: { stream?: unknown; streamURL?: string };
    /** Local SDP after ICE gathering: one round trip carries everything. */
    offer: () => Promise<string>;
    accept: (answerSdp: string) => Promise<void>;
    sendControl: (text: string) => boolean;
    sendPointer: (text: string) => boolean;
    stats: () => Promise<PeerStats>;
    close: () => void;
}

function boundedSdp(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('v=0') || value.includes('\u0000')
        || new TextEncoder().encode(value).length > MAX_REALTIME_SDP_BYTES) {
        throw new Error('Invalid browser session answer.');
    }
    return value;
}

export async function createBrowserPeer(callbacks: BrowserPeerCallbacks): Promise<BrowserPeer> {
    const { MediaStream, RTCPeerConnection, RTCRtpReceiver, RTCSessionDescription } = await import('react-native-webrtc');
    const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const stream = new MediaStream([]);
    const control = peer.createDataChannel('control', { ordered: true });
    const pointer = peer.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 });
    let closed = false;
    let remoteTrack: MediaStreamTrack | undefined;

    const transceiver: RTCRtpTransceiver = peer.addTransceiver('video', { direction: 'recvonly' });
    try {
        const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
        const h264 = codecs.filter((codec) => /h264/i.test(codec.mimeType));
        const vp8 = codecs.filter((codec) => /vp8/i.test(codec.mimeType));
        const chosen = h264.length > 0 ? h264 : vp8;
        if (chosen.length > 0) transceiver.setCodecPreferences(chosen);
    } catch { /* the endpoint negotiates its default order */ }

    peer.ontrack = (event: { track: MediaStreamTrack | null }) => {
        const track = event.track;
        if (closed || track?.kind !== 'video') return;
        for (const old of stream.getTracks()) stream.removeTrack(old);
        stream.addTrack(track);
        remoteTrack = track;
        callbacks.onTrack();
    };
    peer.onconnectionstatechange = () => {
        if (closed) return;
        const state = peer.connectionState;
        if (state === 'connected') callbacks.onState('connected');
        else if (state === 'failed' || state === 'closed' || state === 'disconnected') callbacks.onState('lost');
    };
    control.onmessage = (event: { data: unknown }) => {
        if (!closed && typeof event.data === 'string') callbacks.onControl(event.data);
    };
    control.onopen = () => { if (!closed) callbacks.onState('control-open'); };
    control.onclose = () => { if (!closed) callbacks.onState('lost'); };

    const send = (channel: typeof control, text: string): boolean => {
        if (closed || channel.readyState !== 'open' || channel.bufferedAmount > MAX_CHANNEL_BUFFER_BYTES) return false;
        channel.send(text);
        return true;
    };

    const gathered = new Promise<void>((resolve) => {
        if (peer.iceGatheringState === 'complete') { resolve(); return; }
        const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
        peer.onicegatheringstatechange = () => {
            if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
        };
    });

    return {
        media: { streamURL: stream.toURL() },
        offer: async () => {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            await gathered;
            const sdp = peer.localDescription?.sdp;
            if (closed || sdp === undefined) throw new Error('The browser session offer was not created.');
            return sdp;
        },
        accept: async (answer) => {
            if (closed) throw new Error('The browser session closed.');
            await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: boundedSdp(answer) }));
        },
        sendControl: (text) => send(control, text),
        sendPointer: (text) => send(pointer, text),
        stats: async (): Promise<PeerStats> => {
            const report = (await peer.getStats(remoteTrack)) as Map<string, Record<string, unknown>>;
            const stats: PeerStats = {};
            report.forEach((entry) => {
                if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
                    stats.framesDecoded = entry.framesDecoded as number | undefined;
                    stats.framesDropped = entry.framesDropped as number | undefined;
                    stats.packetsLost = entry.packetsLost as number | undefined;
                    if (typeof entry.jitterBufferDelay === 'number' && typeof entry.jitterBufferEmittedCount === 'number' && entry.jitterBufferEmittedCount > 0) {
                        stats.jitterBufferDelayMs = (entry.jitterBufferDelay / entry.jitterBufferEmittedCount) * 1000;
                    }
                    if (typeof entry.totalDecodeTime === 'number' && typeof entry.framesDecoded === 'number' && entry.framesDecoded > 0) {
                        stats.decodeMs = (entry.totalDecodeTime / entry.framesDecoded) * 1000;
                    }
                    const codec = typeof entry.codecId === 'string' ? report.get(entry.codecId) : undefined;
                    stats.codec = codec?.mimeType as string | undefined;
                }
                if (entry.type === 'candidate-pair' && entry.nominated === true && typeof entry.currentRoundTripTime === 'number') {
                    stats.rttMs = entry.currentRoundTripTime * 1000;
                }
            });
            return stats;
        },
        close: () => {
            if (closed) return;
            closed = true;
            remoteTrack?.stop();
            remoteTrack = undefined;
            try { control.close(); } catch { /* already closed */ }
            try { pointer.close(); } catch { /* already closed */ }
            try { peer.close(); } catch { /* already closed */ }
            stream.release(false);
        },
    };
}
