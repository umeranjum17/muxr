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

/**
 * The beats — the script (written by gpt-5.6-sol, implemented verbatim).
 * No card interludes: every line shares the frame with the footage that
 * proves it. `anchor` says where the words live: above the desk, beside the
 * phone, under the pair.
 */
export type Anchor = 'top' | 'right' | 'bottom' | 'center';
export const BEATS: Array<{
    id: string; frames: number; lines: string[]; anchor: Anchor; small?: string;
}> = [
    { id: 'bug', frames: 240, anchor: 'top',
      lines: ['Claude Code finds a refresh-token race.'] },
    { id: 'fix', frames: 240, anchor: 'top',
      lines: ['It writes the fix.', 'It adds three tests.'] },
    { id: 'wall', frames: 300, anchor: 'bottom',
      lines: ['Then pnpm test needs your approval.'] },
    { id: 'moves', frames: 240, anchor: 'right',
      lines: ['Away from your desk,', 'muxr shows the same prompt', 'on your phone.'] },
    { id: 'approval', frames: 240, anchor: 'bottom',
      lines: ['Your tap approves pnpm test.', 'Claude continues on your computer.'] },
    { id: 'run', frames: 300, anchor: 'bottom',
      lines: ['The tests run on your computer.', 'Every result appears live in muxr.'] },
    { id: 'result', frames: 240, anchor: 'right',
      lines: ['26 passed.', 'The refresh-token race is fixed.'] },
    { id: 'diffs', frames: 240, anchor: 'right',
      lines: ['See every diff.', 'Ship from your pocket.'] },
    { id: 'inbox', frames: 240, anchor: 'right',
      lines: ['An agent blocks?', 'muxr pings you.'] },
    { id: 'voice', frames: 270, anchor: 'right',
      lines: ['\u201cWhat changed while I was out?\u201d', 'Voice prompts on your behalf.'] },
    { id: 'herd', frames: 300, anchor: 'right',
      lines: ['Claude. Codex. Gemini. Cursor.', '22+ agents. One herd.'] },
    { id: 'relay', frames: 270, anchor: 'right',
      lines: ['Your Wi-Fi. Tailscale.', 'Or your own relay.'],
      small: 'END-TO-END ENCRYPTED \u00b7 OPEN-SOURCE SELF-HOSTED STACK' },
    { id: 'forget', frames: 180, anchor: 'center',
      lines: ['Forget the laptop.'] },
    { id: 'end', frames: 240, anchor: 'bottom', lines: [] },
];

export const starts = (() => {
    const map: Record<string, number> = {};
    let at = 0;
    for (const beat of BEATS) { map[beat.id] = at; at += beat.frames; }
    return map;
})();

export const TOTAL = BEATS.reduce((sum, beat) => sum + beat.frames, 0);
