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
const RING_RADIUS = 104;
/** Below this the ideal fan's own discs would overlap, so the rigid search stops; tighter regions get the adaptive fan. */
const RING_RADIUS_FLOOR = 64;
const RING_RADIUS_STEP = 8;
/** Half a slot plus a margin keeps every disc fully inside the region. */
const EDGE_MARGIN = RING_SLOT_SIZE / 2 + 8;

/**
 * The arc, solved — not placed by eye. Returns slot centres as offsets from
 * the anchor's centre. The bearing points at the centre of the available
 * region (not the window: on a small phone with the keyboard up the window's
 * centre is inside the keyboard). Slots spread across the sweep; the first
 * slot sits at the end nearest the anchor's own screen edge, so arc order is
 * list order. When the discs would leave the region the whole fan rotates as
 * a rigid body first, then the radius steps down — the arc is never bent. A
 * region too short for any rigid arc (a phone with the keyboard up) gets a
 * searched fan instead: slots take the nearest spots on the region's edge
 * rows that keep the sweep's dead zone and a disc's width apart, so no
 * region, however short, draws overlapping or unselectable neighbours.
 */
export function ringSlotOffsets(anchor: { x: number; y: number }, region: { width: number; height: number }, count: number): { x: number; y: number }[] {
    if (count <= 0) return [];
    const sweep = (RING_SWEEP_DEG * Math.PI) / 180;
    const bearing = Math.atan2(region.height / 2 - anchor.y, region.width / 2 - anchor.x);
    const anchorRight = anchor.x >= region.width / 2;
    const pitch = count > 1 ? sweep / (count - 1) : 0;
    const place = (radius: number, rotation: number): { x: number; y: number }[] =>
        Array.from({ length: count }, (_, index) => {
            // First slot at the screen-edge end of the arc: for a right-hand
            // anchor the clockwise end walking left around the top, for a
            // left-hand anchor the mirror image walking right.
            const fromEdge = anchorRight ? sweep / 2 - index * pitch : -(sweep / 2 - index * pitch);
            const angle = bearing + rotation + fromEdge;
            return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
        });
    const fits = (points: { x: number; y: number }[]): boolean =>
        points.every((point, i) => {
            const x = anchor.x + point.x;
            const y = anchor.y + point.y;
            return x >= EDGE_MARGIN && x <= region.width - EDGE_MARGIN && y >= EDGE_MARGIN && y <= region.height - EDGE_MARGIN
                && points.every((other, j) => j <= i || Math.hypot(point.x - other.x, point.y - other.y) >= RING_SLOT_SIZE);
        });
    for (let radius = RING_RADIUS; radius >= RING_RADIUS_FLOOR; radius -= RING_RADIUS_STEP) {
        // Rigid-body rotation, the smallest angles first: the arc stays an arc.
        for (const rotation of [0, -6, 6, -12, 12, -18, 18]) {
            const points = place(radius, (rotation * Math.PI) / 180);
            if (fits(points)) return points;
        }
    }
    // A region too short for any rigid arc — a phone with the keyboard up.
    // Search the region's edge rows instead of shaping an arc: every
    // in-bounds spot on them a hair past the sweep's dead zone is a
    // candidate, and each slot takes the first one that still leaves a
    // disc's width to every slot before it, nearest the anchor first. If
    // tight windows leave that fan short, a bounded re-search tries other
    // early picks; a region too small to hold every disc at all gets the
    // slots that fit. Either way a slot is only ever placed where the checks
    // already hold, so what the component draws can never overlap, sit in
    // the dead zone, or hang off the region.
    const sweepable = RING_DEAD_ZONE + 0.005;
    const candidates: { x: number; y: number; d: number }[] = [];
    for (const y of [EDGE_MARGIN, region.height - EDGE_MARGIN]) {
        for (let x = EDGE_MARGIN; x <= region.width - EDGE_MARGIN; x += 2) {
            const d = Math.hypot(x - anchor.x, y - anchor.y);
            if (d >= sweepable) candidates.push({ x, y, d });
        }
    }
    candidates.sort((a, b) => a.d - b.d);
    const clear = (current: { x: number; y: number }[], candidate: { x: number; y: number }): boolean =>
        current.every((other) => Math.hypot(candidate.x - other.x, candidate.y - other.y) >= RING_SLOT_SIZE);
    const greedy: { x: number; y: number }[] = [];
    while (greedy.length < count) {
        const spot = candidates.find((candidate) => clear(greedy, candidate));
        if (!spot) break;
        greedy.push(spot);
    }
    if (greedy.length === count) return greedy.map((spot) => ({ x: spot.x - anchor.x, y: spot.y - anchor.y }));
    const searched: { x: number; y: number }[] = [];
    const search = (depth: number): boolean => {
        if (depth === count) return true;
        let branches = 0;
        for (const candidate of candidates) {
            if (!clear(searched, candidate)) continue;
            searched.push(candidate);
            if (search(depth + 1)) return true;
            searched.pop();
            branches += 1;
            if (branches === 8) break;
        }
        return false;
    };
    search(0);
    const placed = searched.length === count ? searched : greedy;
    return placed.map((spot) => ({ x: spot.x - anchor.x, y: spot.y - anchor.y }));
}


