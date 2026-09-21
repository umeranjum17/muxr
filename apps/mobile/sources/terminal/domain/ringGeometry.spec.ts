import { describe, expect, it } from 'vitest';
import { RING_DEAD_ZONE, RING_SLOT_SIZE, dockedRingOffsets, ringSlotOffsets, slotUnderFinger } from './ringGeometry';

// The ring's geometry is the contract: slots fan along a thumb arc anchored
// at the thumb control, in list order from the anchor's screen edge, and a
// sweep fires the slot whose wedge holds the finger. Solved here the way the
// component draws it, so the test fails if the fan or the wedge drifts.
describe('command ring geometry', () => {
    // A 390-wide phone with the anchor bottom-right.
    const region = { width: 390, height: 500 };
    const anchor = { x: 326, y: 402 };

    it('fans the default four into an arc that stays inside the region', () => {
        const points = ringSlotOffsets(anchor, region, 4);
        expect(points).toHaveLength(4);
        for (const point of points) {
            const x = anchor.x + point.x;
            const y = anchor.y + point.y;
            expect(x).toBeGreaterThanOrEqual(24 + 8);
            expect(x).toBeLessThanOrEqual(region.width - 24 - 8);
            expect(y).toBeGreaterThanOrEqual(24 + 8);
            expect(y).toBeLessThanOrEqual(region.height - 24 - 8);
        }
        // Arc order is list order from the anchor's screen edge: for a
        // right-hand anchor the first slot is the rightmost one, and the
        // last curls down past straight-left, nearest the thumb.
        const xs = points.map((point) => point.x);
        expect(xs[0]).toBe(Math.max(...xs));
        const ys = points.map((point) => point.y);
        expect(ys[3]).toBe(Math.max(...ys));
    });

    it('mirrors for a left-hand anchor: dock the thumb control left, the ring fans right', () => {
        const leftAnchor = { x: 64, y: anchor.y };
        const points = ringSlotOffsets(leftAnchor, region, 4);
        const xs = points.map((point) => point.x);
        expect(xs[0]).toBe(Math.min(...xs));
        const ys = points.map((point) => point.y);
        expect(ys[3]).toBe(Math.max(...ys));
    });

    it('squeezes to a small phone: every slot still fits when the region cannot hold the ideal radius', () => {
        const tight = { width: 360, height: 260 };
        const points = ringSlotOffsets({ x: 296, y: 220 }, tight, 4);
        for (const point of points) {
            const x = 296 + point.x;
            const y = 220 + point.y;
            expect(x).toBeGreaterThanOrEqual(24 + 8);
            expect(x).toBeLessThanOrEqual(tight.width - 24 - 8);
            expect(y).toBeGreaterThanOrEqual(24 + 8);
            expect(y).toBeLessThanOrEqual(tight.height - 24 - 8);
        }
    });

    it('stays usable with the keyboard up at every compact height: every dockable anchor fans without overlap and every slot still fires', () => {
        // 360dp phones leave the ring 161dp with the keyboard up; on the
        // 270dp reference phone the branch line and tab strip take more,
        // down to 110dp. Every dockable anchor, every reachable count.
        for (const compact of [
            { width: 360, height: 161 },
            { width: 360, height: 140 },
            { width: 270, height: 140 },
            { width: 270, height: 120 },
            { width: 270, height: 110 },
        ]) {
            for (let x = 40; x <= compact.width - 40; x += 20) {
                for (let y = 40; y <= compact.height - 40; y += 10) {
                    for (const count of [2, 3, 4]) {
                        const points = ringSlotOffsets({ x, y }, compact, count);
                        const where = `at anchor (${x}, ${y}) in ${compact.width}x${compact.height} with ${count} slots`;
                        expect(points, where).toHaveLength(count);
                        for (const point of points) {
                            expect(x + point.x, where).toBeGreaterThanOrEqual(24 + 8);
                            expect(x + point.x, where).toBeLessThanOrEqual(compact.width - 24 - 8);
                            expect(y + point.y, where).toBeGreaterThanOrEqual(24 + 8);
                            expect(y + point.y, where).toBeLessThanOrEqual(compact.height - 24 - 8);
                        }
                        for (let a = 0; a < points.length; a += 1) {
                            expect(Math.hypot(points[a]!.x, points[a]!.y), where).toBeGreaterThanOrEqual(RING_DEAD_ZONE);
                            expect(slotUnderFinger(points[a]!, points), where).toBe(a);
                            for (let b = a + 1; b < points.length; b += 1) {
                                expect(Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y), where).toBeGreaterThanOrEqual(RING_SLOT_SIZE);
                            }
                        }
                    }
                }
            }
        }
    });

    it('fires the slot under a lifted finger and nothing inside the dead zone', () => {
        const points = ringSlotOffsets(anchor, region, 4);
        // Each slot's own position resolves to itself.
        points.forEach((point, index) => {
            expect(slotUnderFinger(point, points)).toBe(index);
        });
        // Between two slots, the nearer wedge wins, and both resolve.
        const middle = { x: (points[1]!.x + points[2]!.x) / 2, y: (points[1]!.y + points[2]!.y) / 2 };
        expect(slotUnderFinger(middle, points)).not.toBeNull();
        // Back on the anchor: a lift there cancels, never fires.
        expect(slotUnderFinger({ x: 0, y: 0 }, points)).toBeNull();
        expect(slotUnderFinger({ x: 30, y: -30 }, points)).toBeNull();
    });

    it('keeps every slot at the view-only corner anchor, inside the region', () => {
        // The view-only ring's anchor hugs the right edge 44dp in, so no
        // docked arc has sideways room there: the searched fan must take
        // over without dropping a slot or leaving the region.
        for (const region of [{ width: 270, height: 400 }, { width: 270, height: 300 }, { width: 360, height: 500 }]) {
            const anchor = { x: Math.max(44, region.width - 44), y: Math.max(120, region.height - 84) };
            const disc = region.width < 340 ? 38 : 48;
            const count = region.width < 340 ? 5 : 6;
            const points = dockedRingOffsets(anchor, region, count, disc);
            const where = `at the view-only anchor in ${region.width}x${region.height}`;
            expect(points, where).toHaveLength(count);
            const margin = disc / 2 + 6;
            points.forEach((point, index) => {
                const x = anchor.x + point.x;
                const y = anchor.y + point.y;
                expect(x, where).toBeGreaterThanOrEqual(margin);
                expect(x, where).toBeLessThanOrEqual(region.width - margin);
                expect(y, where).toBeGreaterThanOrEqual(margin);
                expect(y, where).toBeLessThanOrEqual(region.height - margin);
                expect(Math.hypot(point.x, point.y), where).toBeGreaterThanOrEqual(RING_DEAD_ZONE);
                expect(slotUnderFinger(point, points), where).toBe(index);
            });
            for (let a = 0; a < points.length; a += 1) {
                for (let b = a + 1; b < points.length; b += 1) {
                    expect(Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y), where).toBeGreaterThanOrEqual(disc);
                }
            }
        }
    });
});
