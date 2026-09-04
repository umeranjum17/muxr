/**
 * Protocol-20 Herdr client socket. The host's graphics bridge is the client;
 * this is the server that handshake must satisfy.
 *
 * Frames are pane-sized: cols x rows x cell px from the world's phone
 * geometry, falling back to the measured 539x575 attach. The write path is
 * capped at the ~3 MB/s the real Herdr app-client socket sustains, so a burst
 * of paints queues instead of flushing instantly.
 */
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';

const PROTOCOL_VERSION = 20;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_IMAGE_WIDTH = 539;
const DEFAULT_IMAGE_HEIGHT = 575;
const DEFAULT_BYTES_PER_SECOND = 3 * 1024 * 1024;
const REQUEST_HZ = 60;

export const DEFAULT_WORLD = {
    workspaces: [{ workspace_id: 'w1', label: '/tmp/demo', focused: true, active_tab_id: 't1', tab_count: 1 }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'demo' }],
    panes: [{
        pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/tmp/demo',
        focused: true, rect: { x: 0, y: 0, width: 80, height: 24 },
    }],
    agents: [],
};

let activeRequestFrames = () => {};

/** `paneId` is the pane the phone is attached to, when the caller knows it. */
export function requestFrames(count, paneId) {
    activeRequestFrames(count, paneId);
}

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

function positiveInt(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function firstPositive(...values) {
    for (const value of values) {
        const n = positiveInt(value, 0);
        if (n > 0) return n;
    }
    return 0;
}

/** cols x rows x cell px from the world, else the measured phone attach. */
export function imageSizeFromWorld(world, overrides = {}) {
    const overrideWidth = positiveInt(overrides.imageWidth, 0);
    const overrideHeight = positiveInt(overrides.imageHeight, 0);
    if (overrideWidth > 0 && overrideHeight > 0) return { width: overrideWidth, height: overrideHeight };
    const phone = world?.phone ?? {};
    const focused = (world?.panes ?? []).find((pane) => pane?.focused === true) ?? world?.panes?.[0] ?? {};
    const rect = focused.rect ?? focused.geometry ?? {};
    const cols = firstPositive(phone.cols, world?.cols, focused.cols, rect.width);
    const rows = firstPositive(phone.rows, world?.rows, focused.rows, rect.height);
    const cellWidthPx = firstPositive(
        phone.cellWidthPx, phone.cell_width_px,
        world?.cellWidthPx, world?.cell_width_px,
        focused.cellWidthPx, focused.cell_width_px,
    );
    const cellHeightPx = firstPositive(
        phone.cellHeightPx, phone.cell_height_px,
        world?.cellHeightPx, world?.cell_height_px,
        focused.cellHeightPx, focused.cell_height_px,
    );
    if (cols > 0 && rows > 0 && cellWidthPx > 0 && cellHeightPx > 0) {
        return { width: cols * cellWidthPx, height: rows * cellHeightPx };
    }
    return {
        width: overrideWidth || DEFAULT_IMAGE_WIDTH,
        height: overrideHeight || DEFAULT_IMAGE_HEIGHT,
    };
}

function kittyChunk({ row, col, imageId, width, height, rgba, cols, rows, proof = false }) {
    // Cheap unique fill: one byte for the field, then a 32-bit stamp so two
    // consecutive payloads cannot be byte-identical even if the fill wrapped.
    rgba.fill((imageId * 37) & 255);
    // PR-only opaque checkerboard: identifiable in the phone framebuffer,
    // unlike terminal text/chrome or a pipeline event with zero deliveries.
    if (proof) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        const color = ((x >> 5) + (y >> 5)) % 2 === 0 ? [235, 35, 170] : [20, 215, 185];
        rgba[at] = color[0]; rgba[at + 1] = color[1]; rgba[at + 2] = color[2]; rgba[at + 3] = 255;
    }
    rgba[0] = imageId & 255;
    rgba[1] = (imageId >>> 8) & 255;
    rgba[2] = (imageId >>> 16) & 255;
    rgba[3] = 255;
    rgba[4] = (imageId >>> 24) & 255;
    rgba[5] = (imageId * 19) & 255;
    rgba[6] = 180 ^ ((imageId * 13) & 255);
    rgba[7] = 255;
    const payload = rgba.toString('base64');
    // Transmit then place: the host's inline store only admits a=t|q, then routes a=p|T.
    // The placement covers the pane, which is what a repainting producer does
    // and what makes the host classify this as the pane's whole surface.
    return Buffer.from(
        `\u001b[${row};${col}H`
        + `\u001b_Ga=t,f=32,s=${width},v=${height},i=${imageId},m=0;${payload}\u001b\\`
        + `\u001b_Ga=p,i=${imageId},c=${cols},r=${rows};\u001b\\`,
    );
}

