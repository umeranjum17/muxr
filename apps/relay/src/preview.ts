/**
 * Preview channels. Still a pipe -- just one that speaks TCP on one end.
 *
 * The host joins a channel and forwards it to a dev server on its own loopback.
 * A client joins the same channel and the relay opens an ephemeral TCP listener
 * for it, so the phone loads a plain `http://relay-host:port/` URL. Serving the
 * preview at a root path is the point: absolute asset paths, HMR websockets and
 * redirects all work without rewriting a single byte.
 *
 * The relay does not parse HTTP here. It moves bytes and tags them with a
 * connection id, because a browser opens several TCP connections per page.
 *
 * Deliberately off `routeEnvelope` and out of `PeerTable`: preview traffic is
 * bulk, so recording it would evict real session events from a replay log sized
 * for events, and a preview socket in the peer table would start receiving
 * session envelopes it cannot read.
 */

import { createServer, type Server, type Socket } from 'node:net';
import type { RawData, WebSocket } from 'ws';
import { decodePreviewFrame, encodePreviewFrame, PREVIEW_CLOSE, PREVIEW_DATA } from '@muxr/contract';

const UPSTREAM_POLL_MS = 50;
const UPSTREAM_WAIT_ATTEMPTS = 40;

/** `::ffff:192.168.1.5` and `192.168.1.5` are the same peer. */
function normalizeAddress(address: string | undefined): string {
    if (address === undefined) return '';
    return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

export class PreviewChannels {
    /** Channel -> host socket waiting for a client to open a listener for it. */
    private readonly upstreams = new Map<string, WebSocket>();
    private readonly listeners = new Set<Server>();

    joinMachine(channel: string, socket: WebSocket): void {
        this.upstreams.get(channel)?.close();
        this.upstreams.set(channel, socket);
        socket.on('close', () => {
            if (this.upstreams.get(channel) === socket) this.upstreams.delete(channel);
        });
    }

    /**
     * Forwards frames between a client that runs its own listener and the host.
     * The relay holds no socket of its own here, so the preview survives a relay
     * published only on 443 -- a tunnel, or any TLS front door.
     */
    async bridgeClient(channel: string, socket: WebSocket): Promise<void> {
        const upstream = await this.waitForUpstream(channel);
        if (upstream === undefined) {
            socket.close(1008, 'preview: no host on this channel');
            return;
        }
        this.upstreams.delete(channel);

        const copy = (from: WebSocket, to: WebSocket) => (data: RawData) => {
            // Decoded, not relayed blind: a malformed frame is dropped here
            // rather than handed to the other end.
            if (decodePreviewFrame(new Uint8Array(data as Buffer)) === undefined) return;
            if (to.readyState === to.OPEN) to.send(data as Buffer, { binary: true });
        };
        socket.on('message', copy(socket, upstream));
        upstream.on('message', copy(upstream, socket));

        const teardown = (): void => {
            if (socket.readyState === socket.OPEN) socket.close();
            if (upstream.readyState === upstream.OPEN) upstream.close();
        };
        socket.on('close', teardown);
        socket.on('error', teardown);
        upstream.on('close', teardown);
        upstream.on('error', teardown);
        socket.send(JSON.stringify({ type: 'preview.bridge' }));
    }

    /**
     * Opens the TCP listener this client will point a WebView at and reports the
     * port back over `socket`. Rejects when no host has joined the channel, so
     * the app can say so instead of showing a page that never loads.
     */
    async joinClient(
        channel: string,
        socket: WebSocket,
        _bindHost: string,
        remoteAddress: string | undefined,
    ): Promise<void> {
        // `ws` writes the 101 before it emits 'connection', so the host can
        // report its preview socket open a beat before the relay has registered
        // it -- and the client is told to connect off the back of that. Wait
        // rather than reject a channel that is about to exist.
        const upstream = await this.waitForUpstream(channel);
        if (upstream === undefined) {
            socket.close(1008, 'preview: no host on this channel');
            return;
        }
        this.upstreams.delete(channel);

        // Only the device that asked for this preview may connect. When the
        // websocket peer is loopback the client came through the local TLS
        // proxy, so its TCP connections arrive from its real interface address
        // and an exact-match ACL would reject the very device it protects.
        const allowed = normalizeAddress(remoteAddress);
        const proxied = allowed === '127.0.0.1' || allowed === '::1';

        const connections = new Map<number, Socket>();
        let nextConnId = 0;

        const server = createServer((tcp) => {
            if (!proxied && allowed !== '' && normalizeAddress(tcp.remoteAddress) !== allowed) {
                tcp.destroy();
                return;
            }
            nextConnId += 1;
            const connId = nextConnId;
            connections.set(connId, tcp);

            // ponytail: no backpressure. A large bundle buffers in ws until it
            // drains. Pause on upstream.bufferedAmount if it ever bites.
            tcp.on('data', (chunk: Buffer) => sendUp(connId, PREVIEW_DATA, new Uint8Array(chunk)));
            tcp.on('close', () => {
                connections.delete(connId);
                sendUp(connId, PREVIEW_CLOSE);
            });
            tcp.on('error', () => {
                connections.delete(connId);
                sendUp(connId, PREVIEW_CLOSE);
            });
        });

        const sendUp = (connId: number, flag: number, payload?: Uint8Array): void => {
            if (upstream.readyState === upstream.OPEN) {
                upstream.send(encodePreviewFrame(connId, flag, payload), { binary: true });
            }
        };

        upstream.on('message', (data: RawData) => {
            const frame = decodePreviewFrame(new Uint8Array(data as Buffer));
            if (frame === undefined) return;
            const tcp = connections.get(frame.connId);
            if (tcp === undefined) return;
            if (frame.flag === PREVIEW_CLOSE) {
                connections.delete(frame.connId);
                tcp.end();
                return;
            }
            if (frame.payload.length > 0) tcp.write(frame.payload);
        });

        const teardown = (): void => {
            this.listeners.delete(server);
            for (const tcp of connections.values()) tcp.destroy();
            connections.clear();
            server.close();
            if (socket.readyState === socket.OPEN) socket.close();
            if (upstream.readyState === upstream.OPEN) upstream.close();
        };
        socket.on('close', teardown);
        socket.on('error', teardown);
        upstream.on('close', teardown);
        upstream.on('error', teardown);

        const port = await new Promise<number | undefined>((resolve) => {
            server.once('error', () => resolve(undefined));
            // Bind wide, not on the relay's own host: the phone reaches this
            // port over the tailnet, not through the loopback the relay listens
            // on. The ACL above decides who may talk.
            server.listen(0, '0.0.0.0', () => {
                const address = server.address();
                resolve(typeof address === 'object' && address !== null ? address.port : undefined);
            });
        });

        if (port === undefined) {
            teardown();
            return;
        }
        this.listeners.add(server);
        socket.send(JSON.stringify({ type: 'preview.ready', port }));
    }

    private async waitForUpstream(channel: string): Promise<WebSocket | undefined> {
        for (let attempt = 0; attempt < UPSTREAM_WAIT_ATTEMPTS; attempt += 1) {
            const upstream = this.upstreams.get(channel);
            if (upstream !== undefined && upstream.readyState === upstream.OPEN) return upstream;
            await new Promise((resolve) => setTimeout(resolve, UPSTREAM_POLL_MS));
        }
        return undefined;
    }

    get activeListeners(): number {
        return this.listeners.size;
    }

    closeAll(): void {
        for (const server of this.listeners) server.close();
        this.listeners.clear();
        for (const socket of this.upstreams.values()) socket.terminate();
        this.upstreams.clear();
    }
}
