import React from 'react';
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Backdrop } from './Backdrop';
import { CameraKey, Stage3D } from './Stage3D';
import { Desk, Panel } from './Desk';
import deskPanel from '../../lib/desk.json';
import authoringPanel from '../../lib/authoring.json';

const PANELS: Record<string, Panel> = { desk: deskPanel, authoring: authoringPanel };
import { DISPLAY, MONO, muted, status, text } from './theme';

export type ShotSpec = {
    id: string;
    kicker: string;
    headline: string;
    /** Which capture the front of the handset shows. */
    theme: 'light' | 'dark';
    /** The one piece of colour in the frame, at dot size, per the product's law. */
    status?: 'working' | 'blocked' | 'done';
    /** Set to turn the shot into a flip: the other theme rides the back face. */
    flipTo?: 'light' | 'dark';
    camera?: CameraKey;
    /**
     * `desk`  the same pane in its desktop window, behind the handset.
     * `panel` a terminal window on its own — for the beats that are the CLI.
     */
    layout?: 'split' | 'full' | 'desk' | 'panel';
    panel?: 'desk' | 'authoring';
    side?: 'left' | 'right';
};

/** Fast out, long tail. The curve everything in the film moves on. */
const EASE = Easing.bezier(0.16, 1, 0.3, 1);

const reveal = (frame: number, delay: number, duration = 26) =>
    interpolate(frame - delay, [0, duration], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: EASE,
    });

