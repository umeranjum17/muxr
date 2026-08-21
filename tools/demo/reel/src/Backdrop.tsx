import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { indigo, ink, teal } from './theme';

/**
 * The shared stage: ink ground plus the two slow-drifting glows that the app's
 * glass tokens already use, so every frame of marketing shares one light source.
 */
export const Backdrop: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const frame = useCurrentFrame();
    const drift = interpolate(frame, [0, 900], [0, 1], { extrapolateRight: 'clamp' });

    return (
        <AbsoluteFill style={{ backgroundColor: ink, overflow: 'hidden' }}>
            <AbsoluteFill
                style={{
                    background: `radial-gradient(closest-side, ${teal}, transparent)`,
                    width: 1600,
                    height: 1600,
                    left: -420 + drift * 120,
                    top: -560 + drift * 80,
                    filter: 'blur(40px)',
                }}
            />
            <AbsoluteFill
                style={{
                    background: `radial-gradient(closest-side, ${indigo}, transparent)`,
                    width: 1500,
                    height: 1500,
                    left: 900 - drift * 100,
                    top: 340 - drift * 60,
                    filter: 'blur(40px)',
                }}
            />
            <AbsoluteFill
                style={{
                    backgroundImage: 'radial-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)',
                    backgroundSize: '4px 4px',
                    opacity: 0.55,
                }}
            />
            {children}
        </AbsoluteFill>
    );
};
