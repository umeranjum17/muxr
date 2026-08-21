import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { baseline, col, css, film, ground, hairline, span, type as scale } from './design';
import type { Ground } from './design';
import { Headline, Body } from './Headline';
import { BEATS, type Beat } from './beats';
import { Panel } from './Panel';

const G = film;
type Paint = (typeof ground)[Ground];

/** One stage box for every beat: the six columns the copy is not using, run off
 *  the outer edge, stopping one gutter short of the copy. A screen and a plate
 *  are two things on the same stage, not two stages. */
const STAGE_W = col(G, 7) - G.gutter;
const stageLeft = (side: Beat['side']) => (side === 'right' ? 0 : col(G, 7));
/** Full-bleed height, overshooting the frame equally top and bottom. */
const STAGE_H = baseline(179);
const STAGE_TOP = -baseline(22);

/**
 * A screen is cropped by the frame, never floated in it. No tilt, no drop
 * shadow, no glow behind it — the frame edge does the work a fake shadow would
 * otherwise be doing badly, and running it off the outer edge is what makes it
 * read as a window on something larger rather than a sticker.
 *
 * `crop` says which band of the capture the stage shows, per beat, because the
 * stage is a fixed window and the scroll position is not.
 */
const Screen: React.FC<{ src: string; side: Beat['side']; crop?: number }> = ({ src, side, crop }) => (
    <div
        style={{
            position: 'absolute',
            // Copy right means the stage is the left edge, and the reverse.
            left: stageLeft(side),
            top: STAGE_TOP,
            width: STAGE_W,
            height: STAGE_H,
        }}
    >
        <Img
            src={staticFile(src)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `50% ${crop ?? 50}%` }}
        />
    </div>
);

/**
 * Copy always occupies six columns. Only the stage moves. The block sits on the
 * bottom margin, the same line the bookend cards end on, so the headline does
 * not move across a cut and the leftover air collects in one stated place —
 * above the kicker, never split between top and bottom.
 */
const Copy: React.FC<{ beat: Beat; g: Paint }> = ({ beat, g }) => {
    const t = scale.film;
    return (
        <div
            style={{
                position: 'absolute',
                left: col(G, beat.side === 'right' ? 7 : 1),
                bottom: G.margin,
                width: span(G, 6),
            }}
        >
            <div style={{ ...css(t.micro), color: g.dim, textTransform: 'uppercase' }}>{beat.kicker}</div>
            {/* The only ornament, and it is load-bearing: it binds the kicker to
                the headline so the two read as one block rather than two. The
                rule's own 2px comes out of the gap below it, so the optical
                interval stays baseline(4) and the stack stays even. */}
            <div
                style={{
                    height: hairline,
                    background: g.rule,
                    marginTop: baseline(2),
                    marginBottom: baseline(4) - hairline,
                }}
            />
            <Headline text={beat.headline} color={g.text} kind="film" />
            <Body text={beat.body} color={g.dim} kind="film" marginTop={baseline(4)} />
        </div>
    );
};

/** The full measure. A rule that stops at an interior column line has to be
 *  explained; a rule that runs margin to margin is the margin. */
const Card: React.FC<{ beat: Beat; g: Paint }> = ({ beat, g }) => {
    const t = scale.film;
    return (
        <div
            style={{
                position: 'absolute',
                left: col(G, 1),
                top: G.margin,
                width: span(G, 12),
                height: G.h - G.margin * 2,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
            }}
        >
            <Headline text={beat.headline} color={g.text} kind="film" />
            <div
                style={{
                    height: hairline,
                    background: g.rule,
                    marginTop: baseline(5),
                    marginBottom: baseline(3) - hairline,
                }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ ...css(t.micro), color: g.dim }}>{beat.kicker}</div>
                <div style={{ ...css(t.micro), color: g.text, fontFamily: 'PlexMono', letterSpacing: 0 }}>
                    {beat.body}
                </div>
            </div>
        </div>
    );
};

/**
 * What sits on the stage varies — a cropped screen or a terminal plate — but the
 * box does not. The desk plate *is* the claim (the pane your desk has, at desk
 * width), so putting a phone on top of it only guillotines the scrollback it
 * exists to prove, and store-terminal already carries the phone version.
 */
const Stage: React.FC<{ beat: Beat }> = ({ beat }) =>
    beat.panel !== undefined ? (
        <Panel which={beat.panel} left={stageLeft(beat.side)} width={STAGE_W} />
    ) : (
        <Screen src={`stills/${beat.capture}/${beat.shot}.png`} side={beat.side} crop={beat.crop} />
    );

export const FilmFrame: React.FC<{ beat: string }> = ({ beat: id }) => {
    const beat = BEATS.find((b) => b.id === id) ?? BEATS[0];
    const g = ground[beat.ground];
    return (
        <AbsoluteFill style={{ background: g.bg }}>
            {beat.layout === 'card' ? (
                <Card beat={beat} g={g} />
            ) : (
                <>
                    <Stage beat={beat} />
                    <Copy beat={beat} g={g} />
                </>
            )}
        </AbsoluteFill>
    );
};