export const Shot: React.FC<{ spec: ShotSpec; durationInFrames: number }> = ({ spec, durationInFrames }) => {
    const frame = useCurrentFrame();
    const { width, height } = useVideoConfig();
    const portrait = height > width;
    const t = frame / Math.max(1, durationInFrames - 1);

    const layout = spec.layout ?? 'split';
    const side = spec.side ?? 'left';
    const desk = layout === 'desk';
    const panel = layout === 'panel';
    const full = layout === 'full' || (portrait && !desk && !panel);

    const kickerIn = reveal(frame, 2, 18);
    const headIn = reveal(frame, 6);
    const ruleIn = reveal(frame, 16, 30);
    // Everything leaves together, a beat before the cut, so the transition lands
    // on a settled frame rather than mid-word.
    const out = interpolate(frame, [durationInFrames - 15, durationInFrames - 3], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: EASE,
    });

    const copy = (
        <div
            key="copy"
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                justifyContent: full ? 'flex-end' : 'center',
                padding: full
                    ? (portrait ? '0 76px 96px' : '0 0 116px 132px')
                    : (side === 'left' ? '0 40px 0 132px' : '0 132px 0 40px'),
                width: full ? '100%' : '44%',
                height: '100%',
                opacity: out,
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    fontFamily: MONO,
                    fontSize: portrait ? 26 : 24,
                    letterSpacing: '0.26em',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                    color: muted,
                    opacity: kickerIn,
                    transform: `translateY(${interpolate(kickerIn, [0, 1], [10, 0])}px)`,
                    marginBottom: 30,
                }}
            >
                <span
                    style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: status[spec.status ?? 'working'],
                        // The dot arrives after the word, so the eye lands on it.
                        opacity: reveal(frame, 12, 20),
                    }}
                />
                {spec.kicker}
            </div>
            {/* A wipe rather than a fade: type that arrives from behind an edge
                reads as deliberate, where type that materialises reads as a
                slide deck. */}
            <div style={{ overflow: 'hidden', paddingBottom: 14 }}>
                <div
                    style={{
                        fontFamily: DISPLAY,
                        fontWeight: 700,
                        color: text,
                        fontSize: portrait ? 88 : (full || panel ? 94 : 106),
                        lineHeight: 1.02,
                        letterSpacing: '-0.035em',
                        maxWidth: portrait ? 900 : (full ? 700 : 790),
                        textWrap: 'balance',
                        transform: `translateY(${interpolate(headIn, [0, 1], [112, 0])}%)`,
                    }}
                >
                    {spec.headline}
                </div>
            </div>
            <div
                style={{
                    height: 2,
                    width: interpolate(ruleIn, [0, 1], [0, 168]),
                    background: 'rgba(255,255,255,0.22)',
                    marginTop: 32,
                }}
            />
        </div>
    );

    const stage = full
        ? { width, height }
        : desk
            ? { width: Math.round(width * 0.3), height: Math.round(height * 0.92) }
            : { width: Math.round(width * 0.56), height };

    if (panel) {
        return (
            <Backdrop haloAt="66%">
                <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <div style={{ width: '42%', height: '100%' }}>{copy}</div>
                    <div style={{ width: '58%', height: '100%', display: 'flex', alignItems: 'center', paddingRight: 120 }}>
                        <div style={{ width: '100%', height: '74%' }}>
                            <Desk
                                panel={PANELS[spec.panel ?? 'authoring']!}
                                theme={spec.theme}
                                t={t}
                                delay={6}
                                scrollBy={-150}
                            />
                        </div>
                    </div>
                </AbsoluteFill>
            </Backdrop>
        );
    }

    if (desk) {
        return (
            <Backdrop haloAt="64%">
                <AbsoluteFill style={{ opacity: reveal(frame, 0, 16) }}>
                    {/* The desktop window sits back and to the left; the handset
                        stands in front of its corner. One pane, two windows —
                        which is the whole argument. */}
                    <div
                        style={{
                            position: 'absolute',
                            left: '41%',
                            top: '15%',
                            width: '47%',
                            height: '56%',
                            transform: 'perspective(2200px) rotateY(-9deg) rotateX(2deg)',
                            transformOrigin: 'right center',
                        }}
                    >
                        <Desk panel={PANELS[spec.panel ?? 'desk']!} theme={spec.theme} t={t} delay={8} />
                    </div>
                    <div
                        style={{
                            position: 'absolute',
                            right: '2%',
                            bottom: '-4%',
                            width: `${stage.width}px`,
                            height: `${stage.height}px`,
                        }}
                    >
                        <Stage3D
                            frontSrc={staticFile(`shots/${spec.theme}/${spec.id}.mp4`)}
                            kind="push"
                            width={stage.width}
                            height={stage.height}
                            t={t}
                            spin={interpolate(t, [0, 1], [0.16, 0.06])}
                            lean={0.02}
                            lift={interpolate(reveal(frame, 6, 34), [0, 1], [-0.5, 0])}
                        />
                    </div>
                </AbsoluteFill>
                <AbsoluteFill style={{ flexDirection: 'row' }}>{copy}</AbsoluteFill>
            </Backdrop>
        );
    }

    return (
        <Backdrop haloAt={full ? '50%' : (side === 'left' ? '72%' : '28%')}>
            <AbsoluteFill style={{ opacity: reveal(frame, 0, 16) }}>
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: full ? 0 : (side === 'left' ? '44%' : 0),
                        width: full ? '100%' : '56%',
                    }}
                >
                    <Stage3D
                        frontSrc={staticFile(`shots/${spec.theme}/${spec.id}.mp4`)}
                        backSrc={spec.flipTo === undefined ? undefined : staticFile(`shots/${spec.flipTo}/${spec.id}.mp4`)}
                        kind={spec.camera ?? 'push'}
                        width={stage.width}
                        height={stage.height}
                        t={t}
                        spin={spec.flipTo === undefined
                            ? interpolate(t, [0, 1], [0.05, -0.035])
                            // Turn it over once, on the film's own curve, and hold.
                            : interpolate(t, [0.18, 0.74], [0, Math.PI], {
                                extrapolateLeft: 'clamp',
                                extrapolateRight: 'clamp',
                                easing: EASE,
                            })}
                        lean={spec.camera === 'tilt' ? 0.085 : 0.015}
                        lift={interpolate(reveal(frame, 0, 30), [0, 1], [-0.14, 0])}
                    />
                </div>
            </AbsoluteFill>
            <AbsoluteFill style={{ flexDirection: 'row' }}>
                {full || side === 'left' ? copy : <div key="spacer" style={{ width: '56%' }} />}
                {full || side === 'left' ? null : copy}
            </AbsoluteFill>
        </Backdrop>
    );
};
