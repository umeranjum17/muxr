/**
 * Terminal channels. The plainest pipe in the building.
 *
 * The host joins a channel as `machine` and streams herdr's NDJSON terminal
 * protocol; clients join the same channel and the relay forwards frames
 * verbatim: machine -> all clients, any client -> machine. Text, never parsed.
 *
 * Same reasons as preview for living off `routeEnvelope` and out of `PeerTable`:
 * frame traffic is bulk, and a terminal socket must never receive session
 * envelopes it cannot read.
 */

import type { RawData, WebSocket } from 'ws';

const UPSTREAM_POLL_MS = 50;
const UPSTREAM_WAIT_ATTEMPTS = 40;
/** Frames held for a client that has not connected yet. Enough for a full paint. */
const BUFFER_LIMIT = 512;
/** A machine stream no client ever pairs with is orphaned cost -- and in
 * control mode a stolen pane. Give the client this long to show up. */
const UNPAIRED_TTL_MS = 30_000;

interface ClientBinding {
    socket: WebSocket;
    release: (closeUpstream: boolean) => void;
}

interface UpstreamEntry {
    socket: WebSocket;
    buffered: string[];
    paired: boolean;
    client?: ClientBinding;
}

export class TerminalChannels {
    /** Channel -> host socket streaming the pane, plus frames sent before a client joined. */
    private readonly upstreams = new Map<string, UpstreamEntry>();

    joinMachine(channel: string, socket: WebSocket, accept: (frame: string) => boolean = () => true): void {
        // One stream per pane: a re-attach replaces the stale host side.
        this.upstreams.get(channel)?.socket.close();
        const entry: UpstreamEntry = { socket, buffered: [], paired: false };
        this.upstreams.set(channel, entry);
        // herdr paints the whole screen in its first frames, which land before
        // the client has finished connecting. Hold them or the terminal opens blank.
        socket.on('message', (data: RawData) => {
            const frame = String(data);
            if (!accept(frame)) {
                socket.close(1008, 'terminal requires opaque v2 ciphertext');
                return;
            }
            if (!entry.paired && entry.buffered.length < BUFFER_LIMIT) entry.buffered.push(frame);
        });
        socket.on('close', () => {
            if (this.upstreams.get(channel) === entry) this.upstreams.delete(channel);
        });
        const unpairedTimer = setTimeout(() => {
            if (!entry.paired && socket.readyState === socket.OPEN) socket.close();
        }, UNPAIRED_TTL_MS);
        unpairedTimer.unref();
        socket.on('close', () => clearTimeout(unpairedTimer));
    }

    /**
     * Pair a client with the host side of `channel`. Waits briefly for the host
     * to arrive (same 101 race as preview): the host joins on `terminal.attach`
     * and the client connects off the back of that response.
     */
    async joinClient(channel: string, socket: WebSocket, accept: (frame: string) => boolean = () => true): Promise<void> {
        const entry = await this.waitForUpstream(channel);
        if (entry === undefined) {
            socket.close(1008, 'terminal: no host on this channel');
            return;
        }
        const upstream = entry.socket;

        // A reconnect can complete before the relay observes the old TCP close.
        // Transfer ownership first: stale cleanup may close the old client, but
        // it must never close the upstream now serving its replacement.
        entry.client?.release(false);

        for (const frame of entry.buffered.splice(0)) socket.send(frame);
        entry.paired = true;

        const onClientMessage = (data: RawData): void => {
            const frame = String(data);
            if (!accept(frame)) {
                socket.close(1008, 'terminal requires opaque v2 ciphertext');
                return;
            }
            if (upstream.readyState === upstream.OPEN) upstream.send(frame);
        };
        const onUpstreamMessage = (data: RawData): void => {
            const frame = String(data);
            if (!accept(frame)) {
                upstream.close(1008, 'terminal requires opaque v2 ciphertext');
                return;
            }
            if (socket.readyState === socket.OPEN) socket.send(frame);
        };

        socket.on('message', onClientMessage);
        upstream.on('message', onUpstreamMessage);

        let released = false;
        const binding: ClientBinding = {
            socket,
            release: (closeUpstream): void => {
                if (released) return;
                released = true;
                socket.off('message', onClientMessage);
                socket.off('close', teardown);
                socket.off('error', teardown);
                upstream.off('message', onUpstreamMessage);
                upstream.off('close', teardown);
                upstream.off('error', teardown);
                if (entry.client === binding) delete entry.client;
                if (socket.readyState === socket.OPEN) socket.close();
                if (
                    closeUpstream &&
                    this.upstreams.get(channel) === entry &&
                    upstream.readyState === upstream.OPEN
                ) {
                    upstream.close();
                }
            },
        };
        const teardown = (): void => binding.release(true);
        entry.client = binding;

        // A terminal stream exists to serve its current client. A clientless
        // control stream is not neutral: it holds a --takeover on someone's
        // pane, so a dead phone ends it unless a replacement already owns it.
        socket.on('close', teardown);
        socket.on('error', teardown);
        upstream.on('close', teardown);
        upstream.on('error', teardown);
    }

    private async waitForUpstream(
        channel: string,
    ): Promise<UpstreamEntry | undefined> {
        for (let attempt = 0; attempt < UPSTREAM_WAIT_ATTEMPTS; attempt += 1) {
            const entry = this.upstreams.get(channel);
            if (entry !== undefined && entry.socket.readyState === entry.socket.OPEN) return entry;
            await new Promise((resolve) => setTimeout(resolve, UPSTREAM_POLL_MS));
        }
        return undefined;
    }

    closeAll(): void {
        for (const entry of this.upstreams.values()) entry.socket.terminate();
        this.upstreams.clear();
    }
}
