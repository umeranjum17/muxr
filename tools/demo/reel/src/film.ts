import type { Ground } from './design';

/**
 * The film, as a shot list.
 *
 * One job is followed from the desk to the pocket to done. The eight
 * capabilities are not eight items — they are the eight things that happen to
 * one piece of work while you are somewhere else, which is why "sixteen" is
 * withheld until shot 11. Quantity only reads as power once the viewer has
 * watched a single pane succeed; open on sixteen and it is a list.
 *
 * Every duration is a whole multiple of 6 frames (0.2s). With no music, the
 * cut grid is the only pulse the film has.
 */
export type Shot = {
    id: string;
    frames: number;
    ground: Ground;
    /** Which cut window in reel/public/film, and where this shot starts in it. */
    clip?: { window: string; from?: number };
    /**
     * A settled still instead of a clip. Used where the shot states a claim
     * rather than shows an action, and where a scroll would be a liability —
     * the Connection screen prints the machine owner's own relay host, and a
     * moving clip carries it in and out of frame.
     */
    still?: string;
    kicker?: string;
    /** `\n` is a chosen break. Nothing wraps by accident. */
    headline?: string;
    /** Uppercase micro type, used where a headline would be too much. */
    micro?: string;
    /**
     * How the capture is staged.
     *
     * `bleed` fills the frame with a band of the screen — a 9:20 capture scaled
     * to a 16:9 frame's width is a 1.8x magnification, so this is a macro shot
     * by construction and only works when the band is chosen to BE the subject
     * (a key row, a gutter, a number). It carries no caption, because type over
     * a full-bleed macro is unreadable and putting a scrim behind the type to
     * fix that is the tell the rubric fails.
     *
     * `split` puts the screen on one side at a scale where the UI reads as UI,
     * and the copy in the six columns opposite. Captioned shots use this.
     */
    stage: 'bleed' | 'split' | 'device' | 'graphic' | 'lockup';
    /** Crop band of the capture, 0-100, when the shot wants part of the screen. */
    crop?: number;
    /** Scale at the shot's first and last frame. Equal means locked off. */
    push?: [number, number];
    /** Which side the screen sits on in a split. Copy takes the other six columns. */
    side?: 'left' | 'right';
};

export const SHOTS: Shot[] = [
    {
        // Five seconds, one image, no cut. Every reference film commits to its
        // opening frame; the rejected versions all cut within two seconds.
        id: 'open', frames: 156, ground: 'ink', stage: 'bleed',
        clip: { window: 'herdA', from: 0 },
        micro: 'You leave', push: [1, 1.038],
    },
    {
        // The only device in the film, and it never moves. What travels is the
        // reflection. The pane on its screen is literally shot 1 carrying on,
        // so the cut is a scale match rather than a new subject.
        id: 'pocket', frames: 114, ground: 'ink', stage: 'device',
        clip: { window: 'herdA', from: 156 },
        kicker: '01 / Continuity', headline: 'Same pane.\nSame scrollback.',
    },
    {
        // No caption: the product's own key row (ctrl, shift, esc, ^C) says
        // "you can actually drive this" better than a line of copy would.
        id: 'drive', frames: 78, ground: 'ink', stage: 'bleed',
        clip: { window: 'terminal' }, crop: 74, push: [1.06, 1.0],
    },
    {
        id: 'voice', frames: 96, ground: 'ink', stage: 'split', side: 'right',
        clip: { window: 'voice' },
        kicker: '02 / Voice', headline: '“What changed\nwhile I was out?”',
    },
    {
        // The only frame with no product in it. Action at a distance needs one
        // beat of pure graphic or the viewer never registers that the phone and
        // the machine are different places.
        id: 'relay', frames: 78, ground: 'ink', stage: 'graphic',
        micro: 'Your phone · your machine',
    },
    {
        id: 'diff', frames: 108, ground: 'paper', stage: 'split', side: 'left',
        clip: { window: 'changesA', from: 0 }, crop: 26,
        kicker: '03 / Review', headline: 'See the diff.\nThen approve.',
    },
    {
        // No caption. The press does the talking.
        id: 'approve', frames: 60, ground: 'paper', stage: 'bleed',
        clip: { window: 'changesA', from: 108 }, crop: 26, push: [1, 1.11],
    },
    {
        id: 'spend', frames: 78, ground: 'ink', stage: 'split', side: 'right',
        clip: { window: 'usage' }, crop: 8,
        kicker: '04 / Spend', headline: '$177 today.\n269.4M tokens.',
    },
    {
        id: 'extend', frames: 78, ground: 'ink', stage: 'split', side: 'left',
        clip: { window: 'plugins' }, crop: 38,
        kicker: '05 / Extend', headline: 'Native panels.\nNo WebViews.',
    },
    {
        id: 'selfhost', frames: 66, ground: 'ink', stage: 'split', side: 'right',
        still: 'dark/connection',
        // Framed to start below the Relay row: that row prints the machine
        // owner's own tailnet host, and review/leakcheck.mjs fails the build
        // if it ever creeps back into frame. crop: 62,
        kicker: '06 / Self-hosted', headline: 'Your relay.\nYour rules.',
    },
    {
        // The reveal. The film has followed one agent for thirty seconds; this
        // is where it pulls back and there are sixteen.
        id: 'scale', frames: 96, ground: 'ink', stage: 'split', side: 'left',
        clip: { window: 'herdB' }, crop: 44, push: [1.14, 1.0],
        kicker: '07 / The herd', headline: 'Sixteen agents.\nOne screen.',
    },
    {
        id: 'away', frames: 84, ground: 'ink', stage: 'split', side: 'right',
        clip: { window: 'inbox' }, crop: 12,
        kicker: '08 / Away', headline: 'It finds you\nat 2am.',
    },
    {
        id: 'lockup', frames: 108, ground: 'ink', stage: 'lockup',
    },
];

export const TOTAL = SHOTS.reduce((sum, shot) => sum + shot.frames, 0);

/** First frame of each shot, so a Sequence can be placed without arithmetic. */
export const startOf = (index: number) => SHOTS.slice(0, index).reduce((sum, shot) => sum + shot.frames, 0);
