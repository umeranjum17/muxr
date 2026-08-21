import type { Ground } from './design';

export type Beat = {
    id: string;
    kicker: string;
    /** `\n` is a chosen break, not a wrap. Nothing here wraps by accident. */
    headline: string;
    body: string;
    ground: Ground;
    /** Which side the copy sits on. The stage takes the other side. */
    side: 'left' | 'right';
    /** Which capture theme the screen on stage was filmed in. */
    capture: 'dark' | 'light';
    shot: string;
    layout?: 'card';
    panel?: 'desk' | 'authoring';
    /** Which band of the capture the stage shows, 0-100. The stage is a fixed
     *  window; where the flow stopped scrolling is not. */
    crop?: number;
};

/**
 * Eleven beats. The ground alternates in pairs so the cut carries the rhythm
 * and no transition effect has to. Copy covers what the product actually does
 * that nothing else does: voice, continuity, review, extension, spend, and a
 * relay you own.
 */
export const BEATS: Beat[] = [
    {
        id: 'title',
        kicker: 'muxr',
        headline: 'Leave the desk.\nNot the work.',
        body: 'trymuxr.com',
        ground: 'ink',
        side: 'left',
        capture: 'dark',
        shot: 'herd',
        layout: 'card',
    },
    {
        id: 'herd',
        kicker: 'The herd',
        headline: 'Sixteen agents.\nOne screen.',
        body: 'Claude, Codex, Gemini and Cursor, across every repo you have open —\nworking, blocked, or waiting on you.',
        ground: 'ink',
        side: 'left',
        capture: 'dark',
        shot: 'herd',
        crop: 0,
    },
    {
        id: 'same',
        kicker: 'Continuity',
        headline: 'Same pane.\nSame scrollback.',
        body: 'Not a mirror and not a summary. Stand up mid-thought and the pane\nis already open in your hand.',
        ground: 'paper',
        side: 'right',
        capture: 'light',
        shot: 'terminal',
        panel: 'desk',
    },
    {
        id: 'voice',
        kicker: 'Voice',
        headline: '“What changed\nwhile I was out?”',
        body: 'Native speech to speech. Ask it, interrupt it, tell it what to do next —\nno transcribe-then-prompt lag.',
        ground: 'ink',
        side: 'left',
        capture: 'dark',
        shot: 'voice',
        crop: 0,
    },
    {
        id: 'diff',
        kicker: 'Review',
        headline: 'See the diff.\nThen approve.',
        body: 'A real dual gutter and a per-file rail, rendered natively. Approve\nfrom the queue, or send it back.',
        ground: 'paper',
        side: 'right',
        capture: 'light',
        shot: 'changes',
        crop: 0,
    },
    {
        id: 'extend',
        kicker: 'Extend',
        headline: 'Native panels.\nNo WebViews.',
        body: 'Extensions render through a bounded API your machine approves.\nNothing downloads HTML to your phone.',
        ground: 'paper',
        side: 'left',
        capture: 'light',
        shot: 'plugins',
        crop: 38,
    },
    {
        id: 'author',
        kicker: 'Yours to build',
        headline: 'One command.\nYour own panel.',
        body: '`create` scaffolds it, `check` validates it, `dev` runs it live against\nthe app while you edit.',
        ground: 'ink',
        side: 'right',
        capture: 'dark',
        shot: 'plugins',
        panel: 'authoring',
    },
    {
        id: 'spend',
        kicker: 'Spend',
        headline: '$177 today.\n269.4M tokens.',
        body: 'Per model and per agent, read straight from the logs on the machine\nthat did the work.',
        ground: 'ink',
        side: 'left',
        capture: 'dark',
        shot: 'usage',
        crop: 6,
    },
    {
        id: 'selfhosted',
        kicker: 'Self-hosted',
        headline: 'Your relay.\nYour rules.',
        body: 'Tailscale, a Cloudflare tunnel, a VPS you own, or plain LAN.\nEnd-to-end encrypted on every one of them.',
        ground: 'paper',
        side: 'right',
        capture: 'light',
        shot: 'connection',
        crop: 12,
    },
    {
        id: 'away',
        kicker: 'Away',
        headline: 'It finds you\nat 2am.',
        body: 'Everything that finished, went quiet, or needs a decision —\ngrouped by repo, pushed to your phone.',
        ground: 'ink',
        side: 'left',
        capture: 'dark',
        shot: 'inbox',
        crop: 0,
    },
    {
        id: 'end',
        kicker: 'Open source · Apache-2.0 · self-hosted',
        headline: 'Leave the desk.',
        body: 'npm i -g @trymuxr/cli',
        ground: 'paper',
        side: 'left',
        capture: 'light',
        shot: 'herd',
        layout: 'card',
    },
];

export type StoreShot = {
    id: string;
    /** The only words on the frame. It has to survive being read at carousel
     *  thumbnail size, where the whole asset is about 150px wide. */
    headline: string;
    ground: Ground;
    capture: 'dark' | 'light';
    /** Which band of the capture the frame shows, 0-100. Chosen per shot so the
     *  bottom edge falls between rows rather than through one. */
    crop?: number;
};

/**
 * Eight store frames, ordered as the Play carousel shows them: what it is,
 * then the three things that make it unlike a dashboard, then the rest.
 * Grounds alternate so the strip has rhythm when you swipe it.
 */
export const STORE: StoreShot[] = [
    { id: 'herd', crop: 6.75, headline: 'Sixteen agents.\nOne screen.', ground: 'ink', capture: 'dark' },
    { id: 'terminal', crop: 12.75, headline: 'Same pane.\nSame scrollback.', ground: 'paper', capture: 'light' },
    { id: 'voice', crop: 5, headline: '“What changed\nwhile I was out?”', ground: 'ink', capture: 'dark' },
    { id: 'changes', crop: 9.5, headline: 'See the diff.\nThen approve.', ground: 'paper', capture: 'light' },
    { id: 'connection', crop: 62.5, headline: 'Your relay.\nYour rules.', ground: 'ink', capture: 'dark' },
    { id: 'usage', crop: 48, headline: '$177 today.\n269.4M tokens.', ground: 'ink', capture: 'dark' },
    { id: 'plugins', crop: 88, headline: 'Native panels.\nNo WebViews.', ground: 'paper', capture: 'light' },
    { id: 'inbox', crop: 9, headline: 'It finds you\nat 2am.', ground: 'ink', capture: 'dark' },
];
