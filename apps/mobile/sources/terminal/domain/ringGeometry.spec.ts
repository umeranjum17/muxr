import { describe, expect, it } from 'vitest';
import { CLUSTER_PAD, CLUSTER_SPOT, CLUSTER_STEPS, RING_CAPTION_PAD, RING_DEAD_ZONE, RING_SLOT_SIZE, clusterLayout, ringFan, ringOffsets, slotUnderFinger } from './ringGeometry';

type Point = { x: number; y: number };

// The ring's geometry is the contract: the control floats on the terminal and
// the arc is struck from wherever it rests, in list order from the anchor's
// nearer screen edge, and a sweep fires the slot whose wedge holds the finger.
// Solved here the way the component draws it, so the test fails if the arc or
// the wedge drifts.
describe('command ring geometry', () => {
    /**
     * Every terminal the ring has to open in: narrow PWA pane and roomy phone,
     * each with the keyboard down and with it up. `terminal` is the terminal's
     * own box; `overlay` adds the rails beneath it, which a short terminal is
     * allowed to borrow rather than drop an action.
     */
    const panes = [
        { width: 270, terminal: 440, overlay: 560 },
        { width: 270, terminal: 110, overlay: 230 },
        { width: 360, terminal: 620, overlay: 740 },
        { width: 360, terminal: 161, overlay: 281 },
    ];
    const discFor = (width: number): number => (width < 340 ? 38 : 48);
    /** The floating control the cross sits clear of. */
    const CONTROL = 44;

    it('carries every action from wherever the control rests, in every pane', () => {
        for (const pane of panes) {
            const region = { width: pane.width, height: pane.overlay };
            // Every resting position the control can be dragged to, corner to
            // corner of the terminal it floats on.
            for (let x = 38; x <= pane.width - 38; x += 26) {
                for (let y = 38; y <= pane.terminal - 38; y += 34) {
                    const anchor = { x, y };
                    const where = `resting at (${x}, ${y}) on a ${pane.width}x${pane.terminal} terminal`;
                    const fan = ringFan(anchor, region, pane.terminal, 6, discFor(pane.width));
                    const points = fan.offsets;
                    expect(points, `${where}: carries every action`).toHaveLength(6);

                    const radii = points.map((point: Point) => Math.hypot(point.x, point.y));
                    expect(Math.max(...radii) - Math.min(...radii), `${where}: one radius, not an ellipse`).toBeLessThanOrEqual(0.5);
                    expect(Math.min(...radii), `${where}: past the dead zone, so a lift fires`).toBeGreaterThanOrEqual(RING_DEAD_ZONE);

                    const gaps = points.slice(1).map((point: Point, index: number) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
                    expect(Math.max(...gaps) - Math.min(...gaps), `${where}: one gap between neighbours`).toBeLessThanOrEqual(0.5);
                    expect(Math.min(...gaps), `${where}: neighbours never touch`).toBeGreaterThanOrEqual(fan.disc);

                    const margin = fan.disc / 2 + (fan.captions ? RING_CAPTION_PAD : 6);
                    points.forEach((point: Point, index: number) => {
                        expect(anchor.x + point.x, `${where}: slot ${index} stays in the pane`).toBeGreaterThanOrEqual(margin);
                        expect(anchor.x + point.x, `${where}: slot ${index} stays in the pane`).toBeLessThanOrEqual(region.width - margin);
                        expect(anchor.y + point.y, `${where}: slot ${index} stays in the pane`).toBeGreaterThanOrEqual(margin);
                        expect(anchor.y + point.y, `${where}: slot ${index} stays in the pane`).toBeLessThanOrEqual(region.height - margin);
                        // Every drawn slot is reachable by the sweep that drew it.
                        expect(slotUnderFinger(point, points), `${where}: slot ${index} fires itself`).toBe(index);
                    });
                }
            }
        }
    });

    it('keeps the arc on the terminal, and its captions, whenever the terminal has room', () => {
        // A roomy pane never spends either concession: the ring opens at full
        // disc size, captioned, entirely above the rails.
        const pane = { width: 360, terminal: 620, overlay: 740 };
        const fan = ringFan({ x: 300, y: 520 }, { width: pane.width, height: pane.overlay }, pane.terminal, 6, RING_SLOT_SIZE);
        expect(fan.disc).toBe(RING_SLOT_SIZE);
        expect(fan.captions).toBe(true);
        for (const point of fan.offsets) expect(520 + point.y).toBeLessThanOrEqual(pane.terminal);
    });

    it('leans away from the edge the control rests against, in list order', () => {
        const region = { width: 390, height: 500 };
        // Against the right edge the arc runs leftward: the first slot is the
        // one nearest the hand that opened it, the last curls in toward it.
        const right = ringOffsets({ x: 340, y: 420 }, region, 4);
        expect(right.map((point: Point) => point.x)[0]).toBe(Math.max(...right.map((point: Point) => point.x)));
        // Against the left edge it mirrors.
        const left = ringOffsets({ x: 50, y: 420 }, region, 4);
        expect(left.map((point: Point) => point.x)[0]).toBe(Math.min(...left.map((point: Point) => point.x)));
        // Resting in open terminal, the arc prefers to open upward.
        const open = ringOffsets({ x: 195, y: 420 }, region, 4);
        for (const point of open) expect(point.y).toBeLessThan(0);
        // Dropped in the top corner, the same arc turns over and opens down
        // rather than dropping slots off the top of the pane.
        const high = ringOffsets({ x: 340, y: 60 }, region, 4);
        expect(high).toHaveLength(4);
        expect(Math.max(...high.map((point: Point) => point.y))).toBeGreaterThan(0);
    });

    it('places the directional cluster clear of the control, inside the terminal', () => {
        // The terminal's own box, keyboard down and keyboard up. The cross has
        // to reach the thumb on a 161dp and a 140dp terminal without ever
        // covering the control that opened it — that control is the only way
        // out of the cross — and without spilling onto the rails below, which
        // carry the key row and the composer: the cross lays no scrim, so it
        // owns no part of the surface outside the terminal.
        const boxes = [
            { width: 270, terminal: 440 },
            { width: 360, terminal: 620 },
            { width: 360, terminal: 161 },
            { width: 360, terminal: 140 },
            { width: 270, terminal: 110 },
            // The reference 270dp phone with the keyboard up and a two-line
            // prompt: the terminal the cross used to spill out of.
            { width: 270, terminal: 86 },
        ];
        for (const box of boxes) {
            for (let x = 38; x <= box.width - 38; x += 26) {
                for (let y = 38; y <= box.terminal - 38; y += 17) {
                    const where = `cluster for a control at (${x}, ${y}) on a ${box.width}x${box.terminal} terminal`;
                    const layout = clusterLayout({ x, y }, { width: box.width, height: box.terminal }, CONTROL);
                    for (const spot of Object.values(CLUSTER_SPOT)) {
                        const left = layout.left + spot.column * (layout.key + layout.gap);
                        const top = layout.top + spot.row * (layout.key + layout.gap);
                        expect(left < x + 22 && x - 22 < left + layout.key && top < y + 22 && y - 22 < top + layout.key,
                            `${where}: the cross never covers the control`).toBe(false);
                        // Every key is on the terminal, and nowhere else.
                        expect(left, `${where}: every key stays on the terminal`).toBeGreaterThanOrEqual(CLUSTER_PAD);
                        expect(left + layout.key, `${where}: every key stays on the terminal`).toBeLessThanOrEqual(box.width - CLUSTER_PAD);
                        expect(top, `${where}: every key stays on the terminal`).toBeGreaterThanOrEqual(CLUSTER_PAD);
                        expect(top + layout.key, `${where}: every key stays on the terminal`).toBeLessThanOrEqual(box.terminal - CLUSTER_PAD);
                    }
                }
            }
        }
        // A roomy pane keeps the largest keys. The step-down is for the short
        // terminals the keyboard leaves behind.
        expect(clusterLayout({ x: 306, y: 560 }, { width: 360, height: 620 }, CONTROL).key).toBe(CLUSTER_STEPS[0]!.key);
    });

    it('fires the slot under a lifted finger and nothing inside the dead zone', () => {
        const points = ringOffsets({ x: 300, y: 400 }, { width: 390, height: 500 }, 4, RING_SLOT_SIZE);
        points.forEach((point: Point, index: number) => {
            expect(slotUnderFinger(point, points)).toBe(index);
        });
        // Between two slots the nearer wedge wins, and both resolve.
        const middle = { x: (points[1]!.x + points[2]!.x) / 2, y: (points[1]!.y + points[2]!.y) / 2 };
        expect(slotUnderFinger(middle, points)).not.toBeNull();
        // Back on the control: a lift there cancels, never fires.
        expect(slotUnderFinger({ x: 0, y: 0 }, points)).toBeNull();
        expect(slotUnderFinger({ x: 30, y: -30 }, points)).toBeNull();
        // Out past the far side of the circle, where no slot was drawn, a lift
        // also cancels rather than firing whichever end happens to be nearest.
        const away = { x: -points[0]!.x, y: -points[0]!.y };
        expect(slotUnderFinger(away, points)).toBeNull();
    });
});
