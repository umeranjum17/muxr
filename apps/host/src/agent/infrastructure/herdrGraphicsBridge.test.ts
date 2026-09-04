import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HerdrGraphicsBridge, MAX_IMAGE_BYTES, decodeServerMessage, encodeKitty, mapGraphicsPointer, routeGraphicsPane } from './herdrGraphicsBridge.js';

const uint = (value: number | bigint): Buffer => {
    const number = BigInt(value);
    if (number < 251n) return Buffer.from([Number(number)]);
    if (number <= 0xffffn) { const data = Buffer.alloc(3); data[0] = 251; data.writeUInt16LE(Number(number), 1); return data; }
    const data = Buffer.alloc(9); data[0] = 253; data.writeBigUInt64LE(number, 1); return data;
};
const bytes = (value: Buffer): Buffer => Buffer.concat([uint(value.length), value]);

// One flow check: real protocol-20 GraphicsFile shape → exact visible-pane route
// → bounded Kitty placement. Hidden/ambiguous panes must never receive pixels.
const graphicsResultAck = (written: Buffer): boolean | undefined => {
    const length = written.readUInt32LE(0);
    const payload = written.subarray(4, 4 + length);
    if (payload[0] !== 10) return undefined;
    return payload[payload.length - 1] === 1;
};

const serverFrame = (payload: Buffer): Buffer => {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32LE(payload.length);
    return Buffer.concat([length, payload]);
};

