/**
 * The command ring's geometry: where the slots bloom around the floating
 * control that opened them, and which slot a swept finger would fire. Pure
 * math, so the component draws exactly what the tests solve.
 *
 * The control floats on the terminal itself, so its anchor is a point INSIDE
 * the region rather than a dock below it. The arc is free to point anywhere:
 * it prefers to open upward, and rotates as a rigid body — around the control,
 * never away from it — until every disc has room.
 */

/** Slot disc diameter; the geometry's margins and the component's layout agree on it. */
export const RING_SLOT_SIZE = 48;
/**
 * Clear air between two neighbouring discs, measured along the chord. Wide
 * enough that every disc's caption owns its own space: the ring names each
 * action rather than leaving six unlabelled glyphs over the terminal.
 */
export const RING_DISC_GAP = 22;
/**
 * How wide a slot's caption may be: one chord less a hair, so two neighbouring
 * captions can never touch however the arc ended up spaced.
 */
export const RING_CAPTION_WIDTH = (discSize: number): number => discSize + RING_DISC_GAP - 6;
/**
 * The arc the ring prefers to span. The radius is derived from it, so the ring
 * keeps one shape — a thumb's sweep, not a full circle — at any slot count.
 */
export const RING_SWEEP_DEG = 150;
/** Lifts closer to the anchor than this cancel; the ring never misfires on a tap. */
export const RING_DEAD_ZONE = 60;
/** Room under a disc for its caption, and the clearance the arc keeps so a
 *  caption never lands outside the pane. */
export const RING_CAPTION_PAD = 26;
/** Clearance for a disc carrying no caption. */
const BARE_PAD = 6;
/**
 * Past this the arc stops being one thumb's reach, but a cornered anchor may
 * still need it: a wider circle spans the same chord over a narrower sweep,
 * which is what lets the ring fold into whatever quadrant is free.
 */
const RADIUS_MAX = 208;
/** Gaps the ring closes to before it gives up on the reference one. */
const TIGHT_GAPS = [12, 6, 2];

/**
 * `count` discs on a TRUE CIRCLE around the floating control, evenly spaced by
 * one chord, all inside `region`.
 *
 * One radius and one chord for every disc, so the ring reads as an arc struck
 * from the control rather than a spray of buttons: the angular pitch is
 * derived from the disc's own width, which keeps the visual gap between
 * neighbours identical at any radius.
 *
 * Room is found by rotating the whole arc, smallest turn first, so a control
 * resting in open terminal opens straight up and one dragged into a corner
 * folds into the space it has. Only when no rotation of any radius fits does
 * the ring close its gap; the caller shrinks the disc before that, and only a
 * region with no room for the slot at all gets a short fan.
 */
export function ringOffsets(
    anchor: { x: number; y: number },
    region: { width: number; height: number },
    count: number,
    discSize = RING_SLOT_SIZE,
    margin = discSize / 2 + 6,
): { x: number; y: number }[] {
    if (count <= 0) return [];
    const points = ringArc(anchor, region, count, discSize, margin);
    if (points !== null) return points;
    // Nothing here carries this many discs: hand back the widest arc that does
    // fit, still a circle and still evenly spaced, with the count it fits.
    if (count > 1) return ringOffsets(anchor, region, count - 1, discSize, margin);
    return [{ x: 0, y: -Math.max(RING_DEAD_ZONE + 4, margin) }];
}

/**
 * One attempt at the full arc: every disc or nothing. Kept separate from
 * `ringOffsets` because the callers that are about to try a different disc
 * size want the failure immediately rather than a shorter arc solved all the
 * way down — the search runs while the terminal is being resized, and solving
 * five arcs nobody will draw is how it stops fitting in a frame.
 */
