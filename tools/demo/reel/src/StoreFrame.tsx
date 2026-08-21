import React from 'react';
import { AbsoluteFill, staticFile } from 'remotion';
import { Backdrop } from './Backdrop';
import { Stage3D } from './Stage3D';
import { DISPLAY, SANS, muted, text } from './theme';

/**
 * One Play Store screenshot, shot on the film's own stage.
 *
 * A flat CSS mockup of a handset is a rectangle with a border-radius. Putting
 * the same capture on the 3D stage gives it a body that reflects the studio
 * environment and a reflection under it on the mirrored floor — the depth is
 * real rather than painted, which is the difference between a screenshot in a
 * frame and a product photograph.
 */
export const StoreFrame: React.FC<{
    id: string;
    theme: 'light' | 'dark';
    caption: string;
    sub: string;
}> = ({ id, theme, caption, sub }) => (
    <Backdrop haloAt="50%">
        <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center' }}>
            <div
                style={{
                    height: 300,
                    flex: 'none',
                    padding: '0 76px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 24,
                    textAlign: 'center',
                }}
            >
                <div
                    style={{
                        fontFamily: DISPLAY,
                        fontWeight: 700,
                        color: text,
                        fontSize: 76,
                        lineHeight: 1.04,
                        letterSpacing: '-0.028em',
                        textWrap: 'balance',
                    }}
                >
                    {caption}
                </div>
                {sub === '' ? null : (
                    <div
                        style={{
                            fontFamily: SANS,
                            color: muted,
                            fontSize: 32,
                            lineHeight: 1.34,
                            maxWidth: 880,
                            textWrap: 'balance',
                        }}
                    >
                        {sub}
                    </div>
                )}
            </div>
            <div style={{ flex: 1, minHeight: 0, width: '100%', position: 'relative' }}>
                <Stage3D
                    frontStill={staticFile(`stills/${theme}/${id}.png`)}
                    width={1080}
                    height={1620}
                    // Near straight on: a Play carousel renders these small, and
                    // an angle that flatters the object costs the UI its
                    // legibility. Just enough to catch an edge highlight.
                    kind="store"
                    t={0}
                    spin={0.055}
                    lean={0.012}
                />
            </div>
        </AbsoluteFill>
    </Backdrop>
);
