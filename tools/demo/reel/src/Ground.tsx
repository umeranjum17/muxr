import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { TOKENS } from './config';

/** The lit ink the film happens in: radial lift, vignette. */
export const Ground: React.FC = () => (
    <AbsoluteFill>
        <AbsoluteFill style={{ background: TOKENS.ground.gradient }} />
        <AbsoluteFill style={{ background: TOKENS.ground.vignette }} />
    </AbsoluteFill>
);

/**
 * Monochrome grain, re-seeded every few frames: a 15Hz shimmer that keeps the
 * ground alive without reading as noise. Sits above the panels, under the
 * captions.
 */
export const Grain: React.FC = () => {
    const frame = useCurrentFrame();
    const seed = Math.floor(frame / TOKENS.ground.grainReseed);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">`
        + `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" `
        + `numOctaves="2" seed="${seed}" stitchTiles="stitch"/>`
        + `<feColorMatrix type="saturate" values="0"/></filter>`
        + `<rect width="1024" height="1024" filter="url(#n)"/></svg>`;
    return (
        <AbsoluteFill
            style={{
                backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`,
                backgroundRepeat: 'repeat',
                opacity: TOKENS.ground.grain,
                mixBlendMode: 'overlay',
                pointerEvents: 'none',
            }}
        />
    );
};
