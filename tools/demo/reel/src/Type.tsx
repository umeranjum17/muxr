import React from 'react';
import { useCurrentFrame } from 'remotion';
import { DISPLAY, MONO } from './theme';
import { dim as dimColour, enter, leave, status } from './motion';

/**
 * Type in this film is large enough to crop the frame and arrives by wiping up
 * from behind an edge. It plays 390 CSS px wide on a phone, where anything
 * under about 64px at 1920 is unreadable — so there is no body copy, only a
 * headline and a mono line.
 */
export const Head: React.FC<{
    lines: string[];
    total: number;
    delay?: number;
    size?: number;
    style?: React.CSSProperties;
}> = ({ lines, total, delay = 4, size = 146, style }) => {
    const frame = useCurrentFrame();
    const out = leave(frame, total);
    return (
        <div style={{ opacity: out, ...style }}>
            {lines.map((line, i) => {
                const arrive = enter(frame, delay + i * 6, 30);
                return (
                    <div key={line} style={{ overflow: 'hidden', paddingBottom: size * 0.08 }}>
                        <div
                            style={{
                                fontFamily: DISPLAY,
                                fontWeight: 700,
                                color: '#ffffff',
                                fontSize: size,
                                lineHeight: 0.95,
                                letterSpacing: '-0.045em',
                                whiteSpace: 'nowrap',
                                transform: `translateY(${(1 - arrive) * 112}%)`,
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

/** The mono line under a headline, with the one dot of colour the film allows. */
export const Kicker: React.FC<{
    children: React.ReactNode;
    total: number;
    delay?: number;
    tone?: keyof typeof status;
    style?: React.CSSProperties;
}> = ({ children, total, delay = 18, tone = 'working', style }) => {
    const frame = useCurrentFrame();
    const arrive = enter(frame, delay, 22);
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                fontFamily: MONO,
                fontSize: 25,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: dimColour,
                opacity: arrive * leave(frame, total),
                transform: `translateY(${(1 - arrive) * 10}px)`,
                ...style,
            }}
        >
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: status[tone], flex: 'none' }} />
            {children}
        </div>
    );
};
