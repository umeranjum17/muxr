/**
 * Protocol-20 Herdr client socket. The host's graphics bridge is the client;
 * this is the server that handshake must satisfy.
 */
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:net';

const PROTOCOL_VERSION = 20;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_W = 32;
const IMAGE_H = 32;

export const DEFAULT_WORLD = {
    workspaces: [{ workspace_id: 'w1', label: '/tmp/demo', focused: true, active_tab_id: 't1', tab_count: 1 }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'demo' }],
    panes: [{
        pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/tmp/demo',
        focused: true, rect: { x: 0, y: 0, width: 80, height: 24 },
    }],
    agents: [],
};

export function frame(payload) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(payload.length);
    return Buffer.concat([length, payload]);
}

export function uint(value) {
    const number = BigInt(value);
    if (number < 251n) return Buffer.from([Number(number)]);
    if (number <= 0xffffn) {
        const data = Buffer.allocUnsafe(3);
        data[0] = 251;
        data.writeUInt16LE(Number(number), 1);
        return data;
    }
    if (number <= 0xffffffffn) {
        const data = Buffer.allocUnsafe(5);
        data[0] = 252;
        data.writeUInt32LE(Number(number), 1);
        return data;
    }
    const data = Buffer.allocUnsafe(9);
    data[0] = 253;
    data.writeBigUInt64LE(number, 1);
    return data;
}

export function welcomePayload() {
    // version 20, ignored field, error = None
    return Buffer.concat([uint(0), uint(PROTOCOL_VERSION), uint(0), uint(0)]);
}

export function outputPayload(bytes) {
    return Buffer.concat([
        uint(2), uint(0), uint(0), uint(0), uint(0),
        uint(bytes.length), bytes,
    ]);
}

export function tileRects(count) {
    if (count <= 1) return [{ x: 0, y: 0, width: 80, height: 24 }];
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const width = Math.max(1, Math.floor(80 / cols));
    const height = Math.max(1, Math.floor(24 / rows));
    return Array.from({ length: count }, (_, index) => ({
        x: (index % cols) * width,
        y: Math.floor(index / cols) * height,
        width,
        height,
    }));
}

/** Where each pane's own program would leave the cursor before printing. */
export function paneCursors(world) {
    const panes = world?.panes ?? DEFAULT_WORLD.panes;
    const tiles = tileRects(Math.max(1, panes.length));
    return panes.map((pane, index) => {
        const rect = pane?.rect ?? tiles[index] ?? tiles[0];
        return { row: rect.y + 1, col: rect.x + 1, paneId: pane?.pane_id ?? 'p1', rect };
    });
}

export function cursorInWorld(world) {
    const cursors = paneCursors(world);
    const panes = world?.panes ?? DEFAULT_WORLD.panes;
    const index = Math.max(0, panes.findIndex((pane) => pane.focused === true));
    return cursors[index] ?? cursors[0];
}

function kittyChunk({ row, col, imageId }) {
    const rgba = Buffer.alloc(IMAGE_W * IMAGE_H * 4);
    const red = (imageId * 37) & 255;
    const green = (imageId * 19) & 255;
    for (let offset = 0; offset < rgba.length; offset += 4) {
        rgba[offset] = red;
        rgba[offset + 1] = green;
        rgba[offset + 2] = 180;
        rgba[offset + 3] = 255;
    }
    const payload = rgba.toString('base64');
    // Transmit then place: the host's inline store only admits a=t|q, then routes a=p|T.
    return Buffer.from(
        `\u001b[${row};${col}H`
        + `\u001b_Ga=t,f=32,s=${IMAGE_W},v=${IMAGE_H},i=${imageId},m=0;${payload}\u001b\\`
        + `\u001b_Ga=p,i=${imageId},c=4,r=2;\u001b\\`,
    );
}

function readType(payload) {
    const prefix = payload[0];
    if (prefix === undefined) return -1;
    if (prefix <= 250) return prefix;
    return -1;
}

function serveClient(socket, world, frameHz, timers, isClosed) {
    let buffered = Buffer.alloc(0);
    let welcomed = false;
    let timer;
    const stop = () => {
        if (timer === undefined) return;
        clearInterval(timer);
        timers.delete(timer);
        timer = undefined;
    };
    const emit = (() => {
        // Every pane in turn, because any of them can be the one the phone has
        // attached: a single-pane emitter leaves the attached terminal empty and
        // proves nothing about the image path.
        const cursors = paneCursors(world);
        let imageId = 1;
        return () => {
            if (isClosed() || !socket.writable) {
                stop();
                return;
            }
            const cursor = cursors[imageId % cursors.length] ?? cursors[0];
            try {
                socket.write(frame(outputPayload(kittyChunk({ ...cursor, imageId }))));
                imageId += 1;
            } catch {
                stop();
            }
        };
    })();
    socket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4) {
            const length = buffered.readUInt32LE(0);
            if (length > MAX_MESSAGE_BYTES) {
                socket.destroy();
                return;
            }
            if (buffered.length < length + 4) break;
            const payload = buffered.subarray(4, length + 4);
            buffered = buffered.subarray(length + 4);
            const type = readType(payload);
            if (type === 0 && !welcomed) {
                welcomed = true;
                socket.write(frame(welcomePayload()));
                if (frameHz > 0) {
                    emit();
                    timer = setInterval(emit, Math.max(1, Math.round(1000 / frameHz)));
                    timers.add(timer);
                }
            } else if (type === 4) {
                stop();
                socket.end();
            }
        }
    });
    socket.on('close', stop);
    socket.on('error', stop);
}

export async function startGraphics({ socketPath, world = DEFAULT_WORLD, frameHz = 0 }) {
    try { unlinkSync(socketPath); } catch { /* leftover from a killed run */ }
    const sockets = new Set();
    const timers = new Set();
    let closed = false;
    const rate = Number(frameHz);
    const hz = Number.isFinite(rate) && rate > 0 ? rate : 0;
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        serveClient(socket, world, hz, timers, () => closed);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    return {
        close() {
            if (closed) return;
            closed = true;
            for (const timer of timers) clearInterval(timer);
            timers.clear();
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close();
            try { unlinkSync(socketPath); } catch { /* listen never created it */ }
        },
    };
}
