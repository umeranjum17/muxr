import React from 'react';
import { Img, staticFile, useCurrentFrame } from 'remotion';
import { depthOf, drift, enter, ink, leave } from './motion';

/**
 * One piece of the real UI, floating.
 *
 * There is no device in this film. A fragment of a capture is placed in the
 * dark at a depth, and the depth decides how blurred it is, how far it recedes
 * into the ground, and how much of the beat's drift it takes — which is what
 * makes a flat crop read as sitting somewhere in a space.
 */
export const Layer: React.FC<{
    src: string;
    /** Rendered width in px; the fragment keeps its own aspect. */
    w: number;
    at: React.CSSProperties;
    /** 0 is the focal plane. Higher is further back. */
    depth?: number;
    tilt?: number;
    delay?: number;
    total: number;
    /** How far it travels in on the way to its place. */
    rise?: number;
    radius?: number;
    /** Pills are lit from their own edge rather than dropped on a card. */
    pill?: boolean;
}> = ({ src, w, at, depth = 0, tilt = 0, delay = 0, total, rise = 44, radius = 22, pill = false }) => {
    const frame = useCurrentFrame();
    const { blur, veil, parallax } = depthOf(depth);
    const arrive = enter(frame, delay, 30);
    const out = leave(frame, total);
    const x = drift(frame, total) * parallax;

    return (
        <div
            style={{
                position: 'absolute',
                width: w,
                borderRadius: pill ? 999 : radius,
                overflow: 'hidden',
                opacity: arrive * out,
                transform: [
                    `translateX(${x}px)`,
                    `translateY(${(1 - arrive) * rise}px)`,
                    `perspective(2600px) rotateY(${tilt}deg)`,
                    `scale(${0.955 + arrive * 0.045})`,
                ].join(' '),
                filter: blur === 0 ? undefined : `blur(${blur}px)`,
                boxShadow: pill
                    ? '0 26px 52px -14px rgba(0,0,0,0.92), 0 0 0 1px rgba(255,255,255,0.08)'
                    : '0 70px 130px -34px rgba(0,0,0,0.95), 0 0 0 1px rgba(255,255,255,0.07)',
                ...at,
            }}
        >
            <Img src={staticFile(`frag/${src}`)} style={{ width: '100%', display: 'block' }} />
            {veil === 0 ? null : (
                <div style={{ position: 'absolute', inset: 0, background: `${ink}${Math.round(veil * 255).toString(16).padStart(2, '0')}` }} />
            )}
        </div>
    );
};
