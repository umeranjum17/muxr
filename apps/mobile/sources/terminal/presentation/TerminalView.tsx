/**
 * Ghostty native terminal — iOS + Android.
 * Metro picks TerminalView.web.tsx on web (xterm.js).
 *
 * Same contract as the old WebView path: base64 frames from herdr go in,
 * keystrokes come out. No ANSI parsing on the RN side.
 *
 * Scroll is Ghostty's alone. herdr's scroll re-renders the screen, which this
 * view would draw as fresh output at the bottom — so instead of forwarding
 * drags, we seed Ghostty with herdr's scrollback at attach and let its own
 * buffer hold the past. One scrollback, not two fighting.
 */

import * as React from 'react';
import { View } from 'react-native';
import { TerminalView as GhosttyView, type TerminalViewRef } from 'expo-libghostty';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { openTerminal, type TerminalChannel } from '../application/OpenTerminal';
import { beginViewportCapture, recordTerminalOutput, setTerminalColumns } from '../application/recentOutput';

/**
 * One scroll message costs herdr one full-screen repaint whatever the line
 * count, so a fling should travel as one big jump, not as forty queued small
 * ones. The cap only guards against a runaway accumulator.
 */
const MAX_SCROLL_LINES = 400;
/** A scroll whose repaint never came back must not gate scrolling forever. */
const SCROLL_ACK_TIMEOUT_MS = 250;

export interface TerminalViewProps {
    sessionId: string;
    onStatus?: (status: string) => void;
    onChannel?: (channel: TerminalChannel | undefined) => void;
}

/** KeyboardAvoidingView animates through many intermediate sizes; wait for settle. */
const RESIZE_DEBOUNCE_MS = 120;

export const TerminalView = React.memo((props: TerminalViewProps) => {
    const { sessionId, onStatus, onChannel } = props;
    const termRef = React.useRef<TerminalViewRef>(null);
    const channelRef = React.useRef<TerminalChannel | undefined>(undefined);
    const openedRef = React.useRef(false);
    const lastSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pendingWritesRef = React.useRef<string[]>([]);
    const writeRafRef = React.useRef<number | undefined>(undefined);
    const pendingScrollRef = React.useRef(0);
    const scrollRafRef = React.useRef<number | undefined>(undefined);
    const scrollInFlightRef = React.useRef(false);
    const scrollAckTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const cancelCoalesce = (): void => {
        if (writeRafRef.current !== undefined) cancelAnimationFrame(writeRafRef.current);
        if (scrollRafRef.current !== undefined) cancelAnimationFrame(scrollRafRef.current);
        if (scrollAckTimerRef.current !== undefined) clearTimeout(scrollAckTimerRef.current);
        writeRafRef.current = undefined;
        scrollRafRef.current = undefined;
        scrollAckTimerRef.current = undefined;
        scrollInFlightRef.current = false;
        pendingWritesRef.current = [];
        pendingScrollRef.current = 0;
    };

    const flushWrites = (): void => {
        writeRafRef.current = undefined;
        const chunks = pendingWritesRef.current;
        pendingWritesRef.current = [];
        const view = termRef.current;
        if (view === null || chunks.length === 0) return;
        if (chunks.length === 1) {
            void view.write(chunks[0]!);
            return;
        }
        const decoded = chunks.map((chunk) => decodeBase64(chunk));
        let total = 0;
        for (const chunk of decoded) total += chunk.length;
        const all = new Uint8Array(total);
        let offset = 0;
        for (const chunk of decoded) {
            all.set(chunk, offset);
            offset += chunk.length;
        }
        void view.write(encodeBase64(all));
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
        const clamped = Math.max(-MAX_SCROLL_LINES, Math.min(MAX_SCROLL_LINES, lines));
        scrollInFlightRef.current = true;
        scrollAckTimerRef.current = setTimeout(settleScroll, SCROLL_ACK_TIMEOUT_MS);
        // A pane with mouse reporting on (nvim, lazygit, any full-screen TUI)
        // routes the wheel to whichever region the cell belongs to, so sending
        // nothing scrolls its sidebar forever. Ghostty reports rows only.
        // ponytail: centre cell, not the finger; carry x/y in onScroll to fix properly.
        const size = lastSizeRef.current;
        channelRef.current?.scroll(clamped, size === null
            ? undefined
            : { column: Math.floor(size.cols / 2), row: Math.floor(size.rows / 2) });
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
        },
        [onChannel, sessionId],
    );

    const attach = React.useCallback(
        (cols: number, rows: number) => {
            setTerminalColumns(sessionId, cols);
            const last = lastSizeRef.current;
            if (last !== null && last.cols === cols && last.rows === rows) return;
            lastSizeRef.current = { cols, rows };

            if (openedRef.current) {
                if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
                // ponytail: debounce only after attach; first size opens immediately.
                resizeTimerRef.current = setTimeout(() => {
                    // Resize records the size; the re-attach is what makes herdr
                    // draw the whole screen again. Ghostty reflows its grid on
                    // its own for a keyboard or a pinch, and herdr would keep
                    // sending diffs for a screen that no longer matches.
                    channelRef.current?.resize(cols, rows);
                    beginViewportCapture(sessionId);
                    channelRef.current?.repaint();
                }, RESIZE_DEBOUNCE_MS);
                return;
            }
            openedRef.current = true;
            onStatus?.('connecting');
            // Nothing may be written to this terminal but herdr's own frames.
            // herdr paints cells at absolute coordinates and then sends diffs
            // against the screen it believes we are showing, so any byte we add
            // -- seeded history, a repaint, a cleared screen -- lands those
            // diffs on the wrong cells and quietly eats lines.
            void Promise.resolve()
                .then(() => openTerminal({ agentRoute: sessionId, size: { cols, rows } }))
                .then((channel) => {
                    channelRef.current = channel;
                    // The first thing herdr sends is the whole screen, so this
                    // attach is a viewport capture. Without it the chip has no
                    // viewport until the first scroll.
                    beginViewportCapture(sessionId);
                    // Same discipline as the web view: herdr repaint bursts
                    // arrive as many socket messages; one Ghostty write per
                    // frame instead of one per message.
                    channel.onData((base64) => {
                        recordTerminalOutput(sessionId, base64);
                        settleScroll();
                        pendingWritesRef.current.push(base64);
                        if (writeRafRef.current === undefined) {
                            writeRafRef.current = requestAnimationFrame(flushWrites);
                        }
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
                    if (latest !== null && (latest.cols !== cols || latest.rows !== rows)) {
                        if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
                        resizeTimerRef.current = undefined;
                        channel.resize(latest.cols, latest.rows);
                        beginViewportCapture(sessionId);
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
                fontSize={12}
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
                onScroll={({ nativeEvent }) => {
                    // The repaint herdr sends back is the new viewport; capture
                    // it for the link chip (see recentOutput.ts).
                    beginViewportCapture(sessionId);
                    pendingScrollRef.current -= nativeEvent.rows;
                    if (scrollRafRef.current === undefined) {
                        scrollRafRef.current = requestAnimationFrame(flushScroll);
                    }
                }}
            />
        </View>
    );
});
