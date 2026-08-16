/**
 * The slice of WebRTC the voice session actually uses.
 *
 * The browser and react-native-webrtc ship separate, incompatible type
 * definitions for the same API. Describing only what we touch lets the session
 * code stay identical on every platform, with the casting confined to the two
 * platform shims.
 */
export interface VoiceTrack {
    enabled: boolean;
    stop(): void;
}

export interface VoiceStream {
    getTracks(): VoiceTrack[];
    getAudioTracks(): VoiceTrack[];
}

export interface VoiceChannel {
    readyState: string;
    send(data: string): void;
    close(): void;
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
}

export interface VoicePeer {
    connectionState: string;
    onconnectionstatechange: (() => void) | null;
    ontrack: ((event: { streams: VoiceStream[] }) => void) | null;
    addTrack(track: VoiceTrack, stream: VoiceStream): void;
    createDataChannel(label: string): VoiceChannel;
    createOffer(): Promise<{ type: string; sdp?: string }>;
    setLocalDescription(description: unknown): Promise<void>;
    setRemoteDescription(description: unknown): Promise<void>;
    close(): void;
}
