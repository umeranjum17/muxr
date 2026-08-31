/**
 * xterm.js in the DOM. Web only -- Metro picks TerminalView.tsx on native.
 */

import * as React from 'react';
import { View } from 'react-native';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import { beginViewportCapture, recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    /** Set once the channel is live, so a parent toolbar can send keys. */
    onChannel?: (channel: TerminalChannel | undefined) => void;
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const hostRef = React.useRef<View | null>(null);
    const { sessionId, onStatus, onChannel } = props;

    React.useEffect(() => {
        const element = hostRef.current as unknown as HTMLElement | null;
        if (element === null) return;

        const term = new Terminal({
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: { background: '#0c0c0b' },
            convertEol: false,
            scrollback: 5000,
            cursorBlink: true,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        term.loadAddon(new ImageAddon());
        term.open(element);
        fit.fit();
        setTerminalColumns(sessionId, term.cols);
        // WebGL renderer: xterm.js rates it ~900% faster frame rendering than
        // canvas (it's VS Code's default). Canvas stays as the fallback where
        // WebGL is unavailable (old WebViews, blocked GPUs).
        try {
            term.loadAddon(new WebglAddon());
        } catch {
            // no WebGL context: the default canvas renderer carries on
        }

        // Mobile browsers hand a vertical drag to native scrolling unless the
        // element opts out, so touchmove never reached the handler below on a
        // real phone (synthetic events worked, a finger did not). xterm's
        // viewport is itself scrollable, so it needs the opt-out too.
        const killNativeScroll = (node: HTMLElement | null): void => {
            if (node === null) return;
            node.style.touchAction = 'none';
            node.style.overscrollBehavior = 'none';
        };
        killNativeScroll(element);
        killNativeScroll(element.querySelector('.xterm-viewport'));
        killNativeScroll(element.querySelector('.xterm-screen'));

        let channel: TerminalChannel | undefined;
        let disposed = false;
        let graphicsActive = false;
        const cellMetrics = (): { width: number; height: number } | undefined => {
            const cell = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })
                ._core?._renderService?.dimensions?.css?.cell;
            return cell?.width !== undefined && cell.height !== undefined && cell.width > 0 && cell.height > 0
                ? { width: cell.width * window.devicePixelRatio, height: cell.height * window.devicePixelRatio }
                : undefined;
        };

        onStatus?.('connecting');
        const initialCell = cellMetrics();
        void openTerminal({
            agentRoute: sessionId,
            size: {
                cols: term.cols,
                rows: term.rows,
                ...(initialCell === undefined ? {} : { cellWidthPx: initialCell.width, cellHeightPx: initialCell.height }),
            },
        })
            .then((opened) => {
                if (disposed) {
                    opened.close();
                    return;
                }
                channel = opened;
                onChannel?.(opened);
                onStatus?.('live');
                // Frame batching (Moshi's "write batching" discipline): herdr
                // repaints whole screens, so during scroll/redraw bursts frames
                // arrive back-to-back -- one term.write per rAF instead of one
                // per socket message halves render passes.
                let pending: string[] = [];
                let frameScheduled = false;
                const flushFrames = (): void => {
                    frameScheduled = false;
                    if (disposed || pending.length === 0) return;
                    const chunks = pending;
                    pending = [];
                    let total = 0;
                    const decoded = chunks.map(decodeBase64);
                    for (const chunk of decoded) total += chunk.length;
                    const all = new Uint8Array(total);
                    let offset = 0;
                    for (const chunk of decoded) { all.set(chunk, offset); offset += chunk.length; }
                    term.write(all);
                };
                opened.onData((base64) => {
                    recordTerminalOutput(sessionId, base64);
                    pending.push(base64);
                    if (!frameScheduled) {
                        frameScheduled = true;
                        requestAnimationFrame(flushFrames);
                    }
                });
                opened.onGraphics((active) => { graphicsActive = active; });
                opened.onState((state) => onStatus?.(state));
                opened.onClose((reason) => onStatus?.(reason ?? 'closed'));
                term.onData((data) => opened.sendText(data));
            })
            .catch((error: unknown) => {
                onStatus?.(error instanceof Error ? error.message : String(error));
            });

        let resizeFrame: number | undefined;
        const resize = (): void => {
            cancelAnimationFrame(resizeFrame ?? 0);
            resizeFrame = requestAnimationFrame(() => {
                if (disposed) return;
                fit.fit();
                setTerminalColumns(sessionId, term.cols);
                channel?.resize(term.cols, term.rows, cellMetrics());
            });
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(element);
        window.addEventListener('resize', resize);
        resize();

        // herdr owns the pane's scrollback and repaints the viewport, so xterm's
        // local buffer holds frames rather than history -- scrolling xterm here
        // shows garbage. Forward the gesture to herdr instead: it scrolls the
        // REAL pane and repaints, so the terminal scrolls in place.
        //
        // Touch is content-follows-finger, like every native scroll surface:
        // drag DOWN and the content moves down, revealing older output above.
        // The wheel keeps the opposite sign because wheel-up means "go back"
        // on every desktop -- the two inputs disagree on purpose.
        //
        // A full-screen TUI on the alternate screen has no scrollback, so herdr
        // ignores the scroll and the pane simply does not move. That is the
        // honest behaviour; do not bolt a popup onto it.
        const cellHeight = (): number => {
            const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })
                ._core?._renderService?.dimensions?.css?.cell;
            return dims?.height !== undefined && dims.height > 0 ? dims.height : 18;
        };
        // Scroll coalescing + inertia. Every scroll message is a full RTT and a
        // full-screen repaint, so per-touchmove sends rubber-band: accumulate
        // pixels and emit at most one scroll per animation frame. On release,
        // decaying velocity keeps the pane gliding like a native surface.
        let scrollAcc = 0;
        let scrollScheduled = false;
        let velocity = 0; // px per frame, touch only
        let momentumRunning = false;
        const emitScroll = (): void => {
            scrollScheduled = false;
            if (disposed) return;
            const lines = Math.trunc(scrollAcc / cellHeight());
            if (lines === 0) return;
            const clamped = Math.max(-40, Math.min(40, lines)); // don't ask herdr for the world
            channel?.scroll(clamped, { column: Math.floor(term.cols / 2), row: Math.floor(term.rows / 2) });
            scrollAcc -= clamped * cellHeight();
            if (lines !== clamped) scrollAcc = 0; // we clamped: drop the absurd remainder
        };
        const scheduleScroll = (): void => {
            if (scrollScheduled) return;
            scrollScheduled = true;
            requestAnimationFrame(emitScroll);
        };
        const momentum = (): void => {
            if (disposed || Math.abs(velocity) < 0.5) { momentumRunning = false; return; }
            scrollAcc += velocity;
            velocity *= 0.94;
            emitScroll();
            requestAnimationFrame(momentum);
        };
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            event.stopPropagation();
            beginViewportCapture(sessionId); // herdr's repaint is the new viewport
            scrollAcc -= event.deltaY; // wheel up = back = positive
            scheduleScroll();
        };
        let touchY: number | null = null;
        let touchT = 0;
        let gesturePx = 0;
        const pointer = (phase: 'down' | 'move' | 'up', clientX: number, clientY: number): void => {
            if (!graphicsActive || channel === undefined) return;
            const rect = element.getBoundingClientRect();
            channel.pointer(phase, clientX - rect.left, clientY - rect.top, rect.width, rect.height);
        };
        const onTouchStart = (event: TouchEvent): void => {
            if (event.touches.length === 1) pointer('down', event.touches[0].clientX, event.touches[0].clientY);
            velocity = 0;
            momentumRunning = false;
            touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
            touchT = performance.now();
            scrollAcc = 0;
            gesturePx = 0;
        };
        const onTouchMove = (event: TouchEvent): void => {
            if (touchY === null || event.touches.length !== 1) return;
            const y = event.touches[0].clientY;
            pointer('move', event.touches[0].clientX, y);
            const now = performance.now();
            const dy = y - touchY; // finger down = content down = older output
            const dt = now - touchT;
            if (dt > 0 && dt < 100) velocity = velocity * 0.7 + (dy / dt) * 16.7 * 0.3; // smoothed px/frame
            scrollAcc += dy;
            gesturePx += dy;
            touchY = y;
            touchT = now;
            if (Math.abs(gesturePx) < 8) return; // slop: taps stay taps
            event.preventDefault();
            event.stopPropagation();
            beginViewportCapture(sessionId); // herdr's repaint is the new viewport
            scheduleScroll();
        };
        const onTouchEnd = (event: TouchEvent): void => {
            const touch = event.changedTouches[0];
            if (touch !== undefined) pointer('up', touch.clientX, touch.clientY);
            touchY = null;
            gesturePx = 0;
            if (!momentumRunning && Math.abs(velocity) >= 0.5) {
                momentumRunning = true;
                requestAnimationFrame(momentum);
            }
        };
        element.addEventListener('wheel', onWheel, { capture: true, passive: false });
        element.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
        element.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
        element.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });

        return () => {
            disposed = true;
            window.removeEventListener('resize', resize);
            resizeObserver.disconnect();
            cancelAnimationFrame(resizeFrame ?? 0);
            element.removeEventListener('wheel', onWheel, { capture: true });
            element.removeEventListener('touchstart', onTouchStart, { capture: true });
            element.removeEventListener('touchmove', onTouchMove, { capture: true });
            element.removeEventListener('touchend', onTouchEnd, { capture: true });
            onChannel?.(undefined);
            channel?.close();
            term.dispose();
        };
    }, [sessionId, onStatus, onChannel]);

    return <View ref={hostRef} style={{ flex: 1, backgroundColor: '#0c0c0b' }} />;
});
