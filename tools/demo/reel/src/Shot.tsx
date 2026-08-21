import React from 'react';
import { AbsoluteFill, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from './Backdrop';
import { Phone3D } from './Phone3D';
import { DISPLAY, MONO, SANS, muted, tealSolid, text } from './theme';

export type ShotSpec = {
    id: string;
    kicker: string;
    headline: string;
    body: string;
    startFrom?: number;
};

const Words: React.FC<{ children: string; style: React.CSSProperties; delay: number }> = ({
    children,
    style,
    delay,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const words = children.split(' ');
    return (
        <div style={{ ...style, display: 'flex', flexWrap: 'wrap' }}>
            {words.map((word, i) => {
                const enter = spring({
                    frame: frame - delay - i * 2.2,
                    fps,
                    config: { damping: 200, mass: 0.6 },
                    durationInFrames: 22,
                });
                return (
                    <span
                        key={`${word}-${i}`}
                        style={{
                            display: 'inline-block',
                            marginRight: '0.26em',
                            opacity: enter,
                            transform: `translateY(${interpolate(enter, [0, 1], [26, 0])}px)`,
                        }}
                    >
                        {word}
                    </span>
                );
            })}
        </div>
    );
};

export const Shot: React.FC<{ spec: ShotSpec }> = ({ spec }) => {
    const frame = useCurrentFrame();
    const { fps, width, height } = useVideoConfig();
    const portrait = height > width;

    const rule = spring({ frame: frame - 4, fps, config: { damping: 200 }, durationInFrames: 26 });

    const copy = (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: portrait ? 'center' : 'flex-start',
                textAlign: portrait ? 'center' : 'left',
                padding: portrait ? '0 90px' : '0 0 0 132px',
                width: portrait ? '100%' : '46%',
                height: portrait ? 'auto' : '100%',
            }}
        >
            <div
                style={{
                    fontFamily: MONO,
                    fontSize: portrait ? 28 : 26,
                    letterSpacing: '0.22em',
                    textTransform: 'uppercase',
                    color: tealSolid,
                    opacity: interpolate(frame, [0, 14], [0, 1], { extrapolateRight: 'clamp' }),
                    marginBottom: 26,
                }}
            >
                {spec.kicker}
            </div>
            <Words
                delay={6}
                style={{
                    fontFamily: DISPLAY,
                    fontWeight: 700,
                    color: text,
                    fontSize: portrait ? 82 : 92,
                    lineHeight: 1.03,
                    letterSpacing: '-0.03em',
                    justifyContent: portrait ? 'center' : 'flex-start',
                }}
            >
                {spec.headline}
            </Words>
            <div
                style={{
                    height: 3,
                    width: interpolate(rule, [0, 1], [0, portrait ? 180 : 220]),
                    background: tealSolid,
                    opacity: 0.75,
                    margin: '34px 0 30px',
                }}
            />
            <Words
                delay={16}
                style={{
                    fontFamily: SANS,
                    fontWeight: 400,
                    color: muted,
                    fontSize: portrait ? 34 : 34,
                    lineHeight: 1.45,
                    maxWidth: portrait ? 820 : 640,
                    justifyContent: portrait ? 'center' : 'flex-start',
                }}
            >
                {spec.body}
            </Words>
        </div>
    );

    const stage = portrait
        ? { width, height: Math.round(height * 0.62) }
        : { width: Math.round(width * 0.54), height };

    return (
        <Backdrop>
            <AbsoluteFill
                style={{
                    flexDirection: portrait ? 'column' : 'row',
                    alignItems: 'center',
                    justifyContent: portrait ? 'flex-start' : 'center',
                    paddingTop: portrait ? 120 : 0,
                }}
            >
                {copy}
                <div style={{ position: 'relative', ...stage }}>
                    <Phone3D
                        src={staticFile(`shots/${spec.id}.mp4`)}
                        width={stage.width}
                        height={stage.height}
                    />
                </div>
            </AbsoluteFill>
        </Backdrop>
    );
};
