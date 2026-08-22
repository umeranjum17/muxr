import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame } from 'remotion';
import { FPS, GREEN, MUTED, TOKENS } from './config';
import { MONO, SANS } from './fonts';

/**
 * A caption: one sentence, words arriving on the word spring, the final
 * period replaced by the status-dot green — the film's signature. Entrances
 * are springy, exits are curt.
 */
export const Caption: React.FC<{
    text: string; at: number; frames: number; parallax: { dx: number; dy: number };
}> = ({ text, at, frames, parallax }) => {
    const frame = useCurrentFrame();
    if (frame < at || frame > at + frames + 4) return null;
    const local = frame - at;

    const words = text.replace(/\.$/, '').split(' ');
    const exitAt = frames - TOKENS.caption.exit;
    const exit = interpolate(local, [exitAt, frames], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic) });

    return (
        <AbsoluteFill style={{
            justifyContent: 'center', alignItems: 'center',
            transform: `translate(${parallax.dx}px, ${parallax.dy - 16 * exit}px)`,
            opacity: 1 - exit,
        }}>
            <div style={{
                fontFamily: SANS, fontWeight: TOKENS.caption.weight,
                fontSize: TOKENS.caption.size, color: TOKENS.caption.color,
                letterSpacing: TOKENS.caption.tracking,
                display: 'flex', gap: '0.28em', alignItems: 'baseline',
            }}>
                {words.map((word, i) => {
                    const wordAt = i * TOKENS.caption.wordStagger;
                    const p = local < wordAt ? 0
                        : spring({ frame: local - wordAt, fps: FPS, config: TOKENS.motion.word });
                    const fade = interpolate(local, [wordAt, wordAt + 8], [0, 1],
                        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                    return (
                        <span key={i} style={{
                            display: 'inline-block',
                            transform: `translateY(${(TOKENS.caption.rise * (1 - p)).toFixed(2)}px)`,
                            opacity: fade,
                        }}>{word}</span>
                    );
                })}
                <Dot at={words.length * TOKENS.caption.wordStagger} local={local} size={12} />
            </div>
        </AbsoluteFill>
    );
};

/** The green period. */
export const Dot: React.FC<{ at: number; local: number; size: number }> = ({ at, local, size }) => {
    const p = local < at ? 0 : spring({ frame: local - at, fps: FPS, config: TOKENS.motion.word });
    return (
        <span style={{
            display: 'inline-block', width: size, height: size, borderRadius: size / 2,
            background: GREEN, transform: `scale(${p.toFixed(3)})`,
        }} />
    );
};

/** The abandonment counter, honest to the take's clock. */
export const Counter: React.FC<{ at: number; frames: number; seconds: (frame: number) => number }> =
    ({ at, frames, seconds }) => {
        const frame = useCurrentFrame();
        if (frame < at + 20 || frame > at + frames + 40) return null;
        const opacity = interpolate(frame, [at + 20, at + 50], [0, 0.85],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const value = Math.floor(seconds(frame));
        return (
            <div style={{
                position: 'absolute', left: 0, right: 0, top: 1120, textAlign: 'center',
                fontFamily: MONO, fontSize: 34, color: MUTED, opacity,
                letterSpacing: '0.06em',
            }}>
                WAITING FOR INPUT · 00:{String(value).padStart(2, '0')}
            </div>
        );
    };

/** The close: the wordmark with the green period, the URL, a terminal cursor. */
export const EndCard: React.FC<{ at: number }> = ({ at }) => {
    const frame = useCurrentFrame();
    if (frame < at + 24) return null;
    const local = frame - at - 24;
    const rise = spring({ frame: local, fps: FPS, config: TOKENS.motion.word });
    const urlIn = interpolate(local, [36, 60], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const cursor = Math.floor(frame / 30) % 2 === 0 ? 1 : 0;
    return (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 24 }}>
            <div style={{
                fontFamily: SANS, fontWeight: 600, fontSize: 120, color: TOKENS.caption.color,
                letterSpacing: '-0.02em', display: 'flex', alignItems: 'baseline', gap: '0.18em',
                transform: `translateY(${(36 * (1 - rise)).toFixed(2)}px)`,
                opacity: Math.min(1, local / 10),
            }}>
                muxr
                <Dot at={8} local={local} size={18} />
            </div>
            <div style={{
                fontFamily: MONO, fontSize: 28, color: MUTED, opacity: urlIn,
                display: 'flex', alignItems: 'center', gap: 10,
            }}>
                trymuxr.com
                <span style={{
                    display: 'inline-block', width: 13, height: 30,
                    background: TOKENS.caption.color, opacity: cursor,
                }} />
            </div>
        </AbsoluteFill>
    );
};
