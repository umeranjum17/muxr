import React from 'react';
import { useCurrentFrame } from 'remotion';
import { DISPLAY, MONO } from './theme';
import { arrive, cadenceOffset, Cadence, depart, dim, status, TYPE } from './system';

/**
 * Headlines use the mask reveal: each line sits in an overflow-hidden box and
 * rises from its own baseline. No blur on text — it costs first-paint
 * legibility, and this plays small.
 *
 * Lines lag each other by four frames rather than arriving together, which is
 * the follow-through the previous cut had none of.
 */
export const Head: React.FC<{
    lines: string[];
    total: number;
    cadence: Cadence;
    align?: 'left' | 'right';
    style?: React.CSSProperties;
}> = ({ lines, total, cadence, align = 'left', style }) => {
    const frame = useCurrentFrame();
    const spec = TYPE.display;
    const role = 'display' as const;
    const out = depart(frame, total, role);

    return (
        <div style={{ textAlign: align, opacity: out, ...style }}>
            {lines.map((line, i) => {
                const t = arrive(frame, role, i * 4 + cadenceOffset(cadence, role));
                return (
                    <div key={line} style={{ overflow: 'hidden', paddingBottom: spec.size * 0.07 }}>
                        <div
                            style={{
                                fontFamily: DISPLAY,
                                fontWeight: 700,
                                color: '#ffffff',
                                fontSize: spec.size,
                                lineHeight: spec.leading,
                                letterSpacing: spec.tracking,
                                whiteSpace: 'nowrap',
                                transform: `translateY(${(1 - t) * 112}%)`,
                            }}
                        >
                            {line}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

/** The mono line, and the one dot of colour the film allows. */
export const Label: React.FC<{
    children: React.ReactNode;
    total: number;
    cadence: Cadence;
    tone?: keyof typeof status;
    align?: 'left' | 'right';
    style?: React.CSSProperties;
}> = ({ children, total, cadence, tone = 'working', align = 'left', style }) => {
    const frame = useCurrentFrame();
    const t = arrive(frame, 'label', cadenceOffset(cadence, 'label'));
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
                gap: 15,
                fontFamily: MONO,
                fontSize: TYPE.label.size,
                letterSpacing: TYPE.label.tracking,
                textTransform: 'uppercase',
                color: dim,
                opacity: t * depart(frame, total, 'label'),
                transform: `translateY(${(1 - t) * 9}px)`,
                ...style,
            }}
        >
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: status[tone], flex: 'none' }} />
            {children}
        </div>
    );
};