/** The docked fan never dips below this many degrees above the anchor's own
 *  horizon, so its ends clear the rails the thumb control sits in. */
export const DOCKED_END_LIFT_DEG = 10;
/** Past this the arc stops being one thumb's reach, but a cornered anchor may
 *  still need it: a wider circle spans the same chord over a narrower sweep,
 *  which is what lets the fan fold into a quadrant. */
const DOCKED_RADIUS_MAX = 208;
/** Clear air between two neighbouring discs, measured along the chord. */
const DOCKED_DISC_GAP = 6;

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
 * anchor-relative, the same space `ringSlotOffsets` returns, so
 * `slotUnderFinger` drives the sweep unchanged.
 */
export function dockedRingOffsets(
    anchor: { x: number; y: number },
    region: { width: number; height: number },
    count: number,
    discSize = RING_SLOT_SIZE,
): { x: number; y: number }[] {
    if (count <= 0) return [];
    const margin = discSize / 2 + 6;
    const chord = discSize + DOCKED_DISC_GAP;
    // Ends lifted clear of the rails caps how far the fan may span.
    const sweepCap = ((180 - 2 * DOCKED_END_LIFT_DEG) * Math.PI) / 180;
    // A circle tighter than this either overlaps its own discs at that sweep
    // or sits inside the sweep's dead zone, where a lift cannot fire it.
    const floor = Math.max(
        RING_DEAD_ZONE + 4,
        chord / 2 + 1,
        count > 1 ? chord / (2 * Math.sin(sweepCap / (2 * (count - 1)))) : discSize,
    );
    // Lean away from the edge the thumb rests against: the room is inboard.
    const lean = anchor.x > region.width / 2 ? -1 : 1;
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
            return x >= margin && x <= region.width - margin && y >= margin && y <= region.height - margin;
        });
    // Tightest circle first: the ring should sit in the thumb's reach, and a
    // smaller radius spends the same chord over a wider sweep, which wraps the
    // control the way the references do. Growing the radius is the escape for
    // an anchor with no room to either side (the view-only corner): the same
    // discs then span a narrower sweep and fold into the free quadrant.
    for (let radius = floor; radius <= DOCKED_RADIUS_MAX; radius += 2) {
        // How far this circle may rotate before an end drops onto the rails
        // the control sits in. A wider circle spans less sweep, so it buys its
        // own room to lean; the fan never tilts its way below the horizon.
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
    // Nothing fits at any radius. Keep the circle and keep it upright: an arc
    // that grazes the region's edge is still one control opening in place,
    // which a scattered fan never was. The overlay clamps what is left.
    return place(floor, 0);
}

/** Which slot a swept finger would fire: past the dead zone and inside that
 *  slot's angular wedge (its bearing ± half the arc's pitch). A single slot
 *  owns everything past the dead zone. Offsets are relative to the anchor, the
 *  same space `ringSlotOffsets` returns. */
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
