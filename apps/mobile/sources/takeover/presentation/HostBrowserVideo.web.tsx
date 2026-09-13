import * as React from 'react';
import type { HostBrowserVideoProps } from './HostBrowserVideo';

type FrameCallbackVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: (now: number, metadata: { width: number; height: number }) => void) => number;
};

/**
 * Web: the received track in an inline, muted, autoplaying `<video>`. The
 * first *presented* frame of each media generation is established through
 * `requestVideoFrameCallback` (a fresh `srcObject` alone proves nothing);
 * `loadedmetadata` is the fallback where the callback is missing. Wheel
 * ticks go to the page as scroll at the pointer.
 */
export function HostBrowserVideo(props: HostBrowserVideoProps): React.JSX.Element {
    const ref = React.useRef<FrameCallbackVideo | null>(null);
    const stream = props.media?.stream as MediaStream | undefined;
    const { mediaGeneration, onPresented, onFrame, onWheel } = props;

    React.useEffect(() => {
        const video = ref.current;
        if (video === null) return undefined;
        video.srcObject = stream ?? null;
        if (stream === undefined) return undefined;
        let live = true;
        const presented = (width: number, height: number) => {
            if (!live) return;
            live = false;
            onFrame({ width, height });
            onPresented(mediaGeneration);
        };
        if (typeof video.requestVideoFrameCallback === 'function') {
            video.requestVideoFrameCallback((_now, metadata) => presented(metadata.width, metadata.height));
        } else {
            video.addEventListener('loadeddata', () => presented(video.videoWidth, video.videoHeight), { once: true });
        }
        const onResize = () => { if (video.videoWidth > 0) onFrame({ width: video.videoWidth, height: video.videoHeight }); };
        video.addEventListener('resize', onResize);
        void video.play().catch(() => undefined);
        return () => {
            live = false;
            video.removeEventListener('resize', onResize);
            video.srcObject = null;
        };
    }, [stream, mediaGeneration, onPresented, onFrame]);

    React.useEffect(() => {
        const video = ref.current;
        if (video === null || onWheel === undefined) return undefined;
        const handler = (event: WheelEvent) => {
            event.preventDefault();
            const rect = video.getBoundingClientRect();
            onWheel({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event.deltaX, event.deltaY);
        };
        video.addEventListener('wheel', handler, { passive: false });
        return () => video.removeEventListener('wheel', handler);
    }, [onWheel]);

    return (
        <video
            ref={ref}
            playsInline
            muted
            autoPlay
            disablePictureInPicture
            aria-label="Live view of the agent's browser"
            style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', display: 'block' }}
        />
    );
}
