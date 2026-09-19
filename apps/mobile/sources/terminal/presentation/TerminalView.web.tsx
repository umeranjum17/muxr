/**
 * xterm.js in the DOM. Web only -- Metro picks TerminalView.tsx on native.
 * Kitty APC bytes pass through untouched because xterm 6 has no APC handler.
 */

import * as React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import type { TerminalCommand } from './FloatingTerminalControls';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import { recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
    /** Same contract as the native view; the browser has no view commands and
     *  no terminal IME, so the pane keeps its own keyboard fallback and the
     *  panel is Close plus the quick-action rows. */
    onViewControls?: (controls: { commands: TerminalCommand[]; dismissKeyboard: () => void }) => void;
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
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const [inlineImage, setInlineImage] = React.useState<{ sessionId: string; id: string; mime: string; bytes: string } | null>(null);
    const visibleImage = inlineImage?.sessionId === sessionId ? inlineImage : null;

    React.useEffect(() => {
        setInlineImage(null);
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

        let channel: TerminalChannel | undefined;

        onStatus?.('connecting');
        const controller = new AbortController();
        void openTerminal({
            agentRoute: sessionId,
            signal: controller.signal,
            size: { cols: term.cols, rows: term.rows },
        })
            .then((opened) => {
                if (disposed) {
                    opened.close();
                    return;
                }
                channel = opened;
                channelRef.current = opened;
                onChannel?.(opened);
                // Nothing re-scrolls on attach: the pane's viewport belongs to
                // herdr, which reports it back on `terminal.scroll-state`.
                let pending: string[] = [];
                let frameScheduled = false;
                const flushFrames = (): void => {
                    frameScheduled = false;
                    if (disposed || pending.length === 0) return;
                    const chunks = pending;
                    pending = [];
                    for (const chunk of chunks) term.write(decodeBase64(chunk));
                };
                opened.onData((base64) => {
                    recordTerminalOutput(sessionId, base64);
                    pending.push(base64);
                    if (!frameScheduled) {
                        frameScheduled = true;
                        requestAnimationFrame(flushFrames);
                    }
                });
                // Predicted echo joins the same ordered frame queue; it is not
                // host output, so it is never recorded as pane output.
                opened.onPredictedData((base64) => {
                    pending.push(base64);
                    if (!frameScheduled) {
                        frameScheduled = true;
                        requestAnimationFrame(flushFrames);
                    }
                });
                opened.onImage((image) => setInlineImage({ sessionId, ...image }));
                opened.onState((state) => onStatus?.(state));
                opened.onClose((reason) => onStatus?.(reason ?? 'closed'));
                term.onData((data) => opened.sendText(data));
                opened.resize(term.cols, term.rows);
            })
            .catch((error: unknown) => {
                if (disposed) return;
                onStatus?.(error instanceof Error ? error.message : String(error));
            });

        let resizeFrame: number | undefined;
        const resize = (): void => {
            cancelAnimationFrame(resizeFrame ?? 0);
            resizeFrame = requestAnimationFrame(() => {
                if (disposed) return;
                fit.fit();
                setTerminalColumns(sessionId, term.cols);
                channel?.resize(term.cols, term.rows);
            });
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(element);
        window.addEventListener('resize', resize);
        const dpr = (): number => window.devicePixelRatio || 1;
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
        const onTouchStart = (event: TouchEvent): void => {
            velocity = 0;
            momentumRunning = false;
            touchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
            touchT = performance.now();
            scrollAcc = 0;
            gesturePx = 0;
            if (event.touches.length === 2) {
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
                channel?.resize(term.cols, term.rows);
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
            if (event.touches.length < 2) pinchDistance = 0;
            touchY = null;
            gesturePx = 0;
            if (!momentumRunning && Math.abs(velocity) >= 0.5) {
                momentumRunning = true;
                requestAnimationFrame(momentum);
            }
        };
        const onVisibility = (): void => {
            if (document.visibilityState !== 'visible') return;
            if (webgl === undefined) attachWebgl();
        };
        element.addEventListener('wheel', onWheel, { capture: true, passive: false });
        element.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
        element.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
        element.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
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
            document.removeEventListener('visibilitychange', onVisibility);
            channelRef.current = undefined;
            onChannel?.(undefined);
            channel?.close();
            controller.abort();
            term.dispose();
        };
    }, [sessionId, onStatus, onChannel]);

    return (
        <View style={{ flex: 1, position: 'relative', backgroundColor: '#0c0c0b' }}>
            <View ref={hostRef} style={{ flex: 1, backgroundColor: '#0c0c0b' }} />
            {visibleImage !== null && (
                <View style={{ position: 'absolute', left: 12, right: 12, bottom: 8, zIndex: 30, minHeight: 120, height: '42%', maxHeight: 420, overflow: 'hidden', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: '#0c0c0b', boxShadow: '0 6px 16px rgba(0,0,0,0.5)' }}>
                    <Image
                        source={{ uri: `data:${visibleImage.mime};base64,${visibleImage.bytes}` }}
                        style={{ width: '100%', height: '100%' }}
                        resizeMode="contain"
                        accessibilityLabel="Image from agent"
                    />
                    <Pressable
                        onPress={() => setInlineImage(null)}
                        accessibilityRole="button"
                        accessibilityLabel="Dismiss image"
                        style={{ position: 'absolute', top: 0, left: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)' }}
                    >
                        <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 20 }}>×</Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
});
