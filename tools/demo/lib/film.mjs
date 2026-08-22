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
 * @property {string} id      matches the clip name in cut/shots/
 * @property {'card'|'shot'} kind
 * @property {string} name
 * @property {string} [text]  a card's line — the only authored copy in the film
 * @property {number} start   first frame in the film
 * @property {number} frames  length; always a multiple of 6
 */

/**
 * The film, in order. Caption-led acts: each card states a cause, the footage
 * after it is the effect. The first cut had no narration and played as random
 * screens — real footage cannot narrate itself. This structure is the fix,
 * not a garnish: every screen now arrives as the answer to a sentence the
 * viewer just read.
 */
const TABLE = [
    ['c1', 'card', 'Your agent needs a yes.', 42],
    ['f1', 'shot', 'Claude Code mid-work', 78],
    ['f2', 'shot', 'The approval, huge', 60],
    ['c2', 'card', 'You\u2019re not at your desk.', 42],
    ['f3', 'shot', 'Abandoned, counter ticking', 90],
    ['c3', 'card', 'Your phone is.', 36],
    ['f4', 'shot', 'Same question, on the phone', 90],
    ['c4', 'card', 'One tap. The desk obeys.', 48],
    ['f5', 'shot', 'HERO \u2014 the tap, both screens', 120],
    ['c5', 'card', 'The work finishes without you.', 42],
    ['f6', 'shot', 'Tests run, 26 passed', 108],
    ['c6', 'card', 'All your agents. One pocket.', 42],
    ['f7', 'shot', 'The Herd', 90],
    ['end', 'shot', 'Brand close', 108],
];

export const SHOTS = [];
{
    let at = 0;
    for (const [id, kind, label, frames] of TABLE) {
        if (frames % 6 !== 0) throw new Error(`${id}: ${frames} is not a multiple of 6`);
        SHOTS.push(kind === 'card'
            ? { id, kind, name: label, text: label, start: at, frames }
            : { id, kind, name: label, start: at, frames });
        at += frames;
    }
}

export const CARDS = SHOTS.filter((s) => s.kind === 'card');
export const TOTAL_FRAMES = SHOTS.reduce((sum, s) => sum + s.frames, 0);
if (TOTAL_FRAMES !== 996) throw new Error(`film is ${TOTAL_FRAMES} frames, expected 996`);

/**
 * The README loop: "Your phone is." through the hero — context card, phone
 * reveal, priming card, the tap. The one sequence that is the whole product,
 * and it carries its own captions so it makes sense with nothing around it.
 */
export const LOOP = { start: 312, frames: 294 };

/**
 * The film's one soft edit: the Herd dissolves into the end card.
 *
 * Every other cut is hard — that is the film's language. One dissolve, at the
 * close, reads as punctuation instead of a transition style. The shot feeding
 * it is cut `frames` longer and the blend consumes the overlap, so the total
 * stays exactly TOTAL_FRAMES.
 */
export const DISSOLVE = { from: 'f7', into: 'end', frames: 12 };
