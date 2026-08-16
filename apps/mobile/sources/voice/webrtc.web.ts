import type { VoicePeer, VoiceStream } from './peerTypes';

/**
 * Browsers already have WebRTC, including the echo canceller, so the web build
 * uses it directly rather than pulling in the native module.
 */
export function createPeerConnection(): VoicePeer {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    return peer as unknown as VoicePeer;
}

export async function getMicrophone(): Promise<VoiceStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return stream as unknown as VoiceStream;
}

let element: HTMLAudioElement | null = null;

/** The browser needs somewhere to put the remote track; phones do not. */
export function attachRemoteAudio(stream: VoiceStream): void {
    element ??= Object.assign(document.createElement('audio'), { autoplay: true });
    element.srcObject = stream as unknown as MediaStream;
}

export function routeAudioToSpeaker(): void {
    // The browser owns output routing.
}

export function releaseAudioRoute(): void {
    if (element === null) return;
    element.srcObject = null;
    element = null;
}
