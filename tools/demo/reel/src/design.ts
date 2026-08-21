// The design system the review loop iterates on.
//
// Everything positional in the film and the store frames resolves through this
// file. If a coordinate appears in a component that did not come from `col`,
// `span`, or `baseline`, it is off-grid and the rubric fails it.

// ---------------------------------------------------------------- grid

/** The film: 12 columns at 1920, 120px margins, 48px gutters — colWidth 96, so
 *  every column line and every span lands on a whole pixel. */
export const film = { w: 1920, h: 1080, cols: 12, margin: 120, gutter: 48 };
/** The store frame: 6 columns at 1080, 72px margins, 24px gutters. */
export const store = { w: 1080, h: 1920, cols: 6, margin: 72, gutter: 24 };

type Grid = typeof film;

const colWidth = (g: Grid) => (g.w - g.margin * 2 - g.gutter * (g.cols - 1)) / g.cols;

/** Left edge of column `n`, 1-indexed. */
export const col = (g: Grid, n: number) => g.margin + (n - 1) * (colWidth(g) + g.gutter);
/** Width of `n` columns including the gutters between them. */
export const span = (g: Grid, n: number) => n * colWidth(g) + (n - 1) * g.gutter;
/** The 8px baseline everything vertical snaps to. */
export const baseline = (n: number) => n * 8;
/** Every rule in either deliverable. 2px, so no block it sits in is odd-height. */
export const hairline = 2;
/**
 * Display type is set from its ink, not its box. A single constant cannot do
 * that: the left side bearing is a property of the glyph, so one flush-left
 * block set with one offset presents as many left edges as it has distinct
 * first letters. Measured on Bricolage Bold at 84/-2.6 against a rule at the
 * margin, these are the corrections that put the ink itself on the line.
 */
const LSB: Record<string, number> = {
    // Round shoulders sit furthest inside their box and need the most pull.
    O: -7, C: -7, G: -7, Q: -7, S: -6, o: -7, c: -7, e: -7, s: -6,
    // Diagonals and crossbar caps already overhang; pulling them breaks the line.
    T: -2, A: -2, V: -2, W: -2, Y: -2, J: -3,
    // Quotes and punctuation hang fully — they are set outside the measure.
    '\u201c': -26, '"': -24, '$': -3,
};
/** Flat stems (E, K, I, P, N, L, m, n, r) are the reference and need this much. */
const LSB_STEM = -5;

/** The correction for a line, keyed on the character that starts it. */
export const optical = (line: string) => LSB[line[0]] ?? LSB_STEM;

// ---------------------------------------------------------------- ground

// Two grounds, cut against each other. There is no third. Beats alternate, so
// the film's rhythm comes from the cut rather than from a transition effect.
export const ground = {
    ink: {
        // Deliberately NOT the app's own #000 page colour. Matching it makes
        // the join invisible, which sounds like elegance and renders as a
        // screen with no edge at all — the crop stops reading as a crop. One
        // step lighter and the capture becomes the darker plane standing on it.
        bg: '#0a0a0c',
        // A single raised plane for panels. One step, not a ramp.
        raised: '#1b1b1f',
        text: '#f5f5f6',
        // Secondary type is the same hue at lower luminance, never a grey with
        // its own cast.
        dim: '#8a8a90',
        rule: 'rgba(245,245,246,0.16)',
    },
    paper: {
        bg: '#f2f1ed',
        raised: '#ffffff',
        text: '#111113',
        dim: '#6b6b70',
        rule: 'rgba(17,17,19,0.16)',
    },
} as const;

export type Ground = keyof typeof ground;

/**
 * The only colour in either deliverable, and only ever at dot size. These are
 * the app's own status hues, so the marketing cannot invent a brand colour the
 * product does not have.
 */
export const status = { working: '#0A84FF', blocked: '#FF453A', done: '#30D158' } as const;

// ---------------------------------------------------------------- type

export const face = { display: 'Bricolage', sans: 'Plex', mono: 'PlexMono' };

/**
 * Three sizes per deliverable. Not four. A fourth size is how a set stops
 * looking designed and starts looking assembled.
 */
export const type = {
    film: {
        display: { size: 84, lh: 88, track: -2.6, weight: 700, family: 'Bricolage' },
        body: { size: 24, lh: 32, track: -0.1, weight: 400, family: 'Plex' },
        micro: { size: 14, lh: 24, track: 1.6, weight: 600, family: 'Plex' },
    },
    store: {
        display: { size: 84, lh: 88, track: -2.6, weight: 700, family: 'Bricolage' },
        body: { size: 24, lh: 32, track: -0.1, weight: 400, family: 'Plex' },
        micro: { size: 14, lh: 24, track: 1.6, weight: 600, family: 'Plex' },
    },
} as const;

export const css = (t: { size: number; lh: number; track: number; weight: number; family: string }) => ({
    fontFamily: t.family,
    fontSize: t.size,
    lineHeight: `${t.lh}px`,
    letterSpacing: t.track,
    fontWeight: t.weight,
    margin: 0,
});

// ---------------------------------------------------------------- device

/** Captures are 1080x2400 with the 100px phone status bar cropped off as they
 *  are written, so every screen in either deliverable uses this ratio. */
export const SCREEN = 1080 / 2300;
