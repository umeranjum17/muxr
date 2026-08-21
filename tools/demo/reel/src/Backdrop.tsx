import React from 'react';
import { AbsoluteFill } from 'remotion';
import { halo, ink, inkRaised } from './theme';

/**
 * The shared stage: ink, and one soft white light behind where the handset
 * stands. Nothing here animates — a drifting gradient is motion the eye has to
 * ignore, and it snapped at every cut because a sequence restarts its frame
 * count.
 */
export const Backdrop: React.FC<{ children?: React.ReactNode; haloAt?: string }> = ({
    children,
    haloAt = '50%',
}) => (
    <AbsoluteFill style={{ backgroundColor: ink, overflow: 'hidden' }}>
        <AbsoluteFill
            style={{
                background: `radial-gradient(120% 80% at 50% -10%, ${inkRaised} 0%, ${ink} 62%)`,
            }}
        />
        <AbsoluteFill
            style={{
                background: `radial-gradient(closest-side, ${halo}, transparent)`,
                width: 1500,
                height: 1500,
                left: haloAt,
                marginLeft: -750,
                top: '-22%',
            }}
        />
        <AbsoluteFill
            style={{
                backgroundImage: 'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)',
                backgroundSize: '4px 4px',
                opacity: 0.5,
            }}
        />
        {children}
    </AbsoluteFill>
);
