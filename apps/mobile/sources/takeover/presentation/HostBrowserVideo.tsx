import * as React from 'react';
import type { HostComponent } from 'react-native';
import type { RTCVideoViewProps } from 'react-native-webrtc';
import type { BrowserPeer } from '../infrastructure/browserSessionClient';
import type { Size } from '../domain/coordinates';

export interface HostBrowserVideoProps {
    media: BrowserPeer['media'] | undefined;
    mediaGeneration: number;
    /** A frame of this media generation reached the screen. */
    onPresented: (mediaGeneration: number) => void;
    /** Decoded frame size, for the contained-rectangle mapping. */
    onFrame: (frame: Size) => void;
    onWheel?: (point: { x: number; y: number }, deltaX: number, deltaY: number) => void;
}

/**
 * Patched RTCView (patches/react-native-webrtc+124.0.8.patch) reports the
 * renderer's first frame per attached stream. Android's patched event is the
 * preferred signal; the native RTCView also emits dimensions when its first
 * decoded frame reaches the renderer, so that callback is the compatibility
 * fallback for builds where the custom direct event is dropped.
 */
type PatchedRtcView = HostComponent<RTCVideoViewProps & {
    onFirstFrameRendered?: (event: { nativeEvent: { streamURL?: string | null } }) => void;
}>;

/** Native: the received track in an RTCView that never opens picture-in-picture. */
export function HostBrowserVideo(props: HostBrowserVideoProps): React.JSX.Element | null {
    const [View, setView] = React.useState<PatchedRtcView | null>(null);
    React.useEffect(() => {
        // Lazy: the app must not initialize WebRTC at startup.
        let live = true;
        void import('react-native-webrtc').then((module) => { if (live) setView(() => module.RTCView as PatchedRtcView); });
        return () => { live = false; };
    }, []);
    const streamURL = props.media?.streamURL;
    const { mediaGeneration, onPresented, onFrame } = props;
    const presentedRef = React.useRef(false);
    const markPresented = React.useCallback(() => {
        if (presentedRef.current) return;
        presentedRef.current = true;
        onPresented(mediaGeneration);
    }, [mediaGeneration, onPresented]);
    if (View === null || streamURL === undefined) return null;
    return (
        <View
            key={mediaGeneration}
            streamURL={streamURL}
            objectFit="contain"
            style={{ flex: 1 }}
            onDimensionsChange={(event) => {
                const frame = { width: event.nativeEvent.width, height: event.nativeEvent.height };
                onFrame(frame);
                // On Android the decoder's first real resolution callback is
                // delivered even when the patched direct event is not. It is
                // safe to acknowledge only a non-empty frame, and the ref
                // keeps this fallback idempotent with onFirstFrameRendered.
                if (frame.width > 2 && frame.height > 2) markPresented();
            }}
            onFirstFrameRendered={(event) => {
                const eventStreamURL = event.nativeEvent.streamURL;
                if (eventStreamURL === undefined || eventStreamURL === null || eventStreamURL === streamURL) markPresented();
            }}
        />
    );
}
