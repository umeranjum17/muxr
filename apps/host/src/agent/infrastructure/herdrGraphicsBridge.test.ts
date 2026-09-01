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
        }, true).toString('utf8');
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
        internals.retire(5n, 5);
        const survivor = JSON.parse(replayed.at(-1)!) as { graphics: boolean; bytes: string };
        expect(survivor.graphics).toBe(true);
        expect(Buffer.from(survivor.bytes, 'base64').toString('utf8')).toContain('a=d,d=I,i=5');
        expect(Buffer.from(survivor.bytes, 'base64').toString('utf8')).not.toContain(',d=i,');
        expect(internals.latestByPane.get('visible')).toEqual(successor);

        internals.retire(2n, 8);
        const retiredCurrent = JSON.parse(replayed.at(-1)!) as { graphics: boolean; bytes: string };
        expect(retiredCurrent.graphics).toBe(false);
        expect(Buffer.from(retiredCurrent.bytes, 'base64').toString('utf8')).toContain('a=d,d=A');
        expect(Buffer.from(retiredCurrent.bytes, 'base64').toString('utf8')).not.toContain(',d=i,');
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
            internals.retire(20n, 20);
            const inflightClear = JSON.parse(replayed.at(-1)!) as { graphics: boolean; bytes: string };
            expect(inflightClear.graphics).toBe(false);
            expect(Buffer.from(inflightClear.bytes, 'base64').toString('utf8')).toContain('a=d,d=A');
            releaseProcess();
            await inflight;
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
            internals.retire(21n, 21);
            expect(replayed).toHaveLength(framesBeforeUnknown);
            releaseRoute();
            await unknownPane;
            expect(acks).toHaveLength(acksBeforeUnknown + 1);
            expect(graphicsResultAck(acks.at(-1)!)).toBe(true);
            const unknownClear = JSON.parse(replayed.at(-1)!) as { graphics: boolean; bytes: string };
            expect(unknownClear.graphics).toBe(false);
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
            const paneClear = JSON.parse(replayed.at(-1)!) as { graphics: boolean; bytes: string };
            expect(paneClear.graphics).toBe(false);
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
        expect(JSON.parse(replayed.at(-1)!) as { graphics: boolean }).toMatchObject({ graphics: false });
        internals.imageOwners.set(99n, { paneId: 'visible', imageId: 99, sourceImageId: 99 });
        internals.retire(99n, 99);
        expect((JSON.parse(replayed.at(-1)!) as { graphics: boolean }).graphics).toBe(false);
        bridge.close();
        expect(bridge.register(portrait)).toBe(false);
    });
});
