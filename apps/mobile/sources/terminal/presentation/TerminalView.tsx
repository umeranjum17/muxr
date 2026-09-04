/**
 * Ghostty native terminal — iOS + Android.
 * Metro picks TerminalView.web.tsx on web (xterm.js).
 *
 * Same contract as the old WebView path: base64 frames from herdr go in,
 * keystrokes come out. No ANSI parsing on the RN side.
 *
 * herdr owns the history, so a drag has to move herdr's viewport and be
 * repainted back. Ghostty's buffer holds only repaint diffs.
 *
 * Pointer mode (both platforms): tap emits a pointer click; drag scrolls the
 * pane. One gesture never emits pointer-drag and pane-scroll together.
 */

import * as React from 'react';
import { AppState, PixelRatio, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TerminalView as GhosttyView, type TerminalViewRef } from 'expo-libghostty';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import {
    recordTerminalGraphicsFrame,
    recordTerminalResize,
    recordTerminalScrollClamped,
    recordTerminalScrollLatency,
    recordTerminalScrollRows,
} from '@/catalog/infrastructure/connectionDiagnostics';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import { recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';
import { createTerminalWritePump, type TerminalWritePump } from '../application/terminalWritePump';
import type { TerminalGraphicsReason } from '@muxr/contract';

/**
 * One scroll message costs herdr one full-screen repaint whatever the line
 * count, so a fling should travel as one big jump, not as forty queued small
 * ones. The cap only guards against a runaway accumulator.
 */
const MAX_SCROLL_LINES = 400;
/** A scroll whose repaint never came back must not gate scrolling forever. */
const SCROLL_ACK_TIMEOUT_MS = 250;
/**
 * Zoom means two different things and both are real.
 *
 * On a text pane it is the font: Ghostty reflows, the grid changes, and herdr
 * repaints at the new size, so more or fewer columns of real text fit.
 *
 * On an image pane the grid must not change -- the program is laid out for it --
 * so zoom asks the program for more pixels per cell instead. The picture gets
 * sharper in the same box, and it costs bytes as the square of the step, which
 * is why the ladder is short and starts at one.
 */
const FONT_STEPS = [8, 10, 12, 14, 17, 20] as const;
const DEFAULT_FONT_INDEX = 2;
const RENDER_SCALE_STEPS = [1, 1.5, 2] as const;

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
}

/** KeyboardAvoidingView animates through many intermediate sizes; wait for settle. */
const RESIZE_DEBOUNCE_MS = 120;

function combineTextFrames(frames: readonly string[]): string {
    if (frames.length <= 1) return frames[0] ?? '';
    const decoded = frames.map((chunk) => decodeBase64(chunk));
    let total = 0;
    for (const chunk of decoded) total += chunk.length;
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of decoded) {
        all.set(chunk, offset);
        offset += chunk.length;
    }
    return encodeBase64(all);
}

