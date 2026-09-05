/**
 * xterm.js in the DOM. Web only -- Metro picks TerminalView.tsx on native.
 * Kitty APC is stripped here because xterm 6 has no APC handler.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { FloatingTerminalControls } from './FloatingTerminalControls';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import { recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';
import { t } from '@/text';
import {
    createKittyDecoderState,
    inflateZlib,
    materializeKittyCommands,
    splitKittyFrame,
    type KittyPlacement,
} from '../application/kittyDecoder';

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
    onActions?: () => void;
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

type CellMetrics = { width: number; height: number };

function deviceCells(term: Terminal, dpr: number): CellMetrics {
    const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: {
        css?: { cell?: { width?: number; height?: number } };
        device?: { cell?: { width?: number; height?: number } };
    } } } })._core?._renderService?.dimensions;
    const device = dims?.device?.cell;
    if (device?.width && device.height) return { width: device.width, height: device.height };
    const css = dims?.css?.cell;
    return {
        width: (css?.width && css.width > 0 ? css.width : 8) * dpr,
        height: (css?.height && css.height > 0 ? css.height : 16) * dpr,
    };
}

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const [viewport, setViewport] = React.useState({ width: 0, height: 0 });
    const hostRef = React.useRef<View | null>(null);
    const { sessionId, onStatus, onChannel } = props;
    const [graphicsUnavailable, setGraphicsUnavailable] = React.useState(false);

    React.useEffect(() => {
        const element = hostRef.current as unknown as HTMLElement | null;
        if (element === null) return;
        element.style.position = 'relative';

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
        term.open(element);
        fit.fit();
        setTerminalColumns(sessionId, term.cols);
        let webgl: WebglAddon | undefined;
        let attachingWebgl = false;
        let disposed = false;
        const attachWebgl = (): void => {
            if (attachingWebgl || disposed || webgl !== undefined) return;
            attachingWebgl = true;
            try {
                const next = new WebglAddon();
                term.loadAddon(next);
                next.onContextLoss?.(onContextLoss);
                webgl = next;
            } catch {
                webgl = undefined;
            } finally {
                attachingWebgl = false;
            }
        };
        const onContextLoss = (): void => {
            const failed = webgl;
            webgl = undefined;
            try { failed?.dispose(); } catch { /* already dead */ }
            attachWebgl();
        };
        attachWebgl();

        const killNativeScroll = (node: HTMLElement | null): void => {
            if (node === null) return;
            node.style.touchAction = 'none';
            node.style.overscrollBehavior = 'none';
        };
        killNativeScroll(element);
        killNativeScroll(element.querySelector('.xterm-viewport'));
        killNativeScroll(element.querySelector('.xterm-screen'));

        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.position = 'absolute';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '1';
        element.appendChild(canvas);
        const context = canvas.getContext('2d');
        const placements: KittyPlacement[] = [];
        const decoder = createKittyDecoderState();
        let graphicsActive = false;
        let graphicsFailed = false;
        let channel: TerminalChannel | undefined;
        let pointerSuppressed = false;
        let paintGeneration = 0;

        const dpr = (): number => window.devicePixelRatio || 1;
        const physicalMetrics = (): CellMetrics => deviceCells(term, dpr());
        const reportMetrics = (includeCells: boolean): void => {
            const cells = physicalMetrics();
            channel?.resize(term.cols, term.rows, includeCells && !graphicsFailed ? { width: cells.width, height: cells.height } : undefined);
        };
        const alignCanvas = (): void => {
            const screen = element.querySelector('.xterm-screen') as HTMLElement | null;
            const width = screen?.offsetWidth ?? element.offsetWidth;
            const height = screen?.offsetHeight ?? element.offsetHeight;
            const left = screen?.offsetLeft ?? 0;
            const top = screen?.offsetTop ?? 0;
            const scale = dpr();
            canvas.style.left = `${left}px`;
            canvas.style.top = `${top}px`;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            canvas.width = Math.max(1, Math.floor(width * scale));
            canvas.height = Math.max(1, Math.floor(height * scale));
        };
        const clearCanvas = (): void => {
            paintGeneration += 1;
            placements.length = 0;
            context?.clearRect(0, 0, canvas.width, canvas.height);
        };
        const paint = (): void => {
            if (context === null) return;
            paintGeneration += 1;
            const generation = paintGeneration;
            alignCanvas();
            context.clearRect(0, 0, canvas.width, canvas.height);
            const cells = physicalMetrics();
            for (const image of placements) {
                const imageData = new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height);
                const destX = image.col * cells.width;
                const destY = image.row * cells.height;
                const destW = image.cols * cells.width;
                const destH = image.rows * cells.height;
                createImageBitmap(imageData).then((bitmap) => {
                    if (disposed || generation !== paintGeneration) { bitmap.close(); return; }
                    context.drawImage(bitmap, destX, destY, destW, destH);
                    bitmap.close();
                }).catch(() => { /* keep last frame */ });
            }
        };
        const failGraphics = (): void => {
            graphicsFailed = true;
            graphicsActive = false;
            pointerSuppressed = true;
            clearCanvas();
            reportMetrics(false);
            setGraphicsUnavailable(true);
        };

        onStatus?.('connecting');
        const initialCells = physicalMetrics();
        void openTerminal({
            agentRoute: sessionId,
            size: { cols: term.cols, rows: term.rows, cellWidthPx: initialCells.width, cellHeightPx: initialCells.height },
        })
            .then((opened) => {
                if (disposed) {
                    opened.close();
                    return;
                }
                channel = opened;
                onChannel?.(opened);
                onStatus?.('live');
                opened.onGraphics((active) => { graphicsActive = active && !graphicsFailed; });
                let pending: { bytes: string; graphics?: boolean }[] = [];
                let frameScheduled = false;
                const flushFrames = (): void => {
                    frameScheduled = false;
                    if (disposed || pending.length === 0) return;
                    const chunks = pending;
                    pending = [];
                    for (const chunk of chunks) {
                        const bytes = decodeBase64(chunk.bytes);
                        if (chunk.graphics === undefined) {
                            term.write(bytes);
                            continue;
                        }
                        const split = splitKittyFrame(bytes, decoder);
                        if (split.error === 'unsupported') {
                            term.write(bytes);
                            continue;
                        }
                        if (split.error !== undefined) {
                            if (split.ansi.length > 0) term.write(split.ansi);
                            failGraphics();
                            return;
                        }
                        if (split.ansi.length > 0) term.write(split.ansi);
                        if (split.commands.length === 0) continue;
                        void materializeKittyCommands(split.commands, inflateZlib).then((result) => {
                            if (disposed) return;
                            if (result.error !== undefined) { failGraphics(); return; }
                            if (result.deleteAll) clearCanvas();
                            for (const id of result.deleteIds) {
                                const index = placements.findIndex((item) => item.id === id);
                                if (index >= 0) placements.splice(index, 1);
                            }
                            if (result.placements.length > 0) {
                                placements.splice(0, placements.length, ...result.placements);
                            }
                            paint();
                        });
                    }
                };
                opened.onData((base64, graphics) => {
                    if (graphics !== true) recordTerminalOutput(sessionId, base64);
                    pending.push({ bytes: base64, graphics });
                    if (!frameScheduled) {
                        frameScheduled = true;
                        requestAnimationFrame(flushFrames);
                    }
                });
                opened.onState((state) => onStatus?.(state));
                opened.onClose((reason) => onStatus?.(reason ?? 'closed'));
                term.onData((data) => opened.sendText(data));
                reportMetrics(true);
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
                reportMetrics(!graphicsFailed && document.visibilityState === 'visible');
                paint();
            });
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(element);
        window.addEventListener('resize', resize);
        const dprQuery = window.matchMedia(`(resolution: ${dpr()}dppx)`);
        const onDpr = (): void => resize();
        dprQuery.addEventListener?.('change', onDpr);
        resize();

        const cellHeight = (): number => {
            const css = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })
                ._core?._renderService?.dimensions?.css?.cell;
            return css?.height !== undefined && css.height > 0 ? css.height : 18;
        };
        let scrollAcc = 0;
        let scrollScheduled = false;
        let velocity = 0;
        let momentumRunning = false;
        const wheelCell = (event: WheelEvent): { column: number; row: number } | undefined => {
            const screen = element.querySelector('.xterm-screen') as HTMLElement | null;
            if (screen === null) return undefined;
            const rect = screen.getBoundingClientRect();
            const css = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })
                ._core?._renderService?.dimensions?.css?.cell;
            const width = css?.width && css.width > 0 ? css.width : 8;
            const height = css?.height && css.height > 0 ? css.height : 16;
            const column = Math.floor((event.clientX - rect.left) / width);
            const row = Math.floor((event.clientY - rect.top) / height);
            if (column < 0 || row < 0 || column >= term.cols || row >= term.rows) return undefined;
            return { column, row };
        };
        const emitScroll = (): void => {
            scrollScheduled = false;
            if (disposed) return;
            const lines = Math.trunc(scrollAcc / cellHeight());
            if (lines === 0) return;
            const clamped = Math.max(-40, Math.min(40, lines));
            channel?.scroll(clamped, { column: Math.floor(term.cols / 2), row: Math.floor(term.rows / 2) });
            scrollAcc -= clamped * cellHeight();
            if (lines !== clamped) scrollAcc = 0;
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
            if (graphicsActive && !pointerSuppressed) {
                const at = wheelCell(event) ?? { column: Math.floor(term.cols / 2), row: Math.floor(term.rows / 2) };
                const lines = Math.max(-40, Math.min(40, Math.trunc(-event.deltaY / cellHeight()) || (event.deltaY < 0 ? 1 : -1)));
                channel?.scroll(lines, at);
                return;
            }
            scrollAcc -= event.deltaY;
            scheduleScroll();
        };
        let touchY: number | null = null;
        let touchT = 0;
        let gesturePx = 0;
        let pinchStart = 0;
        let pinchDistance = 0;
        const distance = (touches: TouchList): number => {
            if (touches.length < 2) return 0;
            const dx = touches[0]!.clientX - touches[1]!.clientX;
            const dy = touches[0]!.clientY - touches[1]!.clientY;
            return Math.hypot(dx, dy);
        };
        const localPoint = (event: MouseEvent | Touch, physical: boolean): { x: number; y: number; width: number; height: number } => {
            const screen = element.querySelector('.xterm-screen') as HTMLElement | null;
            const origin = screen ?? element;
            const rect = origin.getBoundingClientRect();
            const scale = physical ? dpr() : 1;
            return {
                x: (event.clientX - rect.left) * scale,
                y: (event.clientY - rect.top) * scale,
                width: rect.width * scale,
                height: rect.height * scale,
            };
        };
        const onTouchStart = (event: TouchEvent): void => {
            velocity = 0;
            momentumRunning = false;
            touchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
            touchT = performance.now();
            scrollAcc = 0;
            gesturePx = 0;
            if (event.touches.length === 2) {
                pointerSuppressed = true;
                pinchStart = term.options.fontSize ?? 13;
                pinchDistance = distance(event.touches);
            }
        };
        const onTouchMove = (event: TouchEvent): void => {
            if (event.touches.length === 2 && pinchDistance > 0) {
                event.preventDefault();
                const next = Math.min(28, Math.max(8, pinchStart * (distance(event.touches) / pinchDistance)));
                term.options.fontSize = next;
                fit.fit();
                setTerminalColumns(sessionId, term.cols);
                reportMetrics(!graphicsFailed);
                paint();
                return;
            }
            if (touchY === null || event.touches.length !== 1) return;
            const y = event.touches[0]!.clientY;
            const now = performance.now();
            const dy = y - touchY;
            const dt = now - touchT;
            if (dt > 0 && dt < 100) velocity = velocity * 0.7 + (dy / dt) * 16.7 * 0.3;
            scrollAcc += dy;
            gesturePx += dy;
            touchY = y;
            touchT = now;
            if (Math.abs(gesturePx) < 8) return;
            event.preventDefault();
            event.stopPropagation();
            scheduleScroll();
        };
        const onTouchEnd = (event: TouchEvent): void => {
            if (event.touches.length < 2) {
                pointerSuppressed = false;
                pinchDistance = 0;
            }
            if (graphicsActive && !pointerSuppressed && Math.abs(gesturePx) < 8 && event.changedTouches[0] !== undefined) {
                const point = localPoint(event.changedTouches[0], true);
                channel?.pointer('down', point.x, point.y, point.width, point.height);
                channel?.pointer('up', point.x, point.y, point.width, point.height);
            }
            touchY = null;
            gesturePx = 0;
            if (!momentumRunning && Math.abs(velocity) >= 0.5) {
                momentumRunning = true;
                requestAnimationFrame(momentum);
            }
        };
        const onMouseDown = (event: MouseEvent): void => {
            if (!graphicsActive || pointerSuppressed || event.button !== 0) return;
            event.preventDefault();
            const point = localPoint(event, true);
            channel?.pointer('down', point.x, point.y, point.width, point.height);
        };
        const onMouseMove = (event: MouseEvent): void => {
            if (!graphicsActive || pointerSuppressed || (event.buttons & 1) === 0) return;
            const point = localPoint(event, true);
            channel?.pointer('move', point.x, point.y, point.width, point.height);
        };
        const onMouseUp = (event: MouseEvent): void => {
            if (!graphicsActive || pointerSuppressed || event.button !== 0) return;
            const point = localPoint(event, true);
            channel?.pointer('up', point.x, point.y, point.width, point.height);
        };
        const onVisibility = (): void => {
            if (document.visibilityState !== 'visible') {
                pointerSuppressed = true;
                clearCanvas();
                reportMetrics(false);
                return;
            }
            if (webgl === undefined && !graphicsFailed) attachWebgl();
            pointerSuppressed = graphicsFailed;
            reportMetrics(!graphicsFailed);
            paint();
        };
        element.addEventListener('wheel', onWheel, { capture: true, passive: false });
        element.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
        element.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
        element.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
        element.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            disposed = true;
            window.removeEventListener('resize', resize);
            dprQuery.removeEventListener?.('change', onDpr);
            resizeObserver.disconnect();
            cancelAnimationFrame(resizeFrame ?? 0);
            element.removeEventListener('wheel', onWheel, { capture: true });
            element.removeEventListener('touchstart', onTouchStart, { capture: true });
            element.removeEventListener('touchmove', onTouchMove, { capture: true });
            element.removeEventListener('touchend', onTouchEnd, { capture: true });
            element.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('visibilitychange', onVisibility);
            canvas.remove();
            onChannel?.(undefined);
            channel?.close();
            term.dispose();
        };
    }, [sessionId, onStatus, onChannel]);

    return (
        <View onLayout={(event) => setViewport(event.nativeEvent.layout)} style={{ flex: 1, backgroundColor: '#0c0c0b' }}>
            <View ref={hostRef} style={{ flex: 1, backgroundColor: '#0c0c0b' }} />
            {props.onActions && <FloatingTerminalControls width={viewport.width} height={viewport.height} commands={[{ label: 'Session actions', icon: 'construct-outline', run: props.onActions, dismiss: true }]} />}
            {graphicsUnavailable && (
                <Text accessibilityRole="summary" accessibilityLiveRegion="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>
                    {t('files.graphicsUnavailable')}
                </Text>
            )}
        </View>
    );
});
