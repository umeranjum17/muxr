import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from './Backdrop';
import { DISPLAY, MONO, SANS, muted, tealSolid, text } from './theme';

export const TitleCard: React.FC<{ tagline: string }> = ({ tagline }) => {
    const frame = useCurrentFrame();
    const { fps, width, height } = useVideoConfig();
    const portrait = height > width;

    const mark = spring({ frame, fps, config: { damping: 200, mass: 0.8 }, durationInFrames: 30 });
    const line = spring({ frame: frame - 12, fps, config: { damping: 200 }, durationInFrames: 30 });
    const out = interpolate(frame, [56, 74], [1, 0.92], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    return (
        <Backdrop>
            <AbsoluteFill
                style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: `scale(${out})`,
                }}
            >
                <Img
                    src={staticFile('img/wordmark@3x.png')}
                    style={{
                        width: portrait ? 480 : 560,
                        opacity: mark,
                        transform: `translateY(${interpolate(mark, [0, 1], [34, 0])}px)`,
                        filter: 'brightness(0) invert(1)',
                    }}
                />
                <div
                    style={{
                        fontFamily: DISPLAY,
                        fontWeight: 700,
                        color: text,
                        fontSize: portrait ? 74 : 86,
                        letterSpacing: '-0.03em',
                        marginTop: 46,
                        opacity: line,
                        transform: `translateY(${interpolate(line, [0, 1], [26, 0])}px)`,
                        textAlign: 'center',
                        maxWidth: portrait ? 940 : 1400,
                        lineHeight: 1.05,
                    }}
                >
                    {tagline}
                </div>
                <div
                    style={{
                        marginTop: 34,
                        height: 3,
                        width: interpolate(line, [0, 1], [0, 260]),
                        background: tealSolid,
                        opacity: 0.8,
                    }}
                />
            </AbsoluteFill>
        </Backdrop>
    );
};

export const EndCard: React.FC<{ install: string; site: string; note: string }> = ({ install, site, note }) => {
    const frame = useCurrentFrame();
    const { fps, width, height } = useVideoConfig();
    const portrait = height > width;

    const a = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 28 });
    const b = spring({ frame: frame - 14, fps, config: { damping: 200 }, durationInFrames: 28 });
    const c = spring({ frame: frame - 26, fps, config: { damping: 200 }, durationInFrames: 28 });

    return (
        <Backdrop>
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
                <Img
                    src={staticFile('img/glyph@3x.png')}
                    style={{
                        width: 120,
                        borderRadius: 28,
                        opacity: a,
                        transform: `translateY(${interpolate(a, [0, 1], [24, 0])}px)`,
                    }}
                />
                <div
                    style={{
                        fontFamily: MONO,
                        fontSize: portrait ? 40 : 46,
                        color: text,
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 18,
                        padding: '22px 38px',
                        marginTop: 52,
                        opacity: b,
                        transform: `translateY(${interpolate(b, [0, 1], [22, 0])}px)`,
                    }}
                >
                    {install}
                </div>
                <div
                    style={{
                        fontFamily: DISPLAY,
                        fontWeight: 700,
                        fontSize: portrait ? 58 : 64,
                        color: text,
                        letterSpacing: '-0.02em',
                        marginTop: 46,
                        opacity: c,
                    }}
                >
                    {site}
                </div>
                <div
                    style={{
                        fontFamily: SANS,
                        fontSize: portrait ? 30 : 32,
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
