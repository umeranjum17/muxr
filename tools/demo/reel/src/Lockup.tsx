import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile } from 'remotion';
import { baseline, css, film, ground, type as scale } from './design';
import { OUT_EXPO } from './grade';

const G = film;
const LINE = 'Leave the desk. Not the work.';

/**
 * The end card, and the only place the film holds completely still.
 *
 * A soundtrack would use silence here; a silent film has to use stillness, so
 * the shot before this one freezes for its last frames and then everything
 * stops except a cursor. The line types rather than fades because the product
 * is a terminal, and a block cursor is the one piece of ornament this film has
 * earned.
 */
export const Lockup: React.FC<{ frame: number; frames: number }> = ({ frame, frames }) => {
    const g = ground.ink;
    const t = scale.film;

    const mark = interpolate(frame, [8, 30], [0, 1], { easing: OUT_EXPO, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const typed = Math.floor(interpolate(frame, [34, 74], [0, LINE.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
    const tail = interpolate(frame, [80, 92], [0, 1], { easing: OUT_EXPO, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    // Frame-derived, so the blink is identical on every render and on every
    // machine. A wall-clock blink is how the last version came out shaking.
    const cursorOn = Math.floor(frame / 12) % 2 === 0;
    const fadeOut = interpolate(frame, [frames - 8, frames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    return (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: fadeOut }}>
            <Img
                src={staticFile('img/wordmark@3x.png')}
                style={{ width: 300, opacity: mark, filter: 'grayscale(1) brightness(2.6)' }}
            />
            <div style={{ ...css(t.body), fontFamily: 'PlexMono', color: g.text, marginTop: baseline(5), letterSpacing: 0 }}>
                {LINE.slice(0, typed)}
                <span style={{ opacity: cursorOn ? 1 : 0 }}>▊</span>
            </div>
            <div style={{ ...css(t.micro), color: g.dim, marginTop: baseline(6), opacity: tail, letterSpacing: 1.2 }}>
                npm install -g --ignore-scripts @trymuxr/cli
            </div>
            <div style={{ ...css(t.micro), color: g.dim, marginTop: baseline(1), opacity: tail, textTransform: 'uppercase' }}>
                trymuxr.com
            </div>
        </AbsoluteFill>
    );
};