function ringArc(
    anchor: { x: number; y: number },
    region: { width: number; height: number },
    count: number,
    discSize: number,
    margin: number,
): { x: number; y: number }[] | null {
    // Lean away from the edge the control rests against: the room is inboard.
    const lean = anchor.x > region.width / 2 ? -1 : 1;
    // The search tries thousands of circles and nearly all of them miss on
    // their first or second disc, so candidates are tested without building
    // anything: only the circle that fits is ever materialised. This runs while
    // the terminal is being resized, where the whole budget is one frame.
    const bearingOf = (index: number, pitch: number, spread: number, turn: number): number => {
        const from = lean < 0 ? spread / 2 - index * pitch : -(spread / 2 - index * pitch);
        return -Math.PI / 2 + turn + from;
    };
    const fits = (radius: number, pitch: number, spread: number, turn: number): boolean => {
        for (let index = 0; index < count; index += 1) {
            const angle = bearingOf(index, pitch, spread, turn);
            const x = anchor.x + radius * Math.cos(angle);
            if (x < margin || x > region.width - margin) return false;
            const y = anchor.y + radius * Math.sin(angle);
            if (y < margin || y > region.height - margin) return false;
        }
        return true;
    };
    const arc = (gap: number): { x: number; y: number }[] | null => {
        const chord = discSize + gap;
        // A circle tighter than this either sits inside the dead zone, where a
        // lift cannot fire it, or wraps the arc back onto its own first disc.
        // Three discs are the fewest that can wrap: one or two never span more
        // than the half-turn `asin` already caps the pitch at.
        const floor = Math.max(
            RING_DEAD_ZONE + 4,
            chord / 2 + 1,
            count > 2 ? chord / (2 * Math.sin(Math.PI / (count - 1))) : 0,
        );
        // The reference arc: this many discs a chord apart across one sweep.
        const preferred = count > 1
            ? chord / (2 * Math.sin((RING_SWEEP_DEG * Math.PI) / 180 / (2 * (count - 1))))
            : RING_DEAD_ZONE + discSize / 2;
        // Arc order is list order, running from the anchor's own edge inward.
        const place = (radius: number, pitch: number, spread: number, turn: number): { x: number; y: number }[] =>
            Array.from({ length: count }, (_, index) => {
                const angle = bearingOf(index, pitch, spread, turn);
                return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
            });
        // The reference radius first, then wider (the same chord over a
        // narrower sweep, which folds into a quadrant), then tighter.
        const start = Math.max(preferred, floor);
        const radii: number[] = [];
        for (let radius = start; radius <= RADIUS_MAX; radius += 4) radii.push(radius);
        for (let radius = start - 4; radius >= floor; radius -= 4) radii.push(radius);
        for (const radius of radii) {
            const pitch = count > 1 ? 2 * Math.asin(Math.min(1, chord / (2 * radius))) : 0;
            const spread = pitch * (count - 1);
            // Smallest turns first, so the ring opens upward when it can.
            for (let step = 0; step <= 180; step += 8) {
                for (const turn of step === 0 ? [0] : [lean * step, -lean * step]) {
                    const radians = (turn * Math.PI) / 180;
                    if (fits(radius, pitch, spread, radians)) return place(radius, pitch, spread, radians);
                }
            }
        }
        return null;
    };
    for (const gap of [RING_DISC_GAP, ...TIGHT_GAPS]) {
        const points = arc(gap);
        if (points !== null) return points;
    }
    return null;
}

/**
 * The whole arc, as the component draws it: how big the discs ended up,
 * whether they could keep their captions, and where they sit.
 *
 * Every action reaches every pane, so nothing here may return fewer discs than
 * it was asked for while a concession is left. In order of what is worth
 * giving up: the discs shrink, then the arc is allowed past the terminal's own
 * bottom edge into the rails below it — the ring scrims everything it covers,
 * so a terminal too short for the arc borrows that space rather than dropping
 * an action — and only then do the captions go. `preferHeight` is how much of
 * the region is terminal; the arc stays inside it whenever it can.
 */
