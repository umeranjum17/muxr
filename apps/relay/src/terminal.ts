/**
 * Terminal channels. The plainest pipe in the building.
 *
 * The host joins a channel as `machine` and streams herdr's NDJSON terminal
 * protocol; clients join the same channel and the relay forwards frames
 * verbatim: machine -> client, client -> machine. Text, never parsed.
 */

import type { RawData, WebSocket } from 'ws';

const UPSTREAM_POLL_MS = 50;
const UPSTREAM_WAIT_ATTEMPTS = 40;
const BUFFER_HIGH_BYTES = 512 * 1024;
const BUFFER_LOW_BYTES = BUFFER_HIGH_BYTES / 2;
const DRAIN_POLL_MS = 25;
/** A machine stream no client ever pairs with is orphaned cost -- and in
 * control mode a stolen pane. Give the client this long to show up. */
const UNPAIRED_TTL_MS = 30_000;

interface FlowControl {
    afterSend: () => void;
    release: () => void;
}

interface ClientBinding {
    socket: WebSocket;
    forwardMachine: (frame: string) => boolean;
    release: (closeUpstream: boolean) => void;
}

interface UpstreamEntry {
    socket: WebSocket;
    buffered: string[];
    bufferedBytes: number;
    prePairPause: symbol;
    client?: ClientBinding;
    unpairedTimer: NodeJS.Timeout | undefined;
    setUpstreamPaused: (reason: symbol, paused: boolean) => void;
    dispose: (closeSocket: boolean) => void;
}

function flowControl(destination: WebSocket, setSourcePaused: (paused: boolean) => void): FlowControl {
    let paused = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const clearDrainTimer = (): void => {
        if (drainTimer === undefined) return;
        clearInterval(drainTimer);
        drainTimer = undefined;
    };
    const check = (): void => {
        if (!paused && destination.bufferedAmount > BUFFER_HIGH_BYTES) {
            paused = true;
            setSourcePaused(true);
            drainTimer = setInterval(check, DRAIN_POLL_MS);
            drainTimer.unref();
        } else if (paused && destination.bufferedAmount <= BUFFER_LOW_BYTES) {
            paused = false;
            setSourcePaused(false);
            clearDrainTimer();
        }
    };

    return {
        afterSend: check,
        release: () => {
            clearDrainTimer();
            if (paused) {
                paused = false;
                setSourcePaused(false);
            }
        },
    };
}

export class TerminalChannels {
    /** Channel -> host socket streaming the pane, plus frames sent before a client joined. */
    private readonly upstreams = new Map<string, UpstreamEntry>();

    joinMachine(channel: string, socket: WebSocket, accept: (frame: string) => boolean = () => true): void {
        this.upstreams.get(channel)?.dispose(true);

        const pauseReasons = new Set<symbol>();
        const prePairPause = Symbol('pre-pair');
        let disposed = false;
        let entry: UpstreamEntry;

        const setUpstreamPaused = (reason: symbol, paused: boolean): void => {
            const wasPaused = pauseReasons.size > 0;
            if (paused) pauseReasons.add(reason);
            else pauseReasons.delete(reason);
            const isPaused = pauseReasons.size > 0;
            if (!wasPaused && isPaused) socket.pause();
            else if (wasPaused && !isPaused && socket.readyState === socket.OPEN) socket.resume();
        };
        const onMachineMessage = (data: RawData): void => {
            const frame = String(data);
            if (!accept(frame)) {
                socket.close(1008, 'terminal requires opaque v2 ciphertext');
                return;
            }
            if (entry.client !== undefined) {
                entry.client.forwardMachine(frame);
                return;
            }
            entry.buffered.push(frame);
            entry.bufferedBytes += Buffer.byteLength(frame);
            if (entry.bufferedBytes > BUFFER_HIGH_BYTES) setUpstreamPaused(prePairPause, true);
        };
        const onMachineError = (): void => { if (socket.readyState === socket.OPEN) socket.close(); };
        const onMachineClose = (): void => entry.dispose(false);
        const dispose = (closeSocket: boolean): void => {
            if (disposed) return;
            disposed = true;
            if (entry.unpairedTimer !== undefined) clearTimeout(entry.unpairedTimer);
            entry.client?.release(false);
            socket.off('message', onMachineMessage);
            socket.off('error', onMachineError);
            socket.off('close', onMachineClose);
            pauseReasons.clear();
            if (this.upstreams.get(channel) === entry) this.upstreams.delete(channel);
            if (closeSocket && (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)) socket.close();
        };

        entry = { socket, buffered: [], bufferedBytes: 0, prePairPause, unpairedTimer: undefined, setUpstreamPaused, dispose };
        this.upstreams.set(channel, entry);
        socket.on('message', onMachineMessage);
        socket.on('error', onMachineError);
        socket.on('close', onMachineClose);
        entry.unpairedTimer = setTimeout(() => {
            if (entry.client === undefined && socket.readyState === socket.OPEN) socket.close();
        }, UNPAIRED_TTL_MS);
        entry.unpairedTimer.unref();
    }

