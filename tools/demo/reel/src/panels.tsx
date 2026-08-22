import React from 'react';
import { OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, Easing } from 'remotion';
import { AT, ENTER, FPS, HAIRLINE, MUTED, SRC, TOKENS, starts } from './config';
import { MONO } from './fonts';

const obj = TOKENS.motion.object;

/** Media seconds → the `startFrom` OffthreadVideo wants at this comp fps. */
const from = (seconds: number) => Math.round(seconds * FPS);

/**
 * The desk's footage timeline. One panel, three in-panel jumps — the world
 * never cuts, but a screen is allowed to skip time. Each jump hides under a
 * camera glide, and the hero segment starts at 94.43s so the real tap lands
 * exactly 100 frames into the hero act.
 */
const DESK_SEGMENTS = [
    { at: starts.work, media: AT.work },
    { at: starts.waiting, media: AT.waiting },
    { at: starts.hero, media: AT.tap - 100 / FPS },
];

/** World geometry: where the panels live and when they move. */
export const DESK = {
    solo: { x: 479, y: 41 },
    hero: { x: 698.5, y: 41 },
    content: 962,
};
export const PHONE = {
    center: 425,
    y: 92,
    w: 403,
    h: 896,
    // For the herd the panel opens into a sheet: wide enough that the whole
    // group fits full-width, dots and all, inside the phone-aspect window
    // that could never hold it.
    sheetW: 728,
};

/** One overshooting arrival, shared by everything that enters or relocates. */
const arrive = (frame: number, at: number) =>
    frame < at ? 0 : spring({ frame: frame - at, fps: FPS, config: obj });

