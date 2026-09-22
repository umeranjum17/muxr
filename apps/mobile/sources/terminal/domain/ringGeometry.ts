/**
 * The command ring's geometry: where the slots fan around the thumb control's
 * anchor and which slot a swept finger would fire. Pure math, so the component
 * draws exactly what the tests solve.
 */

/** Slot disc diameter; the geometry's margins and the component's layout agree on it. */
export const RING_SLOT_SIZE = 48;
/** Total fan angle, in degrees, from the first slot to the last. */
export const RING_SWEEP_DEG = 135;
/** Lifts closer to the anchor than this cancel; the ring never misfires on a tap. */
export const RING_DEAD_ZONE = 60;
/** The docked fan never dips below this many degrees above the anchor's own
 *  horizon, so its ends clear the rails the thumb control sits in. */
export const DOCKED_END_LIFT_DEG = 10;
/** Past this the arc stops being one thumb's reach, but a cornered anchor may
 *  still need it: a wider circle spans the same chord over a narrower sweep,
 *  which is what lets the fan fold into a quadrant. */
const DOCKED_RADIUS_MAX = 208;
/** Clear air between two neighbouring discs, measured along the chord. */
const DOCKED_DISC_GAP = 6;
/** Tighter gaps the fan closes to before it gives up on the reference one. */
const DOCKED_DISC_GAPS = [2, 1];

/**
 * The docked ring's fan: `count` discs on a TRUE CIRCLE around the thumb
 * anchor, opening upward over the terminal and leaning away from whichever
 * side edge the thumb rests against.
 *
 * One radius and one chord for every disc, so the ring reads as an arc struck
 * from the control rather than a spray of buttons: the angular pitch is
 * derived from the disc's own width, which keeps the visual gap between
 * neighbours identical at any radius. A region too tight for the roomiest
 * radius gets a smaller circle (a wider angular spread at the same chord),
 * never a squashed one — the previous ellipse solved independent horizontal
 * and vertical semi-axes, so its discs sat at different distances, and an
 * anchor near the right edge collapsed it into a scattered fallback.
 *
 * The whole arc rotates as a rigid body to find room. Offsets are
 * anchor-relative, the space the component positions the discs in, so
 * `slotUnderFinger` drives the sweep unchanged.
 *
 * A region too short for the roomiest fan is served in order: the same circle
 * with the gap closed, then the same fan over `reach` — the whole overlay the
 * control is drawn in — instead of the terminal box. Every one of those is
 * still one circle inside RING_SWEEP_DEG, the wedge `slotUnderFinger` solves
 * with. When no circle carries every disc, the widest fan that fits is
 * returned with the count it fits; the caller keeps working on it — closing
 * the gap, shrinking the disc, spending the whole overlay — and only renders a
 * short fan when the pane has no room for the slot at all.
 */
