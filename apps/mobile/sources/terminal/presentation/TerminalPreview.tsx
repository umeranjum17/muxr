/**
 * Terminal thumbnail for session cards and the pane grid. One implementation
 * for web and native -- plain text, no xterm, no WebView.
 *
 * Observe streams cost a herdr subprocess, a relay channel and (on native) a
 * WebView PER TILE, so a grid of panes was a subprocess storm on the host and
 * a memory storm on the phone. A periodic `pane.read` of the visible screen is
 * one socket round trip per tile instead, and ANSI-stripped text renders in a
 * Text node. Thumbnails lose colour; the live terminal screen still has it.
 */

import * as React from 'react';
import { AppState, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { sync } from '@/catalog/sync';

// ponytail: fixed interval, no backoff. Make it adaptive if tile counts grow
// enough that the polling itself shows up in host CPU.
const POLL_MS = 3000;
/** Roughly one terminal viewport; the tile clips whatever does not fit. */
const MAX_LINES = 24;

function tail(text: string, maxLines: number, nonEmpty: boolean): string {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed === '') return '';
    const lines = trimmed.split('\n');
    const kept = nonEmpty ? lines.filter((line) => line.trim() !== '') : lines;
    return kept.slice(-maxLines).join('\n');
}

/** What a snapshot tile knows about its text: never 'live' unless it polls. */
export type TerminalPreviewState =
    | { kind: 'loading' }
    | { kind: 'ready'; at: number }
    | { kind: 'empty'; at: number }
    | { kind: 'failed' };

export const TerminalPreview = React.memo((props: {
    sessionId: string;
    paused?: boolean;
    live?: boolean;
    /** Last N lines to keep; the default is about one viewport. */
    maxLines?: number;
    /** Keep only non-empty lines, for a short card snapshot. */
    nonEmpty?: boolean;
    /** Snapshot state for a card that labels its preview honestly. */
    onState?: (state: TerminalPreviewState) => void;
}) => {
    const { theme } = useUnistyles();
    const [text, setText] = React.useState('');
    const maxLines = props.maxLines ?? MAX_LINES;
    const nonEmpty = props.nonEmpty === true;
    const onStateRef = React.useRef(props.onState);
    onStateRef.current = props.onState;

    React.useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setInterval> | undefined;

        const read = (): void => {
            // 'visible' is a passive read: herdr never moves the application
            // viewport for it, so polling cannot disturb a live agent.
            void sync
                .request('pane.read', { sessionId: props.sessionId, source: 'visible' })
                .then((result) => {
                    if (!alive) return;
                    const next = tail(result.text, maxLines, nonEmpty);
                    setText(next);
                    onStateRef.current?.(next === '' ? { kind: 'empty', at: Date.now() } : { kind: 'ready', at: Date.now() });
                })
                .catch(() => {
                    /* pane gone or host busy -- keep the last frame */
                    if (alive) onStateRef.current?.({ kind: 'failed' });
                });
        };

        const start = (): void => {
            if (timer !== undefined) return;
            read();
            if (props.live !== false) timer = setInterval(read, POLL_MS);
        };
        const stop = (): void => {
            if (timer === undefined) return;
            clearInterval(timer);
            timer = undefined;
        };

        // Tiles stay mounted behind a backgrounded app or outside the strip's
        // viewport; polling there is pure battery and relay traffic.
        if (AppState.currentState === 'active' && props.paused !== true) start();
        const subscription = AppState.addEventListener('change', (next) => {
            if (next === 'active' && props.paused !== true) start();
            else stop();
        });

        return () => {
            alive = false;
            stop();
            subscription.remove();
        };
    }, [props.live, props.paused, props.sessionId, maxLines, nonEmpty]);

    return (
        // A thumbnail of the last frame: one image to assistive tech, and its
        // text stays at the 11px floor rather than a 7px texture.
        <View
            accessibilityRole="image"
            accessibilityLabel="Terminal preview"
            importantForAccessibility="no-hide-descendants"
            style={{ flex: 1, backgroundColor: theme.colors.terminal.background, overflow: 'hidden' }}
            pointerEvents="none"
        >
            <Text
                style={{
                    color: theme.colors.terminal.stdout,
                    fontFamily: 'Menlo, Monaco, Courier New, monospace',
                    fontSize: 11,
                    lineHeight: 14,
                }}
            >
                {text}
            </Text>
        </View>
    );
});
