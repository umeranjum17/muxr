import React from 'react';
import { Img, staticFile, useCurrentFrame } from 'remotion';
import { arrive, cadenceOffset, Cadence, depart, depthOf, ink, ROLE } from './system';

/**
 * One piece of the real UI, floating.
 *
 * There is no device in this film. A fragment of a capture sits in the dark at
 * a depth, and the depth decides how blurred it is, how far it recedes into the
 * ground, and how much of the beat's drift it takes.
 *
 * Motion comes from the role, not from this component: a chip snaps in thirteen
 * frames, a panel settles over thirty, and they start at different points in the
 * beat so the arrival overlaps instead of landing as one block.
 */
export const Layer: React.FC<{
    src: string;
    w: number;
    at: React.CSSProperties;
    total: number;
    cadence: Cadence;
    role?: 'panel' | 'chip';
    depth?: number;
    tilt?: number;
    /** Stagger within a role — chips in a row, panels in a stack. */
    order?: number;
    radius?: number;
}> = ({ src, w, at, total, cadence, role = 'panel', depth = 0, tilt = 0, order = 0, radius = 22 }) => {
    const frame = useCurrentFrame();
    const spec = ROLE[role];
    const { blur, veil, parallax } = depthOf(depth);

    const stagger = order * (role === 'chip' ? 4 : 7);
    const t = arrive(frame, role, stagger + cadenceOffset(cadence, role));
    const out = depart(frame, total, role);

    // An arc, not a straight line: things that move in the world curve, and a
    // pure translateY reads as a slide projector.
    const x = (1 - t) * spec.drift * (tilt >= 0 ? -1 : 1) + Math.sin(t * Math.PI) * 3;
    const parallaxX = (frame / Math.max(1, total)) * -26 * parallax;

    return (
        <div
            style={{
                position: 'absolute',
                width: w,
                borderRadius: role === 'chip' ? 999 : radius,
                overflow: 'hidden',
                opacity: t * out,
                transform: [
                    `translate(${x + parallaxX}px, ${(1 - t) * spec.rise}px)`,
                    `perspective(2600px) rotateY(${tilt}deg)`,
                    `scale(${spec.scaleFrom + t * (1 - spec.scaleFrom)})`,
                ].join(' '),
                filter: blur === 0 && spec.blurFrom === 0
                    ? undefined
                    : `blur(${blur + (1 - t) * spec.blurFrom}px)`,
                boxShadow: role === 'chip'
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