export function ringFan(
    anchor: { x: number; y: number },
    region: { width: number; height: number },
    preferHeight: number,
    count: number,
    discSize: number,
): { offsets: { x: number; y: number }[]; disc: number; captions: boolean } {
    const sizes = [discSize, Math.round(discSize * 0.85), Math.round(discSize * 0.72)];
    const heights = preferHeight < region.height ? [preferHeight, region.height] : [region.height];

    for (const pad of [RING_CAPTION_PAD, BARE_PAD]) {
        for (const height of heights) {
            for (const size of sizes) {
                const offsets = ringArc(anchor, { width: region.width, height }, count, size, size / 2 + pad);
                if (offsets !== null) return { offsets, disc: size, captions: pad === RING_CAPTION_PAD };
            }
        }
    }
    // No concession left: the widest arc this pane can hold, at the tightest
    // disc, over everything the ring may draw on.
    const disc = sizes[sizes.length - 1]!;
    return { offsets: ringOffsets(anchor, region, count, disc, disc / 2 + BARE_PAD), disc, captions: false };
}

/**
 * Which slot a swept finger would fire: past the dead zone and inside that
 * slot's angular wedge. The wedge is half the arc's OWN pitch — the angle
 * between two neighbouring discs as drawn — so the wedges tile the arc exactly
 * however tight or wide the circle ended up, and a lift out past the ends
 * still cancels. A single slot owns everything past the dead zone. Offsets are
 * relative to the anchor, the space the arc returns.
 */
export function slotUnderFinger(finger: { x: number; y: number }, slots: readonly { x: number; y: number }[]): number | null {
    if (Math.hypot(finger.x, finger.y) < RING_DEAD_ZONE || slots.length === 0) return null;
    const angle = Math.atan2(finger.y, finger.x);
    const between = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
        let gap = Math.abs(Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
        if (gap > Math.PI) gap = 2 * Math.PI - gap;
        return gap;
    };
    const pitch = slots.length > 1 ? between(slots[0]!, slots[1]!) : 2 * Math.PI;
    let best: number | null = null;
    let bestGap = Infinity;
    slots.forEach((slot, index) => {
        let gap = Math.abs(angle - Math.atan2(slot.y, slot.x));
        if (gap > Math.PI) gap = 2 * Math.PI - gap;
        if (gap <= pitch / 2 && gap < bestGap) {
            best = index;
            bestGap = gap;
        }
    });
    return best;
}

/**
 * The directional cluster's placement. The control that opens it stands down
 * while the cluster is up, so the cluster owns the space the control left and
 * is centred on the control's resting point instead of held clear of it —
 * there is no control to collide with, and none to press through.
 *
 * A 3x3 cross is preferred, its keys stepping down together (52/8, then 44/6,
 * then 38/6) but never below the 38dp floor. Below the terminal height a 38dp
 * cross needs — three keys and two gaps, plus the pad at both ends, 138dp —
 * the same keys lie in one full-size band a single key tall (left, up, down,
 * right, return), every key still 38dp. Only a terminal that cannot hold even
 * that band, shorter than one 38dp key plus the pad at both ends (50dp) or
 * narrower than five keys, gets no cluster at all: the caller declines to open
 * it rather than drawing an unusable key. The arrows stay on the key row, so
 * nothing becomes unreachable.
 */

/** The key edge and the gap between keys, roomiest first. */
export const CLUSTER_STEPS: readonly { key: number; gap: number }[] = [
    { key: 52, gap: 8 },
    { key: 44, gap: 6 },
    { key: 38, gap: 6 },
];
/** Distance every key keeps from the edge of the terminal it sits on. */
export const CLUSTER_PAD = 6;
/** A cluster key is never drawn smaller than this, at any terminal height. */
export const CLUSTER_KEY_FLOOR = 38;
/** The band's preferred gap; it tightens before a key would shrink, and never below zero. */
export const CLUSTER_BAND_GAP = 6;

/** One key of the cluster's 3x3 box. */
export type ClusterSpot = 'up' | 'left' | 'centre' | 'right' | 'down';

