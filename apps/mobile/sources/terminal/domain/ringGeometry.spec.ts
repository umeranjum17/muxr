import { describe, expect, it } from 'vitest';
import { RING_DEAD_ZONE, RING_SLOT_SIZE, dockedRingOffsets, slotUnderFinger } from './ringGeometry';

// The ring's geometry is the contract: slots fan along a thumb arc anchored
// at the thumb control, in list order from the anchor's screen edge, and a
// sweep fires the slot whose wedge holds the finger. Solved here the way the
// component draws it, so the test fails if the fan or the wedge drifts.
describe('command ring geometry', () => {
    // A 390-wide phone. The control is docked in the composer rail, below the
    // terminal's own box, so its anchor sits under the region it fans over,
    // and `reach` is the whole overlay the rail and the fan are drawn in.
    const region = { width: 390, height: 500 };
    const anchor = { x: 326, y: 560 };
    const reach = 640;

    it('fans the default four into an arc that stays inside the region', () => {
        const points = dockedRingOffsets(anchor, region, 4, RING_SLOT_SIZE, reach);
        expect(points).toHaveLength(4);
        for (const point of points) {
            const x = anchor.x + point.x;
            const y = anchor.y + point.y;
            expect(x).toBeGreaterThanOrEqual(24 + 6);
            expect(x).toBeLessThanOrEqual(region.width - 24 - 6);
            expect(y).toBeGreaterThanOrEqual(24 + 6);
            expect(y).toBeLessThanOrEqual(reach - 24 - 6);
        }
        // Arc order is list order from the anchor's own edge: the first slot is
        // the one nearest the hand that opened the ring, the last curls in
        // toward the thumb.
        const xs = points.map((point) => point.x);
        expect(xs[0]).toBe(Math.max(...xs));
        const ys = points.map((point) => point.y);
        expect(ys[3]).toBe(Math.max(...ys));
    });

    it('mirrors for a left-hand anchor: dock the thumb control left, the ring fans right', () => {
        const points = dockedRingOffsets({ x: 64, y: 560 }, region, 4, RING_SLOT_SIZE, reach);
        const xs = points.map((point) => point.x);
        expect(xs[0]).toBe(Math.min(...xs));
        const ys = points.map((point) => point.y);
        expect(ys[3]).toBe(Math.max(...ys));
    });

    it('keeps every slot on a terminal box too short for the fan', () => {
        // The keyboard-up case the ring used to lose its trailing slots to:
        // 140dp of terminal, six actions. The fan takes the whole overlay it
        // is drawn in rather than rendering five of the six.
        const compact = { width: 360, height: 140 };
        const docked = { x: 360 - 105, y: 140 + 63 };
        expect(dockedRingOffsets(docked, compact, 6, RING_SLOT_SIZE, docked.y + 40)).toHaveLength(6);
        expect(dockedRingOffsets(docked, compact, 6, RING_SLOT_SIZE)).not.toHaveLength(6);
    });

    it('stays usable with the keyboard up at every compact height: every slot is drawn, fires itself, and keeps its neighbours apart', () => {
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
            const disc = compact.width < 340 ? 38 : 48;
            const count = compact.width < 340 ? 5 : 6;
            for (let x = 40; x <= compact.width - 40; x += 20) {
                const docked = { x, y: compact.height + 63 };
                const points = dockedRingOffsets(docked, compact, count, disc, docked.y + 40);
                const where = `at anchor (${x}, ${docked.y}) in ${compact.width}x${compact.height} with ${count} slots`;
                expect(points, where).toHaveLength(count);
                for (const point of points) {
                    const left = docked.x + point.x;
                    const top = docked.y + point.y;
                    expect(left, where).toBeGreaterThanOrEqual(disc / 2 + 6);
                    expect(left, where).toBeLessThanOrEqual(compact.width - disc / 2 - 6);
                    expect(top, where).toBeGreaterThanOrEqual(disc / 2 + 6);
                    expect(top, where).toBeLessThanOrEqual(docked.y + 40 - disc / 2 - 6);
                }
                for (let a = 0; a < points.length; a += 1) {
                    expect(Math.hypot(points[a]!.x, points[a]!.y), where).toBeGreaterThanOrEqual(RING_DEAD_ZONE);
                    expect(slotUnderFinger(points[a]!, points), where).toBe(a);
                    for (let b = a + 1; b < points.length; b += 1) {
                        expect(Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y), where).toBeGreaterThanOrEqual(disc);
                    }
                }
            }
        }
    });

    it('fires the slot under a lifted finger and nothing inside the dead zone', () => {
        const points = dockedRingOffsets(anchor, region, 4, RING_SLOT_SIZE, reach);
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
        // docked arc has sideways room there: the fan must still carry every
        // slot without leaving the region.
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

    // The rejected build opened this ring as a spray: the fan solved an
    // ellipse with independent semi-axes, so its discs sat at different
    // distances from the control and an anchor near the right edge collapsed
    // into a scattered fallback. The ring must read as one arc struck from the
    // control it opened from, at every width, count and dockable anchor.
    it('opens in place: every disc the same distance from the control and the same gap apart', () => {
        for (const region of [{ width: 270, height: 400 }, { width: 270, height: 200 }, { width: 360, height: 520 }, { width: 360, height: 180 }]) {
            const disc = region.width < 340 ? 38 : 48;
            const count = region.width < 340 ? 5 : 6;
            // Every anchor the composer rail can hand it, edge to edge.
            for (let x = 40; x <= region.width - 40; x += 20) {
                // The screen anchors the trigger on the composer rail, below the
                // fan's own bounds, and solves the arc against the terminal.
                const anchor = { x, y: region.height + 40 };
                const points = dockedRingOffsets(anchor, region, count, disc);
                const where = `anchored at (${x}, ${anchor.y}) in ${region.width}x${region.height}`;
                expect(points.length, `${where}: carries its slots`).toBeGreaterThan(0);
                expect(points.length, where).toBeLessThanOrEqual(count);

                const radii = points.map((point) => Math.hypot(point.x, point.y));
                const spread = Math.max(...radii) - Math.min(...radii);
                expect(spread, `${where}: one radius, not an ellipse`).toBeLessThanOrEqual(0.5);

                if (points.length > 1) {
                    const gaps = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
                    expect(Math.max(...gaps) - Math.min(...gaps), `${where}: one gap between neighbours`).toBeLessThanOrEqual(0.5);
                    expect(Math.min(...gaps), `${where}: neighbours never touch`).toBeGreaterThanOrEqual(disc);
                }

                // Anchored in place: the arc opens around its own control, so
                // no disc may sit below the control it came out of.
                const margin = disc / 2 + 6;
                points.forEach((point) => {
                    expect(point.y, `${where}: the fan opens upward`).toBeLessThanOrEqual(0);
                    const x = anchor.x + point.x;
                    const y = anchor.y + point.y;
                    expect(x, `${where}: stays in the region`).toBeGreaterThanOrEqual(margin);
                    expect(x, `${where}: stays in the region`).toBeLessThanOrEqual(region.width - margin);
                    expect(y, `${where}: stays in the region`).toBeGreaterThanOrEqual(margin);
                });
            }
        }
    });
});
