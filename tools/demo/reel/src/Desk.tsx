import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { MONO, SANS, muted, text } from './theme';

export type Panel = { label: string; agent: string; branch: string; lines: string[] };

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * A terminal window, drawn rather than screenshotted. Every line is a real
 * snapshot — a herdr pane's scrollback (`lib/desk.json`) or a real CLI session
 * (`lib/authoring.json`) — and only the window around it is ours. Drawing keeps
 * the type crisp at any size, which a texture would not.
 */
export const Desk: React.FC<{ panel: Panel; theme: 'light' | 'dark'; t: number; delay?: number; scrollBy?: number }> = ({
    panel,
    theme,
    t,
    delay = 0,
    scrollBy = -84,
}) => {
    const frame = useCurrentFrame();
    const dark = theme === 'dark';
    const enter = interpolate(frame - delay, [0, 34], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: EASE,
    });

    // A slow crawl up the scrollback: the pane is alive, and a still one reads
    // as a screenshot of something that already finished.
    const scroll = interpolate(t, [0, 1], [0, scrollBy]);

    const surface = dark ? '#141416' : '#ffffff';
    const chrome = dark ? '#1c1c20' : '#f6f6f7';
    const line = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.09)';
    const body = dark ? '#d8d8de' : '#26262b';
    const dim = dark ? '#7d7d86' : '#8a8a92';

    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                borderRadius: 18,
                overflow: 'hidden',
                background: surface,
                border: `1px solid ${line}`,
                boxShadow: '0 50px 110px -40px rgba(0,0,0,0.85)',
                opacity: enter,
                transform: `translateY(${interpolate(enter, [0, 1], [26, 0])}px)`,
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            <div
                style={{
                    height: 62,
                    flex: 'none',
                    background: chrome,
                    borderBottom: `1px solid ${line}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '0 22px',
                }}
            >
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#30D158' }} />
                <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 20, color: dark ? text : '#111114' }}>
                    {panel.label}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 17, color: dim }}>
                    {panel.agent} · {panel.branch}
                </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '18px 24px' }}>
                <div style={{ transform: `translateY(${scroll}px)` }}>
                    {panel.lines.map((raw, i) => (
                        <div
                            key={`${i}-${raw.slice(0, 12)}`}
                            style={{
                                fontFamily: MONO,
                                fontSize: 17,
                                lineHeight: '27px',
                                whiteSpace: 'pre',
                                color: raw.trimStart().startsWith('|') || raw.includes('...') ? dim : body,
                            }}
                        >
                            {raw}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

