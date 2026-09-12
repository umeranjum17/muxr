/**
 * Agent-browser coordinate mapping.
 *
 * The video track shows the service's viewport, letterboxed with `contain`
 * inside the display box. A tap crosses two spaces: display points to the
 * contained video rectangle, then normalized position to **viewport CSS
 * coordinates** -- never document coordinates, because the service injects
 * input at the viewport and the page owns its own scroll. Letterbox taps
 * are rejected, not clamped: nothing sits under them.
 */

export interface Size {
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Rect extends Point, Size {}

/** The rect a `contain`-rendered frame occupies inside its container, letterbox offsets included. */
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

/**
 * Map a display-space point into viewport CSS coordinates. `frame` is the
 * decoded video size, `viewport` the CSS size the service reported for the
 * same target generation; they share an aspect ratio, so only the
 * normalized position crosses. Returns undefined outside the video.
 */
export function mapDisplayToViewport(tap: Point, display: Size, frame: Size, viewport: Size): Point | undefined {
    const rect = containRect(display, frame);
    if (rect.width === 0 || rect.height === 0 || viewport.width <= 0 || viewport.height <= 0) return undefined;
    const nx = (tap.x - rect.x) / rect.width;
    const ny = (tap.y - rect.y) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return undefined;
    return { x: Math.round(nx * viewport.width), y: Math.round(ny * viewport.height) };
}