// ClientHello transports the native cell metrics even if a stable grid never
// sends a later terminal.resize. Retain both decoded fields and exact wire bytes.
function clientHelloMetrics(payload) {
    let at = 0;
    const next = () => {
        const tag = payload.readUInt8(at++);
        if (tag < 251) return tag;
        const bytes = tag === 251 ? 2 : tag === 252 ? 4 : tag === 253 ? 8 : 0;
        if (!bytes) throw new Error('Invalid ClientHello integer');
        const value = bytes === 8 ? Number(payload.readBigUInt64LE(at)) : payload.readUIntLE(at, bytes);
        at += bytes;
        if (!Number.isSafeInteger(value)) throw new Error('Unsafe ClientHello integer');
        return value;
    };
    try {
        const [type, version, cols, rows, cellWidthPx, cellHeightPx] = Array.from({ length: 6 }, next);
        if (type !== 0 || version !== PROTOCOL_VERSION) return undefined;
        return { source: 'graphics.ClientHello', version, cols, rows, cellWidthPx, cellHeightPx, payloadBase64: payload.toString('base64') };
    } catch { return undefined; }
}

function readType(payload) {
    const prefix = payload[0];
    if (prefix === undefined) return -1;
    if (prefix <= 250) return prefix;
    return -1;
}

function createPacer({ socket, bytesPerSecond, timers, isClosed, buildFrame, frameBytes }) {
    let queued = 0;
    let written = 0;
    let startedAt = Date.now();
    let timer;
    let pumping = false;
    const estimated = Math.max(1, Number(frameBytes) || 1);

    const clear = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timers.delete(timer);
        timer = undefined;
    };

    const schedule = (ms) => {
        clear();
        const handle = setTimeout(() => {
            if (timer === handle) timer = undefined;
            timers.delete(handle);
            pump();
        }, ms);
        timer = handle;
        timers.add(handle);
    };

    const pump = () => {
        if (isClosed() || !socket.writable) {
            queued = 0;
            pumping = false;
            clear();
            return;
        }
        if (queued <= 0) {
            pumping = false;
            return;
        }
        const budget = ((Date.now() - startedAt) / 1000) * bytesPerSecond - written;
        if (written > 0 && budget < estimated) {
            const waitMs = Math.ceil((estimated - Math.max(0, budget)) / bytesPerSecond * 1000);
            pumping = true;
            schedule(Math.max(1, waitMs));
            return;
        }
        queued -= 1;
        try {
            const payload = buildFrame();
            socket.write(payload);
            written += payload.length;
        } catch {
            queued = 0;
            pumping = false;
            clear();
            return;
        }
        if (queued > 0) {
            pumping = true;
            schedule(Math.max(1, Math.ceil(estimated / bytesPerSecond * 1000)));
            return;
        }
        pumping = false;
    };

    return {
        admit() {
            queued += 1;
            if (!pumping) {
                pumping = true;
                pump();
            }
        },
        stop() {
            queued = 0;
            pumping = false;
            clear();
        },
    };
}

function decodeSgr(payload) {
    const text = payload.toString('latin1');
    const reports = [];
    const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        reports.push({
            button: Number(match[1]),
            x: Number(match[2]),
            y: Number(match[3]),
            action: match[4] === 'm' ? 'release' : 'press',
        });
    }
    return reports;
}

