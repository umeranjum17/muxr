import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HerdrGraphicsBridge, MAX_IMAGE_BYTES, decodeServerMessage, encodeKitty, mapGraphicsPointer, routeGraphicsPane } from './herdrGraphicsBridge.js';
import { GraphicsTrace, graphicsTrace } from './graphicsTrace.js';

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

const frameAnsi = (frame: string): string => {
    const parsed: unknown = JSON.parse(frame);
    if (typeof parsed !== 'object' || parsed === null || !('bytes' in parsed) || typeof parsed.bytes !== 'string') {
        throw new Error('Terminal frame is missing encoded bytes');
    }
    return Buffer.from(parsed.bytes, 'base64').toString('utf8');
};

/** The frame's takeover metadata: true stays live, false ends it, absent is ordinary ANSI. */
const frameGraphics = (frame: string): boolean | undefined => {
    const parsed: unknown = JSON.parse(frame);
    if (typeof parsed !== 'object' || parsed === null || !('graphics' in parsed)) return undefined;
    if (typeof parsed.graphics !== 'boolean') return undefined;
    return parsed.graphics;
};

describe('Herdr graphics flow', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

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
            retirePane: (paneId: string) => void;
            read: (data: Buffer) => void;
            queueInline: (data: Buffer) => void;
            drainInline: () => Promise<void>;
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
        // The lease is gone but the phone still shows this frame; the pane's
        // current image stays tracked until its replacement is placed.
        expect(internals.latestByPane.get('visible')).toEqual(successor);

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
            // A retired lease drops the stale in-flight frame only: no
            // clear-all is emitted, the phone keeps the delivered successor,
            // and the bridge stays open -- retirement is per-transfer.
            expect(replayed).toHaveLength(framesBeforeInflight);
            expect(acks).toHaveLength(acksBeforeInflight + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            expect(internals.closed).toBe(false);
            expect(internals.latestByPane.get('visible')).toEqual(successor);
            expect(internals.imageOwners.has(20n)).toBe(false);

            // The wire path itself: a real `retired` server message must not
            // tear the bridge down or clear any registration.
            const framesBeforeWireRetire = replayed.length;
            internals.read(serverFrame(Buffer.concat([uint(14), uint(20n), uint(20)])));
            expect(internals.closed).toBe(false);
            expect(replayed).toHaveLength(framesBeforeWireRetire);

            // Hiding a resident placement is not image destruction. Herdr
            // returns with a placement-only command, without another upload.
            const beforeHide = replayed.length;
            internals.queueInline(Buffer.from('\u001b_Ga=d,d=i,i=8,p=41,q=2;\u001b\\'));
            await internals.drainInline();
            const hidden = replayed.slice(beforeHide).map(frameAnsi);
            expect(hidden.join('')).toContain('a=d,d=i,i=2,p=2');
            expect(hidden.join('')).not.toContain('d=I');
            // The hide keeps the resident image for its replay, so every hide
            // frame keeps the pane's takeover alive and never reports it gone.
            expect(replayed.slice(beforeHide).every((frame) => frameGraphics(frame) === true)).toBe(true);
            const beforeDisplay = replayed.length;
            internals.queueInline(Buffer.from('\u001b[3;4H\u001b_Ga=p,i=8,p=41,c=8,r=5,q=2;\u001b\\'));
            await internals.drainInline();
            const displayed = replayed.slice(beforeDisplay).map(frameAnsi);
            expect(displayed.join('')).toContain('a=p,i=2,p=2,c=107,r=30');
            expect(displayed.join('')).not.toContain('a=T');
            const lateFrames: string[] = [];
            bridge.register({ ...portrait, channel: 'late-retained', write: (frame) => lateFrames.push(frame) });
            expect(lateFrames.map(frameAnsi).some((frame) => frame.includes('a=T,f=32,s=1600,v=900,i=2'))).toBe(true);
            bridge.unregister('late-retained');

            // A standalone uppercase delete of the pane's displayed image is a
            // real delete: no successor placement is queued, so it forwards
            // at once, translated to the id the phone holds, and the takeover
            // metadata reports what the pane lost. The unrelated pane sees
            // nothing.
            const unrelatedFrames: string[] = [];
            bridge.register({ ...portrait, paneId: 'unrelated', channel: 'unrelated', write: (frame) => unrelatedFrames.push(frame) });
            const beforeDelete = replayed.length;
            internals.queueInline(Buffer.from('\u001b_Ga=d,d=I,i=8,q=2;\u001b\\'));
            await internals.drainInline();
            const retiredDelete = replayed.slice(beforeDelete).map(frameAnsi).join('');
            expect(retiredDelete).toContain('a=d,d=I,i=2');
            expect(retiredDelete).not.toContain('a=d,d=I,i=8');
            expect(replayed.slice(beforeDelete).every((frame) => frameGraphics(frame) === false)).toBe(true);
            expect(unrelatedFrames).toEqual([]);
            bridge.unregister('unrelated');
            expect(internals.latestByPane.has('visible')).toBe(false);
            expect(internals.imageOwners.has(2n)).toBe(false);

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
            // Retiring the in-flight unknown-pane transfer drops it silently:
            // no clear-all, the displayed successor stays tracked and shown.
            expect(replayed).toHaveLength(framesBeforeUnknown);
            expect(internals.closed).toBe(false);
            expect(internals.latestByPane.get('visible')).toEqual(successor);
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
        // A stray retirement for an untracked transfer is steady-state noise:
        // no frame, no teardown, registrations still live.
        const framesBeforeStray = replayed.length;
        internals.read(serverFrame(Buffer.concat([uint(14), uint(99), uint(99)])));
        expect(internals.closed).toBe(false);
        expect(replayed).toHaveLength(framesBeforeStray);
        // Only a real close ends the bridge and its registrations.
        bridge.close();
        expect(internals.closed).toBe(true);
        expect(bridge.register(portrait)).toBe(false);
    });

    // One flow check for a program's own images: two of them live in one pane,
    // a repaint of one supersedes only itself, the program's delete removes
    // exactly what it named, and a gesture leaves the pane as few wheel notches
    // as the pane has answered frames.
    it('replays a program image at the cell it was placed at, not the pane it sits in', async () => {
        // A phone returning from the background re-registers and is replayed the
        // pane's live placements. An inline placement is encoded in pane-local
        // cells, so the replay has to carry the rect the placement was scanned
        // against or the image lands shifted right by the pane's own offset.
        const socket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            visibleRect: (paneId: string) => Promise<{ x: number; y: number; width: number; height: number } | undefined>;
            queueInline: (data: Buffer) => void;
            drainInline: () => Promise<void>;
            inlineQueue: unknown[];
            inlineDraining: boolean;
        };
        internals.sourcePane = async () => 'pane';
        internals.visibleRect = async () => ({ x: 26, y: 1, width: 94, height: 39 });

        const frames: string[] = [];
        const phone = {
            channel: 'phone', paneId: 'pane', cols: 94, rows: 39, cellWidthPx: 8, cellHeightPx: 16,
            write: (frame: string) => { frames.push(Buffer.from(JSON.parse(frame).bytes as string, 'base64').toString('utf8')); },
        };
        bridge.register(phone);

        const drain = vi.spyOn(internals, 'drainInline');
        const pixels = Buffer.alloc(2 * 2 * 4, 7).toString('base64');
        internals.queueInline(Buffer.from(
            '\u001b[3;27H'
            + `\u001b_Ga=t,f=32,s=2,v=2,i=43,m=0;${pixels}\u001b\\`
            + '\u001b_Ga=p,i=43,p=567128,c=6,r=3;\u001b\\',
        ));
        await drain.mock.results.at(-1)?.value;
        expect(internals.inlineQueue).toHaveLength(0);
        expect(internals.inlineDraining).toBe(false);
        expect(frames).toHaveLength(1);
        // Global cell 3;27 inside a pane at x 26, y 1 is pane-local cell 2;1.
        expect(frames[0]).toContain('\u001b[2;1H');

        // Backgrounding and returning replays what the pane is showing.
        bridge.unregister('phone');
        frames.length = 0;
        bridge.register(phone);
        expect(frames).toHaveLength(1);
        expect(frames[0]).toContain('\u001b[2;1H');
        expect(frames[0]).not.toContain('\u001b[3;27H');

        // Herdr's delete names Herdr's placement id and is forwarded verbatim,
        // so the placement the phone was given has to carry that same id. A
        // renumbered one leaves pixels no delete can reach.
        const placed = frames[0]!;
        frames.length = 0;
        internals.queueInline(Buffer.from('\u001b_Ga=d,d=i,i=43,p=567128;\u001b\\'));
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(1);
        const deleted = /p=(\d+)/.exec(frames[0]!)?.[1];
        expect(deleted).toBe('567128');
        expect(placed).toContain(`p=${deleted}`);

        // A delete naming one placement must not retire the image's others.
        frames.length = 0;
        internals.queueInline(Buffer.from(
            '\u001b[5;30H'
            + `\u001b_Ga=t,f=32,s=2,v=2,i=44,m=0;${pixels}\u001b\\`
            + '\u001b_Ga=p,i=44,p=700001,c=6,r=3;\u001b\\',
        ));
        await drain.mock.results.at(-1)?.value;
        internals.queueInline(Buffer.from(
            '\u001b[9;30H'
            + '\u001b_Ga=p,i=44,p=700002,c=6,r=3;\u001b\\',
        ));
        await drain.mock.results.at(-1)?.value;
        internals.queueInline(Buffer.from('\u001b_Ga=d,d=i,i=44,p=700001;\u001b\\'));
        await drain.mock.results.at(-1)?.value;

        bridge.unregister('phone');
        frames.length = 0;
        bridge.register(phone);
        const surviving = frames.filter((frame) => frame.includes('p=700002'));
        expect(surviving).toHaveLength(1);
        expect(frames.some((frame) => frame.includes('p=700001'))).toBe(false);
    });

    it('delivers a frame while a producer keeps repainting the same surface', async () => {
        // Supersession is re-checked after the layout probe, after the decode
        // and after the rect. While a producer repaints faster than one frame
        // can be prepared, a newer block for the same surface is always queued
        // by the time those checks run, so every prepared frame is discarded
        // and the pane delivers nothing at all.
        const socket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            visibleRect: (paneId: string) => Promise<{ x: number; y: number; width: number; height: number } | undefined>;
            queueInline: (data: Buffer) => void;
            drainInline: () => Promise<void>;
            inlineQueue: unknown[];
        };
        internals.sourcePane = async () => 'pane';

        const frames: string[] = [];
        bridge.register({
            channel: 'phone', paneId: 'pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20,
            write: (frame) => frames.push(frame),
        });

        const pixels = Buffer.alloc(2 * 2 * 4, 7).toString('base64');
        const repaint = (id: number): Buffer => Buffer.from(
            '\u001b[1;1H'
            + `\u001b_Ga=t,f=32,s=2,v=2,i=${id},m=0;${pixels}\u001b\\`
            + `\u001b_Ga=p,i=${id},c=20,r=10;\u001b\\`,
        );
        // The layout probe shells out to herdr, so it really is async. A
        // repaint lands while it is open, which is what a scrolling browser
        // does: the next frame is always already waiting.
        let repaints = 1;
        let deliveredDuringBurst = -1;
        internals.visibleRect = async () => {
            if (repaints < 6) { repaints += 1; internals.queueInline(repaint(repaints)); }
            // What the phone has been shown while the producer is still going.
            if (repaints === 5) deliveredDuringBurst = frames.length;
            await new Promise((resolve) => setImmediate(resolve));
            return { x: 0, y: 0, width: 20, height: 10 };
        };

        const drain = vi.spyOn(internals, 'drainInline');
        internals.queueInline(repaint(1));
        await drain.mock.results.at(-1)?.value;
        expect(internals.inlineQueue).toHaveLength(0);
        expect(repaints).toBe(6);

        // The last repaint finds an empty queue and is delivered, so counting
        // at the end hides this. What matters is the phone being shown nothing
        // for as long as the producer keeps painting: a scrolling browser only
        // moves once the gesture stops.
        expect(deliveredDuringBurst).toBeGreaterThan(0);
    });

    it('halves a large frame while moving, then refines it after the pane settles', async () => {
        const socket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            visibleRect: (paneId: string) => Promise<{ x: number; y: number; width: number; height: number } | undefined>;
            ensurePaneProcess: (paneId: string) => Promise<boolean>;
            queueInline: (data: Buffer) => void;
            enqueue: (file: { path: string; expectedLength: bigint; imageId: number; transferId: bigint; leading: Buffer; control: string }) => void;
            drain: () => Promise<void>;
            drainInline: () => Promise<void>;
            wheelReport: (paneId: string, direction: 'up' | 'down', point: { x: number; y: number }) => Buffer | undefined;
            forwardInlineBlock: (work: unknown, allowDeleteDeferral?: boolean) => Promise<void>;
            inlineImages: { prepared: (...args: never[]) => Promise<unknown> };
            livePlacements: Map<string, Map<string, { block: unknown; rect?: unknown }>>;
            sourceRevision: Map<string, number>;
            sourceQueueVersion: number;
            inlineQueue: unknown[];
            inlineDraining: boolean;
        };
        internals.sourcePane = vi.fn(async () => 'pane');
        internals.visibleRect = vi.fn(async () => ({ x: 0, y: 0, width: 20, height: 10 }));

        const frames: string[] = [];
        bridge.register({
            channel: 'phone', paneId: 'pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20,
            write: (frame) => frames.push(frame),
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const drain = vi.spyOn(internals, 'drainInline');
        const settle = async (): Promise<void> => {
            await drain.mock.results.at(-1)?.value;
            expect(internals.inlineQueue).toHaveLength(0);
            expect(internals.inlineDraining).toBe(false);
        };

        // A pane-filling frame at the producer's own density: 600x400 is past
        // the size where compression is worth hardening, which is the same
        // point past which the density is worth halving.
        const width = 600;
        const height = 400;
        const rgba = Buffer.alloc(width * height * 4);
        for (let i = 0; i < rgba.length; i += 4) {
            const value = (i / 4) % 255;
            rgba[i] = value; rgba[i + 1] = 255 - value; rgba[i + 2] = value; rgba[i + 3] = 255;
        }
        internals.queueInline(Buffer.from(
            '\u001b[1;1H'
            + `\u001b_Ga=t,f=32,s=${width},v=${height},i=9,o=z,m=0;${deflateSync(rgba).toString('base64')}\u001b\\`
            + '\u001b_Ga=p,i=9,c=20,r=10;\u001b\\',
        ));
        await settle();
        expect(frames).toHaveLength(1);
        const ansi = frameAnsi(frames[0]!);

        // Halved, and the control it writes matches the pixels it sends.
        expect(ansi).toContain('a=T,f=32,s=300,v=200,i=9,');
        // The payload is chunked; the image is every chunk's body joined.
        const encoded = [...ansi.matchAll(/\u001b_G[^;]*;([^\u001b]*)\u001b\\/g)]
            .map((match) => match[1] ?? '').join('');
        const halved = inflateSync(Buffer.from(encoded, 'base64'));
        expect(halved).toHaveLength(300 * 200 * 4);
        // Cell counts are independent of pixel density, so the placement the
        // phone is given is the one it would have had at full density.
        expect(ansi).toContain('c=20,r=7');

        // Averaged, not sampled. The first output pixel covers source pixels
        // 0, 1, 600 and 601, whose red channels are 0, 1, 90 and 91: the mean
        // is 46, where nearest-neighbour would have kept 0.
        expect(halved[0]).toBe(46);

        // Scroll coordinates stay in producer space even while the wire image
        // is coarse.
        expect(internals.wheelReport('pane', 'down', { x: 300, y: 229 })?.toString('utf8'))
            .toBe('\u001b[<35;300;229M\u001b[<65;300;229M');

        // Once the producer and input have both been quiet, the same resident
        // source image is replayed at full density through the same serial
        // lifecycle. There is no second raw-frame queue.
        const routedBefore = (internals.sourcePane as ReturnType<typeof vi.fn>).mock.calls.length;
        const probedBefore = (internals.visibleRect as ReturnType<typeof vi.fn>).mock.calls.length;
        await vi.advanceTimersByTimeAsync(200);
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(2);
        // The refinement already knows its pane and the rect its placement was
        // measured with: re-routing would re-probe every pane's layout, which
        // costs far more than the encode it is waiting on.
        expect((internals.sourcePane as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(routedBefore);
        expect((internals.visibleRect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(probedBefore);
        expect(frameAnsi(frames[1]!)).toContain('a=T,f=32,s=600,v=400,i=9,');

        // A source that changes again shortly after a full frame is refined on
        // the same 200ms quiet rule. Nothing may hold it coarse for longer
        // because a full frame happened to go out recently.
        const repaint = (id: number): void => {
            const next = Buffer.alloc(width * height * 4);
            for (let i = 0; i < next.length; i += 4) {
                const value = ((i / 4) + id) % 255;
                next[i] = value; next[i + 1] = 255 - value; next[i + 2] = value; next[i + 3] = 255;
            }
            internals.queueInline(Buffer.from(
                '\u001b[1;1H'
                + `\u001b_Ga=t,f=32,s=${width},v=${height},i=${id},o=z,m=0;${deflateSync(next).toString('base64')}\u001b\\`
                + `\u001b_Ga=p,i=${id},c=20,r=10;\u001b\\`,
            ));
        };
        await vi.advanceTimersByTimeAsync(100);
        repaint(11);
        await settle();
        // Producer activity keeps the wire image coarse.
        expect(frames).toHaveLength(3);
        expect(frameAnsi(frames[2]!)).toContain('a=T,f=32,s=300,v=200,i=11,');
        await vi.advanceTimersByTimeAsync(199);
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(4);
        expect(frameAnsi(frames[3]!)).toContain('a=T,f=32,s=600,v=400,i=11,');

        // A producer that keeps repainting inside the quiet window stays coarse
        // throughout, then settles to exactly one refinement of the latest
        // source and never repeats it while idle.
        for (const id of [12, 13, 14]) {
            await vi.advanceTimersByTimeAsync(100);
            repaint(id);
            await settle();
        }
        expect(frames).toHaveLength(7);
        for (const frame of frames.slice(4)) expect(frameAnsi(frame)).toContain('a=T,f=32,s=300,v=200,');
        await vi.advanceTimersByTimeAsync(200);
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(8);
        expect(frameAnsi(frames[7]!)).toContain('a=T,f=32,s=600,v=400,i=14,');
        await vi.advanceTimersByTimeAsync(5000);
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(8);

        // A coarse preparation slower than the settle window has already spent
        // that window. Arming a fresh 200ms afterwards would charge the encode
        // to the viewer twice, so the refinement is due as soon as it lands --
        // but never earlier than 200ms after the final source activity.
        const store = internals.inlineImages;
        const realPrepared = store.prepared.bind(store);
        store.prepared = (async (...args: never[]) => {
            if ((args[2] as unknown) === 'coarse') vi.setSystemTime(Date.now() + 300);
            return realPrepared(...args);
        }) as typeof store.prepared;
        const slowStartedAt = Date.now();
        repaint(15);
        await settle();
        const coarseCount = frames.length;
        expect(coarseCount).toBe(9);
        expect(frameAnsi(frames[8]!)).toContain('a=T,f=32,s=300,v=200,i=15,');
        // Elapsed since the source route already exceeds the quiet window.
        expect(Date.now() - slowStartedAt).toBeGreaterThanOrEqual(200);
        await vi.advanceTimersByTimeAsync(0);
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(10);
        expect(frameAnsi(frames[9]!)).toContain('a=T,f=32,s=600,v=400,i=15,');
        store.prepared = realPrepared;
        await vi.advanceTimersByTimeAsync(5000);
        await drain.mock.results.at(-1)?.value;
        expect(frames).toHaveLength(10);

        // A refinement whose placement disappeared has nothing left to sharpen.
        // It must fail closed rather than route or probe for a replacement.
        const placed = internals.livePlacements.get('pane')!;
        const [, retained] = [...placed.entries()][0]!;
        const routedAtGone = (internals.sourcePane as ReturnType<typeof vi.fn>).mock.calls.length;
        const probedAtGone = (internals.visibleRect as ReturnType<typeof vi.fn>).mock.calls.length;
        internals.livePlacements.delete('pane');
        await internals.forwardInlineBlock({
            block: retained.block,
            at: Date.now(),
            refinement: {
                paneId: 'pane',
                sourceRevision: internals.sourceRevision.get('pane') ?? 0,
                sourceQueueVersion: internals.sourceQueueVersion,
            },
        }, false);
        expect(frames).toHaveLength(10);
        expect((internals.sourcePane as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(routedAtGone);
        expect((internals.visibleRect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(probedAtGone);

        // Direct GraphicsFile frames use the same bounded raw-state/refinement
        // path, with their Herdr lease acknowledged before preparation.
        const directSocket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const directBridge = Reflect.construct(HerdrGraphicsBridge, [directSocket, 'herdr']) as HerdrGraphicsBridge;
        const directInternals = directBridge as unknown as typeof internals;
        directInternals.sourcePane = async () => 'direct-pane';
        directInternals.visibleRect = async () => ({ x: 0, y: 0, width: 20, height: 10 });
        directInternals.ensurePaneProcess = async () => true;
        const directFrames: string[] = [];
        directBridge.register({
            channel: 'direct-phone', paneId: 'direct-pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20,
            write: (frame) => directFrames.push(frame),
        });
        const directDir = mkdtempSync(join(tmpdir(), 'herdr-adaptive-direct-'));
        const directPath = join(directDir, 'frame.rgba');
        writeFileSync(directPath, rgba);
        const directDrain = vi.spyOn(directInternals, 'drain');
        directInternals.enqueue({
            path: directPath, expectedLength: BigInt(rgba.length), imageId: 10, transferId: 10n,
            leading: Buffer.from('\u001b[1;1H'), control: 'a=T,f=32,s=600,v=400,i=10',
        });
        await directDrain.mock.results.at(-1)?.value;
        expect(frameAnsi(directFrames[0]!)).toContain('a=T,f=32,s=300,v=200,');
        await vi.advanceTimersByTimeAsync(200);
        await directDrain.mock.results.at(-1)?.value;
        expect(frameAnsi(directFrames[1]!)).toContain('a=T,f=32,s=600,v=400,');
        directBridge.close();
        rmSync(directDir, { recursive: true, force: true });

        // A gesture is still reported in the producer's pixel space, never the
        // transmitted one, or every touch would land at half its position.
        const mapped = mapGraphicsPointer(
            { compressed: Buffer.alloc(1), width: 300, height: 200, imageId: 9, transferId: 0n, sourceWidth: 600, sourceHeight: 400 },
            { channel: 'phone', paneId: 'pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20, write: () => {} },
            { x: 100, y: 100, width: 200, height: 200, phase: 'move' },
        );
        expect(mapped).toEqual({ x: 300, y: 229 });
    });

    it('keeps one resident full image per pane while an inline neighbour survives', async () => {
        const socket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            visibleRect: (paneId: string) => Promise<{ x: number; y: number; width: number; height: number } | undefined>;
            queueInline: (data: Buffer) => void;
            drainInline: () => Promise<void>;
            inlineQueue: unknown[];
            inlineDraining: boolean;
            livePlacements: Map<string, Map<string, { image: { imageId: number } }>>;
        };
        internals.sourcePane = async () => 'pane';
        internals.visibleRect = async () => ({ x: 0, y: 0, width: 20, height: 10 });

        const frames: string[] = [];
        bridge.register({
            channel: 'phone', paneId: 'pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20,
            write: (frame) => frames.push(frame),
        });

        const pixels = Buffer.alloc(2 * 2 * 4, 5).toString('base64');
        const image = (id: number, row: number, col: number, cols: number, rows: number): Buffer => Buffer.from(
            `\u001b[${row};${col}H`
            + `\u001b_Ga=t,f=32,s=2,v=2,i=${id},m=0;${pixels}\u001b\\`
            + `\u001b_Ga=p,i=${id},c=${cols},r=${rows};\u001b\\`,
        );
        const drain = vi.spyOn(internals, 'drainInline');
        const settle = async (): Promise<void> => {
            await drain.mock.results.at(-1)?.value;
            expect(internals.inlineQueue).toHaveLength(0);
            expect(internals.inlineDraining).toBe(false);
        };

        // A pane-filling image, then a small one beside it.
        internals.queueInline(image(1, 1, 1, 20, 10));
        await settle();
        internals.queueInline(image(2, 8, 3, 4, 2));
        await settle();
        expect(frames).toHaveLength(2);
        expect(frames.every((frame) => !frameAnsi(frame).includes('a=d,'))).toBe(true);

        // A repaint clipped to a different extent is a different placement key,
        // so `replaced` sees no predecessor and would leave the first image
        // resident forever. The pane may hold exactly one full image, so this
        // frame clears it -- ahead of its own pixels, in the same frame.
        internals.queueInline(image(3, 1, 1, 19, 9));
        await settle();
        expect(frames).toHaveLength(3);
        const repaint = frameAnsi(frames[2]!);
        expect(repaint).toContain('a=d,d=I,i=1,');
        expect(repaint).toContain('a=T,f=32,s=2,v=2,i=3');
        expect(repaint.indexOf('a=d,d=I,i=1,')).toBeLessThan(repaint.indexOf('a=T,f=32,s=2,v=2,i=3'));
        // The inline neighbour is a separate, legitimate placement.
        expect(repaint).not.toContain('a=d,d=I,i=2,');
        expect(repaint).not.toContain('a=d,d=A');
        const live = internals.livePlacements.get('pane')!;
        expect([...live.values()].map((placement) => placement.image.imageId).sort()).toEqual([2, 3]);
    });

    it('deletes the image it displaces when a pane exceeds its placement limit', async () => {
        const socket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            visibleRect: (paneId: string) => Promise<{ x: number; y: number; width: number; height: number } | undefined>;
            queueInline: (data: Buffer) => void;
            drainInline: () => Promise<void>;
            inlineQueue: unknown[];
            inlineDraining: boolean;
        };
        internals.sourcePane = async () => 'pane';
        internals.visibleRect = async () => ({ x: 0, y: 0, width: 20, height: 10 });

        const frames: string[] = [];
        bridge.register({
            channel: 'phone', paneId: 'pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20,
            write: (frame) => frames.push(frame),
        });

        const pixels = Buffer.alloc(2 * 2 * 4, 3).toString('base64');
        // Distinct cells, so each is its own surface rather than a repaint.
        const small = (id: number): Buffer => Buffer.from(
            `\u001b[${id};1H`
            + `\u001b_Ga=t,f=32,s=2,v=2,i=${id},m=0;${pixels}\u001b\\`
            + `\u001b_Ga=p,i=${id},c=2,r=1;\u001b\\`,
        );
        const drain = vi.spyOn(internals, 'drainInline');
        const settle = async (): Promise<void> => {
            await drain.mock.results.at(-1)?.value;
            expect(internals.inlineQueue).toHaveLength(0);
            expect(internals.inlineDraining).toBe(false);
        };

        // Sixteen fit. The seventeenth displaces the first, and the phone is
        // owed a delete for it: a placement dropped silently leaves resident
        // pixels this host no longer tracks, and the terminal has to reclaim
        // them itself on the next transmission.
        for (let id = 1; id <= 16; id += 1) {
            internals.queueInline(small(id));
            await settle();
        }
        expect(frames).toHaveLength(16);
        expect(frames.every((frame) => !frameAnsi(frame).includes('a=d,'))).toBe(true);

        internals.queueInline(small(17));
        await settle();
        expect(frames).toHaveLength(18);
        const evicted = frameAnsi(frames[16]!);
        expect(evicted).toContain('a=d,d=I,i=1,');
        expect(evicted).not.toContain('a=d,d=A');
        // The delete lands before the frame that displaced it, and names only
        // that image.
        expect(frameAnsi(frames[17]!)).toContain('a=T,f=32,s=2,v=2,i=17');
        expect(frameAnsi(frames[17]!)).not.toContain('a=d,d=I,i=1,');

        // The displaced surface is forgotten, not merely dropped: an identical
        // placement of it later is a real frame again, never suppressed as
        // already placed.
        internals.queueInline(small(1));
        await settle();
        expect(frames).toHaveLength(20);
        expect(frameAnsi(frames.at(-1)!)).toContain('a=T,f=32,s=2,v=2,i=1');
    });

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
            drainInline: () => Promise<void>;
            supersededFrames: number;
            notchesSent: number;
            notchesDropped: number;
            inlineQueue: unknown[];
            inlineDraining: boolean;
            imageOwners: Map<bigint, { paneId: string; imageId: number; sourceImageId: number }>;
            latestByPane: Map<string, { compressed: Buffer; width: number; height: number; imageId: number; transferId: bigint }>;
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
        // Await the actual worker; event-loop turns do not bound async deflate.
        const drain = vi.spyOn(internals, 'drainInline');
        const settle = async (): Promise<void> => {
            await drain.mock.results.at(-1)?.value;
            expect(internals.inlineQueue).toHaveLength(0);
            expect(internals.inlineDraining).toBe(false);
        };

        // A pane-filling image, then a small one beside it.
        internals.queueInline(image(1, 1, 1, 20, 10));
        await settle();
        internals.queueInline(image(2, 8, 3, 4, 2));
        await settle();
        expect(frames).toHaveLength(2);
        expect(frames[0]).toMatchObject({ graphics: true, graphicsSurface: 'full' });
        // The small image is drawn at its own size, but the pane still owns the
        // full surface, so that is what the phone is told. Reporting this one
        // frame's surface ended the phone's graphics scroll ownership while a
        // pane-filling image was still resident -- the same question the delete
        // path below already answers with survivingSurface.
        expect(frames[1]).toMatchObject({ graphics: true, graphicsSurface: 'full' });
        // Neither frame may clear the whole pane, or the other image is erased.
        expect(frames.every((frame) => !Buffer.from(frame.bytes, 'base64').toString('utf8').includes('a=d,d=A'))).toBe(true);

        // A phone joining while both are live is replayed both placements, and
        // every replayed frame must report the pane's surface, not the size of
        // whichever placement happens to be replayed last.
        const rejoined: { graphicsSurface?: string }[] = [];
        bridge.register({
            channel: 'rejoined',
            paneId: 'pane',
            cols: 20,
            rows: 10,
            cellWidthPx: 10,
            cellHeightPx: 20,
            write: (frame) => rejoined.push(JSON.parse(frame) as { graphicsSurface?: string }),
        });
        expect(rejoined).toHaveLength(2);
        expect(rejoined.every((frame) => frame.graphicsSurface === 'full')).toBe(true);
        bridge.unregister('rejoined');

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
        // Keep the no-repaint fallback clock separate from real frame work.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const gesture = { x: 150, y: 100, width: 200, height: 200 };
        const burst = bridge.scrollInput('phone', 'down', 30, gesture);
        expect(burst).toHaveLength(4);
        expect(burst[0]!.toString('utf8')).toBe('\u001b[<35;2;1M\u001b[<65;2;1M');
        // A second fling on top of the first asks for more travel than the
        // backlog may hold: the intent above the cap is dropped, and counted,
        // because a gesture that under-travels has to be visible somewhere.
        expect(bridge.scrollInput('phone', 'down', 30, gesture)).toHaveLength(0);
        expect(internals.notchesDropped).toBe(8);
        const framesBeforeDrain = frames.length;
        internals.queueInline(image(5, 1, 1, 20, 10));
        await settle();
        expect(frames.length).toBe(framesBeforeDrain + 1);
        expect(notches).toHaveLength(1);
        expect(notches[0]).toBe(burst[0]!.toString('utf8'));
        expect(internals.notchesSent).toBe(5);

        // The program's own delete names Herdr's id, which is the id the phone
        // holds, so it removes that image and nothing else. The pane still
        // owns the full-surface image, so the metadata must not report that
        // its graphics ended.
        internals.queueInline(Buffer.from('\u001b_Ga=d,d=I,i=2,q=2;\u001b\\'));
        await settle();
        expect(Buffer.from(frames.at(-1)!.bytes, 'base64').toString('utf8')).toContain('a=d,d=I,i=2');
        expect(frames.at(-1)).toMatchObject({ graphics: true, graphicsSurface: 'full' });

        // A small image beside the full surface survives a delete of the
        // presented image: the takeover metadata must report the inline
        // surface that survives, so the phone hands pointer and magnifier
        // back instead of keeping full takeover.
        internals.queueInline(image(8, 8, 3, 4, 2));
        await settle();
        internals.queueInline(Buffer.from('\u001b_Ga=d,d=I,i=5,q=2;\u001b\\'));
        await settle();
        expect(Buffer.from(frames.at(-1)!.bytes, 'base64').toString('utf8')).toContain('a=d,d=I,i=5');
        expect(frames.at(-1)).toMatchObject({ graphics: true, graphicsSurface: 'inline' });
        // The small image's own standalone delete ends the pane's takeover.
        internals.queueInline(Buffer.from('\u001b_Ga=d,d=I,i=8,q=2;\u001b\\'));
        await settle();
        expect(Buffer.from(frames.at(-1)!.bytes, 'base64').toString('utf8')).toContain('a=d,d=I,i=8');
        expect(frames.at(-1)).toMatchObject({ graphics: false });
        expect(internals.latestByPane.has('pane')).toBe(false);

        // A direct image delete is translated to the phone's id, not
        // broadcast under a source id that could name unrelated pixels. With
        // no successor placement queued it is a real delete: it forwards at
        // once and clears the bookkeeping.
        internals.imageOwners.set(6n, { paneId: 'pane', imageId: 900, sourceImageId: 6 });
        internals.latestByPane.set('pane', { compressed: Buffer.from([1]), width: 2, height: 2, imageId: 900, transferId: 6n });
        internals.queueInline(Buffer.from('\u001b_Ga=d,d=I,i=6,q=2;\u001b\\'));
        await settle();
        expect(Buffer.from(frames.at(-1)!.bytes, 'base64').toString('utf8')).toContain('a=d,d=I,i=900');
        expect(frames.at(-1)).toMatchObject({ graphics: false });
        expect(internals.latestByPane.has('pane')).toBe(false);
        expect(internals.imageOwners.has(6n)).toBe(false);
        bridge.close();
    });

    it.skipIf(process.platform === 'win32')('delivers a queued repaint atomically and honors the final image delete', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'herdr-repaint-'));
        const socketPath = join(dir, 'client.sock');
        const herdrBin = join(dir, 'herdr');
        const layoutGate = join(dir, 'layout-gate');
        const layoutEntered = join(dir, 'layout-entered');
        const layout = {
            workspace_id: 'workspace',
            tab_id: 'tab',
            area: { x: 0, y: 0, width: 20, height: 10 },
            panes: [{ pane_id: 'pane', rect: { x: 0, y: 0, width: 20, height: 10 } }],
        };
        // Fixture only the external Herdr protocol. Routing, scanning, image
        // storage, asynchronous preparation and phone frames are real.
        writeFileSync(herdrBin, `#!${process.execPath}
const command = process.argv.slice(2, 4).join(' ');
const fs = require('node:fs');
if (command === 'pane layout' && fs.existsSync(${JSON.stringify(layoutGate)})) {
    fs.writeFileSync(${JSON.stringify(layoutEntered)}, '');
    while (fs.existsSync(${JSON.stringify(layoutGate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const replies = {
    'pane list': { panes: [{ pane_id: 'pane', focused: true }] },
    'pane layout': { layout: ${JSON.stringify(layout)} },
    'pane process-info': { process_info: { foreground_process_group_id: 42 } },
    'workspace list': { workspaces: [{ workspace_id: 'workspace', active_tab_id: 'tab', focused: true }] },
};
if (!(command in replies)) process.exit(1);
console.log(JSON.stringify({ result: replies[command] }));
`, { mode: 0o700 });
        const server = createServer();
        let bridge: HerdrGraphicsBridge | undefined;
        let producer: Socket | undefined;
        try {
            server.listen(socketPath);
            await once(server, 'listening');
            const connected = once(server, 'connection');
            bridge = await HerdrGraphicsBridge.open({ herdrBin, socketPath, cellWidthPx: 10, cellHeightPx: 20 });
            [producer] = await connected as [Socket];
            producer.resume();
            const frames: string[] = [];
            let consumed = 0;
            let notify = () => {};
            const nextFrame = async (): Promise<string> => {
                if (consumed === frames.length) await new Promise<void>((resolve) => { notify = resolve; });
                return frames[consumed++]!;
            };
            const phone = {
                channel: 'phone', paneId: 'pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20,
                write: (frame: string) => { frames.push(frame); notify(); },
            };
            bridge.register(phone);
            const send = (ansi: string): void => {
                producer!.write(serverFrame(Buffer.concat([
                    uint(2), uint(1), uint(20), uint(10), Buffer.from([0]), bytes(Buffer.from(ansi)),
                ])));
            };
            const pixels = Buffer.alloc(16, 7).toString('base64');
            const image = (id: number, row = 1, col = 1, cols = 20, rows = 10): string =>
                `\u001b[${row};${col}H\u001b_Ga=t,f=32,s=2,v=2,i=${id},m=0;${pixels}\u001b\\`
                + `\u001b_Ga=p,i=${id},c=${cols},r=${rows};\u001b\\`;

            send(image(1));
            expect(JSON.parse(await nextFrame())).toMatchObject({ graphics: true, graphicsSurface: 'full' });
            send(image(2, 8, 3, 4, 2));
            // Placed beside a live pane-filling image: the pane's surface, not
            // this block's.
            expect(JSON.parse(await nextFrame())).toMatchObject({ graphics: true, graphicsSurface: 'full' });

            // Direct graphics replaces the full image without stealing the
            // neighboring image's id. A channel handoff must replay both.
            const rgbaPath = join(dir, 'direct.rgba');
            writeFileSync(rgbaPath, Buffer.alloc(16, 9));
            producer.write(serverFrame(Buffer.concat([
                uint(13), bytes(Buffer.from(rgbaPath)), uint(16), uint(30), uint(31),
                bytes(Buffer.from('\u001b[1;1H')), bytes(Buffer.from('a=T,f=32,s=2,v=2,i=30')),
            ])));
            const direct = frameAnsi(await nextFrame());
            expect(direct).toContain('a=d,d=I,i=1');
            expect(direct).not.toContain('a=d,d=A');
            const directId = /a=T,f=32,s=2,v=2,i=(\d+)/.exec(direct)![1]!;
            bridge.unregister('phone');
            const beforeHandoff = frames.length;
            bridge.register({ ...phone, channel: 'handoff' });
            const handoff = frames.slice(beforeHandoff).map(frameAnsi);
            expect(handoff).toHaveLength(2);
            expect(handoff.join('')).toContain(`a=T,f=32,s=2,v=2,i=${directId},`);
            expect(handoff.join('')).toContain('a=T,f=32,s=2,v=2,i=2,');
            expect(handoff.join('')).not.toContain('a=T,f=32,s=2,v=2,i=1,');
            expect(handoff.join('')).not.toContain('a=d,');
            await nextFrame();
            await nextFrame();
            send('\u001b_Ga=d,d=I,i=30,q=2;\u001b\\');
            expect(frameAnsi(await nextFrame())).toContain(`a=d,d=I,i=${directId}`);
            send(image(1));
            expect(JSON.parse(await nextFrame())).toMatchObject({ graphics: true, graphicsSurface: 'full' });

            // Captured Code pattern: delete the visible image, then queue
            // two repaints. The phone must get only the newest atomic frame,
            // never an intervening clear or deletion of the neighboring image.
            send('\u001b_Ga=d,d=I,i=1,q=2;\u001b\\' + image(3) + image(4));
            const repaint = await nextFrame();
            expect(JSON.parse(repaint)).toMatchObject({ graphics: true, graphicsSurface: 'full' });
            expect(frameAnsi(repaint)).toContain('a=d,d=I,i=1');
            expect(frameAnsi(repaint)).toContain('a=T,f=32,s=2,v=2,i=4');
            expect(frameAnsi(repaint)).not.toContain('a=d,d=A');
            expect(frameAnsi(repaint)).not.toContain('a=d,d=I,i=2');

            // Disconnect while the cached successor is routing. Its pending
            // uppercase delete must still execute; reconnect owes only the
            // neighboring image, never the deleted full-surface pixels.
            bridge.register({ ...phone, channel: 'handoff' });
            await nextFrame();
            await nextFrame();
            writeFileSync(layoutGate, '');
            send('\u001b_Ga=d,d=I,i=4,q=2;\u001b\\\u001b[1;1H\u001b_Ga=p,i=4,c=20,r=10;\u001b\\');
            await vi.waitFor(() => { expect(existsSync(layoutEntered)).toBe(true); }, { timeout: 2000, interval: 10 });
            bridge.unregister('handoff');
            const settled = new Promise<string>((resolve) => {
                bridge!.register({ ...phone, channel: 'observer', paneId: 'observer', write: resolve });
            });
            rmSync(layoutGate);
            expect(frameAnsi(await settled)).toContain('a=d,d=I,i=4');
            bridge.unregister('observer');
            const beforeReturn = frames.length;
            bridge.register({ ...phone, channel: 'returned' });
            expect(frames.slice(beforeReturn).map(frameAnsi)).toHaveLength(1);
            const survivor = await nextFrame();
            expect(frameAnsi(survivor)).toContain('a=T,f=32,s=2,v=2,i=2,');
            expect(JSON.parse(survivor)).toMatchObject({ graphics: true, graphicsSurface: 'inline' });
            send('\u001b_Ga=d,d=I,i=2,q=2;\u001b\\');
            const last = await nextFrame();
            expect(frameAnsi(last)).toContain('a=d,d=I,i=2');
            expect(frameGraphics(last)).toBe(false);
            expect(frames).toHaveLength(12);
            const replayed: string[] = [];
            bridge.register({
                channel: 'reconnected', paneId: 'pane', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20,
                write: (frame) => replayed.push(frame),
            });
            expect(replayed).toEqual([]);
        } finally {
            bridge?.close();
            producer?.destroy();
            await new Promise<void>((resolve) => { server.close(() => resolve()); });
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('keeps the diagnostic trace opt-in, bounded, and out of the frame path', async () => {
        // Off unless explicitly enabled, so an ordinary host records nothing.
        // The rest of this file passes identically with tracing on, which is
        // what shows the trace does not change graphics output.
        if (process.env.MUXR_GRAPHICS_TRACE === undefined) expect(graphicsTrace).toBeUndefined();

        const dir = mkdtempSync(join(tmpdir(), 'muxr-graphics-trace-'));
        const path = join(dir, 'trace.jsonl');
        const trace = new GraphicsTrace(path);
        try {
            // Far past the cap: storage must stop growing, not keep the tail.
            for (let i = 0; i < 5000; i += 1) trace.add('refine.arm', { pane: `pane-${i % 3}`, delayMs: i });
            trace.frame('frame.handoff', 'x'.repeat(4096), { pane: 'pane-0' });
            trace.close();

            const lines = readFileSync(path, 'utf8').trim().split('\n');
            const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(records.length).toBeLessThanOrEqual(4097);
            expect(records.at(-1)).toMatchObject({ event: 'trace.capped' });
            // Metadata only: pane identity is a per-run token, never the id.
            const panes = new Set(records.map((record) => record.pane).filter((value) => value !== undefined));
            expect([...panes].every((value) => /^pane[0-9]+$/.test(String(value)))).toBe(true);
            expect(readFileSync(path, 'utf8')).not.toContain('pane-1');
            expect(statSync(path).mode & 0o077).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('re-arms a settled pane whose refinement lost a fence to another pane', async () => {
        const socket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        const internals = bridge as unknown as {
            sourcePane: (leading: Buffer) => Promise<string | undefined>;
            visibleRect: (paneId: string) => Promise<{ x: number; y: number; width: number; height: number } | undefined>;
            queueInline: (data: Buffer) => void;
            drainInline: () => Promise<void>;
            inlineImages: { prepared: (...args: never[]) => Promise<unknown> };
            inlineQueue: unknown[];
            inlineDraining: boolean;
        };
        // Blocks are routed by the row they were written at: row 1 is A, row 2 is B.
        internals.sourcePane = vi.fn(async (leading: Buffer) => (leading.toString('utf8').startsWith('\u001b[1;') ? 'paneA' : 'paneB'));
        internals.visibleRect = vi.fn(async () => ({ x: 0, y: 0, width: 20, height: 10 }));

        const framesA: string[] = [];
        const framesB: string[] = [];
        bridge.register({ channel: 'a', paneId: 'paneA', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20, write: (frame) => framesA.push(frame) });
        bridge.register({ channel: 'b', paneId: 'paneB', cols: 20, rows: 10, cellWidthPx: 10, cellHeightPx: 20, write: (frame) => framesB.push(frame) });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const drain = vi.spyOn(internals, 'drainInline');
        const settle = async (): Promise<void> => {
            await drain.mock.results.at(-1)?.value;
            expect(internals.inlineQueue).toHaveLength(0);
            expect(internals.inlineDraining).toBe(false);
        };

        const width = 600;
        const height = 400;
        const rgba = Buffer.alloc(width * height * 4, 9);
        const paint = (row: number, id: number): void => {
            internals.queueInline(Buffer.from(
                `\u001b[${row};1H`
                + `\u001b_Ga=t,f=32,s=${width},v=${height},i=${id},o=z,m=0;${deflateSync(rgba).toString('base64')}\u001b\\`
                + `\u001b_Ga=p,i=${id},c=20,r=10;\u001b\\`,
            ));
        };

        try {
            paint(1, 1);
            await settle();
            expect(framesA).toHaveLength(1);
            expect(frameAnsi(framesA[0]!)).toContain('a=T,f=32,s=300,v=200,i=1,');

            // Hold A's refinement inside preparation, then let pane B paint. B
            // moves the shared fence while A's sharp frame is in flight.
            const store = internals.inlineImages;
            const realPrepared = store.prepared.bind(store);
            let release!: () => void;
            const held = new Promise<void>((resolve) => { release = resolve; });
            let heldOnce = false;
            store.prepared = (async (...args: never[]) => {
                if ((args[2] as unknown) === 'full' && !heldOnce) {
                    heldOnce = true;
                    store.prepared = realPrepared;
                    await held;
                }
                return realPrepared(...args);
            }) as typeof store.prepared;

            await vi.advanceTimersByTimeAsync(200);
            paint(2, 2);
            await vi.advanceTimersByTimeAsync(0);
            release();
            await settle();

            // A's refinement was discarded rather than sent: no stale pixels.
            expect(framesA).toHaveLength(1);
            expect(framesB.length).toBeGreaterThan(0);

            // A is still settled, so it must be re-armed and sharpen exactly once.
            await vi.advanceTimersByTimeAsync(200);
            await settle();
            expect(framesA).toHaveLength(2);
            expect(frameAnsi(framesA[1]!)).toContain('a=T,f=32,s=600,v=400,i=1,');
            await vi.advanceTimersByTimeAsync(5000);
            await settle();
            expect(framesA).toHaveLength(2);
        } finally {
            bridge.close();
            vi.useRealTimers();
        }
    });
});
