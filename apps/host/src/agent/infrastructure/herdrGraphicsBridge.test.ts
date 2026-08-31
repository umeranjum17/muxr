import { EventEmitter } from 'node:events';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HerdrGraphicsBridge, decodeServerMessage, encodeKitty, mapGraphicsPointer, routeGraphicsPane } from './herdrGraphicsBridge.js';

const uint = (value: number | bigint): Buffer => {
    const number = BigInt(value);
    if (number < 251n) return Buffer.from([Number(number)]);
    if (number <= 0xffffn) { const data = Buffer.alloc(3); data[0] = 251; data.writeUInt16LE(Number(number), 1); return data; }
    const data = Buffer.alloc(9); data[0] = 253; data.writeBigUInt64LE(number, 1); return data;
};
const bytes = (value: Buffer): Buffer => Buffer.concat([uint(value.length), value]);

// One flow check: real protocol-20 GraphicsFile shape → exact visible-pane route
// → bounded Kitty placement. Hidden/ambiguous panes must never receive pixels.
describe('Herdr graphics flow', () => {
    it('decodes, routes, and emits one pane-scoped Kitty frame', () => {
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
        expect(mapGraphicsPointer(image, portrait, { phase: 'down', x: 200, y: 50, width: 400, height: 1600 })).toBeUndefined();
        expect(mapGraphicsPointer(image, portrait, { phase: 'down', x: 200, y: 790, width: 400, height: 1600 })).toEqual({ x: 800, y: 450 });
        const landscape = { ...portrait, cols: 120, rows: 30 };
        expect(mapGraphicsPointer(image, landscape, { phase: 'down', x: 50, y: 300, width: 1200, height: 600 })).toBeUndefined();
        expect(mapGraphicsPointer(image, landscape, { phase: 'down', x: 595, y: 300, width: 1200, height: 600 })).toEqual({ x: 800, y: 450 });

        const socket = Object.assign(new EventEmitter(), { writable: true, write: () => true, destroy: () => {} });
        const bridge = Reflect.construct(HerdrGraphicsBridge, [socket, 'herdr']) as HerdrGraphicsBridge;
        bridge.register(portrait);
        (bridge as unknown as { latestByPane: Map<string, typeof image> }).latestByPane.set('visible', image);
        bridge.unregister('phone');
        const replayed: string[] = [];
        bridge.register({ ...landscape, channel: 'rotated', write: (frame) => replayed.push(frame) });
        expect(replayed).toHaveLength(1);
        expect(Buffer.from((JSON.parse(replayed[0]!) as { bytes: string }).bytes, 'base64').toString('utf8')).toContain('c=107,r=30');
        (bridge as unknown as { retirePane: (paneId: string) => void }).retirePane('visible');
        expect(JSON.parse(replayed[1]!) as { graphics: boolean }).toMatchObject({ graphics: false });
        bridge.close();
        expect(bridge.register(portrait)).toBe(false);
    });
});
