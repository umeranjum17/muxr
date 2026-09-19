/**
 * xterm.js in the DOM. Web only -- Metro picks TerminalView.tsx on native.
 * Kitty APC bytes pass through untouched because xterm 6 has no APC handler.
 */

import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { IBufferLine, IDecoration } from '@xterm/xterm';
import type { TerminalCommand } from './FloatingTerminalControls';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import { openTerminalLink, TERMINAL_URL_PATTERN, terminalUrlAt } from '../domain/safeTerminalLink';
import { recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';
import { openExternalUrl } from '@/utils/openExternalUrl';

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
    /** Same contract as the native view; the browser has no view commands and
     *  no terminal IME, so the pane keeps its own keyboard fallback and the
     *  ring carries only the screen's own slots. */
    onViewControls?: (controls: { commands: TerminalCommand[]; dismissKeyboard: () => void }) => void;
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

const LONG_PRESS_MS = 500;

/** Cell ranges of plain http(s) URLs in one buffer line. The OSC 8 URI has
 *  no public per-cell API, so those links keep xterm's hover affordance and
 *  this only underlines plain text. */
function plainUrlCellRanges(line: IBufferLine, cols: number): { start: number; length: number }[] {
    let text = '';
    const cellOf: number[] = [];
    const scratch = line.getCell(0);
    for (let c = 0; c < cols; c++) {
        const filled = line.getCell(c, scratch);
        if (!filled) break;
        const ch = filled.getChars() || ' ';
        text += ch;
        for (let k = 0; k < ch.length; k++) cellOf.push(c);
    }
    const ranges: { start: number; length: number }[] = [];
    const pattern = new RegExp(TERMINAL_URL_PATTERN.source, 'g');
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        const start = cellOf[match.index];
        const end = cellOf[match.index + match[0].length - 1];
        if (start !== undefined && end !== undefined) ranges.push({ start, length: end - start + 1 });
    }
    return ranges;
}

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const hostRef = React.useRef<View | null>(null);
    const { sessionId, onStatus, onChannel } = props;
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    // Quiet, immediate confirmation for the long-press link copy.
    const [linkCopied, setLinkCopied] = React.useState(false);
    const hintTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const showLinkCopied = React.useCallback(() => {
        setLinkCopied(true);
        clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setLinkCopied(false), 1600);
    }, []);
    React.useEffect(() => () => clearTimeout(hintTimer.current), []);

    React.useEffect(() => {
        const element = hostRef.current as unknown as HTMLElement | null;
        if (element === null) return;
        element.style.position = 'relative';

        const term = new Terminal({
            // registerDecoration (plain-URL underlines) is a proposed API.
            allowProposedApi: true,
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: { background: '#0c0c0b' },
            convertEol: false,
            scrollback: 5000,
            cursorBlink: true,
            // OSC 8 hyperlinks: xterm falls back to a blocking confirm() with
            // a strongly worded warning when no handler is set. Route through
            // the app boundary, which drops non-web schemes instead.
            linkHandler: {
                activate: (_event, text) => openTerminalLink(text, openExternalUrl),
            },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        // Plain-text URLs ride the addon, but through the same boundary.
        term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri, openExternalUrl)));
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

        // Quiet discoverability: underline plain URLs as they render, one
        // decoration per range anchored to its buffer line, so it scrolls and
        // trims with the content and hides itself outside the viewport.
        // Keyed by buffer row: a render must not rescan every decoration on
        // the buffer just to know a row is already underlined.
        const linkDecorations = new Map<number, IDecoration>();
        term.onRender(({ start, end }) => {
            const buffer = term.buffer.active;
            for (let viewportRow = start; viewportRow <= end; viewportRow++) {
                const line = buffer.getLine(buffer.viewportY + viewportRow);
                if (!line) continue;
                const row = buffer.viewportY + viewportRow;
                if (linkDecorations.has(row)) continue;
                for (const range of plainUrlCellRanges(line, term.cols)) {
                    const marker = term.registerMarker(viewportRow - buffer.cursorY);
                    // A marker clamped off its row would re-register every
                    // render; drop it instead of leaking decorations.
                    if (marker.line !== row) {
                        marker.dispose();
                        continue;
                    }
                    const decoration = term.registerDecoration({ marker, x: range.start, width: range.length });
                    if (!decoration) {
                        marker.dispose();
                        continue;
                    }
                    decoration.onRender((el) => {
                        el.style.borderBottom = '1px solid rgba(190,188,180,0.4)';
                    });
                    marker.onDispose(() => linkDecorations.delete(row));
                    linkDecorations.set(row, decoration);
                }
            }
        });

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
        /** The exact plain URL under a cell, joined across wrapped rows (the OSC 8
         *  URI is not exposed per cell, so long-press covers plain URLs only;
         *  OSC 8 links still open on tap through the link handler). The row is
         *  viewport-relative and shifted into buffer space here: getLine and
         *  isWrapped speak absolute rows, and without the shift a scrolled-up
         *  pane would copy from the wrong line. */
        const findPlainTextLink = (viewportRow: number, col: number): string | null => {
            const buffer = term.buffer.active;
            const row = buffer.viewportY + viewportRow;
            const lineText = (r: number) => buffer.getLine(r)?.translateToString(true) ?? '';
            const lines: string[] = [lineText(row)];
            let topRow = row;
            for (;;) {
                if (topRow <= 0 || !buffer.getLine(topRow)?.isWrapped) break;
                const t = lineText(topRow - 1);
                lines.unshift(t);
                topRow--;
                if (t.includes(' ')) break;
            }
            let bottomRow = row;
            for (;;) {
                const next = buffer.getLine(bottomRow + 1);
                if (!next?.isWrapped) break;
                const t = lineText(bottomRow + 1);
                lines.push(t);
                bottomRow++;
                if (t.includes(' ')) break;
            }
            let anchor = 0;
            for (let i = 0; i < row - topRow; i++) anchor += lines[i].length;
            const at = anchor + Math.min(col, lines[row - topRow].length);
            return terminalUrlAt(lines.join(''), at);
        };
        const plainTextLinkAt = (clientX: number, clientY: number): string | null => {
            const rect = element.getBoundingClientRect();
            const col = Math.floor((clientX - rect.left) / (rect.width / term.cols));
            const row = Math.floor((clientY - rect.top) / cellHeight());
            if (col < 0 || col >= term.cols || row < 0) return null;
            return findPlainTextLink(row, col);
        };
        let longPressTimer: ReturnType<typeof setTimeout> | undefined;
        // Resolved at LONG_PRESS_MS while the finger is still down; written at
        // touchend. Writing mid-hold is rejected by the clipboard because the
        // user gesture has not completed yet.
        let longPressLink: string | null = null;
        let longPressAt: { x: number; y: number } | null = null;
        const clearLongPress = (): void => {
            clearTimeout(longPressTimer);
            longPressTimer = undefined;
            longPressAt = null;
            longPressLink = null;
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
            longPressLink = null;
            touchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
            touchT = performance.now();
            scrollAcc = 0;
            gesturePx = 0;
            if (event.touches.length === 1) {
                const touch = event.touches[0]!;
                longPressAt = { x: touch.clientX, y: touch.clientY };
                clearTimeout(longPressTimer);
                longPressTimer = setTimeout(() => {
                    longPressTimer = undefined;
                    if (longPressAt === null || Math.abs(gesturePx) >= 8) return;
                    longPressLink = plainTextLinkAt(longPressAt.x, longPressAt.y);
                }, LONG_PRESS_MS);
            } else {
                clearLongPress();
            }
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
            if (Math.abs(gesturePx) >= 8) clearLongPress();
            if (Math.abs(gesturePx) < 8) return;
            event.preventDefault();
            event.stopPropagation();
            scheduleScroll();
        };
        const onTouchEnd = (event: TouchEvent): void => {
            const link = longPressLink;
            clearLongPress();
            if (event.touches.length < 2) pinchDistance = 0;
            touchY = null;
            gesturePx = 0;
            // A resolved long-press must not also reach xterm's click-to-open:
            // the touchup would synthesize a click on the link we just copied.
            if (link !== null) {
                if (event.cancelable) event.preventDefault();
                void navigator.clipboard?.writeText(link).then(showLinkCopied).catch(() => {});
            }
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
        // Non-passive so a fired long-press can suppress the synthetic click.
        element.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            disposed = true;
            clearTimeout(longPressTimer);
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
    }, [sessionId, onStatus, onChannel, showLinkCopied]);

    return (
        // position: relative anchors the copy chip to the terminal, not the
        // screen.
        <View style={styles.root}>
            <View ref={hostRef} style={{ flex: 1, backgroundColor: '#0c0c0b' }} />
            {linkCopied && (
                <View style={styles.linkCopiedChip} pointerEvents="none" accessibilityLiveRegion="polite">
                    <Text style={styles.linkCopiedText}>Link copied</Text>
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: '#0c0c0b',
        // Anchors the copy chip (position: absolute) to the terminal.
        position: 'relative',
    },
    linkCopiedChip: {
        position: 'absolute',
        bottom: 16,
        alignSelf: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 12,
        backgroundColor: 'rgba(0,0,0,0.78)',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(255,255,255,0.16)',
        overflow: 'hidden',
    },
    linkCopiedText: {
        color: '#e0e0e0',
        fontSize: 12,
    },
});
