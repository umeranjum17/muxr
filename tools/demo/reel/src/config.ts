// The film's data: palette, the design tokens fable locked, the beat schedule,
// and where each beat's footage lives on the take's clock.
//
// Everything an editor would want to retime or restyle is here; the components
// read this and draw. The footage in-points are the same numbers the ffmpeg
// cut used — the take is unchanged, only the composition is new.

export const FPS = 60;
export const W = 1920;
export const H = 1080;

/** The product's own palette — nothing invented. */
export const INK = '#0a0a0b';
export const PAPER = '#ececec';
export const MUTED = '#9a9a9f';
export const HAIRLINE = '#2e2e2e';
export const GREEN = '#30D158';

export const BLUE = '#0A84FF';

/**
 * Design tokens, locked: one unbroken camera, springs only on objects, green
 * as the voice of the desk saying yes.
 */
export const TOKENS = {
    ground: {
        // Radial lift so the ink reads as a lit space, not a void.
        gradient: `radial-gradient(120% 90% at 50% 40%, #141416 0%, ${INK} 80%)`,
        vignette: `radial-gradient(ellipse at 50% 50%, transparent 70%, rgba(5,5,6,0.55) 100%)`,
        grain: 0.035,
        grainReseed: 4,     // frames between grain seeds — 15Hz shimmer
    },
    panel: {
        radius: 12,
        border: `1px solid ${HAIRLINE}`,
        shadow: '0 2px 8px rgba(0,0,0,0.4), 0 32px 80px rgba(0,0,0,0.55)',
        titlebarHeight: 36,
        titlebarFill: '#111113',
        dot: '#3a3a3e',     // monochrome — this is not macOS cosplay
        phoneRadius: 40,
    },
    motion: {
        // The camera glides, critically damped, and never bounces.
        camera: { damping: 200, stiffness: 100, mass: 1 },
        // Objects arrive with one ~4% overshoot. Life lives in the objects,
        // not the lens.
        object: { damping: 16, stiffness: 170, mass: 1 },
        word: { damping: 14, stiffness: 180, mass: 1 },
    },
    caption: {
        size: 68,
        weight: 600,
        color: PAPER,
        tracking: '-0.01em',
        wordStagger: 4,     // frames between words
        rise: 28,           // px each word rises from
        parallax: 0.85,     // captions ride the ground plane
        exit: 12,           // frames; entrances are springy, exits are curt
    },
    ripple: {
        color: BLUE,
        from: 10,
        to: 110,
        stroke: 3,
        opacity: 0.45,
        frames: 28,
    },
    ack: {
        // The desk answers 12 frames after the tap: call-and-response.
        latency: 12,
        color: GREEN,
        glow: '0 0 28px rgba(48,209,88,0.35)',
        attack: 8,
        hold: 12,
        decay: 36,
    },
};

/** Where the real footage lives, on the take's own clock (seconds). */
export const SRC = {
    desk: 'take/desk-cfr.mp4',       // 1948x1948, 30fps
    phone: 'take/phone-cfr.mp4',     // 1080x2400, 30fps
    after: 'take/phone-after-cfr.mp4',
    // The herd, captured with the other workspace groups collapsed: their
    // rows print machine paths that have no business in the film, and the
    // collapsed headers are clean.
    herd: 'take/phone-herd-cfr.mp4',
};

/** Moments in the take (seconds), measured by cut/timeline.mjs. */
export const AT = {
    work: 49.4,
    approvalUp: 50.94,
    waiting: 92.0,
    phoneApproval: 91.0,
    tap: 96.1,
    testsRunning: 101.4,
    writeup: 5.0,       // on the after pass
    herd: 2.0,          // on the dedicated collapsed-herd clip
};

/**
 * The prompt box inside the 1948x1948 desk render, in render pixels.
 * The camera dives to it for the macro beat.
 */
export const PROMPT = { x: 60, y: 1330, w: 900, h: 506 };

/** The Enter key on the phone screen (1080x2400), in screen pixels. */
export const ENTER = { x: 476, y: 2112 };

/**
 * The acts. `frames` are at 60fps. Each caption is a sentence; the beat after
 * it is that sentence's proof. Total is derived; the renderer trusts this
 * table the way the old cutter trusted lib/film.mjs.
 */
export const ACTS = [
    { id: 'c1', kind: 'card' as const, text: 'Your agent needs a yes.', frames: 96 },
    { id: 'work', kind: 'beat' as const, frames: 168 },   // desk enters, working
    { id: 'macro', kind: 'beat' as const, frames: 156 },  // camera dives to the prompt
    { id: 'c2', kind: 'card' as const, text: 'You’re not at your desk.', frames: 90 },
    { id: 'waiting', kind: 'beat' as const, frames: 180 }, // pull back + counter
    { id: 'c3', kind: 'card' as const, text: 'Your phone is.', frames: 78 },
    { id: 'reveal', kind: 'beat' as const, frames: 168 }, // phone slides in, same question
    { id: 'c4', kind: 'card' as const, text: 'One tap. The desk obeys.', frames: 96 },
    { id: 'hero', kind: 'beat' as const, frames: 264 },   // both panels, the tap, the flip
    { id: 'c5', kind: 'card' as const, text: 'The work finishes without you.', frames: 90 },
    { id: 'finish', kind: 'beat' as const, frames: 216 }, // tests run -> 26 passed
    { id: 'c6', kind: 'card' as const, text: 'All your agents. One pocket.', frames: 90 },
    { id: 'herd', kind: 'beat' as const, frames: 168 },   // the herd, live dots
    { id: 'end', kind: 'beat' as const, frames: 240 },    // wordmark, line, url
];

export const starts = (() => {
    const map: Record<string, number> = {};
    let at = 0;
    for (const act of ACTS) { map[act.id] = at; at += act.frames; }
    return map;
})();

export const TOTAL = ACTS.reduce((sum, act) => sum + act.frames, 0);
