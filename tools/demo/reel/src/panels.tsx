import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame } from 'remotion';
import { FPS, HAIRLINE, MUTED, TOKENS, starts } from './config';
import { MONO } from './fonts';
import { DeskScreen, PhoneScreen, TAP, deskAck } from './screens';

const obj = TOKENS.motion.object;

/** World geometry: where the panels live and when they move. */
export const DESK = {
    solo: { x: 479, y: 41 },
    hero: { x: 698.5, y: 41 },
    content: 962,
};
export const PHONE = { center: 425, y: 92, w: 403, h: 896 };

/** The tap: 2s into the approval act, ripple first, desk answers after. */
export const tapFrame = starts.approval + 120;

/** One overshooting arrival, shared by everything that enters or relocates. */
const arrive = (frame: number, at: number) =>
    frame < at ? 0 : spring({ frame: frame - at, fps: FPS, config: obj });

export const DeskPanel: React.FC<{ dim: number }> = ({ dim }) => {
    const frame = useCurrentFrame();
    const bar = TOKENS.panel.titlebarHeight;

    const enter = arrive(frame, 6);
    const relocate = arrive(frame, starts.moves);
    // The desk bows out once the run has finished: beats 7 and 8 are the phone's.
    const drift = arrive(frame, starts.result);
    const x = DESK.solo.x + (DESK.hero.x - DESK.solo.x) * relocate + 120 * drift;
    const y = DESK.solo.y + 80 * (1 - enter);

    // Asleep while abandoned; the tap from the phone wakes it.
    const wake = arrive(frame, deskAck);
    const parked = frame >= starts.moves;
    const brightness = dim * (parked ? 0.6 + 0.4 * wake : 1);
    const scale = parked ? 0.98 + 0.02 * wake : 1;

    // The acknowledgment: border to green with a glow, then a long decay.
    const { attack, hold, decay } = TOKENS.ack;
    const pulse = frame < deskAck ? 0 : interpolate(frame,
        [deskAck, deskAck + attack, deskAck + attack + hold, deskAck + attack + hold + decay],
        [0, 1, 1, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
    const border = pulse > 0
        ? `1px solid rgba(48, 209, 88, ${(0.25 + 0.75 * pulse).toFixed(3)})`
        : TOKENS.panel.border;

    return (
        <div style={{
            position: 'absolute', left: x, top: y,
            width: DESK.content, height: DESK.content + bar,
            borderRadius: TOKENS.panel.radius, border,
            boxShadow: `${TOKENS.panel.shadow}${pulse > 0 ? `, 0 0 28px rgba(48,209,88,${(0.35 * pulse).toFixed(3)})` : ''}`,
            overflow: 'hidden', background: '#0a0a0b',
            opacity: enter * (1 - drift),
            filter: `brightness(${brightness.toFixed(3)})`,
            transform: `scale(${scale.toFixed(4)})`,
        }}>
            <div style={{
                height: bar, background: TOKENS.panel.titlebarFill,
                borderBottom: `1px solid ${HAIRLINE}`,
                display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16,
            }}>
                {[0, 1, 2].map((i) => (
                    <div key={i} style={{ width: 8, height: 8, borderRadius: 4, background: TOKENS.panel.dot }} />
                ))}
                <span style={{ fontFamily: MONO, fontSize: 13, color: MUTED, marginLeft: 8 }}>
                    auth-fix — Claude Code
                </span>
            </div>
            <div style={{ position: 'relative', width: DESK.content, height: DESK.content }}>
                <DeskScreen />
            </div>
        </div>
    );
};

/** The phone: naked rounded rect, the rebuilt UI inside. */
export const PhonePanel: React.FC<{ dim: number }> = ({ dim }) => {
    const frame = useCurrentFrame();

    const enter = arrive(frame, starts.moves);
    const drift = arrive(frame, starts.end);
    const x = PHONE.center - PHONE.w / 2 - 60 * drift;
    const y = PHONE.y + (1180 - PHONE.y) * (1 - enter);

    // The one authored mark: a single ripple where the thumb lands.
    const ripple = frame < tapFrame ? null : (() => {
        const t = (frame - tapFrame) / TOKENS.ripple.frames;
        if (t > 1) return null;
        const e = Easing.out(Easing.cubic)(t);
        const r = TOKENS.ripple.from + (TOKENS.ripple.to - TOKENS.ripple.from) * e;
        return { r, stroke: TOKENS.ripple.stroke * (1 - e), opacity: TOKENS.ripple.opacity * (1 - e) };
    })();

    return (
        <div style={{
            position: 'absolute', left: x, top: y, width: PHONE.w, height: PHONE.h,
            borderRadius: TOKENS.panel.phoneRadius, border: TOKENS.panel.border,
            boxShadow: TOKENS.panel.shadow, overflow: 'hidden', background: '#000',
            opacity: enter * (1 - drift), filter: `brightness(${dim.toFixed(3)})`,
        }}>
            <PhoneScreen tapAt={tapFrame} />
            {ripple === null ? null : (
                <div style={{
                    position: 'absolute',
                    left: TAP.x - ripple.r, top: TAP.y - ripple.r,
                    width: ripple.r * 2, height: ripple.r * 2,
                    borderRadius: '50%',
                    border: `${Math.max(0.5, ripple.stroke)}px solid ${TOKENS.ripple.color}`,
                    opacity: ripple.opacity,
                }} />
            )}
        </div>
    );
};
