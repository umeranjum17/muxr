import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame } from 'remotion';
import { FPS, GREEN, MUTED, TOKENS } from './config';
import { MONO, SANS } from './fonts';

/**
 * A beat's words, sharing the frame with the product screen. Lines arrive in order,
 * words on the word spring, the final period of the last line replaced by the
 * status-green dot. Anchors: `top` above the desk, `right` beside the phone,
 * `bottom` under the pair.
 */
export const BeatText: React.FC<{
    beat: { lines: string[]; anchor: 'top' | 'right' | 'bottom' | 'center'; small?: string; frames: number };
    at: number;
}> = ({ beat, at }) => {
    const frame = useCurrentFrame();
    if (frame < at + 14 || frame > at + beat.frames + 4) return null;
    const local = frame - at - 14;

    const exitAt = beat.frames - 14 - TOKENS.caption.exit;
    const exit = interpolate(local, [exitAt, exitAt + TOKENS.caption.exit], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic) });

    const place: React.CSSProperties = beat.anchor === 'top'
        ? { top: 44, left: 0, right: 0, alignItems: 'center' }
        : beat.anchor === 'right'
            ? { top: 0, bottom: 0, left: 1100, right: 80, justifyContent: 'center', alignItems: 'flex-start' }
            : beat.anchor === 'center'
                ? { top: 0, bottom: 0, left: 0, right: 0, justifyContent: 'center', alignItems: 'center' }
                : { bottom: 34, left: 0, right: 0, alignItems: 'center' };

    let cursor = 0;
    const perWord = TOKENS.caption.wordStagger;
    return (
        <div style={{
            position: 'absolute', display: 'flex', flexDirection: 'column',
            ...place, opacity: 1 - exit,
            transform: `translateY(${(-12 * exit).toFixed(2)}px)`,
        }}>
        <div style={{
            // The chip: the words get their own ground wherever they land, so
            // a line over busy diff text reads exactly like a line over ink.
            display: 'flex', flexDirection: 'column', gap: 12,
            background: 'rgba(12,12,13,0.94)', border: '1px solid #232326',
            borderRadius: 12, padding: '18px 28px',
            boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        }}>
            {beat.lines.map((line, li) => {
                const words = line.replace(/\.$/, '').split(' ');
                const endsWithPeriod = line.endsWith('.');
                const lineStart = cursor;
                cursor += words.length * perWord + 6;
                const isLast = li === beat.lines.length - 1;
                return (
                    <div key={li} style={{
                        fontFamily: SANS, fontWeight: 600, fontSize: 46,
                        letterSpacing: TOKENS.caption.tracking, color: TOKENS.caption.color,
                        display: 'flex', gap: '0.26em', alignItems: 'baseline',
                        textShadow: '0 2px 18px rgba(0,0,0,0.75)',
                    }}>
                        {words.map((word, wi) => {
                            const wordAt = lineStart + wi * perWord;
                            const p = local < wordAt ? 0
                                : spring({ frame: local - wordAt, fps: FPS, config: TOKENS.motion.word });
                            const fade = interpolate(local, [wordAt, wordAt + 8], [0, 1],
                                { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                            return (
                                <span key={wi} style={{
                                    display: 'inline-block',
                                    transform: `translateY(${(TOKENS.caption.rise * (1 - p)).toFixed(2)}px)`,
                                    opacity: fade,
                                }}>{word}</span>
                            );
                        })}
                        {endsWithPeriod && isLast
                            ? <Dot at={lineStart + words.length * perWord} local={local} size={10} />
                            : endsWithPeriod ? <span>.</span> : null}
                    </div>
                );
            })}
            {beat.small === undefined ? null : (
                <div style={{
                    fontFamily: MONO, fontSize: 19, color: MUTED, letterSpacing: '0.08em',
                    opacity: interpolate(local, [cursor, cursor + 16], [0, 0.9],
                        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
                    marginTop: 6,
                }}>{beat.small}</div>
            )}
        </div>
        </div>
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
                position: 'absolute', left: 0, right: 0, bottom: 126, textAlign: 'center',
                fontFamily: MONO, fontSize: 30, color: MUTED, opacity,
                letterSpacing: '0.06em',
            }}>
                WAITING FOR INPUT · 00:{String(value).padStart(2, '0')}
            </div>
        );
    };

/** The close: the exact app wordmark, the URL, and a terminal cursor. */
export const EndCard: React.FC<{ at: number }> = ({ at }) => {
    const frame = useCurrentFrame();
    if (frame < at + 24) return null;
    const local = frame - at - 24;
    const rise = spring({ frame: local, fps: FPS, config: TOKENS.motion.word });
    const urlIn = interpolate(local, [48, 72], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const cursor = Math.floor(frame / 30) % 2 === 0 ? 1 : 0;
    return (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', gap: 24 }}>
            <Img
                src={staticFile('brand/wordmark.png')}
                style={{
                    width: 360, height: 'auto',
                    transform: `translateY(${(36 * (1 - rise)).toFixed(2)}px)`,
                    opacity: Math.min(1, local / 10),
                }}
            />
            <div style={{
                fontFamily: SANS, fontWeight: 400, fontSize: 40, color: TOKENS.caption.color,
                opacity: Math.min(1, Math.max(0, (local - 20) / 18)),
                letterSpacing: '-0.01em',
            }}>
                Leave the desk. Not the work.
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
