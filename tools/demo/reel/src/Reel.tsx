import React from 'react';
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, interpolate } from 'remotion';
import { Video } from '@remotion/media';
import { baseline, col, css, film, ground, span, type as scale } from './design';
import { SHOTS, TOTAL, startOf, type Shot } from './film';
import { Headline } from './Headline';
import { grade, push, enter, exit, PRESS } from './grade';
import { Device } from './Device';
import { Relay } from './Relay';
import { Lockup } from './Lockup';

const G = film;

/**
 * A capture filling the frame, cropped by the frame rather than floated in it.
 *
 * `crop` picks which band of the 1080x2400 screen is on camera. The clip is
 * scaled to the frame width, so the band is a vertical offset, not a resize —
 * the pixels stay at their native scale and the type inside them stays crisp.
 */
/**
 * Screen on one side at a scale where the UI reads as UI, copy in the six
 * columns opposite. The screen still runs off the top and bottom edges, so it
 * reads as a window onto something larger rather than a rectangle sitting on a
 * background — but at 1.28x frame height instead of the 1.8x that filling the
 * frame's width forces on a 9:20 capture.
 */
const Split: React.FC<{ shot: Shot; frame: number }> = ({ shot, frame }) => {
    const height = G.h * 1.28;
    const width = height * (1080 / 2400);
    const band = ((shot.crop ?? 0) / 100) * (height - G.h);
    const left = shot.side === 'left' ? G.margin : G.w - G.margin - width;
    const scaleAt = push(frame, shot.frames, shot.push);
    const g = ground[shot.ground];
    return (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
            <div
                style={{
                    position: 'absolute', left, top: (G.h - height) / 2 - band + (height - G.h) / 2,
                    width, height, overflow: 'hidden',
                    transform: `scale(${scaleAt})`, transformOrigin: 'center',
                    outline: `1px solid ${g.rule}`,
                }}
            >
                {shot.still === undefined ? (
                    <Video
                        src={staticFile(`film/${shot.clip!.window}.mp4`)}
                        trimBefore={shot.clip!.from ?? 0}
                        style={{ position: 'absolute', left: 0, top: -band, width, height }}
                        effects={grade(frame, shot.ground)}
                    />
                ) : (
                    <Img
                        src={staticFile(`stills/${shot.still}.png`)}
                        style={{ position: 'absolute', left: 0, top: -band, width, height }}
                        effects={grade(frame, shot.ground)}
                    />
                )}
            </div>
        </AbsoluteFill>
    );
};

const Bleed: React.FC<{ shot: Shot; frame: number }> = ({ shot, frame }) => {
    const scaleAt = push(frame, shot.frames, shot.push);
    const height = (G.w / 1080) * 2400;
    const band = ((shot.crop ?? 0) / 100) * (height - G.h);
    return (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, transform: `scale(${scaleAt})`, transformOrigin: 'center' }}>
                {shot.still === undefined ? (
                    <Video
                        src={staticFile(`film/${shot.clip!.window}.mp4`)}
                        trimBefore={shot.clip!.from ?? 0}
                        style={{ position: 'absolute', left: 0, top: -band, width: G.w, height }}
                        effects={grade(frame, shot.ground)}
                    />
                ) : (
                    <Img
                        src={staticFile(`stills/${shot.still}.png`)}
                        style={{ position: 'absolute', left: 0, top: -band, width: G.w, height }}
                        effects={grade(frame, shot.ground)}
                    />
                )}
            </div>
        </AbsoluteFill>
    );
};

/**
 * Kicker, hairline, headline — always in the same six columns, always arriving
 * after the picture. The rule binds the kicker to the headline so the block
 * reads as one object entering rather than three.
 */
const Caption: React.FC<{ shot: Shot; frame: number }> = ({ shot, frame }) => {
    const g = ground[shot.ground];
    const t = scale.film;
    const IMAGE_LEADS = 18;
    const opacity = enter(frame, IMAGE_LEADS) * exit(frame, shot.frames);
    const lift = interpolate(enter(frame, IMAGE_LEADS), [0, 1], [16, 0]);

    if (shot.micro !== undefined) {
        return (
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ ...css(t.micro), color: g.dim, textTransform: 'uppercase', opacity, transform: `translateY(${lift}px)` }}>
                    {shot.micro}
                </div>
            </AbsoluteFill>
        );
    }
    if (shot.headline === undefined) return null;
    // In a split the copy owns the six columns the screen is not using and sits
    // on the optical centre; in anything else it sits at the bottom margin.
    const isSplit = shot.stage === 'split';
    const copyLeft = isSplit && shot.side === 'left' ? col(G, 7) : col(G, 1);
    return (
        <div
            style={{
                position: 'absolute',
                left: copyLeft,
                ...(isSplit
                    ? { top: G.margin, height: G.h - G.margin * 2, display: 'flex', flexDirection: 'column', justifyContent: 'center' }
                    : { bottom: G.margin }),
                width: span(G, 6),
                opacity,
                transform: `translateY(${lift}px)`,
            }}
        >
            <div style={{ ...css(t.micro), color: g.dim, textTransform: 'uppercase' }}>{shot.kicker}</div>
            <div style={{ height: 2, background: g.rule, marginTop: baseline(2), marginBottom: baseline(4) }} />
            <Headline text={shot.headline} color={g.text} kind="film" />
        </div>
    );
};

/**
 * A press recesses. Scaling a touch target up and brightening it is the most
 * repeated amateur tell in this genre; real things move away from the finger.
 */
export const pressAt = (frame: number, at: number) => {
    const down = interpolate(frame, [at, at + 3], [0, 1], { easing: PRESS, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const up = interpolate(frame, [at + 3, at + 8], [1, 0], { easing: PRESS, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return down * up;
};

const Stage: React.FC<{ shot: Shot; frame: number }> = ({ shot, frame }) => {
    if (shot.stage === 'split') return <Split shot={shot} frame={frame} />;
    if (shot.stage === 'device') return <Device shot={shot} frame={frame} />;
    if (shot.stage === 'graphic') return <Relay frame={frame} frames={shot.frames} />;
    if (shot.stage === 'lockup') return <Lockup frame={frame} frames={shot.frames} />;
    return <Bleed shot={shot} frame={frame} />;
};

const ShotView: React.FC<{ shot: Shot }> = ({ shot }) => {
    const frame = useCurrentFrame();
    return (
        <AbsoluteFill style={{ background: ground[shot.ground].bg }}>
            <Stage shot={shot} frame={frame} />
            <Caption shot={shot} frame={frame} />
        </AbsoluteFill>
    );
};

/** Hard cuts, every one of them. Nothing in the film dissolves. */
export const Reel: React.FC = () => (
    <AbsoluteFill style={{ background: ground.ink.bg }}>
        {SHOTS.map((shot, index) => (
            <Sequence key={shot.id} from={startOf(index)} durationInFrames={shot.frames} name={shot.id}>
                <ShotView shot={shot} />
            </Sequence>
        ))}
    </AbsoluteFill>
);

export const REEL_FRAMES = TOTAL;
