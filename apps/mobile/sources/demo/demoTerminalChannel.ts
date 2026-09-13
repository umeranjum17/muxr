import { encodeBase64 } from '@/encryption/base64';
import type { OpenTerminalCommand, TerminalChannel, TerminalChannelState } from '@/terminal/application/OpenTerminal';
import { demoClient } from './demoClient';

/**
 * In-memory TerminalChannel behind the openTerminal() seam. Implements the
 * full channel contract — send/input/resize/scroll/repaint/disconnect/close —
 * against the demo transcript buffers. Production TerminalView.web renders
 * it untouched. No DOM, no sockets, no xterm import here.
 */

function toBase64Line(line: string): string {
    // Real Herdr frames carry CRLF and TerminalView.web sets convertEol:
    // false, so the fixture must too or every line staircases.
    return encodeBase64(new TextEncoder().encode(`${line}\r\n`), 'base64');
}

export function isDemoTerminalSession(sessionId: string): boolean {
    return demoClient.knows(sessionId);
}

export function openDemoTerminalChannel(command: OpenTerminalCommand): Promise<TerminalChannel> {
    const sessionId = command.agentRoute;
    const dataListeners = new Set<(base64: string) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    const stateListeners = new Set<(state: TerminalChannelState) => void>();
    let closed = false;
    let scrollback = 0;

    const emitState = (state: TerminalChannelState): void => {
        for (const listener of [...stateListeners]) listener(state);
    };

    // A fresh attach replays the backlog, then tails live appends.
    const offTranscript = demoClient.onTranscript((changedId, lines) => {
        if (closed || changedId !== sessionId) return;
        const latest = lines[lines.length - 1];
        if (latest === undefined) return;
        for (const listener of [...dataListeners]) listener(toBase64Line(latest));
    });

    const channel: TerminalChannel = {
        // Scripted transcript: no graphics, no pointer surface, no frame accounting.
        recordFrameWritten: () => {},
        onGraphics: () => () => {},
        pointer: () => {},
        onData: (listener) => {
            for (const line of demoClient.transcript(sessionId)) listener(toBase64Line(line));
            dataListeners.add(listener);
            return () => {
                dataListeners.delete(listener);
            };
        },
        onClose: (listener) => {
            closeListeners.add(listener);
            return () => {
                closeListeners.delete(listener);
            };
        },
        onState: (listener) => {
            stateListeners.add(listener);
            // In-memory replay has no socket to wait for.
            if (!closed) listener('live');
            return () => {
                stateListeners.delete(listener);
            };
        },
        sendText: (text) => {
            if (!closed) demoClient.writeInput(sessionId, text);
        },
        sendBytes: (base64) => {
            if (closed) return;
            try {
                const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
                demoClient.writeInput(sessionId, new TextDecoder().decode(bytes));
            } catch {
                // Undecodable input never reaches the transcript.
            }
        },
        resize: (_cols, _rows) => {
            // Recorded output has no grid to reflow; a repaint replays it.
        },
        scroll: (lines) => {
            scrollback = Math.max(0, scrollback + lines);
        },
        reconnect: () => {
            if (closed) return;
            emitState('reconnecting');
            setTimeout(() => {
                if (!closed) emitState('live');
            }, 300);
        },
        repaint: () => {
            if (closed) return;
            for (const line of demoClient.transcript(sessionId)) {
                for (const listener of [...dataListeners]) listener(toBase64Line(line));
            }
        },
        close: () => {
            if (closed) return;
            closed = true;
            offTranscript();
            for (const listener of [...closeListeners]) listener('closed');
        },
    };
    return Promise.resolve(channel);
}