export function dockedRingOffsets(
    anchor: { x: number; y: number },
    region: { width: number; height: number },
    count: number,
    discSize = RING_SLOT_SIZE,
    reach = region.height,
): { x: number; y: number }[] {
    if (count <= 0) return [];
    const margin = discSize / 2 + 6;
    // Lean away from the edge the thumb rests against: the room is inboard.
    const lean = anchor.x > region.width / 2 ? -1 : 1;
    const arc = (heightBound: number, gap: number, sweepCapDeg: number): { x: number; y: number }[] | null => {
        const chord = discSize + gap;
        // A circle tighter than this either overlaps its own discs at that
        // sweep or sits inside the sweep's dead zone, where a lift cannot
        // fire it.
        const sweepCap = (sweepCapDeg * Math.PI) / 180;
        const floor = Math.max(
            RING_DEAD_ZONE + 4,
            chord / 2 + 1,
            count > 1 ? chord / (2 * Math.sin(sweepCap / (2 * (count - 1)))) : discSize,
        );
        const place = (radius: number, turn: number): { x: number; y: number }[] => {
            const pitch = count > 1 ? 2 * Math.asin(Math.min(1, chord / (2 * radius))) : 0;
            const spread = pitch * (count - 1);
            const bearing = -Math.PI / 2 + turn;
            return Array.from({ length: count }, (_, index) => {
                // Arc order is list order, running from the anchor's own edge inward.
                const from = lean < 0 ? spread / 2 - index * pitch : -(spread / 2 - index * pitch);
                const angle = bearing + from;
                return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
            });
        };
        const fits = (points: { x: number; y: number }[]): boolean =>
            points.every((point) => {
                const x = anchor.x + point.x;
                const y = anchor.y + point.y;
                return x >= margin && x <= region.width - margin && y >= margin && y <= heightBound - margin;
            });
        // Tightest circle first: the ring should sit in the thumb's reach, and a
        // smaller radius spends the same chord over a wider sweep, which wraps
        // the control the way the references do. Growing the radius is the
        // escape for an anchor with no room to either side (the view-only
        // corner): the same discs then span a narrower sweep and fold into the
        // free quadrant.
        for (let radius = floor; radius <= DOCKED_RADIUS_MAX; radius += 2) {
            // How far this circle may rotate before an end drops onto the rails
            // the control sits in. A wider circle spans less sweep, so it buys
            // its own room to lean; the fan never tilts its way below the
            // horizon.
            const spreadDeg = (180 / Math.PI) * 2 * Math.asin(Math.min(1, chord / (2 * radius))) * (count - 1);
            const maxTurn = Math.max(0, (180 - 2 * DOCKED_END_LIFT_DEG - spreadDeg) / 2);
            // Smallest turns first, so the fan stays upright when it can.
            for (let step = 0; step <= maxTurn; step += 6) {
                for (const turn of step === 0 ? [0] : [lean * step, -lean * step]) {
                    const points = place(radius, (turn * Math.PI) / 180);
                    if (fits(points)) return points;
                }
            }
            if (maxTurn > 0 && maxTurn % 6 !== 0) {
                for (const turn of [lean * maxTurn, -lean * maxTurn]) {
                    const points = place(radius, (turn * Math.PI) / 180);
                    if (fits(points)) return points;
                }
            }
        }
        return null;
    };
    const attempts: { height: number; gap: number; cap: number }[] = [
        { height: region.height, gap: DOCKED_DISC_GAP, cap: 180 - 2 * DOCKED_END_LIFT_DEG },
    ];
    for (const gap of DOCKED_DISC_GAPS) attempts.push({ height: region.height, gap, cap: RING_SWEEP_DEG });
    if (reach > region.height) for (const gap of [DOCKED_DISC_GAP, ...DOCKED_DISC_GAPS]) attempts.push({ height: reach, gap, cap: RING_SWEEP_DEG });
    for (const attempt of attempts) {
        const points = arc(attempt.height, attempt.gap, attempt.cap);
        if (points !== null) return points;
    }
    // Nothing here carries this many discs: hand back the widest fan that does
    // fit, still a circle and still evenly spaced, with the count it fits.
    if (count > 1) return dockedRingOffsets(anchor, region, count - 1, discSize, reach);
    return [{ x: 0, y: -Math.max(RING_DEAD_ZONE + 4, margin) }];
}

/** Which slot a swept finger would fire: past the dead zone and inside that
 *  slot's angular wedge (its bearing ± half the arc's pitch). A single slot
 *  owns everything past the dead zone. Offsets are relative to the anchor, the
 *  space the fan returns. */
export function slotUnderFinger(finger: { x: number; y: number }, slots: readonly { x: number; y: number }[]): number | null {
    if (Math.hypot(finger.x, finger.y) < RING_DEAD_ZONE || slots.length === 0) return null;
    const angle = Math.atan2(finger.y, finger.x);
    const pitch = slots.length > 1 ? (RING_SWEEP_DEG * Math.PI) / 180 / (slots.length - 1) : 2 * Math.PI;
    let best: number | null = null;
    let bestGap = Infinity;
    slots.forEach((slot, index) => {
        const slotAngle = Math.atan2(slot.y, slot.x);
        let gap = Math.abs(angle - slotAngle);
        if (gap > Math.PI) gap = 2 * Math.PI - gap;
        if (gap <= pitch / 2 && gap < bestGap) {
            best = index;
            bestGap = gap;
        }
    });
    return best;
}
