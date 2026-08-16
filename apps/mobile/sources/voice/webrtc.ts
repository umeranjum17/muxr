import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { RTCPeerConnection, mediaDevices } from 'react-native-webrtc';
import { releaseVoiceAudio, routeVoiceAudio } from '@/../modules/voice-overlay';
import type { VoicePeer, VoiceStream } from './peerTypes';

/**
 * Native WebRTC. The library mirrors the browser API, so the session code is
 * the same on every platform -- only this file differs (see webrtc.web.ts).
 *
 * Echo cancellation, noise suppression and gain control come with the stack;
 * they are the reason the microphone can stay open while the agent speaks.
 */
export function createPeerConnection(): VoicePeer {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    return peer as unknown as VoicePeer;
}

export async function getMicrophone(): Promise<VoiceStream> {
    const stream = await mediaDevices.getUserMedia({ audio: true });
    return stream as unknown as VoiceStream;
}

/**
 * Phones play the remote track themselves, but WebRTC only configures playout
 * once that track arrives -- and it hands the audio to the earpiece on the way
 * past. Claiming the speaker before this point gets quietly undone.
 */
export function attachRemoteAudio(_stream: VoiceStream): void {
    routeAudioToSpeaker();
}

/**
 * A voice call routes to the earpiece by default, which sounds exactly like an
 * agent that never speaks.
 *
 * InCallManager is iOS-only here on purpose. On Android its start() sets the
 * route to the earpiece for audio media and re-applies that from its own
 * proximity and bluetooth events, so it undoes the fix moments after we make
 * it. Android owns its audio session in the native module instead.
 */
export function routeAudioToSpeaker(): void {
    if (Platform.OS === 'ios') {
        InCallManager.start({ media: 'audio' });
        InCallManager.setForceSpeakerphoneOn(true);
        return;
    }
    routeVoiceAudio();
}

export function releaseAudioRoute(): void {
    if (Platform.OS === 'ios') {
        InCallManager.setForceSpeakerphoneOn(false);
        InCallManager.stop();
        return;
    }
    releaseVoiceAudio();
}
