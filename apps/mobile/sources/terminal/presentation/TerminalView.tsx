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
import { FloatingTerminalControls } from './FloatingTerminalControls';
import { AppState, PixelRatio, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { TerminalView as GhosttyView, type TerminalViewRef } from 'expo-libghostty';
import { useLocalSetting } from '@/catalog/store';
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
/** Text zoom reflows the terminal; graphics zoom magnifies its existing surface. */
const FONT_STEPS = [8, 10, 12, 14, 17, 20] as const;
const DEFAULT_FONT_INDEX = 2;
const GRAPHICS_ZOOM_STEPS = [1, 1.25, 1.5, 2] as const;

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
    onActions?: () => void;
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

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const { sessionId, onStatus, onChannel } = props;
    const [viewport, setViewport] = React.useState({ width: 0, height: 0 });
    const autoShowKeyboard = useLocalSetting('terminalAutoShowKeyboard');
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
    const scrollOriginRef = React.useRef<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
    const scrollRafRef = React.useRef<number | undefined>(undefined);
    const scrollInFlightRef = React.useRef(false);
    const scrollAckTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const scrollSentAtRef = React.useRef<number | undefined>(undefined);
    const graphicsActiveRef = React.useRef(false);
    const [fontIndex, setFontIndex] = React.useState(DEFAULT_FONT_INDEX);
    const [scaleIndex, setScaleIndex] = React.useState(0);
    const scaleIndexRef = React.useRef(0);

    const zoomScale = useSharedValue(1), panX = useSharedValue(0), panY = useSharedValue(0);
    const panStartX = useSharedValue(0), panStartY = useSharedValue(0);
    React.useEffect(() => {
        const scale = graphicsActive ? GRAPHICS_ZOOM_STEPS[scaleIndex] : 1;
        zoomScale.value = scale;
        const boundX = viewport.width * (scale - 1) / 2, boundY = viewport.height * (scale - 1) / 2;
        panX.value = Math.max(-boundX, Math.min(boundX, panX.value));
        panY.value = Math.max(-boundY, Math.min(boundY, panY.value));
    }, [graphicsActive, scaleIndex, viewport.width, viewport.height, zoomScale, panX, panY]);
    // One finger still targets the program. Two fingers move the magnified
    // viewport, without resizing the remote app or reopening its connection.
    const pan = Gesture.Pan().minPointers(2).enabled(graphicsActive && scaleIndex > 0)
        .onStart(() => { panStartX.value = panX.value; panStartY.value = panY.value; })
        .onUpdate((event) => {
            const boundX = viewport.width * (zoomScale.value - 1) / 2;
            const boundY = viewport.height * (zoomScale.value - 1) / 2;
            panX.value = Math.max(-boundX, Math.min(boundX, panStartX.value + event.translationX));
            panY.value = Math.max(-boundY, Math.min(boundY, panStartY.value + event.translationY));
        });
    const surfaceStyle = useAnimatedStyle(() => ({ transform: [{ translateX: panX.value }, { translateY: panY.value }, { scale: zoomScale.value }] }));
    const cellFor = (size: { cellWidthPx?: number; cellHeightPx?: number }): { width: number; height: number } | undefined =>
        size.cellWidthPx === undefined || size.cellHeightPx === undefined ? undefined : { width: size.cellWidthPx, height: size.cellHeightPx };
    const applyGraphicsZoom = (index: number): void => {
        scaleIndexRef.current = index;
        setScaleIndex(index);
    };

    const zoom = (direction: 1 | -1): void => {
        if (graphicsActiveRef.current) {
            const next = Math.max(0, Math.min(GRAPHICS_ZOOM_STEPS.length - 1, scaleIndexRef.current + direction));
            if (next !== scaleIndexRef.current) applyGraphicsZoom(next);
            return;
        }
        setFontIndex((current) => Math.max(0, Math.min(FONT_STEPS.length - 1, current + direction)));
    };

    const resetZoom = (): void => {
        if (graphicsActiveRef.current) {
            if (scaleIndexRef.current !== 0) applyGraphicsZoom(0);
            return;
        }
        setFontIndex(DEFAULT_FONT_INDEX);
    };

    const atMaxZoom = graphicsActive ? scaleIndex >= GRAPHICS_ZOOM_STEPS.length - 1 : fontIndex >= FONT_STEPS.length - 1;
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
        const origin = scrollOriginRef.current;
        channelRef.current?.scroll(clamped, size === null ? undefined : {
            column: Math.min(size.cols - 1, Math.floor((origin ? origin.x / origin.width : .5) * size.cols)),
            row: Math.min(size.rows - 1, Math.floor((origin ? origin.y / origin.height : .5) * size.rows)),
            ...origin,
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
                            recoveryRequested = false;
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
                    // One Ghostty write at a time, in wire order. Graphics can
                    // update independent placements or delete an earlier image;
                    // they cannot be coalesced merely because graphics is true.
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
        <View onLayout={(event) => setViewport({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
            onTouchStart={({ nativeEvent }) => {
                // Ghostty fills this surface. Remember the gesture's origin,
                // not the last tapped control or the center of the whole pane.
                if (viewport.width <= 0 || viewport.height <= 0) return;
                // A new touch stops the old gesture; never deliver its queued
                // travel to the newly touched editor/sidebar.
                if (pendingScrollRef.current !== 0) recordTerminalScrollClamped(Math.abs(pendingScrollRef.current));
                pendingScrollRef.current = 0;
                scrollOriginRef.current = { x: Math.max(0, nativeEvent.locationX), y: Math.max(0, nativeEvent.locationY), ...viewport };
            }}
            style={{ flex: 1, backgroundColor: '#0c0c0b', overflow: 'hidden' }}>
            <GestureDetector gesture={pan}>
            <Animated.View style={[{ flex: 1 }, surfaceStyle]}>
            <GhosttyView
                ref={termRef}
                style={{ flex: 1 }}
                pointerMode={graphicsActive}
                autoShowKeyboard={autoShowKeyboard}
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
            </Animated.View>
            </GestureDetector>
            <FloatingTerminalControls width={viewport.width} height={viewport.height} commands={[
                ...(Platform.OS === 'android' ? [{ label: 'Open terminal keyboard', icon: 'keypad-outline' as const, dismiss: true,
                    run: () => { void termRef.current?.showKeyboard().catch(() => onStatus?.('Could not open keyboard')); } }] : []),
                { label: 'Zoom in', icon: 'add', run: () => zoom(1), disabled: atMaxZoom },
                { label: 'Zoom out', icon: 'remove', run: () => zoom(-1), disabled: atMinZoom },
                { label: 'Reset zoom', icon: 'refresh', run: resetZoom, disabled: atDefaultZoom },
                ...(props.onActions ? [{ label: 'Session actions', icon: 'construct-outline' as const, run: props.onActions, dismiss: true }] : []),
            ]} />
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