/** The cross's shape: which cell of the 3x3 box each key owns. */
export const CLUSTER_SPOT: Record<ClusterSpot, { row: number; column: number }> = {
    up: { row: 0, column: 1 },
    left: { row: 1, column: 0 },
    centre: { row: 1, column: 1 },
    right: { row: 1, column: 2 },
    down: { row: 2, column: 1 },
};
/** The band's reading order: the four arrows left to right, return last. */
export const CLUSTER_BAND_ORDER: readonly ClusterSpot[] = ['left', 'up', 'down', 'right', 'centre'];

/** Where the cluster sits, in the terminal's own coordinates. */
export type ClusterLayout = {
    /** A 3x3 cross, or the one-key-tall band the short terminal gets instead. */
    arrangement: 'cross' | 'row';
    key: number;
    gap: number;
    /** Each key's box, relative to the cluster's own box. */
    seats: Record<ClusterSpot, { left: number; top: number }>;
    left: number;
    top: number;
    width: number;
    height: number;
};

const clusterSpan = (step: { key: number; gap: number }): number => step.key * 3 + step.gap * 2;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** The 3x3 cross at the roomiest size that fits the terminal, or null. */
function clusterCross(anchor: { x: number; y: number }, terminal: { width: number; height: number }): ClusterLayout | null {
    for (const step of CLUSTER_STEPS) {
        const span = clusterSpan(step);
        if (span > terminal.width - CLUSTER_PAD * 2 || span > terminal.height - CLUSTER_PAD * 2) continue;
        const seats = {} as Record<ClusterSpot, { left: number; top: number }>;
        (Object.keys(CLUSTER_SPOT) as ClusterSpot[]).forEach((spot) => {
            seats[spot] = {
                left: CLUSTER_SPOT[spot].column * (step.key + step.gap),
                top: CLUSTER_SPOT[spot].row * (step.key + step.gap),
            };
        });
        return {
            arrangement: 'cross', key: step.key, gap: step.gap, seats,
            left: clamp(anchor.x - span / 2, CLUSTER_PAD, terminal.width - span - CLUSTER_PAD),
            top: clamp(anchor.y - span / 2, CLUSTER_PAD, terminal.height - span - CLUSTER_PAD),
            width: span, height: span,
        };
    }
    return null;
}

/** The one-key-tall band, or null when five 38dp keys cannot fit the terminal. */
function clusterBand(anchor: { x: number; y: number }, terminal: { width: number; height: number }): ClusterLayout | null {
    const key = CLUSTER_KEY_FLOOR;
    const room = terminal.width - CLUSTER_PAD * 2;
    // Only the gap tightens when the width is what binds; the key never does.
    const gap = Math.min(CLUSTER_BAND_GAP, Math.floor((room - key * 5) / 4));
    const width = key * 5 + gap * 4;
    if (gap < 0 || width > room || key > terminal.height - CLUSTER_PAD * 2) return null;
    const seats = {} as Record<ClusterSpot, { left: number; top: number }>;
    CLUSTER_BAND_ORDER.forEach((spot, index) => { seats[spot] = { left: index * (key + gap), top: 0 }; });
    return {
        arrangement: 'row', key, gap, seats,
        left: clamp(anchor.x - width / 2, CLUSTER_PAD, terminal.width - width - CLUSTER_PAD),
        top: clamp(anchor.y - key / 2, CLUSTER_PAD, terminal.height - key - CLUSTER_PAD),
        width, height: key,
    };
}

/**
 * Where the cluster goes, entirely within `terminal`, or null when the terminal
 * cannot hold a 38dp key. It is centred on the control's resting point and
 * clamped inside the terminal; the ring's taller region is not a placement
 * surface, because the cluster lays no scrim and may not reach the key row or
 * composer below the terminal.
 */
export function clusterLayout(
    anchor: { x: number; y: number },
    terminal: { width: number; height: number },
): ClusterLayout | null {
    return clusterCross(anchor, terminal) ?? clusterBand(anchor, terminal);
}
