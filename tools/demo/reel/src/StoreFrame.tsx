import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { DISPLAY, MONO, SANS } from './theme';
import { base, dim, ink, status, TYPE } from './system';

/**
 * One Play Store screenshot, in the film's language.
 *
 * No bezel. The capture floats in the dark, tilted a little, with a soft
 * shadow — the same treatment every fragment in the film gets. A Play carousel
 * renders these small, so the tilt stays shallow and the screen stays close to
 * straight on: the point of a store screenshot is that the UI is readable.
 */
export const StoreFrame: React.FC<{
    id: string;
    theme: 'light' | 'dark';
    caption: string;
    sub: string;
    tone?: keyof typeof status;
}> = ({ id, theme, caption, sub, tone = 'working' }) => (
    <AbsoluteFill style={{ background: ink, overflow: 'hidden' }}>
        <AbsoluteFill
            style={{
                background: 'radial-gradient(closest-side, rgba(255,255,255,0.12), transparent)',
                width: 1500, height: 1500, left: '50%', marginLeft: -750, top: 120, filter: 'blur(30px)',
            }}
        />
        <AbsoluteFill style={{ flexDirection: 'column', alignItems: 'center' }}>
            <div
                style={{
                    height: base(42), flex: 'none', padding: `0 ${base(9)}px`,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: base(3),
                    textAlign: 'center',
                }}
            >
                <div
                    style={{
                        fontFamily: DISPLAY, fontWeight: 700, color: '#ffffff',
                        fontSize: TYPE.store.size, lineHeight: TYPE.store.leading,
                        letterSpacing: TYPE.store.tracking, textWrap: 'balance',
                    }}
                >
                    {caption}
                </div>
                {sub === '' ? null : (
                    <div
                        style={{
                            fontFamily: SANS, color: dim, fontSize: TYPE.storeSub.size, lineHeight: TYPE.storeSub.leading,
                            maxWidth: 880, textWrap: 'balance',
                        }}
                    >
                        {sub}
                    </div>
                )}
                <div
                    style={{
                        display: 'flex', alignItems: 'center', gap: 13, marginTop: 8,
                        fontFamily: MONO, fontSize: TYPE.storeLabel.size, letterSpacing: TYPE.storeLabel.tracking,
                        textTransform: 'uppercase', color: '#6e6e75',
                    }}
                >
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: status[tone] }} />
                    captured from the shipping build
                </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, width: '100%', display: 'flex', justifyContent: 'center', paddingBottom: 96 }}>
                <div
                    style={{
                        width: 830,
                        borderRadius: 30,
                        overflow: 'hidden',
                        alignSelf: 'flex-start',
                        transform: 'perspective(3200px) rotateY(-5deg) rotateX(1.4deg)',
                        boxShadow: '0 90px 150px -40px rgba(0,0,0,0.96), 0 0 0 1px rgba(255,255,255,0.09)',
                    }}
                >
                    <Img src={staticFile(`stills/${theme}/${id}.png`)} style={{ width: '100%', display: 'block' }} />
                </div>
            </div>
        </AbsoluteFill>
    </AbsoluteFill>
);
