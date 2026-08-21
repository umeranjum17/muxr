import { Easing, interpolate } from 'remotion';

/**
 * The film's design system.
 *
 * The previous cut placed every beat by hand — eight type sizes, six different
 * top offsets, forty elements all entering on one curve at one duration. That
 * reads as inconsistent because it is, and as slop because uniform entrances
 * across every element is the recognised tell.
 *
 * Everything below exists so a beat is composed by naming a column and a role,
 * not by picking numbers.
 */

/* ── Grid ────────────────────────────────────────────────────────────────── */

export const FRAME = { w: 1920, h: 1080 };
/** 12 columns, 120px margins, 32px gutters. */
export const GRID = { cols: 12, margin: 120, gutter: 32 };
const COL = (FRAME.w - GRID.margin * 2 - GRID.gutter * (GRID.cols - 1)) / GRID.cols;

/** Left edge of column `n` (0-indexed). */
export const col = (n: number) => GRID.margin + n * (COL + GRID.gutter);
/** Width of `n` columns including the gutters between them. */
export const span = (n: number) => n * COL + (n - 1) * GRID.gutter;
/** Distance from the right edge to the right edge of column `n` from the end. */
export const colFromRight = (n: number) => GRID.margin + n * (COL + GRID.gutter);

/** 8px baseline. Vertical positions are multiples of it. */
export const base = (n: number) => n * 8;

/**
 * The two halves are mutually exclusive, with a column of air between them.
 * Copy takes five columns from its margin; the stage takes everything from
 * column six to the opposite edge, and a fragment may bleed off that edge but
 * never across the gutter into the type.
 */
export const COPY_W = span(5);
export const STAGE_X = col(6);
export const STAGE_W = FRAME.w - STAGE_X;

/* ── Type scale ──────────────────────────────────────────────────────────── */

/**
 * Two sizes, not eight — and every headline in the film is set at the display
 * size. That is a constraint on the copy, not on the type: a five-column column
 * holds about twelve characters at this size, so every line is written to
 * twelve. Shrinking a headline to fit is what made the last cut look like it
 * had been assembled from parts.
 *
 * The film plays 390 CSS px wide on a phone, where anything under ~64px at this
 * frame size is illegible — which is also why there is no body copy.
 */
export const TYPE = {
    display: { size: 116, leading: 0.96, tracking: '-0.042em' },
    label: { size: 24, leading: 1.2, tracking: '0.24em' },
    /** The 1080-wide store frame is a narrower column and is read at rest. */
    store: { size: 78, leading: 1.02, tracking: '-0.038em' },
    storeSub: { size: 30, leading: 1.34, tracking: '0' },
    storeLabel: { size: 21, leading: 1.2, tracking: '0.22em' },
};
/** Characters per line the copy column holds at display size. */
export const LINE_BUDGET = 12;

/* ── Easing ──────────────────────────────────────────────────────────────── */

/** Arriving. Fast out, long tail. */
export const OUT = Easing.bezier(0.16, 1, 0.3, 1);
/** Arriving, lighter things. Snappier, shorter tail. */
export const OUT_SNAP = Easing.bezier(0.22, 1, 0.36, 1);
/** Departing. Gentle start, quick finish — exits should not compete. */
export const IN = Easing.bezier(0.55, 0, 0.85, 0.3);

/* ── Motion roles ────────────────────────────────────────────────────────── */

/**
 * Mass decides speed. A nav chip is small and light and should snap; a full
 * panel is heavy and should settle. Giving them the same duration is the thing
 * that makes a sequence feel machine-made.
 *
 * `lead` is where in the beat the role arrives, which is what produces
 * overlapping action: the panel is already settling as the chips land, and the
 * type finishes last.
 */
export type Role = 'panel' | 'chip' | 'display' | 'title' | 'label' | 'inline';

export const ROLE: Record<Role, {
    enter: number; exit: number; lead: number; rise: number; drift: number;
    scaleFrom: number; blurFrom: number; ease: typeof OUT;
}> = {
    //            enter exit lead rise drift scale  blur  ease
    panel: { enter: 30, exit: 10, lead: 0, rise: 22, drift: 14, scaleFrom: 0.982, blurFrom: 7, ease: OUT },
    chip: { enter: 13, exit: 7, lead: 14, rise: 12, drift: 8, scaleFrom: 0.9, blurFrom: 0, ease: OUT_SNAP },
    display: { enter: 20, exit: 9, lead: 6, rise: 0, drift: 0, scaleFrom: 1, blurFrom: 0, ease: OUT },
    title: { enter: 18, exit: 9, lead: 6, rise: 0, drift: 0, scaleFrom: 1, blurFrom: 0, ease: OUT },
    label: { enter: 15, exit: 7, lead: 26, rise: 9, drift: 0, scaleFrom: 1, blurFrom: 0, ease: OUT_SNAP },
    inline: { enter: 22, exit: 9, lead: 16, rise: 16, drift: 0, scaleFrom: 0.94, blurFrom: 4, ease: OUT },
};

/** 0 → 1 for a role, honouring its own lead and duration. */
export const arrive = (frame: number, role: Role, extraDelay = 0) => {
    const r = ROLE[role];
    return interpolate(frame - r.lead - extraDelay, [0, r.enter], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: r.ease,
    });
};

/**
 * 1 → 0 at the end of a beat. Shorter and shallower than the entrance: the eye
 * is already moving to what comes next, so a departure that mirrors the arrival
 * competes with it.
 */
export const depart = (frame: number, total: number, role: Role) => {
    const r = ROLE[role];
    return interpolate(frame, [total - r.exit, total - 1], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: IN,
    });
};

/* ── Beat rhythm ─────────────────────────────────────────────────────────── */

/**
 * Beats alternate which side of the frame the subject sits on, and which of
 * type or image arrives first. A film where every beat has the same rhythm is a
 * metronome; the contrast is what makes it read as edited.
 */
export type Cadence = 'image-first' | 'type-first';
export const cadenceOf = (index: number): Cadence => (index % 2 === 0 ? 'image-first' : 'type-first');
export const sideOf = (index: number): 'left' | 'right' => (index % 2 === 0 ? 'left' : 'right');

/** Type leads on a type-first beat, so shift the roles rather than the layout. */
export const cadenceOffset = (cadence: Cadence, role: Role) => {
    if (cadence === 'image-first') return role === 'display' || role === 'title' || role === 'label' ? 8 : 0;
    return role === 'panel' || role === 'chip' || role === 'inline' ? 10 : -6;
};

/* ── Depth ───────────────────────────────────────────────────────────────── */

/** Blur, recession and parallax all come off one number. */
export const depthOf = (depth: number) => ({
    blur: depth <= 0 ? 0 : 2.6 * depth ** 1.35,
    veil: depth <= 0 ? 0 : Math.min(0.62, 0.2 * depth),
    parallax: 1 / (1 + depth * 0.85),
});

export const ink = '#0d0d0f';
export const paper = '#ffffff';
export const dim = '#8b8b90';
export const status = { working: '#0A84FF', blocked: '#FF453A', done: '#30D158' };
