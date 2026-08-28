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
import { sync } from '@/catalog/sync';

// ponytail: fixed interval, no backoff. Make it adaptive if tile counts grow
// enough that the polling itself shows up in host CPU.
const POLL_MS = 3000;
/** Roughly one terminal viewport; the tile clips whatever does not fit. */
const MAX_LINES = 24;

function tail(text: string): string {
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed === '') return '';
    const lines = trimmed.split('\n');
    return lines.slice(-MAX_LINES).join('\n');
}

export const TerminalPreview = React.memo((props: { sessionId: string }) => {
    const [text, setText] = React.useState('');

    React.useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setInterval> | undefined;

        const read = (): void => {
            // 'visible' is a passive read: herdr never moves the application
            // viewport for it, so polling cannot disturb a live agent.
            void sync
                .request('pane.read', { sessionId: props.sessionId, source: 'visible' })
                .then((result) => {
                    if (alive) setText(tail(result.text));
                })
                .catch(() => {
                    /* pane gone or host busy -- keep the last frame */
                });
        };

        const start = (): void => {
            if (timer !== undefined) return;
            read();
            timer = setInterval(read, POLL_MS);
        };
        const stop = (): void => {
            if (timer === undefined) return;
            clearInterval(timer);
            timer = undefined;
        };

        // Tiles stay mounted behind a backgrounded app; polling there is pure
        // battery and relay traffic for pixels nobody can see.
        if (AppState.currentState === 'active') start();
        const subscription = AppState.addEventListener('change', (next) => {
            if (next === 'active') start();
            else stop();
        });

        return () => {
            alive = false;
            stop();
            subscription.remove();
        };
    }, [props.sessionId]);

    return (
        <View style={{ flex: 1, backgroundColor: '#0c0c0b', overflow: 'hidden' }} pointerEvents="none">
            <Text
                style={{
                    color: '#d8d8d2',
                    fontFamily: 'Menlo, Monaco, Courier New, monospace',
                    fontSize: 7,
                    lineHeight: 9,
                }}
            >
                {text}
            </Text>
        </View>
    );
});