function serveClient(socket, options) {
    const { world, frameHz, imageWidth, imageHeight, bytesPerSecond, timers, isClosed, onReady, inputLogPath } = options;
    let buffered = Buffer.alloc(0);
    let welcomed = false;
    const rgba = Buffer.alloc(imageWidth * imageHeight * 4);
    const cursors = paneCursors(world);
    let imageId = 1;
    let requested = 0;
    let requestTimer;
    let periodicTimer;
    /** The pane a phone is watching, when a request named one. */
    let targetPaneId;

    const pacer = createPacer({
        socket,
        bytesPerSecond,
        timers,
        isClosed,
        frameBytes: Math.ceil(imageWidth * imageHeight * 4 * 4 / 3) + 256,
        buildFrame: () => {
            const wanted = targetPaneId === undefined
                ? undefined
                : cursors.find((cursor) => cursor.paneId === targetPaneId);
            // The PR flow opens the first live pane. Pin its proof producer;
            // round-robin across offscreen panes makes framebuffer proof flaky.
            const cursor = options.enableFile !== undefined ? cursors[0] : wanted ?? cursors[imageId % cursors.length] ?? cursors[0];
            const bytes = kittyChunk({
                ...cursor,
                imageId,
                width: imageWidth,
                height: imageHeight,
                rgba,
                proof: options.enableFile !== undefined,
                cols: Math.max(1, cursor?.rect?.width ?? 1),
                rows: Math.max(1, cursor?.rect?.height ?? 1),
            });
            imageId += 1;
            return frame(outputPayload(bytes));
        },
    });
    const paint = () => {
        if (options.enableFile === undefined || existsSync(options.enableFile)) pacer.admit();
    };

    const stopRequestTick = () => {
        if (requestTimer === undefined) return;
        clearInterval(requestTimer);
        timers.delete(requestTimer);
        requestTimer = undefined;
    };

    const stopPeriodic = () => {
        if (periodicTimer === undefined) return;
        clearInterval(periodicTimer);
        timers.delete(periodicTimer);
        periodicTimer = undefined;
    };

    const stop = () => {
        stopRequestTick();
        stopPeriodic();
        pacer.stop();
    };

    const admitOne = () => {
        if (isClosed() || !socket.writable) {
            stop();
            return;
        }
        if (requested <= 0) {
            stopRequestTick();
            return;
        }
        requested -= 1;
        paint();
        if (requested <= 0) stopRequestTick();
    };

    const requestFramesForClient = (count, paneId) => {
        const n = positiveInt(count, 0);
        if (n <= 0 || isClosed() || !socket.writable) return;
        if (typeof paneId === 'string' && paneId !== '') targetPaneId = paneId;
        requested += n;
        // First paint of a burst is immediate; the rest arrive at 60 Hz and
        // then sit behind the socket pacer, the way a Kitty program queues
        // presents when it repaints on each notch.
        if (requestTimer === undefined) {
            admitOne();
            if (requested > 0) {
                requestTimer = setInterval(admitOne, Math.max(1, Math.round(1000 / REQUEST_HZ)));
                timers.add(requestTimer);
            }
        }
    };

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
            if (inputLogPath !== undefined) {
                try {
                    appendFileSync(inputLogPath, `${JSON.stringify({
                        at: new Date().toISOString(),
                        type,
                        ...(type === 0 ? clientHelloMetrics(payload) : {}),
                        sgr: decodeSgr(payload),
                        bytes: payload.length,
                    })}\n`);
                } catch { /* harness removed its scratch dir */ }
            }
            if (type === 0 && !welcomed) {
                welcomed = true;
                socket.write(frame(welcomePayload()));
                onReady?.(requestFramesForClient);
                if (frameHz > 0) {
                    paint();
                    periodicTimer = setInterval(paint, Math.max(1, Math.round(1000 / frameHz)));
                    timers.add(periodicTimer);
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

export async function startGraphics({
    socketPath,
    world = DEFAULT_WORLD,
    frameHz = 0,
    imageWidth,
    imageHeight,
    bytesPerSecond = DEFAULT_BYTES_PER_SECOND,
    inputLogPath,
    enableFile,
} = {}) {
    try { unlinkSync(socketPath); } catch { /* leftover from a killed run */ }
    const sockets = new Set();
    const timers = new Set();
    const emitters = new Set();
    let orphanRequests = 0;
    let closed = false;
    const rate = Number(frameHz);
    const hz = Number.isFinite(rate) && rate > 0 ? rate : 0;
    const size = imageSizeFromWorld(world, { imageWidth, imageHeight });
    const width = size.width;
    const height = size.height;
    const bps = positiveInt(bytesPerSecond, DEFAULT_BYTES_PER_SECOND);

    let orphanPaneId;
    const requestFramesBound = (count, paneId) => {
        const n = positiveInt(count, 0);
        if (n <= 0 || closed) return;
        if (emitters.size === 0) {
            orphanRequests += n;
            if (typeof paneId === 'string' && paneId !== '') orphanPaneId = paneId;
            return;
        }
        for (const emit of emitters) emit(n, paneId);
    };
    activeRequestFrames = requestFramesBound;

    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        serveClient(socket, {
            world,
            frameHz: hz,
            imageWidth: width,
            imageHeight: height,
            bytesPerSecond: bps,
            timers,
            isClosed: () => closed,
            inputLogPath,
            enableFile,
            onReady: (emit) => {
                emitters.add(emit);
                socket.once('close', () => emitters.delete(emit));
                if (orphanRequests > 0) {
                    emit(orphanRequests, orphanPaneId);
                    orphanRequests = 0;
                }
            },
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    return {
        requestFrames: requestFramesBound,
        close() {
            if (closed) return;
            closed = true;
            orphanRequests = 0;
            emitters.clear();
            if (activeRequestFrames === requestFramesBound) activeRequestFrames = () => {};
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close();
            try { unlinkSync(socketPath); } catch { /* listen never created it */ }
        },
    };
}
