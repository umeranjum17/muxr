import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { Video } from '@remotion/media';
import { film, ground } from './design';
import { grade } from './grade';
import type { Shot } from './film';

const G = film;

/**
 * The one shot that shows a whole device, and it does not move.
 *
 * Every rejected version had a handset that floated, tilted or spun, which is
 * the loudest "template mockup" tell there is — and Apple's own partner
 * guidance forbids animating a device at all. So the body is a set of
 * constants. What travels is a specular strip across the glass: the light
 * moves, the object is bolted down.
 *
 * This was built in React Three Fiber first, with a real extruded body and
 * Lightformers. It rendered a black screen: the R3F canvas draws before
 * `onVideoFrame` has populated the texture, and the frame is committed before
 * the redraw lands. Rather than fight the ordering for one shot in thirteen,
 * the same idea is composited in 2D — the screen is the real clip either way,
 * which is the part that actually matters.
 */
export const Device: React.FC<{ shot: Shot; frame: number }> = ({ shot, frame }) => {
    const g = ground[shot.ground];
    const height = G.h * 0.84;
    const width = height * (1080 / 2400);
    // Offset right so the copy's six columns are never under the body.
    const left = G.w * 0.56;
    const top = (G.h - height) / 2;
    const radius = width * 0.085;

    // The sweep crosses the glass once across the shot, frame-derived like
    // everything else here. A previous version read a wall clock and every
    // render tab produced a different one, which is why the handset shook.
    const travel = -1.2 + (frame / shot.frames) * 2.6;

    return (
        <AbsoluteFill style={{ background: g.bg }}>
            {/* Contact shadow: wide, soft, and grounded under the body rather
                than a uniform glow behind it. */}
            <div
                style={{
                    position: 'absolute',
                    left: left - width * 0.28,
                    top: top + height - 24,
                    width: width * 1.56,
                    height: 96,
                    background: 'radial-gradient(50% 50% at 50% 50%, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0) 72%)',
                }}
            />
            <div
                style={{
                    position: 'absolute',
                    left,
                    top,
                    width,
                    height,
                    borderRadius: radius,
                    overflow: 'hidden',
                    // The body is a hairline and a bevel, not a drawn bezel.
                    boxShadow: `0 0 0 1px rgba(255,255,255,0.10), 0 40px 90px -30px rgba(0,0,0,0.9)`,
                }}
            >
                {shot.clip === undefined ? null : (
                    <Video
                        src={staticFile(`film/${shot.clip.window}.mp4`)}
                        trimBefore={shot.clip.from ?? 0}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        effects={grade(frame, shot.ground)}
                    />
                )}
                {/* The travelling highlight. One strip, low opacity, screen
                    blended so it reads as reflection rather than as a white
                    shape laid over the picture. */}
                <div
                    style={{
                        position: 'absolute',
                        inset: '-30%',
                        transform: `translateX(${travel * width}px) rotate(18deg)`,
                        background:
                            'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.07) 45%, rgba(255,255,255,0.11) 50%, rgba(255,255,255,0.07) 55%, rgba(255,255,255,0) 100%)',
                        mixBlendMode: 'screen',
                        pointerEvents: 'none',
                    }}
                />
            </div>
            {/* The glyph, small, on the body's chin — the only mark in the film
                before the end card. */}
            <Img
                src={staticFile('img/glyph@3x.png')}
                style={{
                    position: 'absolute',
                    left: left + width / 2 - 14,
                    top: top + height + 40,
                    width: 28,
                    opacity: 0.28,
                    filter: 'grayscale(1) brightness(2.4)',
                }}
            />
        </AbsoluteFill>
    );
};
