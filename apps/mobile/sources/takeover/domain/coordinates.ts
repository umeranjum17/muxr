/**
 * Takeover coordinate mapping.
 *
 * Two spaces meet on the takeover screen: the screencast space the frames
 * arrive in (`metadata.deviceWidth` x `metadata.deviceHeight` device pixels)
 * and the display space the phone renders them in (the on-screen size of the
 * <Image>). Every tap and keystroke target has to cross that gap or clicks
 * land in the wrong place -- the classic takeover bug. The frame is drawn
 * with resizeMode "contain", so the mapping goes through the letterboxed
 * rect, and browser input events want CSS pixels, so device pixels divide by
 * `pageScaleFactor` and pick up the scroll/chrome offsets.
 */

export interface StreamFrameMetadata {
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor: number;
    offsetTop: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
}

export interface Size {
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Rect extends Point, Size {}

/** The rect a `contain`-rendered frame actually occupies inside its container, letterbox offsets included. */
export function containRect(container: Size, frame: Size): Rect {
    if (container.width <= 0 || container.height <= 0 || frame.width <= 0 || frame.height <= 0) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }
    const scale = Math.min(container.width / frame.width, container.height / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    return {
        x: (container.width - width) / 2,
        y: (container.height - height) / 2,
        width,
        height,
    };
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * Map a tap in display space to the CSS-pixel coordinates the browser input
 * protocol expects. Taps in the letterbox bars clamp to the nearest frame
 * edge rather than firing into the void.
 */
export function mapDisplayToInput(tap: Point, display: Size, metadata: StreamFrameMetadata): Point {
    const rect = containRect(display, { width: metadata.deviceWidth, height: metadata.deviceHeight });
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const scale = metadata.pageScaleFactor === 0 ? 1 : metadata.pageScaleFactor;
    return {
        x: Math.round(clamp01((tap.x - rect.x) / rect.width) * metadata.deviceWidth / scale + metadata.scrollOffsetX),
        y: Math.round(clamp01((tap.y - rect.y) / rect.height) * metadata.deviceHeight / scale + metadata.offsetTop + metadata.scrollOffsetY),
    };
}
