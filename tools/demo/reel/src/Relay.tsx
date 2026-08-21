import React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import { baseline, css, film, ground, type as scale } from './design';
import { OUT_EXPO, enter } from './grade';

const G = film;

/**
 * The only frame in the film with no product in it.
 *
 * Everything else the film claims is visible on a screen. "Your machine is over
 * there and your phone is here, and the link between them is yours" is not —
 * it is the one idea with no UI to photograph, so it gets one beat of pure
 * graphic. Two marks and a line that draws between them, and the line starts at
 * the phone, because the film's whole premise is that you are the one acting.
 */
export const Relay: React.FC<{ frame: number; frames: number }> = ({ frame, frames }) => {
    const g = ground.ink;
    const t = scale.film;
    const y = G.h / 2;
    const left = G.w * 0.26;
    const right = G.w * 0.74;

    // The line draws from the phone to the machine, then the machine answers.
    const draw = interpolate(frame, [10, 46], [0, 1], { easing: OUT_EXPO, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const answer = interpolate(frame, [48, 62], [0, 1], { easing: OUT_EXPO, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    const Node: React.FC<{ x: number; label: string; lit: number }> = ({ x, label, lit }) => (
        <>
            <div style={{
                position: 'absolute', left: x - 5, top: y - 5, width: 10, height: 10, borderRadius: 5,
                background: g.text, opacity: 0.25 + lit * 0.75,
            }} />
            <div style={{
                position: 'absolute', left: x - 120, top: y + baseline(4), width: 240, textAlign: 'center',
                ...css(t.micro), color: g.dim, textTransform: 'uppercase', opacity: enter(frame, 4),
            }}>{label}</div>
        </>
    );

    return (
        <AbsoluteFill>
            {/* The track the signal runs on, always present so the draw reads as
                travel along something rather than as a line growing. */}
            <div style={{ position: 'absolute', left, top: y - 1, width: right - left, height: 2, background: g.rule }} />
            <div style={{
                position: 'absolute', left, top: y - 1, width: (right - left) * draw, height: 2, background: g.text,
            }} />
            <Node x={left} label="Your phone" lit={enter(frame, 4)} />
            <Node x={right} label="Your machine" lit={answer} />
            {/* No relay in between. That is the claim. */}
            <div style={{
                position: 'absolute', left: 0, top: y - baseline(9), width: G.w, textAlign: 'center',
                ...css(t.micro), color: g.dim, textTransform: 'uppercase', letterSpacing: 3,
                opacity: interpolate(frame, [52, 66], [0, 1], { easing: OUT_EXPO, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            }}>Nobody else in the middle</div>
        </AbsoluteFill>
    );
};
