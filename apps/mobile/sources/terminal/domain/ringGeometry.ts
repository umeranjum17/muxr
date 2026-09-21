/**
 * The command ring's geometry: where the slots fan around the puck's anchor
 * and which slot a swept finger would fire. Pure math, so the component draws
 * exactly what the tests solve.
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


/** Elevations, in degrees, of the docked fan's first and last disc. */
export const DOCKED_ARC_START_DEG = 162;
export const DOCKED_ARC_END_DEG = 18;

/**
 * The docked ring's fan: `count` discs on an elliptical arc ABOVE the thumb
 * anchor (the composer rail's dial), rising from both sides of vertical.
 * The ellipse is narrower on the side with less room and grows until a disc
 * no longer fits, so every pane width gets the tallest clean arc available.
 * Offsets are anchor-relative, same space as `ringSlotOffsets`, so
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
    const pitchDeg = count > 1 ? (DOCKED_ARC_START_DEG - DOCKED_ARC_END_DEG) / (count - 1) : 0;
    const ALeft = anchor.x - margin;
    const ARight = region.width - margin - anchor.x;
    const BMax = anchor.y - margin;
    const solve = (A: number, B: number): { x: number; y: number }[] =>
        Array.from({ length: count }, (_, i) => {
            const rad = ((DOCKED_ARC_START_DEG - i * pitchDeg) * Math.PI) / 180;
            return { x: A * Math.cos(rad), y: -B * Math.sin(rad) };
        });
    const fits = (points: { x: number; y: number }[]): boolean =>
        points.every((p, i) => {
            const x = anchor.x + p.x;
            const y = anchor.y + p.y;
            const inBounds = x >= margin && x <= region.width - margin && y >= margin && y <= region.height - margin;
            const clear = points.every((q, j) => j >= i || Math.hypot(p.x - q.x, p.y - q.y) >= discSize);
            return inBounds && clear;
        });
    for (let B = Math.min(150, BMax); B >= 40; B -= 2) {
        const A = Math.min(1.1 * B, ALeft, ARight);
        if (A < 36) continue;
        const points = solve(A, B);
        if (fits(points)) return points;
    }
    const reduced = Math.max(1, count - 1);
    if (reduced < count) return dockedRingOffsets(anchor, region, reduced, discSize);
    return solve(Math.min(150, BMax), Math.min(150, BMax));
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
