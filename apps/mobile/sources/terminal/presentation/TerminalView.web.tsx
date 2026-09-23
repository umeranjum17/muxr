/**
 * xterm.js in the DOM. Web only -- Metro picks TerminalView.tsx on native.
 * Kitty APC bytes pass through untouched because xterm 6 has no APC handler.
 */

import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { IBuffer, IMarker } from '@xterm/xterm';
import type { TerminalCommand } from './FloatingTerminalControls';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { claimTerminalAhead, rememberTerminalGrid } from '../application/terminalAhead';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import {
    joinedTerminalUrlRanges,
    openTerminalLink,
    plainLinkAtCell,
    safeTerminalLinkUrl,
    type TerminalLinkRow,
} from '../domain/safeTerminalLink';
import { recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';
import { FONT_STEPS, TERMINAL_FONTS, clampFontIndex } from '../domain/fontSteps';
import { useLocalSetting } from '@/catalog/store';
import { openExternalUrl } from '@/utils/openExternalUrl';

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
    onFirstFrameWritten?: () => void;
    /** Same contract as the native view; the browser has no view commands and
     *  no terminal IME, so the pane keeps its own keyboard fallback and the
     *  ring carries only the screen's own slots. */
    onViewControls?: (controls: { commands: TerminalCommand[]; dismissKeyboard: () => void }) => void;
    /** A printed link was reached for; the screen decides what to offer for it.
     *  Without a screen callback, taps open and holds copy. */
    onLinkPress?: (url: string, at?: { x: number; y: number }) => void;
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

const LONG_PRESS_MS = 500;
/**
 * A touch that travels this far sideways before 8px of scroll belongs to the
 * agent pager, which takes a drag at the same distance and steps aside at 8px
 * of vertical travel: whichever line a finger crosses first owns the drag.
 */
const SIDEWAYS_PX = 12;

/** Cell ranges of plain http(s) URLs to underline on one buffer row. The
 *  OSC 8 URI has no public per-cell API, so those links keep xterm's hover
 *  affordance and this only underlines plain text. Ranges come from the same
 *  wrapped-row join the tap and long-press resolve, so a soft-wrapped URL
 *  underlines continuously across all of its rows. */
function plainUrlCellRanges(buffer: IBuffer, cols: number, row: number): { start: number; length: number }[] {
    const line = buffer.getLine(row);
    if (!line) return [];
    const rowAt = (r: number): TerminalLinkRow | undefined => {
        const neighbor = buffer.getLine(r);
        // Padded, not trimmed: the underline covers the text a hit-test
        // resolves, and the join ends at erased tails.
        return neighbor ? { text: neighbor.translateToString(false), isWrapped: neighbor.isWrapped } : undefined;
    };
    return joinedTerminalUrlRanges(line, cols, row, rowAt);
}

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const hostRef = React.useRef<View | null>(null);
    const { sessionId, onStatus, onChannel, onLinkPress } = props;
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const firstFrameCallback = React.useRef(props.onFirstFrameWritten);
    firstFrameCallback.current = props.onFirstFrameWritten;
    // Quiet, immediate confirmation for the long-press link copy.
    const [linkCopied, setLinkCopied] = React.useState(false);
    const hintTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const showLinkCopied = React.useCallback(() => {
        setLinkCopied(true);
        clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setLinkCopied(false), 1600);
    }, []);
    React.useEffect(() => () => clearTimeout(hintTimer.current), []);
    // The size and face chosen in Settings. Read through a ref at creation so a
    // change restyles the open terminal instead of reconnecting it.
    const fontSize = FONT_STEPS[clampFontIndex(useLocalSetting('terminalFontIndex'))];
    const fontFamily = TERMINAL_FONTS[useLocalSetting('terminalFont')].family;
    const face = React.useRef({ fontSize, fontFamily });
    face.current = { fontSize, fontFamily };
    const restyle = React.useRef<(() => void) | undefined>(undefined);
    React.useEffect(() => { restyle.current?.(); }, [fontSize, fontFamily]);

    React.useEffect(() => {
        const element = hostRef.current as unknown as HTMLElement | null;
        if (element === null) return;
        element.style.position = 'relative';

        const term = new Terminal({
            // registerDecoration (plain-URL underlines) is a proposed API.
            allowProposedApi: true,
            fontSize: face.current.fontSize,
            fontFamily: face.current.fontFamily,
            theme: { background: '#0c0c0b' },
            convertEol: false,
            scrollback: 5000,
            cursorBlink: true,
            // OSC 8 hyperlinks: xterm falls back to a blocking confirm() with
            // a strongly worded warning when no handler is set. Route through
            // the app boundary, which drops non-web schemes instead.
            linkHandler: {
                activate: (event, text) => reachLink(text, event),
            },
        });
        // One rule on both terminals: reaching for a link asks what to do with
        // it rather than choosing for you. Only the gesture that can carry the
        // question differs, and only because the native grid's renderer handles
        // its own long press; nothing opens here without being chosen either.
        const reachLink = (url: string, event?: MouseEvent): void => {
            if (onLinkPress === undefined) { openTerminalLink(url, openExternalUrl); return; }
            const box = element.getBoundingClientRect();
            onLinkPress(url, event === undefined ? undefined : { x: event.clientX - box.left, y: event.clientY - box.top });
        };
        const fit = new FitAddon();
        term.loadAddon(fit);
        // Plain-text URLs ride the addon, but through the same boundary.
        term.loadAddon(new WebLinksAddon((event, uri) => reachLink(uri, event)));
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
        // Keyed by buffer row plus the row's text: rows are rewritten in place
        // (progress lines), so an entry revalidates against the text instead of
        // trusting row identity, while unchanged rows still skip the scan.
        const linkDecorations = new Map<number, { text: string; markers: IMarker[] }>();
        term.onRender(({ start, end }) => {
            const buffer = term.buffer.active;
            for (let viewportRow = start; viewportRow <= end; viewportRow++) {
                const line = buffer.getLine(buffer.viewportY + viewportRow);
                if (!line) continue;
                const row = buffer.viewportY + viewportRow;
                const text = line.translateToString(true);
                const cached = linkDecorations.get(row);
                if (cached) {
                    if (cached.text === text) continue;
                    for (const marker of cached.markers) marker.dispose();
                    linkDecorations.delete(row);
                    // This row's rewrite changes what a wrapped row below
                    // joins against; its cached underline re-derives there.
                    if (buffer.getLine(row + 1)?.isWrapped) {
                        const child = linkDecorations.get(row + 1);
                        if (child) {
                            for (const marker of child.markers) marker.dispose();
                            linkDecorations.delete(row + 1);
                        }
                    }
                }
                const markers: IMarker[] = [];
                for (const range of plainUrlCellRanges(buffer, term.cols, row)) {
                    const marker = term.registerMarker(row - (buffer.baseY + buffer.cursorY));
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
                    markers.push(marker);
                }
                if (markers.length > 0) linkDecorations.set(row, { text, markers });
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
        rememberTerminalGrid(term.cols, term.rows);
        // A page turn may already have opened this pane while it settled.
        const ahead = claimTerminalAhead(sessionId);
        const controller = ahead?.controller ?? new AbortController();
        void (ahead?.channel ?? openTerminal({
            agentRoute: sessionId,
            signal: controller.signal,
            size: { cols: term.cols, rows: term.rows },
        }))
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
                let pending: { data: string; host: boolean }[] = [];
                let firstFrameWritten = false;
                let frameScheduled = false;
                const flushFrames = (): void => {
                    frameScheduled = false;
                    if (disposed || pending.length === 0) return;
                    const chunks = pending;
                    pending = [];
                    for (const chunk of chunks) term.write(decodeBase64(chunk.data), () => {
                        if (!chunk.host || disposed || firstFrameWritten) return;
                        firstFrameWritten = true;
                        firstFrameCallback.current?.();
                    });
                };
                opened.onData((base64) => {
                    recordTerminalOutput(sessionId, base64);
                    pending.push({ data: base64, host: true });
                    if (!frameScheduled) {
                        frameScheduled = true;
                        requestAnimationFrame(flushFrames);
                    }
                });
                // Predicted echo joins the same ordered frame queue; it is not
                // host output, so it is never recorded as pane output.
                opened.onPredictedData((base64) => {
                    pending.push({ data: base64, host: false });
                    if (!frameScheduled) {
                        frameScheduled = true;
                        requestAnimationFrame(flushFrames);
                    }
                });
                opened.onState((state) => onStatus?.(state));
                opened.onClose((reason) => onStatus?.(reason ?? 'closed'));
                term.onData((data) => opened.sendText(data));
                opened.resize(term.cols, term.rows);
                // Opened ahead at another size, herdr's screen is the old one's.
                if (ahead !== undefined && (ahead.size.cols !== term.cols || ahead.size.rows !== term.rows)) opened.repaint();
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
                rememberTerminalGrid(term.cols, term.rows);
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
        restyle.current = () => {
            term.options.fontSize = face.current.fontSize;
            term.options.fontFamily = face.current.fontFamily;
            resize();
        };

        const cellHeight = (): number => {
            const css = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })
                ._core?._renderService?.dimensions?.css?.cell;
            return css?.height !== undefined && css.height > 0 ? css.height : 18;
        };
        const screen = element.querySelector('.xterm-screen') ?? element;
        const cellWidth = (): number => {
            const css = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } } })
                ._core?._renderService?.dimensions?.css?.cell;
            return css?.width !== undefined && css.width > 0 ? css.width : screen.getBoundingClientRect().width / term.cols;
        };
        /** The exact plain URL under a cell, joined across wrapped rows.
         *  The row is viewport-relative and shifted into buffer space here: getLine
         *  and isWrapped speak absolute rows, and without the shift a scrolled-up
         *  pane would resolve the wrong line. */
        const findPlainTextLink = (viewportRow: number, col: number): string | null => {
            const buffer = term.buffer.active;
            const row = buffer.viewportY + viewportRow;
            const lineRow = (r: number): TerminalLinkRow | undefined => {
                const line = buffer.getLine(r);
                // Padded, not trimmed: an erased tail leaves unwritten cells
                // that end the printed line, and a soft wrap across them must
                // not glue the child row onto the shortened parent.
                return line ? { text: line.translateToString(false), isWrapped: line.isWrapped } : undefined;
            };
            const tapped = buffer.getLine(row);
            if (!tapped) return null;
            return plainLinkAtCell(tapped, term.cols, col, row, lineRow);
        };
        const linkAt = (clientX: number, clientY: number): string | null => {
            const rect = screen.getBoundingClientRect();
            const col = Math.floor((clientX - rect.left) / cellWidth());
            const row = Math.floor((clientY - rect.top) / cellHeight());
            if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return null;
            const cell = term.buffer.active.getLine(term.buffer.active.viewportY + row)?.getCell(col) as {
                hasExtendedAttrs?: () => number; extended?: { urlId?: number };
            } | undefined;
            const id = cell?.hasExtendedAttrs?.() ? cell.extended?.urlId : undefined;
            const uri = id ? (term as unknown as {
                _core?: { _oscLinkService?: { getLinkData: (id: number) => { uri?: string } | undefined } };
            })._core?._oscLinkService?.getLinkData(id)?.uri : undefined;
            return uri !== undefined && safeTerminalLinkUrl(uri) !== null ? uri : findPlainTextLink(row, col);
        };
        let longPressTimer: ReturnType<typeof setTimeout> | undefined;
        // Resolved at LONG_PRESS_MS while the finger is still down; written at
        // touchend. Writing mid-hold is rejected by the clipboard because the
        // user gesture has not completed yet.
        let longPressLink: string | null = null;
        let longPressAt: { x: number; y: number } | null = null;
        // Where the resolved press landed, kept past clearLongPress so the menu
        // can open on the link rather than at a screen edge.
        let longPressPoint: { x: number; y: number } | null = null;
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
        let touchX = 0;
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
            touchX = event.touches.length === 1 ? event.touches[0]!.clientX : 0;
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
                    longPressLink = linkAt(longPressAt.x, longPressAt.y);
                    const box = element.getBoundingClientRect();
                    longPressPoint = { x: longPressAt.x - box.left, y: longPressAt.y - box.top };
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
            const sideways = Math.abs(event.touches[0]!.clientX - touchX);
            if (Math.abs(gesturePx) < 8 && sideways >= SIDEWAYS_PX) {
                // The page is turning; this touch no longer scrolls or presses.
                clearLongPress();
                touchY = null;
                return;
            }
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
                // A link has more than one thing you might want to do with it,
                // so the press asks, where it was pressed. Without a host to
                // ask, it still copies.
                if (onLinkPress !== undefined) onLinkPress(link, longPressPoint ?? undefined);
                else void navigator.clipboard?.writeText(link).then(showLinkCopied).catch(() => {});
            }
            longPressPoint = null;
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
            restyle.current = undefined;
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
    }, [sessionId, onStatus, onChannel, showLinkCopied, onLinkPress]);

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
