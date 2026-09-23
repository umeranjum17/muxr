/**
 * Ghostty native terminal — iOS + Android.
 * Metro picks TerminalView.web.tsx on web (xterm.js).
 *
 * Same contract as the old WebView path: base64 frames from herdr go in,
 * keystrokes come out. No ANSI parsing on the RN side.
 *
 * herdr owns the history, so a drag has to move herdr's viewport and be
 * repainted back. Ghostty's buffer holds only repaint diffs.
 */

import * as React from 'react';
import type { TerminalCommand } from './FloatingTerminalControls';
import { AppState, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { TerminalView as GhosttyView, type TerminalViewRef } from 'expo-libghostty';

/**
 * The terminal surface's name in the accessibility tree, and the only handle
 * anything outside the app has on it: this app's views publish no resource ids,
 * and the native surface does not publish its own class name. It names the
 * region, never an internal identifier.
 */
export const TERMINAL_SURFACE_LABEL = 'Terminal surface';
import { useLocalSetting, useLocalSettingMutable } from '@/catalog/store';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import {
    recordTerminalResize,
    recordTerminalScrollClamped,
    recordTerminalScrollRows,
    recordTerminalScrollTimeout,
} from '@/catalog/diagnostics';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import { claimTerminalAhead, rememberTerminalGrid } from '../application/terminalAhead';
import { createTerminalScrollGate } from '../application/terminalScrollGate';
import { DEFAULT_FONT_INDEX, FONT_STEPS, clampFontIndex, nearestFontIndex } from '../domain/fontSteps';
import { openTerminalLink } from '../domain/safeTerminalLink';
import { recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';
import { createTerminalWritePump, type TerminalWritePump } from '../application/terminalWritePump';
import { openExternalUrl } from '@/utils/openExternalUrl';

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
    onFirstFrameWritten?: () => void;
    /** The pane hosts the control, so the ring can cover the accessory row. */
    onViewControls?: (controls: TerminalViewControls) => void;
    /**
     * A tap on a printed link offers actions instead of opening it outright
     * on both terminals. Web also offers them on a hold; the native renderer
     * owns its long press and only hands the tap up to this callback.
     */
    onLinkPress?: (url: string, at?: { x: number; y: number }) => void;
}

export type TerminalViewControls = {
    commands: TerminalCommand[];
    /** Take the IME down on the terminal's window. It does not drop the
     *  composer's focus, so callers dismiss that keyboard as well. */
    dismissKeyboard: () => void;
};


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
    const focused = useIsFocused();
    const [viewport, setViewport] = React.useState({ width: 0, height: 0 });
    const terminalKeyboardDisabled = useLocalSetting('terminalKeyboardDisabled');
    const termRef = React.useRef<TerminalViewRef>(null);
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const firstFrameCallback = React.useRef(props.onFirstFrameWritten);
    firstFrameCallback.current = props.onFirstFrameWritten;
    const openAbortRef = React.useRef<AbortController | undefined>(undefined);
    const openedRef = React.useRef(false);
    const lastSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const writePumpRef = React.useRef<TerminalWritePump | undefined>(undefined);
    const writeGenerationRef = React.useRef(0);
    const scrollGateRef = React.useRef<ReturnType<typeof createTerminalScrollGate> | undefined>(undefined);
    const scrollOriginRef = React.useRef<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
    scrollGateRef.current ??= createTerminalScrollGate({
        send: (lines) => {
            const size = lastSizeRef.current;
            const origin = scrollOriginRef.current;
            channelRef.current?.scroll(lines, size === null ? undefined : {
                column: Math.min(size.cols - 1, Math.floor((origin ? origin.x / origin.width : .5) * size.cols)),
                row: Math.min(size.rows - 1, Math.floor((origin ? origin.y / origin.height : .5) * size.rows)),
            });
        },
        onDiscarded: recordTerminalScrollClamped,
        onSent: recordTerminalScrollRows,
        onTimedOut: recordTerminalScrollTimeout,
        scheduleFrame: (run) => requestAnimationFrame(run),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
    });
    const scrollGate = scrollGateRef.current;
    // A standing device preference: the chosen size survives pane remounts and app restarts.
    const [fontIndex, setFontIndex] = useLocalSettingMutable('terminalFontIndex');
    const fontIndexRef = React.useRef(fontIndex);
    fontIndexRef.current = clampFontIndex(fontIndex);
    const safeFontIndex = fontIndexRef.current;

    const zoom = (direction: 1 | -1): void => {
        const next = clampFontIndex(fontIndexRef.current + direction);
        fontIndexRef.current = next;
        setFontIndex(next);
    };

    const resetZoom = (): void => {
        fontIndexRef.current = DEFAULT_FONT_INDEX;
        setFontIndex(DEFAULT_FONT_INDEX);
    };

    // A pinch steps the one text size every terminal shares, from the size it
    // began at, so the size it settles on survives a switch to the next agent.
    // The grid reports the pinch and leaves its own size alone either way.
    const pinchZoom = useLocalSetting('terminalPinchZoom');
    const pinchFrom = React.useRef(0);
    const pinch = ({ nativeEvent }: { nativeEvent: { phase: 'begin' | 'change' | 'end'; scale: number } }): void => {
        if (!pinchZoom || nativeEvent.phase === 'end') return;
        if (nativeEvent.phase === 'begin' || pinchFrom.current === 0) pinchFrom.current = FONT_STEPS[fontIndexRef.current];
        if (nativeEvent.phase === 'begin') return;
        const next = nearestFontIndex(pinchFrom.current * nativeEvent.scale);
        if (next === fontIndexRef.current) return;
        fontIndexRef.current = next;
        setFontIndex(next);
    };

    const atMaxZoom = safeFontIndex >= FONT_STEPS.length - 1;
    const atMinZoom = safeFontIndex <= 0;
    const atDefaultZoom = safeFontIndex === DEFAULT_FONT_INDEX;

    const cancelCoalesce = (): void => {
        writeGenerationRef.current += 1;
        void writePumpRef.current?.cancel();
        writePumpRef.current = undefined;
        scrollGate.reset();
    };

    React.useEffect(() => {
        if (!focused) return;
        const subscription = AppState.addEventListener('change', (state) => {
            const size = lastSizeRef.current;
            const channel = channelRef.current;
            if (size === null || channel === undefined) return;
            if (state !== 'active') {
                channel.resize(size.cols, size.rows);
                return;
            }
            channel.resize(size.cols, size.rows);
            channel.repaint();
        });
        return () => subscription.remove();
    }, [focused]);

    const attach = React.useCallback(
        (cols: number, rows: number) => {
            recordTerminalResize(cols, rows);
            setTerminalColumns(sessionId, cols);
            rememberTerminalGrid(cols, rows);
            const last = lastSizeRef.current;
            lastSizeRef.current = { cols, rows };
            if (!focused) return;
            if (openedRef.current && last !== null && last.cols === cols && last.rows === rows) return;

            if (openedRef.current) {
                if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
                // ponytail: debounce only after attach; first size opens immediately.
                resizeTimerRef.current = setTimeout(() => {
                    // Resize records the size; the re-attach is what makes herdr
                    // draw the whole screen again. Ghostty reflows its grid on
                    // its own for a keyboard or a pinch, and herdr would keep
                    // sending diffs for a screen that no longer matches.
                    channelRef.current?.resize(cols, rows);
                    channelRef.current?.repaint();
                }, RESIZE_DEBOUNCE_MS);
                return;
            }
            openedRef.current = true;
            onStatus?.('connecting');
            const attachGen = writeGenerationRef.current;
            // A page turn may already have opened this pane while it settled.
            const ahead = claimTerminalAhead(sessionId);
            const opened = ahead?.size ?? { cols, rows };
            const controller = ahead?.controller ?? new AbortController();
            openAbortRef.current = controller;
            // Nothing may be written to this terminal but herdr's own frames.
            // herdr paints cells at absolute coordinates and then sends diffs
            // against the screen it believes we are showing, so any byte we add
            // -- seeded history, a repaint, a cleared screen -- lands those
            // diffs on the wrong cells and quietly eats lines.
            void Promise.resolve()
                .then(() => ahead?.channel ?? openTerminal({
                    agentRoute: sessionId,
                    signal: controller.signal,
                    size: { cols, rows },
                }))
                .then((channel) => {
                    if (writeGenerationRef.current !== attachGen) {
                        channel.close();
                        return;
                    }
                    channelRef.current = channel;
                    void writePumpRef.current?.cancel();
                    let recoveryRequested = false;
                    let firstFrameWritten = false;
                    const latest = lastSizeRef.current ?? opened;
                    const needsRepaint = latest.cols !== opened.cols || latest.rows !== opened.rows;
                    let readyForFrame = !needsRepaint;
                    let repaintRequested = false;
                    // Nothing re-scrolls on attach. The pane's viewport belongs
                    // to herdr, which reports it back on `terminal.scroll-state`;
                    // a phone replaying a remembered distance was inventing a
                    // position, and on a pane with no scrollback that replay
                    // went to the program as a 5 000-row wheel burst.
                    writePumpRef.current = createTerminalWritePump({
                        write: async (bytes, ready) => {
                            const view = termRef.current;
                            if (view === null) return;
                            await view.write(bytes);
                            recoveryRequested = false;
                            channel.recordFrameWritten();
                            if (ready && !firstFrameWritten && writeGenerationRef.current === attachGen) {
                                firstFrameWritten = true;
                                firstFrameCallback.current?.();
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
                    // One Ghostty write at a time, in wire order.
                    channel.onData((base64) => {
                        recordTerminalOutput(sessionId, base64);
                        // Output came back, so the next scroll may go. A stream
                        // repaints itself whether or not anything was scrolled,
                        // so this is flow control and nothing more: which frame
                        // answered which scroll is not knowable here.
                        scrollGate.release();
                        writePumpRef.current?.push({ bytes: base64, ready: readyForFrame });
                    });
                    // Predicted echo rides the same ordered pump but is not
                    // host output: it never releases the scroll gate and is
                    // never recorded as pane output.
                    channel.onPredictedData((base64) => {
                        writePumpRef.current?.push({ bytes: base64 });
                    });
                    channel.onState((state) => {
                        if (repaintRequested && state === 'live') readyForFrame = true;
                        onStatus?.(state);
                    });
                    channel.onClose((reason) => onStatus?.(reason ?? 'closed'));
                    onChannel?.(channel);
                    // The keyboard can resize Ghostty while hosted attach is
                    // still waiting. Its debounce then has no channel to call;
                    // replay the latest size now or the prompt is painted below
                    // the visible grid until this screen is reopened.
                    if (needsRepaint) {
                        if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
                        resizeTimerRef.current = undefined;
                        channel.resize(latest.cols, latest.rows);
                        repaintRequested = true;
                        channel.repaint();
                    }
                })
                .catch((error: unknown) => {
                    if (writeGenerationRef.current !== attachGen) return;
                    openedRef.current = false;
                    lastSizeRef.current = null;
                    const message = error instanceof Error ? error.message : String(error);
                    onStatus?.(message.includes('explicit takeover required') ? 'Open on another device · Tap to use it here' : message);
                });
        },
        [focused, sessionId, onStatus, onChannel],
    );

    // Only the visible route controls a pane. Keep its measured grid and native
    // pixels while away, but reacquire a fresh stream when returning.
    useFocusEffect(React.useCallback(() => {
        const size = lastSizeRef.current;
        if (size !== null) attach(size.cols, size.rows);
        return () => {
            cancelCoalesce();
            clearTimeout(resizeTimerRef.current);
            const channel = channelRef.current;
            onChannel?.(undefined);
            channel?.close();
            openAbortRef.current?.abort();
            openAbortRef.current = undefined;
            channelRef.current = undefined;
            openedRef.current = false;
        };
    }, [attach, onChannel]));

    // The commands stay owned here — zoom steps and the terminal IME never
    // leave this view; only their descriptions travel up.
    const latest = React.useRef({ zoom, resetZoom, onStatus });
    latest.current = { zoom, resetZoom, onStatus };
    const { onViewControls } = props;
    // Only this view holds the terminal handle, so closing its IME stays here
    // and the pane is handed a callback instead of the ref.
    const dismissKeyboard = React.useCallback(() => {
        // Android hides the IME through this view's window token whichever view
        // raised it, and clears focus only when the terminal holds it; iOS
        // resigns first responder, which is what a tap on the grid already does.
        if (termRef.current === null) return;
        void termRef.current.hideKeyboard().catch(() => {});
    }, []);
    const viewControls = React.useMemo<TerminalViewControls>(() => ({
        dismissKeyboard,
        commands: [
            { label: 'Open terminal keyboard', icon: 'keyboard' as const,
                run: () => { void termRef.current?.showKeyboard().catch(() => latest.current.onStatus?.('Could not open keyboard')); } },
            { label: 'Zoom out', icon: 'minus' as const, run: () => latest.current.zoom(-1), disabled: atMinZoom },
            { label: 'Zoom in', icon: 'plus' as const, run: () => latest.current.zoom(1), disabled: atMaxZoom },
            { label: 'Reset zoom', icon: 'reset' as const, run: () => latest.current.resetZoom(), disabled: atDefaultZoom },
        ],
    }), [atDefaultZoom, atMaxZoom, atMinZoom, dismissKeyboard]);
    React.useEffect(() => { onViewControls?.(viewControls); }, [onViewControls, viewControls]);
    React.useEffect(() => () => onViewControls?.({ commands: [], dismissKeyboard: () => {} }), [onViewControls]);

    return (
        <View onLayout={(event) => setViewport({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
            onTouchStart={({ nativeEvent }) => {
                // Ghostty fills this surface. Remember the gesture's origin,
                // not the last tapped control or the center of the whole pane.
                if (viewport.width <= 0 || viewport.height <= 0) return;
                // A new touch stops the old gesture; never deliver its queued
                // travel to the newly touched editor/sidebar.
                scrollGate.beginGesture();
                scrollOriginRef.current = { x: Math.max(0, nativeEvent.locationX), y: Math.max(0, nativeEvent.locationY), ...viewport };
            }}
            style={{ flex: 1, backgroundColor: '#0c0c0b', overflow: 'hidden' }}>
            {/* The native surface renders as a plain android.view.View and does
                not publish its own class name, so this wrapper -- which is
                exactly the terminal's box -- carries the surface's name. */}
            <View accessible accessibilityLabel={TERMINAL_SURFACE_LABEL} style={{ flex: 1 }}>
            <GhosttyView
                ref={termRef}
                style={{ flex: 1 }}
                autoShowKeyboard={!terminalKeyboardDisabled}
                fontSize={FONT_STEPS[safeFontIndex]}
                theme={{ background: '#0c0c0b' }}
                onInput={({ nativeEvent }) => {
                    if (nativeEvent.data) channelRef.current?.sendBytes(nativeEvent.data);
                    else if (nativeEvent.text) channelRef.current?.sendText(nativeEvent.text);
                }}
                onResize={({ nativeEvent }) => {
                    attach(nativeEvent.cols, nativeEvent.rows);
                }}
                // herdr owns the history, so a drag has to move herdr's
                // viewport and be repainted back to us. Ghostty's own buffer
                // holds nothing but repaint diffs; scrolling it shows garbage.
                // Ghostty counts rows the way the finger moved, herdr counts
                // them the way the text does, hence the negation.
                onScroll={({ nativeEvent }) => scrollGate.queue(-nativeEvent.rows)}
                onPinch={pinch}
                onOpenLink={({ nativeEvent }) => {
                    if (props.onLinkPress !== undefined) { props.onLinkPress(nativeEvent.url); return; }
                    openTerminalLink(nativeEvent.url, openExternalUrl);
                }}
            />
            </View>
        </View>
    );
});
