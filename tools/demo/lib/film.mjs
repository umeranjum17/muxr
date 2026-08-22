/**
 * The shot table. One source of truth for the film's timing.
 *
 * Nothing else decides when a shot starts or how long it runs — the cut, the
 * composition, the README loop and the review sheet all read this. Every
 * duration is a multiple of 6 frames at 30fps.
 */

export const FPS = 30;

/** The one job the whole film follows. Nothing in frame belongs to anything else. */
export const JOB = {
    repo: 'muxr-demo',
    path: '~/code/muxr-demo',
    session: 'auth-fix',
    agent: 'Claude Code',
    task: 'Fix the refresh-token race condition and run the auth tests',
    files: ['src/auth/token-store.ts', 'tests/auth/session.test.ts'],
    command: 'pnpm test',
};

/**
 * The herd as it stands at 30s. Four sessions, four agent kinds, seeded in
 * herdr workspace `muxr-demo` before filming so the rows are real.
 */
export const HERD = [
    { session: 'auth-fix', agent: 'Claude Code', kind: 'claude', state: 'done' },
    { session: 'billing-refactor', agent: 'Codex', kind: 'codex', state: 'working' },
    { session: 'landing-copy', agent: 'Gemini CLI', kind: 'gemini', state: 'blocked' },
    { session: 'flaky-e2e', agent: 'Cursor', kind: 'cursor', state: 'working' },
];

/** What the herd header reads at 30s. One machine is paired; the take is right. */
export const HERD_HEADER = '4 sessions · 1 machine';

/**
 * @typedef {object} Shot
 * @property {string} id      two-digit, matches the clip and review file names
 * @property {string} name
 * @property {number} start   first frame in the film
 * @property {number} frames  length, always a multiple of 6
 * @property {'desk'|'phone'|'both'|'composite'|'render'} source
 * @property {string} screen  what is on screen
 */

/** @type {Shot[]} */
export const SHOTS = [
    { id: '01', name: 'Full-screen terminal', start: 0, frames: 90, source: 'desk',
      screen: 'The prompt, the two file reads, the diagnosis, the edit. No chrome.' },
    { id: '02', name: 'Macro, pending interaction', start: 90, frames: 90, source: 'desk',
      screen: '`Claude wants to run pnpm test` and its options, scaled ~3x, bleeding off frame.' },
    { id: '03', name: 'Abandoned', start: 180, frames: 90, source: 'desk',
      screen: 'Pull back 100% to 20%. Counter reads WAITING FOR INPUT · 00:41.' },
    { id: '04', name: 'Match cut desktop to phone', start: 270, frames: 120, source: 'phone',
      screen: 'Same prompt, same size, same position. Phone revealed by status bar, header, key row.' },
    { id: '05', name: 'HERO', start: 390, frames: 120, source: 'both',
      screen: 'Both screens edge to edge. Enter on the phone; within 8 frames the desk runs the tests.' },
    { id: '06', name: 'Desk recedes', start: 510, frames: 72, source: 'composite',
      screen: 'Desk scales down and blurs, phone rises to centre. Transition only.' },
    { id: '07', name: 'Work progresses', start: 582, frames: 120, source: 'phone',
      screen: 'Three states, hard cut, header never moves.' },
    { id: '08', name: 'Completion', start: 702, frames: 108, source: 'phone',
      screen: 'Notification, then the finished state large. Hold 1s before the cut.' },
    { id: '09', name: 'Review the diff', start: 810, frames: 90, source: 'phone',
      screen: 'muxr Changes, light theme. The one added line in token-store.ts.' },
    { id: '10', name: 'Herd reveal', start: 900, frames: 90, source: 'phone',
      screen: 'Four sessions, four agents, three states, all legible.' },
    { id: '11', name: 'Brand close', start: 990, frames: 90, source: 'render',
      screen: 'Wordmark, the line typed with a cursor, trymuxr.com.' },
];

export const TOTAL_FRAMES = SHOTS.reduce((sum, shot) => sum + shot.frames, 0);

/** The README loop is shots 01–03, cut from this same timeline. */
export const LOOP = { start: 0, frames: 270 };

// A shot table that drifts silently is how a film ends up with a gap in it.
for (const [index, shot] of SHOTS.entries()) {
    if (shot.frames % 6 !== 0) throw new Error(`${shot.id}: ${shot.frames} frames is not a multiple of 6`);
    const expected = index === 0 ? 0 : SHOTS[index - 1].start + SHOTS[index - 1].frames;
    if (shot.start !== expected) throw new Error(`${shot.id}: starts at ${shot.start}, expected ${expected}`);
}
if (TOTAL_FRAMES !== 1080) throw new Error(`film is ${TOTAL_FRAMES} frames, expected 1080`);