    /** Pair a client with the host side of `channel`, waiting briefly for the host. */
    async joinClient(channel: string, socket: WebSocket, accept: (frame: string) => boolean = () => true): Promise<void> {
        const entry = await this.waitForUpstream(channel);
        if (entry === undefined) {
            socket.close(1008, 'terminal: no host on this channel');
            return;
        }
        const upstream = entry.socket;

        // Transfer ownership before stale cleanup can observe the replacement.
        entry.client?.release(false);
        if (entry.unpairedTimer !== undefined) {
            clearTimeout(entry.unpairedTimer);
            entry.unpairedTimer = undefined;
        }

        const upstreamPause = Symbol('client-downlink');
        let clientPaused = false;
        let released = false;
        let binding: ClientBinding;
        const setClientPaused = (paused: boolean): void => {
            if (paused === clientPaused) return;
            clientPaused = paused;
            if (paused) socket.pause();
            else if (socket.readyState === socket.OPEN) socket.resume();
        };
        const toClient = flowControl(socket, (paused) => entry.setUpstreamPaused(upstreamPause, paused));
        const toUpstream = flowControl(upstream, setClientPaused);
        const teardown = (): void => binding.release(true);
        const onClientMessage = (data: RawData): void => {
            const frame = String(data);
            if (!accept(frame)) {
                socket.close(1008, 'terminal requires opaque v2 ciphertext');
                return;
            }
            if (upstream.readyState !== upstream.OPEN) {
                binding.release(true);
                return;
            }
            try {
                upstream.send(frame);
                toUpstream.afterSend();
            } catch {
                binding.release(true);
            }
        };

        binding = {
            socket,
            forwardMachine: (frame): boolean => {
                if (released || socket.readyState !== socket.OPEN) {
                    binding.release(true);
                    return false;
                }
                try {
                    socket.send(frame);
                    toClient.afterSend();
                    return true;
                } catch {
                    binding.release(true);
                    return false;
                }
            },
            release: (closeUpstream): void => {
                if (released) return;
                released = true;
                socket.off('message', onClientMessage);
                socket.off('close', teardown);
                socket.off('error', teardown);
                toClient.release();
                toUpstream.release();
                if (entry.client === binding) delete entry.client;
                if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close();
                if (closeUpstream && this.upstreams.get(channel) === entry
                    && (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING)) {
                    upstream.close();
                }
            },
        };
        socket.on('message', onClientMessage);
        socket.on('close', teardown);
        socket.on('error', teardown);
        entry.client = binding;

        const buffered = entry.buffered;
        entry.buffered = [];
        entry.bufferedBytes = 0;
        for (const frame of buffered) {
            if (!binding.forwardMachine(frame)) break;
        }
        entry.setUpstreamPaused(entry.prePairPause, false);
    }

    private async waitForUpstream(channel: string): Promise<UpstreamEntry | undefined> {
        for (let attempt = 0; attempt < UPSTREAM_WAIT_ATTEMPTS; attempt += 1) {
            const entry = this.upstreams.get(channel);
            if (entry !== undefined && entry.socket.readyState === entry.socket.OPEN) return entry;
            await new Promise((resolve) => setTimeout(resolve, UPSTREAM_POLL_MS));
        }
        return undefined;
    }

    closeAll(): void {
        for (const entry of [...this.upstreams.values()]) {
            entry.dispose(false);
            entry.socket.terminate();
        }
        this.upstreams.clear();
    }
}
