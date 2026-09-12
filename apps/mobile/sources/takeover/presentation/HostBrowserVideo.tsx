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
 * renderer's first frame per attached stream; the stock dimensions
 * callback is not proof of presentation, so input stays locked without it.
 */
type PatchedRtcView = HostComponent<RTCVideoViewProps & {
    onFirstFrameRendered?: (event: { nativeEvent: { streamURL?: string } }) => void;
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
    if (View === null || streamURL === undefined) return null;
    return (
        <View
            key={mediaGeneration}
            streamURL={streamURL}
            objectFit="contain"
            style={{ flex: 1 }}
            onDimensionsChange={(event) => onFrame({ width: event.nativeEvent.width, height: event.nativeEvent.height })}
            onFirstFrameRendered={(event) => {
                if (event.nativeEvent.streamURL === undefined || event.nativeEvent.streamURL === streamURL) onPresented(mediaGeneration);
            }}
        />
    );
}