/** Panels dim while a caption owns the frame. */
export const cardDim = (frame: number, cards: Array<{ at: number; frames: number }>) => {
    let dim = 1;
    for (const card of cards) {
        const into = interpolate(frame, [card.at, card.at + 12], [0, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const out = interpolate(frame, [card.at + card.frames - 12, card.at + card.frames], [1, 0],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        dim = Math.min(dim, 1 - 0.45 * Math.min(into, out));
    }
    return dim;
};

export const DeskPanel: React.FC<{ dim: number }> = ({ dim }) => {
    const frame = useCurrentFrame();
    const bar = TOKENS.panel.titlebarHeight;

    // Enters rising at the start of `work`; relocates to the hero slot as the
    // phone arrives; drifts off and fades under the end card.
    const enter = arrive(frame, starts.work);
    const relocate = arrive(frame, starts.c3);
    const drift = arrive(frame, starts.end);
    const x = DESK.solo.x + (DESK.hero.x - DESK.solo.x) * relocate + 60 * drift;
    const y = DESK.solo.y + 80 * (1 - enter);

    // Parked at 90% until the green pulse lands, then snaps awake.
    const tapFrame = starts.hero + 100;
    const ackAt = tapFrame + TOKENS.ack.latency;
    const wake = arrive(frame, ackAt);
    const parked = frame >= starts.c3;
    const brightness = dim * (parked ? 0.9 + 0.1 * wake : 1);
    const scale = parked ? 0.98 + 0.02 * wake : 1;

    // The acknowledgment: border to green with a glow, then a long decay.
    const { attack, hold, decay } = TOKENS.ack;
    const pulse = frame < ackAt ? 0 : interpolate(frame,
        [ackAt, ackAt + attack, ackAt + attack + hold, ackAt + attack + hold + decay],
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
                {DESK_SEGMENTS.map((seg, i) => {
                    const until = DESK_SEGMENTS[i + 1]?.at;
                    return (
                        <Sequence key={seg.at} from={seg.at} durationInFrames={until === undefined ? undefined : until - seg.at + 8} layout="none">
                            <FadeIn first={i === 0}>
                                <OffthreadVideo
                                    src={staticFile(SRC.desk)}
                                    startFrom={from(seg.media)}
                                    style={{ width: DESK.content, height: DESK.content, position: 'absolute', inset: 0 }}
                                    muted
                                />
                            </FadeIn>
                        </Sequence>
                    );
                })}
            </div>
        </div>
    );
};

/** An 8-frame ease so an in-panel time-skip lands as a soft blink, not a pop. */
const FadeIn: React.FC<{ first: boolean; children: React.ReactNode }> = ({ first, children }) => {
    const frame = useCurrentFrame();
    const opacity = first ? 1 : interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
    return <div style={{ opacity, position: 'absolute', inset: 0 }}>{children}</div>;
};

/**
 * The phone: naked rounded rect, the real recording inside, with an in-panel
 * window that follows what matters — the approval, the Enter key, the result,
 * the herd. The window is part of the choreography, not a pre-baked crop.
 */
export const PhonePanel: React.FC<{ dim: number }> = ({ dim }) => {
    const frame = useCurrentFrame();

    const enter = arrive(frame, starts.c3);
    const drift = arrive(frame, starts.end);

    // The in-panel window: z zooms the screen, focusY is the row that should
    // sit at the panel's centre, w is the panel's own width — it opens into a
    // sheet for the herd. All three glide on the camera spring.
    const windows: Array<{ at: number; z: number; focusY: number; w: number }> = [
        { at: starts.reveal, z: 1.5, focusY: 1750, w: PHONE.w },
        { at: starts.c4, z: 1.25, focusY: 1900, w: PHONE.w },
        { at: starts.c5, z: 1.5, focusY: 1450, w: PHONE.w },
        // focusY beyond the clamp pins the window to the screen's bottom,
        // which is exactly where the group lives — and keeps the half-cut row
        // above it (a machine path) out of frame.
        { at: starts.c6, z: 1.0, focusY: 2000, w: PHONE.sheetW },
    ];
    let z = windows[0].z;
    let focusY = windows[0].focusY;
    let panelW = windows[0].w;
    for (let i = 1; i < windows.length; i += 1) {
        const w = windows[i];
        if (frame < w.at) break;
        const p = spring({ frame: frame - w.at, fps: FPS, config: TOKENS.motion.camera });
        z += (w.z - windows[i - 1].z) * p;
        focusY += (w.focusY - windows[i - 1].focusY) * p;
        panelW += (w.w - windows[i - 1].w) * p;
    }
    const x = PHONE.center - panelW / 2 - 60 * drift;
    const y = PHONE.y + (1180 - PHONE.y) * (1 - enter);
    const k = (panelW / 1080) * z;
    const offsetY = Math.min(0, Math.max(PHONE.h - 2400 * k, PHONE.h / 2 - focusY * k));

    const segments = [
        { at: starts.reveal, media: AT.phoneApproval, src: SRC.phone },
        { at: starts.hero, media: AT.tap - 100 / FPS, src: SRC.phone },
        { at: starts.finish, media: AT.testsRunning, src: SRC.phone },
        { at: starts.finish + 96, media: AT.writeup, src: SRC.after },
        { at: starts.herd, media: AT.herd, src: SRC.herd },
    ];

    // The one authored mark on the footage: a single ripple where the thumb
    // lands, at the exact frame the take pressed Enter.
    const tapFrame = starts.hero + 100;
    const ripple = frame < tapFrame ? null : (() => {
        const t = (frame - tapFrame) / TOKENS.ripple.frames;
        if (t > 1) return null;
        const e = Easing.out(Easing.cubic)(t);
        const r = TOKENS.ripple.from + (TOKENS.ripple.to - TOKENS.ripple.from) * e;
        return {
            r,
            stroke: TOKENS.ripple.stroke * (1 - e),
            opacity: TOKENS.ripple.opacity * (1 - e),
            x: ENTER.x * k,
            y: ENTER.y * k + offsetY,
        };
    })();

    return (
        <div style={{
            position: 'absolute', left: x, top: y, width: panelW, height: PHONE.h,
            borderRadius: TOKENS.panel.phoneRadius, border: TOKENS.panel.border,
            boxShadow: TOKENS.panel.shadow, overflow: 'hidden', background: '#000',
            opacity: enter * (1 - drift), filter: `brightness(${dim.toFixed(3)})`,
        }}>
            {segments.map((seg, i) => {
                const until = segments[i + 1]?.at;
                return (
                    <Sequence key={seg.at} from={seg.at} durationInFrames={until === undefined ? undefined : until - seg.at + 10} layout="none">
                        <FadeIn first={i === 0}>
                            <OffthreadVideo
                                src={staticFile(seg.src)}
                                startFrom={from(seg.media)}
                                style={{
                                    position: 'absolute', top: offsetY, left: 0,
                                    width: 1080 * k, height: 2400 * k,
                                }}
                                muted
                            />
                        </FadeIn>
                    </Sequence>
                );
            })}
            {ripple === null ? null : (
                <div style={{
                    position: 'absolute',
                    left: ripple.x - ripple.r, top: ripple.y - ripple.r,
                    width: ripple.r * 2, height: ripple.r * 2,
                    borderRadius: '50%',
                    border: `${Math.max(0.5, ripple.stroke)}px solid ${TOKENS.ripple.color}`,
                    opacity: ripple.opacity,
                }} />
            )}
        </div>
    );
};