/** Small, dark, always in the same corner: a control, not a decoration. */
const ZoomButton = (props: { label: string; glyph: 'add' | 'remove' | 'refresh'; onPress: () => void; disabled: boolean }): React.ReactElement => (
    <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        onPress={props.onPress}
        hitSlop={8}
        style={({ pressed }) => ({
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: props.disabled ? 0.35 : 1,
            backgroundColor: pressed ? 'rgba(70,70,68,0.96)' : 'rgba(28,28,27,0.82)',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.14)',
        })}
    >
        <Ionicons name={props.glyph} size={18} color="#e6e6e1" />
    </Pressable>
);

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const { sessionId, onStatus, onChannel } = props;
    const termRef = React.useRef<TerminalViewRef>(null);
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const openedRef = React.useRef(false);
    const lastSizeRef = React.useRef<{ cols: number; rows: number; cellWidthPx?: number; cellHeightPx?: number } | null>(null);
    const [graphicsActive, setGraphicsActive] = React.useState(false);
    const [graphicsReason, setGraphicsReason] = React.useState<TerminalGraphicsReason | undefined>();
    const pointerTouchesRef = React.useRef(0);
    const suppressPointerRef = React.useRef(false);
    const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const writePumpRef = React.useRef<TerminalWritePump | undefined>(undefined);
    const writeGenerationRef = React.useRef(0);
    const pendingScrollRef = React.useRef(0);
    const scrollRafRef = React.useRef<number | undefined>(undefined);
    const scrollInFlightRef = React.useRef(false);
    const scrollAckTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const scrollSentAtRef = React.useRef<number | undefined>(undefined);
    const graphicsActiveRef = React.useRef(false);
    const [fontIndex, setFontIndex] = React.useState(DEFAULT_FONT_INDEX);
    const [scaleIndex, setScaleIndex] = React.useState(0);
    const scaleIndexRef = React.useRef(0);

    /**
     * What the pane is told a cell is worth in pixels. On a text pane that is
     * simply the device's own cell. On an image pane a zoom asks the program for
     * more pixels per cell instead of more cells, because the program is laid
     * out for the grid it was given: the picture sharpens inside the same box,
     * and it costs bytes as the square of the step. Placement and pointer
     * mapping on the host are both ratio-based, so neither notices.
     */
    const cellFor = (size: { cellWidthPx?: number; cellHeightPx?: number }): { width: number; height: number } | undefined => {
        if (size.cellWidthPx === undefined || size.cellHeightPx === undefined) return undefined;
        const scale = graphicsActiveRef.current ? RENDER_SCALE_STEPS[scaleIndexRef.current] ?? 1 : 1;
        return { width: Math.round(size.cellWidthPx * scale), height: Math.round(size.cellHeightPx * scale) };
    };

    /**
     * A zoom on an image pane never changes the grid, so nothing re-attaches:
     * the pane is asked for a different amount of detail and the next frame
     * arrives sharper. The current level is resent with every later resize, or
     * a keyboard would quietly undo it.
     */
    const applyRenderScale = (index: number): void => {
        const size = lastSizeRef.current;
        const channel = channelRef.current;
        scaleIndexRef.current = index;
        setScaleIndex(index);
        if (size === null || channel === undefined) return;
        channel.resize(size.cols, size.rows, cellFor(size));
        channel.repaint();
    };

    const zoom = (direction: 1 | -1): void => {
        if (graphicsActiveRef.current) {
            const next = Math.max(0, Math.min(RENDER_SCALE_STEPS.length - 1, scaleIndexRef.current + direction));
            if (next !== scaleIndexRef.current) applyRenderScale(next);
            return;
        }
        setFontIndex((current) => Math.max(0, Math.min(FONT_STEPS.length - 1, current + direction)));
    };

    const resetZoom = (): void => {
        if (graphicsActiveRef.current) {
            if (scaleIndexRef.current !== 0) applyRenderScale(0);
            return;
        }
        setFontIndex(DEFAULT_FONT_INDEX);
    };

    const atMaxZoom = graphicsActive ? scaleIndex >= RENDER_SCALE_STEPS.length - 1 : fontIndex >= FONT_STEPS.length - 1;
    const atMinZoom = graphicsActive ? scaleIndex <= 0 : fontIndex <= 0;
    const atDefaultZoom = graphicsActive ? scaleIndex === 0 : fontIndex === DEFAULT_FONT_INDEX;

    const cancelCoalesce = (): void => {
        writeGenerationRef.current += 1;
        void writePumpRef.current?.cancel();
        writePumpRef.current = undefined;
        if (scrollRafRef.current !== undefined) cancelAnimationFrame(scrollRafRef.current);
        if (scrollAckTimerRef.current !== undefined) clearTimeout(scrollAckTimerRef.current);
        scrollRafRef.current = undefined;
        scrollAckTimerRef.current = undefined;
        scrollInFlightRef.current = false;
        pendingScrollRef.current = 0;
        scrollSentAtRef.current = undefined;
    };

    /**
     * Latest-wins gating: while one scroll's repaint is on the wire, new drag
     * and fling deltas pile into the accumulator instead of the network. Each
     * queued round trip behind a fling is felt as rubber-band lag; one bigger
     * jump repaints the same screen once.
     */
    const flushScroll = (): void => {
        scrollRafRef.current = undefined;
        if (scrollInFlightRef.current) return;
        const lines = Math.trunc(pendingScrollRef.current);
        pendingScrollRef.current = 0;
        if (lines === 0) return;
        // The clamp is a runaway guard, and a guard that discards a gesture in
        // silence is how a scroll comes to feel arbitrary. Count what it eats.
        const clamped = Math.max(-MAX_SCROLL_LINES, Math.min(MAX_SCROLL_LINES, lines));
        if (clamped !== lines) recordTerminalScrollClamped(Math.abs(lines - clamped));
        recordTerminalScrollRows(Math.abs(clamped));
        scrollInFlightRef.current = true;
        scrollSentAtRef.current = Date.now();
        scrollAckTimerRef.current = setTimeout(settleScroll, SCROLL_ACK_TIMEOUT_MS);
        const size = lastSizeRef.current;
        channelRef.current?.scroll(clamped, size === null ? undefined : {
            column: Math.floor(size.cols / 2),
            row: Math.floor(size.rows / 2),
        });
    };

    /** The repaint (or the timeout) releases the gate and drains what piled up. */
    const settleScroll = (): void => {
        if (!scrollInFlightRef.current) return;
        if (scrollAckTimerRef.current !== undefined) clearTimeout(scrollAckTimerRef.current);
        scrollAckTimerRef.current = undefined;
        scrollInFlightRef.current = false;
        if (Math.trunc(pendingScrollRef.current) !== 0 && scrollRafRef.current === undefined) {
            scrollRafRef.current = requestAnimationFrame(flushScroll);
        }
    };

    React.useEffect(
        () => () => {
            cancelCoalesce();
            if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
            onChannel?.(undefined);
            channelRef.current?.close();
            channelRef.current = undefined;
            openedRef.current = false;
            lastSizeRef.current = null;
            setGraphicsActive(false);
        },
        [onChannel, sessionId],
    );

    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (state) => {
            const size = lastSizeRef.current;
            const channel = channelRef.current;
            if (size === null || channel === undefined) return;
            if (state !== 'active') {
                suppressPointerRef.current = true;
                pointerTouchesRef.current = 0;
                scaleIndexRef.current = 0;
                setScaleIndex(0);
                setGraphicsActive(false);
                channel.resize(size.cols, size.rows);
                return;
            }
            suppressPointerRef.current = false;
            channel.resize(size.cols, size.rows, cellFor(size));
            channel.repaint();
        });
        return () => subscription.remove();
    }, []);

    const attach = React.useCallback(
        (cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number) => {
            recordTerminalResize(cols, rows, cellWidthPx, cellHeightPx);
            setTerminalColumns(sessionId, cols);
            const last = lastSizeRef.current;
            if (last !== null && last.cols === cols && last.rows === rows
                && last.cellWidthPx === cellWidthPx && last.cellHeightPx === cellHeightPx) return;
            lastSizeRef.current = { cols, rows, ...(cellWidthPx === undefined ? {} : { cellWidthPx }), ...(cellHeightPx === undefined ? {} : { cellHeightPx }) };

            if (openedRef.current) {
                if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
                // ponytail: debounce only after attach; first size opens immediately.
                resizeTimerRef.current = setTimeout(() => {
                    // Resize records the size; the re-attach is what makes herdr
                    // draw the whole screen again. Ghostty reflows its grid on
                    // its own for a keyboard or a pinch, and herdr would keep
                    // sending diffs for a screen that no longer matches.
                    channelRef.current?.resize(cols, rows, cellFor({ cellWidthPx, cellHeightPx }));
                    channelRef.current?.repaint();
                }, RESIZE_DEBOUNCE_MS);
                return;
            }
            openedRef.current = true;
            onStatus?.('connecting');
            const attachGen = writeGenerationRef.current;
            // Nothing may be written to this terminal but herdr's own frames.
            // herdr paints cells at absolute coordinates and then sends diffs
            // against the screen it believes we are showing, so any byte we add
            // -- seeded history, a repaint, a cleared screen -- lands those
            // diffs on the wrong cells and quietly eats lines.
            void Promise.resolve()
                .then(() => openTerminal({
                    agentRoute: sessionId,
                    size: { cols, rows, ...(cellWidthPx === undefined ? {} : { cellWidthPx }), ...(cellHeightPx === undefined ? {} : { cellHeightPx }) },
                }))
                .then((channel) => {
                    if (writeGenerationRef.current !== attachGen) {
                        channel.close();
                        return;
                    }
                    channelRef.current = channel;
                    void writePumpRef.current?.cancel();
                    let recoveryRequested = false;
                    writePumpRef.current = createTerminalWritePump({
                        write: async (bytes, graphics) => {
                            const view = termRef.current;
                            if (view === null) return;
                            await view.write(bytes);
                            channel.recordFrameWritten();
                            if (graphics !== true) return;
                            recordTerminalGraphicsFrame(bytes.length);
                            const sentAt = scrollSentAtRef.current;
                            if (sentAt !== undefined) {
                                scrollSentAtRef.current = undefined;
                                recordTerminalScrollLatency(Date.now() - sentAt);
                            }
                        },
                        combineText: combineTextFrames,
                        schedule: (run) => requestAnimationFrame(() => run()),
                        cancelSchedule: (handle) => cancelAnimationFrame(handle as number),
                        onRejected: () => {
                            if (writeGenerationRef.current !== attachGen) return;
                            onStatus?.('terminal write failed');
                            if (recoveryRequested) return;
                            recoveryRequested = true;
                            channel.repaint();
                        },
                    });
                    // Pointer takeover belongs to an image that really is the
                    // pane. For a program's small image above its own prompt the
                    // pane still owns scrolling and taps.
                    channel.onGraphics((active, reason, surface) => {
                        const live = suppressPointerRef.current ? false : active && surface !== 'inline';
                        graphicsActiveRef.current = live;
                        if (!live) {
                            scaleIndexRef.current = 0;
                            setScaleIndex(0);
                        }
                        setGraphicsActive(live);
                        setGraphicsReason(active ? undefined : reason);
                    });
                    // Same discipline as the web view: herdr repaint bursts
                    // arrive as many socket messages; one Ghostty write at a
                    // time. A pending full draw supersedes earlier pending
                    // graphics; a false frame is not a snapshot and must not
                    // drop an unwritten draw. Text is never mixed into a
                    // graphics payload.
                    channel.onData((base64, graphics) => {
                        if (graphics !== true) recordTerminalOutput(sessionId, base64);
                        settleScroll();
                        writePumpRef.current?.push(
                            typeof graphics === 'boolean' ? { bytes: base64, graphics } : { bytes: base64 },
                        );
                    });
                    channel.onState((state) => onStatus?.(state));
                    channel.onClose((reason) => onStatus?.(reason ?? 'closed'));
                    onChannel?.(channel);
                    onStatus?.('live');
                    // The keyboard can resize Ghostty while hosted attach is
                    // still waiting. Its debounce then has no channel to call;
                    // replay the latest size now or the prompt is painted below
                    // the visible grid until this screen is reopened.
                    const latest = lastSizeRef.current;
                    if (latest !== null && (latest.cols !== cols || latest.rows !== rows
                        || latest.cellWidthPx !== cellWidthPx || latest.cellHeightPx !== cellHeightPx)) {
                        if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
                        resizeTimerRef.current = undefined;
                        channel.resize(latest.cols, latest.rows, cellFor(latest));
                        channel.repaint();
                    }
                })
                .catch((error: unknown) => {
                    openedRef.current = false;
                    lastSizeRef.current = null;
                    const message = error instanceof Error ? error.message : String(error);
                    onStatus?.(message.includes('explicit takeover required') ? 'Controlled on another device — tap to take control' : message);
                });
        },
        [sessionId, onStatus, onChannel],
    );

    return (
        <View style={{ flex: 1, backgroundColor: '#0c0c0b' }}>
            <GhosttyView
                ref={termRef}
                style={{ flex: 1 }}
                pointerMode={graphicsActive}
                fontSize={FONT_STEPS[fontIndex]}
                theme={{ background: '#0c0c0b' }}
                onInput={({ nativeEvent }) => {
                    if (nativeEvent.data) channelRef.current?.sendBytes(nativeEvent.data);
                    else if (nativeEvent.text) channelRef.current?.sendText(nativeEvent.text);
                }}
                onResize={({ nativeEvent }) => {
                    attach(nativeEvent.cols, nativeEvent.rows, nativeEvent.cellWidthPx, nativeEvent.cellHeightPx);
                }}
                onTerminalPointer={({ nativeEvent }) => {
                    if (!graphicsActive || suppressPointerRef.current) return;
                    if (nativeEvent.phase === 'down') pointerTouchesRef.current += 1;
                    if (nativeEvent.phase === 'up') pointerTouchesRef.current = Math.max(0, pointerTouchesRef.current - 1);
                    if (nativeEvent.phase === 'move' && pointerTouchesRef.current > 1) return;
                    const scale = Platform.OS === 'ios' ? PixelRatio.get() : 1;
                    channelRef.current?.pointer(
                        nativeEvent.phase,
                        nativeEvent.x * scale,
                        nativeEvent.y * scale,
                        nativeEvent.width * scale,
                        nativeEvent.height * scale,
                    );
                }}
                // herdr owns the history, so a drag has to move herdr's
                // viewport and be repainted back to us. Ghostty's own buffer
                // holds nothing but repaint diffs; scrolling it shows garbage.
                // Ghostty counts rows the way the finger moved, herdr counts
                // them the way the text does, hence the negation.
                onScroll={({ nativeEvent }) => {
                    pendingScrollRef.current -= nativeEvent.rows;
                    if (scrollRafRef.current === undefined) {
                        scrollRafRef.current = requestAnimationFrame(flushScroll);
                    }
                }}
            />
            <View
                style={{ position: 'absolute', top: 10, right: 10, gap: 6 }}
                accessibilityRole="toolbar"
                accessibilityLabel="Terminal zoom"
            >
                {/* A pinch is the shortcut; these are the affordance, and the
                    only zoom a test can drive: one injected pointer cannot
                    pinch. On a text pane they buy columns, on an image pane
                    detail, and the labels stay the same either way so one flow
                    covers both. */}
                <ZoomButton label="Zoom in" glyph="add" onPress={() => zoom(1)} disabled={atMaxZoom} />
                <ZoomButton label="Zoom out" glyph="remove" onPress={() => zoom(-1)} disabled={atMinZoom} />
                <ZoomButton label="Reset zoom" glyph="refresh" onPress={resetZoom} disabled={atDefaultZoom} />
            </View>
            {graphicsReason !== undefined && (
                <View style={{
                    position: 'absolute',
                    left: 10,
                    right: 10,
                    bottom: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    borderRadius: 10,
                    paddingVertical: 9,
                    paddingLeft: 12,
                    paddingRight: 8,
                    backgroundColor: 'rgba(28, 28, 27, 0.96)',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.12)',
                }}>
                    <Text style={{ flex: 1, color: '#d8d8d4', fontSize: 12, lineHeight: 16 }}>
                        Graphics stopped. Retry brings them back to this phone and resizes Herdr on the desktop.
                    </Text>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Retry terminal graphics"
                        onPress={() => channelRef.current?.repaint(true)}
                        style={({ pressed }) => ({
                            minHeight: 36,
                            justifyContent: 'center',
                            borderRadius: 8,
                            paddingHorizontal: 12,
                            backgroundColor: pressed ? '#d7d7d2' : '#f2f2ed',
                        })}
                    >
                        <Text style={{ color: '#11110f', fontSize: 12, fontWeight: '600' }}>Retry</Text>
                    </Pressable>
                </View>
            )}
        </View>
    );
});
