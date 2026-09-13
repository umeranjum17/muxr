/**
 * Agent-browser peer, page half.
 *
 * One `RTCPeerConnection` receiving exactly one video track (H.264 preferred,
 * VP8 only when the endpoint lacks it), plus two data channels: `control`
 * (ordered, reliable) and `pointer` (unordered, no retransmits -- latest
 * motion only). The offer is complete: ICE gathers before it leaves, so one
 * sealed signal round trip carries SDP and candidates both ways. The view
 * attaches `media.stream` to a muted, inline `<video>` and reports the first
 * presented frame through `requestVideoFrameCallback`; until then input
 * stays locked upstream. Stats are sampled for diagnostics only.
 */

import { MAX_REALTIME_SDP_BYTES } from '@muxr/contract';
import type { BrowserPeer, BrowserPeerCallbacks, PeerStats } from './browserSessionClient';

const ICE_GATHER_TIMEOUT_MS = 5_000;
const MAX_CHANNEL_BUFFER_BYTES = 256 * 1024;

function boundedSdp(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('v=0') || value.includes('\u0000')
        || new TextEncoder().encode(value).length > MAX_REALTIME_SDP_BYTES) {
        throw new Error('Invalid browser session answer.');
    }
    return value;
}

/** H.264 first; VP8 only when the endpoint has no H.264 at all. */
function preferH264(transceiver: RTCRtpTransceiver): void {
    const capabilities = RTCRtpReceiver.getCapabilities?.('video');
    if (capabilities === undefined || capabilities === null || typeof transceiver.setCodecPreferences !== 'function') return;
    const h264 = capabilities.codecs.filter((codec) => /h264/i.test(codec.mimeType));
    const vp8 = capabilities.codecs.filter((codec) => /vp8/i.test(codec.mimeType));
    const chosen = h264.length > 0 ? h264 : vp8;
    if (chosen.length > 0) transceiver.setCodecPreferences(chosen);
}

export async function createBrowserPeer(callbacks: BrowserPeerCallbacks): Promise<BrowserPeer> {
    if (typeof RTCPeerConnection !== 'function') throw new Error('This browser cannot stream the agent browser.');
    const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const stream = new MediaStream();
    const control = peer.createDataChannel('control', { ordered: true });
    const pointer = peer.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 });
    let closed = false;
    let receiver: RTCRtpReceiver | undefined;

    const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
    preferH264(transceiver);
    peer.ontrack = (event) => {
        if (closed || event.track.kind !== 'video') return;
        for (const old of stream.getTracks()) stream.removeTrack(old);
        stream.addTrack(event.track);
        receiver = event.receiver;
        // Feature-detected low-buffer hint; stats below say whether it did anything.
        const hinted = event.receiver as unknown as Record<string, unknown>;
        if ('jitterBufferTarget' in hinted) hinted.jitterBufferTarget = 0;
        else if ('playoutDelayHint' in hinted) hinted.playoutDelayHint = 0;
        callbacks.onTrack();
    };
    peer.onconnectionstatechange = () => {
        if (closed) return;
        const state = peer.connectionState;
        if (state === 'connected') callbacks.onState('connected');
        else if (state === 'failed' || state === 'closed' || state === 'disconnected') callbacks.onState('lost');
    };
    control.onmessage = (event: MessageEvent<unknown>) => {
        if (!closed && typeof event.data === 'string') callbacks.onControl(event.data);
    };
    control.onopen = () => { if (!closed) callbacks.onState('control-open'); };
    control.onclose = () => { if (!closed) callbacks.onState('lost'); };

    const send = (channel: RTCDataChannel, text: string): boolean => {
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
        media: { stream },
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
            await peer.setRemoteDescription({ type: 'answer', sdp: boundedSdp(answer) });
        },
        sendControl: (text) => send(control, text),
        sendPointer: (text) => send(pointer, text),
        stats: async (): Promise<PeerStats> => {
            const report = await peer.getStats(receiver?.track ?? null);
            const stats: PeerStats = {};
            report.forEach((entry: Record<string, unknown>) => {
                if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
                    stats.framesDecoded = entry.framesDecoded as number | undefined;
                    stats.framesDropped = entry.framesDropped as number | undefined;
                    stats.packetsLost = entry.packetsLost as number | undefined;
                    stats.jitterBufferDelayMs = typeof entry.jitterBufferDelay === 'number' && typeof entry.jitterBufferEmittedCount === 'number' && entry.jitterBufferEmittedCount > 0
                        ? (entry.jitterBufferDelay / entry.jitterBufferEmittedCount) * 1000
                        : undefined;
                    stats.decodeMs = typeof entry.totalDecodeTime === 'number' && typeof entry.framesDecoded === 'number' && entry.framesDecoded > 0
                        ? (entry.totalDecodeTime / entry.framesDecoded) * 1000
                        : undefined;
                    const codec = typeof entry.codecId === 'string' ? report.get(entry.codecId) : undefined;
                    stats.codec = codec?.mimeType as string | undefined;
                }
                if (entry.type === 'candidate-pair' && entry.nominated === true) {
                    stats.rttMs = typeof entry.currentRoundTripTime === 'number' ? entry.currentRoundTripTime * 1000 : undefined;
                }
            });
            return stats;
        },
        close: () => {
            if (closed) return;
            closed = true;
            for (const track of stream.getTracks()) { track.stop(); stream.removeTrack(track); }
            try { control.close(); } catch { /* already closed */ }
            try { pointer.close(); } catch { /* already closed */ }
            try { peer.close(); } catch { /* already closed */ }
        },
    };
}
