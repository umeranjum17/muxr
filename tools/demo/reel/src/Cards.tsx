import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from './Backdrop';
import { DISPLAY, MONO, SANS, muted, text } from './theme';

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

const reveal = (frame: number, delay: number, duration = 28) =>
    interpolate(frame - delay, [0, duration], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: EASE,
    });

/** Type that arrives from behind an edge, one line at a time. */
const Line: React.FC<{ children: string; delay: number; size: number }> = ({ children, delay, size }) => {
    const frame = useCurrentFrame();
    const enter = reveal(frame, delay);
    return (
        <div style={{ overflow: 'hidden', paddingBottom: size * 0.1 }}>
            <div
                style={{
                    fontFamily: DISPLAY,
                    fontWeight: 700,
                    color: text,
                    fontSize: size,
                    lineHeight: 1,
                    letterSpacing: '-0.038em',
                    transform: `translateY(${interpolate(enter, [0, 1], [112, 0])}%)`,
                }}
            >
                {children}
            </div>
        </div>
    );
};

export const TitleCard: React.FC<{ tagline: string; durationInFrames: number }> = ({
    tagline,
    durationInFrames,
}) => {
    const frame = useCurrentFrame();
    const { width, height } = useVideoConfig();
    const portrait = height > width;
    const size = portrait ? 84 : 118;

    const mark = reveal(frame, 0, 22);
    const rule = reveal(frame, 26, 34);
    const out = interpolate(frame, [durationInFrames - 16, durationInFrames - 2], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: EASE,
    });

    // "Leave the desk. Not the work." is two sentences and reads as two lines.
    const lines = tagline.split(/(?<=\.)\s+/);

    return (
        <Backdrop>
            <AbsoluteFill
                style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: out,
                }}
            >
                <Img
                    src={staticFile('img/wordmark@3x.png')}
                    style={{
                        width: portrait ? 340 : 420,
                        opacity: mark,
                        transform: `translateY(${interpolate(mark, [0, 1], [16, 0])}px)`,
                        filter: 'brightness(0) invert(1)',
                        marginBottom: portrait ? 56 : 66,
                    }}
                />
                <div style={{ textAlign: 'center' }}>
                    {lines.map((line, i) => (
                        <Line key={line} delay={10 + i * 7} size={size}>{line}</Line>
                    ))}
                </div>
                <div
                    style={{
                        marginTop: 44,
                        height: 2,
                        width: interpolate(rule, [0, 1], [0, 220]),
                        background: 'rgba(255,255,255,0.22)',
                    }}
                />
            </AbsoluteFill>
        </Backdrop>
    );
};

export const EndCard: React.FC<{ install: string; site: string; note: string }> = ({ install, site, note }) => {
    const frame = useCurrentFrame();
    const { width, height } = useVideoConfig();
    const portrait = height > width;

    const a = reveal(frame, 0, 24);
    const b = reveal(frame, 12, 26);
    const c = reveal(frame, 24, 26);

    return (
        <Backdrop>
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
                <Img
                    src={staticFile('img/glyph@3x.png')}
                    style={{
                        width: 108,
                        opacity: a,
                        transform: `translateY(${interpolate(a, [0, 1], [14, 0])}px)`,
                        filter: 'brightness(0) invert(1)',
                    }}
                />
                <div
                    style={{
                        fontFamily: MONO,
                        fontSize: portrait ? 27 : 40,
                        color: text,
                        background: 'rgba(255,255,255,0.055)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 14,
                        padding: '20px 32px',
                        marginTop: 54,
                        opacity: b,
                        transform: `translateY(${interpolate(b, [0, 1], [14, 0])}px)`,
                    }}
                >
                    {install}
                </div>
                <div style={{ marginTop: 48, opacity: c }}>
                    <Line delay={24} size={portrait ? 56 : 68}>{site}</Line>
                </div>
                <div
                    style={{
                        fontFamily: SANS,
                        fontSize: portrait ? 28 : 30,
                        color: muted,
                        marginTop: 18,
                        opacity: c,
                    }}
                >
                    {note}
                </div>
            </AbsoluteFill>
        </Backdrop>
    );
};
