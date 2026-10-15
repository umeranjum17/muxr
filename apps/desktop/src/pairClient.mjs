/**
 * A small client of the running muxr host's private pairing socket
 * (`$MUXR_HOME/host/pair.sock`). This is the same socket `muxr pair` uses; the
 * host mints and refreshes the offer, and the desktop window only draws it and
 * approves the two words. No pairing logic lives here — only the wire.
 */
import { createConnection } from 'node:net';

/** Connect and drive one pairing session. Handlers carry the events the window shows. */
export function openPairingSocket(socketPath, handlers) {
    const socket = createConnection(socketPath);
    let input = '';
    let approve = (yes) => socket.write(`${JSON.stringify({ yes })}\n`);

    const receive = (event) => {
        if (event.offer) handlers.onOffer(event.offer);
        else if (event.approval) handlers.onApproval(event.approval);
        else if (event.result) handlers.onPaired(event.result);
        else if (event.error) handlers.onError(event.error);
    };

    socket.on('connect', () => {
        socket.write(`${JSON.stringify({ intent: { kind: 'native', authority: 'control', personal: false } })}\n`);
        handlers.onOpen?.();
    });
    socket.on('data', (chunk) => {
        input += chunk.toString('utf8');
        if (input.length > 1_000_000) { socket.destroy(); return; }
        const lines = input.split('\n');
        input = lines.pop() ?? '';
        for (const line of lines) {
            if (line.trim() === '') continue;
            try { receive(JSON.parse(line)); }
            catch { /* a partial or malformed line is ignored; the host never sends them */ }
        }
    });
    // A socket error (the host went away mid-session) is no message for the
    // window: the close that follows re-opens pairing, or the runtime reports
    // the host stopped. Only the host's own error events are shown.
    socket.on('error', (error) => handlers.onLost?.(error));
    socket.on('close', () => handlers.onClosed?.());

    return {
        approve: (yes) => approve(yes),
        close: () => socket.destroy(),
    };
}