describe('Herdr graphics flow', () => {
    it('decodes, routes, and emits one pane-scoped Kitty frame', async () => {
        const leading = Buffer.from('\u001b[3;4H');
        const payload = Buffer.concat([
            uint(13),
            bytes(Buffer.from('/tmp/herdr-frame.rgba')),
            uint(16),
            uint(7),
            uint(99),
            bytes(leading),
            bytes(Buffer.from('a=T,f=32,s=2,v=2,i=7')),
        ]);
        const message = decodeServerMessage(payload);
        expect(message.type).toBe('graphics-file');
        if (message.type !== 'graphics-file') throw new Error('fixture did not decode');

        const visible = { paneId: 'visible', rect: { x: 3, y: 2, width: 8, height: 5 } };
        expect(routeGraphicsPane(message.file.leading, [visible, { paneId: 'hidden' }])).toBe('visible');
        expect(routeGraphicsPane(message.file.leading, [visible, { paneId: 'overlap', rect: visible.rect }])).toBeUndefined();

        const output = encodeKitty({
            compressed: deflateSync(Buffer.alloc(16)),
            width: 2,
            height: 2,
            imageId: 101,
            transferId: message.file.transferId,
        }, {
            channel: 'phone', paneId: 'visible', cols: 20, rows: 10, cellWidthPx: 8, cellHeightPx: 16, write: () => {},
        }, 'all').toString('utf8');
        expect(output.startsWith('\u001b7')).toBe(true);
        expect(output).toContain('a=d,d=A');
        expect(output).toContain('a=T,f=32,s=2,v=2,i=101');
        expect(output.endsWith('\u001b8')).toBe(true);

        const image = { compressed: Buffer.from([1]), width: 1600, height: 900, imageId: 1, transferId: 1n };
        const portrait = { channel: 'phone', paneId: 'visible', cols: 40, rows: 80, cellWidthPx: 10, cellHeightPx: 20, write: () => {} };
        // Injected SGR reports are 1-based source-image pixels, including when
        // the client viewport is not an exact cell-grid multiple.
        expect(mapGraphicsPointer(image, portrait, { phase: 'down', x: 200, y: 50, width: 400, height: 1600 })).toBeUndefined();
        expect(mapGraphicsPointer(image, portrait, { phase: 'down', x: 200, y: 790, width: 400, height: 1600 })).toEqual({ x: 800, y: 450 });
        expect(mapGraphicsPointer(image, portrait, { phase: 'down', x: 205, y: 810, width: 410, height: 1640 })).toEqual({ x: 800, y: 451 });
        const landscape = { ...portrait, cols: 120, rows: 30 };
        expect(mapGraphicsPointer(image, landscape, { phase: 'down', x: 50, y: 300, width: 1200, height: 600 })).toBeUndefined();
        expect(mapGraphicsPointer(image, landscape, { phase: 'down', x: 595, y: 300, width: 1200, height: 600 })).toEqual({ x: 800, y: 450 });

        const acks: Buffer[] = [];
        const socket = Object.assign(new EventEmitter(), {
            writable: true,
            write: (data: Buffer) => { acks.push(Buffer.from(data)); return true; },
            destroy: () => {},
        });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            latestByPane: Map<string, typeof image>;
            imageOwners: Map<bigint, { paneId: string; imageId: number; sourceImageId: number }>;
            lastErrorAt: number;
            closed: boolean;
            retire: (transferId: bigint, sourceImageId: number) => void;
            read: (data: Buffer) => void;
            retirePane: (paneId: string) => void;
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            ensurePaneProcess: (paneId: string) => Promise<boolean>;
            forward: (file: {
                path: string;
                expectedLength: bigint;
                imageId: number;
                transferId: bigint;
                leading: Buffer;
                control: string;
            }) => Promise<void>;
        };
        bridge.register(portrait);
        internals.latestByPane.set('visible', image);
        expect(bridge.pointerInput('phone', { phase: 'down', x: 200, y: 790, width: 400, height: 1600 }).map((item) => item.toString('utf8')))
            .toEqual(['\u001b[<35;800;450M', '\u001b[<0;800;450M']);
        bridge.unregister('phone');
        const replayed: string[] = [];
        bridge.register({ ...landscape, channel: 'rotated', write: (frame) => replayed.push(frame) });
        expect(replayed).toHaveLength(1);
        expect(Buffer.from((JSON.parse(replayed[0]!) as { bytes: string }).bytes, 'base64').toString('utf8')).toContain('c=107,r=30');

        const successor = { ...image, imageId: 2, transferId: 2n };
        internals.latestByPane.set('visible', successor);
        internals.imageOwners.set(2n, { paneId: 'visible', imageId: 2, sourceImageId: 8 });
        const framesBeforeSuperseded = replayed.length;
        internals.retire(1n, 7);
        expect(replayed).toHaveLength(framesBeforeSuperseded);
        expect(internals.latestByPane.get('visible')).toEqual(successor);
        expect(internals.imageOwners.has(1n)).toBe(false);
        expect(internals.imageOwners.has(2n)).toBe(true);

        internals.sourcePane = async () => 'visible';
        internals.ensurePaneProcess = async () => true;
        const stderr: string[] = [];
        const originalStderr = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
            return true;
        }) as typeof process.stderr.write;
        try {
            internals.lastErrorAt = 0;
            const acksBeforeZero = acks.length;
            await internals.forward({
                path: '/tmp/herdr-missing.rgba',
                expectedLength: 0n,
                imageId: 3,
                transferId: 3n,
                leading: Buffer.from('\u001b[3;4H'),
                control: 'a=T,f=32,s=0,v=0,i=3',
            });
            expect(acks).toHaveLength(acksBeforeZero + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            internals.lastErrorAt = 0;
            const acksBeforeCap = acks.length;
            await internals.forward({
                path: '/tmp/herdr-missing.rgba',
                expectedLength: BigInt(MAX_IMAGE_BYTES) + 1n,
                imageId: 4,
                transferId: 4n,
                leading: Buffer.from('\u001b[3;4H'),
                control: 'a=T,f=32,s=1920,v=1080,i=4',
            });
            expect(acks).toHaveLength(acksBeforeCap + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
        } finally {
            process.stderr.write = originalStderr;
        }
        expect(1786 * 1443 * 4).toBe(10_308_792);
        expect(10_308_792).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
        expect(stderr.join('')).toContain('expectedLength=0');
        expect(stderr.join('')).toContain('control=a=T,f=32,s=0,v=0,i=3');
        expect(stderr.join('')).toContain(`expectedLength=${MAX_IMAGE_BYTES + 1}`);
        expect(stderr.join('')).toContain('control=a=T,f=32,s=1920,v=1080,i=4');
        expect(internals.closed).toBe(false);
        expect(bridge.hasRegistrations()).toBe(true);
        expect(internals.latestByPane.get('visible')).toEqual(successor);
        expect(internals.imageOwners.has(2n)).toBe(true);

        internals.imageOwners.set(5n, { paneId: 'visible', imageId: 5, sourceImageId: 5 });
        const framesBeforeOldRetire = replayed.length;
        internals.retire(5n, 5);
        expect(replayed).toHaveLength(framesBeforeOldRetire);
        expect(internals.latestByPane.get('visible')).toEqual(successor);
        expect(internals.imageOwners.has(5n)).toBe(false);

        const framesBeforeCurrentRetire = replayed.length;
        internals.retire(2n, 8);
        expect(replayed).toHaveLength(framesBeforeCurrentRetire);
        expect(internals.latestByPane.has('visible')).toBe(false);

        const dir = mkdtempSync(join(tmpdir(), 'herdr-gfx-'));
        const rgbaPath = join(dir, 'frame.rgba');
        writeFileSync(rgbaPath, Buffer.alloc(16));
        const inflightFile = {
            path: rgbaPath,
            expectedLength: 16n,
            imageId: 20,
            transferId: 20n,
            leading: Buffer.from('\u001b[3;4H'),
            control: 'a=T,f=32,s=2,v=2,i=20',
        };
        try {
            let releaseProcess: () => void = () => {};
            const processGate = new Promise<void>((resolve) => { releaseProcess = resolve; });
            let enteredProcess: () => void = () => {};
            const inProcess = new Promise<void>((resolve) => { enteredProcess = resolve; });
            internals.sourcePane = async () => 'visible';
            internals.ensurePaneProcess = async () => {
                enteredProcess();
                await processGate;
                return true;
            };
            const framesBeforeInflight = replayed.length;
            const acksBeforeInflight = acks.length;
            const inflight = internals.forward(inflightFile);
            await inProcess;
            expect(acks).toHaveLength(acksBeforeInflight + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            internals.retire(20n, 20);
            releaseProcess();
            await inflight;
            const inflightClear = JSON.parse(replayed.at(-1)!) as { graphics: boolean; graphicsReason?: string; bytes: string };
            expect(inflightClear).toMatchObject({ graphics: false, graphicsReason: 'retired' });
            expect(Buffer.from(inflightClear.bytes, 'base64').toString('utf8')).toContain('a=d,d=A');
            expect(acks).toHaveLength(acksBeforeInflight + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            expect(replayed.slice(framesBeforeInflight).every((frame) => {
                const parsed = JSON.parse(frame) as { graphics?: boolean };
                return parsed.graphics !== true;
            })).toBe(true);
            expect(internals.latestByPane.has('visible')).toBe(false);
            expect(internals.imageOwners.has(20n)).toBe(false);

            let releaseRoute: () => void = () => {};
            const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve; });
            let enteredRoute: () => void = () => {};
            const inRoute = new Promise<void>((resolve) => { enteredRoute = resolve; });
            internals.sourcePane = async () => {
                enteredRoute();
                await routeGate;
                return 'visible';
            };
            internals.ensurePaneProcess = async () => true;
            internals.latestByPane.set('visible', successor);
            internals.imageOwners.set(2n, { paneId: 'visible', imageId: 2, sourceImageId: 8 });
            const framesBeforeUnknown = replayed.length;
            const acksBeforeUnknown = acks.length;
            const unknownPane = internals.forward({ ...inflightFile, imageId: 21, transferId: 21n, control: 'a=T,f=32,s=2,v=2,i=21' });
            await inRoute;
            expect(acks).toHaveLength(acksBeforeUnknown + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            internals.retire(21n, 21);
            expect(replayed).toHaveLength(framesBeforeUnknown);
            releaseRoute();
            await unknownPane;
            expect(acks).toHaveLength(acksBeforeUnknown + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            const unknownClear = JSON.parse(replayed.at(-1)!) as { graphics: boolean; graphicsReason?: string; bytes: string };
            expect(unknownClear).toMatchObject({ graphics: false, graphicsReason: 'retired' });
            expect(Buffer.from(unknownClear.bytes, 'base64').toString('utf8')).toContain('a=d,d=A');
            expect(replayed.slice(framesBeforeUnknown).filter((frame) => {
                const parsed = JSON.parse(frame) as { graphics?: boolean; bytes: string };
                return parsed.graphics === false && Buffer.from(parsed.bytes, 'base64').toString('utf8').includes('a=d,d=A');
            })).toHaveLength(1);
            expect(replayed.slice(framesBeforeUnknown).every((frame) => {
                const parsed = JSON.parse(frame) as { graphics?: boolean };
                return parsed.graphics !== true;
            })).toBe(true);
            expect(internals.latestByPane.has('visible')).toBe(false);
            expect(internals.imageOwners.has(21n)).toBe(false);

            let releaseGeneration: () => void = () => {};
            const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
            let enteredGeneration: () => void = () => {};
            const inGeneration = new Promise<void>((resolve) => { enteredGeneration = resolve; });
            internals.sourcePane = async () => {
                enteredGeneration();
                await generationGate;
                return 'visible';
            };
            internals.latestByPane.set('visible', successor);
            internals.imageOwners.set(2n, { paneId: 'visible', imageId: 2, sourceImageId: 8 });
            const framesBeforePane = replayed.length;
            const acksBeforePane = acks.length;
            const raced = internals.forward({ ...inflightFile, imageId: 22, transferId: 22n, control: 'a=T,f=32,s=2,v=2,i=22' });
            await inGeneration;
            internals.retirePane('visible');
            const paneClear = JSON.parse(replayed.at(-1)!) as { graphics: boolean; graphicsReason?: string; bytes: string };
            expect(paneClear.graphics).toBe(false);
            expect(paneClear.graphicsReason).toBeUndefined();
            expect(Buffer.from(paneClear.bytes, 'base64').toString('utf8')).toContain('a=d,d=A');
            releaseGeneration();
            await raced;
            expect(acks).toHaveLength(acksBeforePane + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            expect(replayed.slice(framesBeforePane).every((frame) => {
                const parsed = JSON.parse(frame) as { graphics?: boolean };
                return parsed.graphics !== true;
            })).toBe(true);
            expect(internals.latestByPane.has('visible')).toBe(false);
            expect(internals.imageOwners.has(22n)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }

        internals.retirePane('visible');
        expect(JSON.parse(replayed.at(-1)!) as { graphics: boolean; graphicsReason?: string })
            .toMatchObject({ graphics: false });
        expect((JSON.parse(replayed.at(-1)!) as { graphicsReason?: string }).graphicsReason).toBeUndefined();
        internals.read(serverFrame(Buffer.concat([uint(14), uint(99), uint(99)])));
        expect(JSON.parse(replayed.at(-1)!) as { graphics: boolean; graphicsReason?: string })
            .toMatchObject({ graphics: false, graphicsReason: 'retired' });
        expect(internals.closed).toBe(true);
        expect(bridge.register(portrait)).toBe(false);
    });

    // One flow check for a program's own images: two of them live in one pane,
    // a repaint of one supersedes only itself, the program's delete removes
    // exactly what it named, and a gesture leaves the pane as few wheel notches
    // as the pane has answered frames.
    it('keeps two program images, coalesces repaints, and paces a gesture', async () => {
        const socket = Object.assign(new EventEmitter(), {
            writable: true,
            write: () => true,
            destroy: () => {},
        });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            visibleRect: (paneId: string) => Promise<{ x: number; y: number; width: number; height: number } | undefined>;
            queueInline: (data: Buffer) => void;
            supersededFrames: number;
            inlineQueue: unknown[];
            inlineDraining: boolean;
        };
        internals.sourcePane = async () => 'pane';
        internals.visibleRect = async () => ({ x: 0, y: 0, width: 20, height: 10 });

        const frames: { graphics?: boolean; graphicsSurface?: string; bytes: string }[] = [];
        const notches: string[] = [];
        bridge.register({
            channel: 'phone',
            paneId: 'pane',
            cols: 20,
            rows: 10,
            cellWidthPx: 10,
            cellHeightPx: 20,
            write: (frame) => frames.push(JSON.parse(frame) as { bytes: string }),
            sendInput: (input) => notches.push(input.toString('utf8')),
        });

        const pixels = Buffer.alloc(2 * 2 * 4, 7).toString('base64');
        const image = (id: number, row: number, col: number, cols: number, rows: number): Buffer => Buffer.from(
            `\u001b[${row};${col}H`
            + `\u001b_Ga=t,f=32,s=2,v=2,i=${id},m=0;${pixels}\u001b\\`
            + `\u001b_Ga=p,i=${id},c=${cols},r=${rows};\u001b\\`,
        );
        // The worker itself is the signal: drained queue, nothing in flight.
        const settle = async (): Promise<void> => {
            for (let turn = 0; turn < 1000; turn += 1) {
                if (internals.inlineQueue.length === 0 && !internals.inlineDraining) return;
                await new Promise((resolve) => { setImmediate(resolve); });
            }
        };

        // A pane-filling image, then a small one beside it.
        internals.queueInline(image(1, 1, 1, 20, 10));
        await settle();
        internals.queueInline(image(2, 8, 3, 4, 2));
        await settle();
        expect(frames).toHaveLength(2);
        expect(frames[0]).toMatchObject({ graphics: true, graphicsSurface: 'full' });
        expect(frames[1]).toMatchObject({ graphics: true, graphicsSurface: 'inline' });
        // Neither frame may clear the whole pane, or the other image is erased.
        expect(frames.every((frame) => !Buffer.from(frame.bytes, 'base64').toString('utf8').includes('a=d,d=A'))).toBe(true);

        // A repaint of the full surface arrives twice before either is prepared:
        // the older one is dropped, and the small image is untouched.
        internals.queueInline(Buffer.concat([image(3, 1, 1, 20, 10), image(4, 1, 1, 20, 10)]));
        await settle();
        expect(internals.supersededFrames).toBe(1);
        expect(frames).toHaveLength(3);
        expect(Buffer.from(frames[2]!.bytes, 'base64').toString('utf8')).toContain('i=4');
        // Replacing a surface deletes exactly the image it replaced.
        expect(Buffer.from(frames[2]!.bytes, 'base64').toString('utf8')).toContain('a=d,d=I,i=1');

        // A gesture: three rows is one notch, and only what the pane has
        // answered goes out now. The rest is owed, not queued in front of it.
        const burst = bridge.scrollInput('phone', 'down', 30);
        expect(burst).toHaveLength(4);
        expect(burst[0]!.toString('utf8')).toMatch(/^\u001b\[<65;\d+;\d+M$/);
        const framesBeforeDrain = frames.length;
        internals.queueInline(image(5, 1, 1, 20, 10));
        await settle();
        expect(frames.length).toBe(framesBeforeDrain + 1);
        expect(notches).toHaveLength(1);

        // The program's own delete names Herdr's id, which is the id the phone
        // holds, so it removes that image and nothing else.
        internals.queueInline(Buffer.from('\u001b_Ga=d,d=I,i=2,q=2;\u001b\\'));
        await settle();
        expect(Buffer.from(frames.at(-1)!.bytes, 'base64').toString('utf8')).toContain('a=d,d=I,i=2');
        expect(frames.at(-1)).toMatchObject({ graphics: false });
        bridge.close();
    });
});
