import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { GREEN, HAIRLINE, MUTED, TOKENS } from './config';
import { MONO, SANS } from './fonts';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const BLUE = '#0A84FF';
const RED = '#FF453A';
const TEXT = '#ececec';
const SURFACE = '#1a1a1a';
const HIGH = '#212121';

const agents = [
    { name: 'auth-migration', agent: 'Claude Code', state: 'Working', color: BLUE },
    { name: 'checkout-e2e', agent: 'Codex', state: 'Needs you', color: RED },
    { name: 'release-notes', agent: 'Gemini', state: 'Done', color: GREEN },
    { name: 'landing-page', agent: 'Cursor', state: 'Idle', color: '#8E8E93' },
];

const Window: React.FC<{ title: string; children: React.ReactNode; style: React.CSSProperties }> = ({ title, children, style }) => (
    <div style={{
        position: 'absolute', overflow: 'hidden', background: '#09090a',
        border: TOKENS.panel.border, borderRadius: TOKENS.panel.radius,
        boxShadow: TOKENS.panel.shadow, ...style,
    }}>
        <div style={{
            height: 36, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px',
            background: TOKENS.panel.titlebarFill, borderBottom: `1px solid ${HAIRLINE}`,
        }}>
            {[0, 1, 2].map((i) => <span key={i} style={{ width: 8, height: 8, borderRadius: 4, background: '#3a3a3e' }} />)}
            <span style={{ marginLeft: 8, color: MUTED, font: `13px ${MONO}` }}>{title}</span>
        </div>
        {children}
    </div>
);

const Terminal: React.FC<{ sent: boolean; running: boolean; compact?: boolean }> = ({ sent, running, compact }) => (
    <div style={{ padding: compact ? '18px 16px' : '34px 38px', color: '#d6d6d8', fontFamily: MONO, fontSize: compact ? 15 : 21, lineHeight: compact ? '24px' : '32px' }}>
        <div><span style={{ color: RED }}>●</span> checkout-e2e <span style={{ color: MUTED }}>· Codex</span></div>
        <div style={{ color: MUTED }}>  Checkout still fails after the refresh redirect.</div>
        <div style={{ color: MUTED }}>  The session boundary is the likely cause.</div>
        <div style={{ marginTop: compact ? 12 : 20 }}>● Waiting for your direction.</div>
        {sent ? <>
            <div style={{ marginTop: compact ? 14 : 24 }}><span style={{ color: GREEN }}>❯</span> Fix the root cause. Rerun checkout.</div>
            <div style={{ marginTop: compact ? 10 : 16 }}>● On it — tracing auth → cart handoff.</div>
        </> : null}
        {running ? <>
            <div style={{ marginTop: compact ? 10 : 16, color: MUTED }}>  Reading session-store.ts</div>
            <div><span style={{ color: BLUE }}>●</span> Working…</div>
        </> : null}
    </div>
);

const Herd: React.FC = () => (
    <div style={{ position: 'absolute', inset: 0, background: '#000', color: TEXT, fontFamily: SANS }}>
        <div style={{ height: 62, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 10 }}>
            <strong style={{ fontSize: 22 }}>Herd</strong>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: GREEN }} />
            <span style={{ color: GREEN, fontSize: 13 }}>connected</span>
        </div>
        <div style={{ padding: '14px 18px 8px', color: '#8E8E93', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' }}>Every agent</div>
        <div style={{ margin: '0 12px', border: `1px solid ${HAIRLINE}`, borderRadius: 14, overflow: 'hidden', background: SURFACE }}>
            <div style={{ minHeight: 50, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: `1px solid ${HAIRLINE}` }}>
                <span style={{ color: MUTED }}>▾</span><strong>muxr</strong>
                <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 12 }}>4 agents</span>
            </div>
            {agents.map((row, i) => (
                <div key={row.name} style={{ minHeight: 68, display: 'flex', alignItems: 'center', gap: 11, padding: '0 14px', borderTop: i === 0 ? undefined : `1px solid ${HAIRLINE}` }}>
                    <div style={{ width: 34, height: 34, borderRadius: 10, background: HIGH, display: 'grid', placeItems: 'center', fontWeight: 700 }}>{row.name[0].toUpperCase()}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>{row.name}</div>
                        <div style={{ color: MUTED, fontSize: 12, marginTop: 3 }}>{row.agent}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: row.color, fontSize: 12 }}>
                            <span style={{ width: 7, height: 7, borderRadius: 4, background: row.color }} />{row.state}
                        </div>
                    </div>
                </div>
            ))}
        </div>
        <div style={{ position: 'absolute', left: 12, right: 12, bottom: 18, height: 50, borderRadius: 25, background: '#f2f2f4', color: '#777', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 15 }}>
            Plan, ask, build… <span style={{ marginLeft: 'auto', color: '#222' }}>◉</span>
        </div>
    </div>
);

const PhoneTerminal: React.FC<{ typed: string; sent: boolean; running: boolean }> = ({ typed, sent, running }) => (
    <div style={{ position: 'absolute', inset: 0, background: '#000', color: TEXT }}>
        <div style={{ height: 54, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', background: SURFACE, fontFamily: SANS }}>
            <span style={{ fontSize: 23 }}>‹</span><span style={{ width: 8, height: 8, borderRadius: 4, background: running ? BLUE : RED }} />
            <strong>checkout-e2e</strong><span style={{ marginLeft: 'auto', color: MUTED }}>•••</span>
        </div>
        <div style={{ position: 'absolute', inset: '54px 0 116px', background: '#1e1e1e' }}><Terminal compact sent={sent} running={running} /></div>
        <div style={{ position: 'absolute', left: 10, right: 10, bottom: 18, height: 54, borderRadius: 27, background: HIGH, display: 'flex', alignItems: 'center', padding: '0 10px 0 17px', font: `14px ${SANS}` }}>
            <span style={{ color: typed.length === 0 ? MUTED : TEXT, flex: 1 }}>{typed || 'Type or dictate a prompt…'}</span>
            <span style={{ width: 36, height: 36, borderRadius: 18, background: typed.length === 0 ? '#343438' : GREEN, display: 'grid', placeItems: 'center', color: '#fff' }}>↑</span>
        </div>
    </div>
);

const Caption: React.FC<{ lines: string[]; opacity: number }> = ({ lines, opacity }) => (
    <div style={{ position: 'absolute', left: 770, right: 100, bottom: 82, opacity, color: TEXT, fontFamily: SANS, fontSize: 56, fontWeight: 650, lineHeight: 1.08, letterSpacing: '-.025em' }}>
        {lines.map((line) => <div key={line}>{line}</div>)}
    </div>
);

export const MobileStory: React.FC = () => {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    const terminalIn = interpolate(frame, [142, 172], [0, 1], clamp);
    const reset = interpolate(frame, [durationInFrames - 30, durationInFrames - 1], [0, 1], clamp);
    const prompt = 'Fix the root cause. Rerun checkout.';
    const typedCount = Math.floor(interpolate(frame, [245, 380], [0, prompt.length], clamp));
    const sent = frame >= 410;
    const running = frame >= 438;
    const typed = sent ? '' : prompt.slice(0, typedCount);
    const introCaption = (1 - interpolate(frame, [118, 144], [0, 1], clamp)) * (1 - reset) + reset;
    const terminalCaption = interpolate(frame, [170, 190, 228, 245], [0, 1, 1, 0], clamp) * (1 - reset);
    const promptCaption = interpolate(frame, [245, 270, 375, 402], [0, 1, 1, 0], clamp) * (1 - reset);
    const runCaption = interpolate(frame, [438, 462, durationInFrames - 55, durationInFrames - 30], [0, 1, 1, 0], clamp);

    return (
        <AbsoluteFill style={{ background: TOKENS.ground.gradient }}>
            <Window title="checkout-e2e — Codex" style={{ left: 700, top: 100, width: 1050, height: 700, opacity: running ? 1 - reset * 0.32 : 0.68 }}>
                <div style={{ position: 'absolute', inset: '36px 0 0', opacity: 1 - reset }}>
                    <Terminal sent={sent} running={running} />
                </div>
                <div style={{ position: 'absolute', inset: '36px 0 0', opacity: reset }}>
                    <Terminal sent={false} running={false} />
                </div>
            </Window>
            <div style={{ position: 'absolute', left: 150, top: 72, width: 403, height: 896, borderRadius: 40, overflow: 'hidden', border: TOKENS.panel.border, boxShadow: TOKENS.panel.shadow, background: '#000' }}>
                <div style={{ position: 'absolute', inset: 0, opacity: Math.max(1 - terminalIn, reset) }}><Herd /></div>
                <div style={{ position: 'absolute', inset: 0, opacity: terminalIn * (1 - reset) }}><PhoneTerminal typed={typed} sent={sent} running={running} /></div>
            </div>
            <Caption opacity={introCaption} lines={['Every agent.', 'Working. Needs you. Done.']} />
            <Caption opacity={terminalCaption} lines={['Tap in.', 'The exact live terminal.']} />
            <Caption opacity={promptCaption} lines={['Prompt the same session', 'from your phone.']} />
            <Caption opacity={runCaption} lines={['Your computer keeps', 'doing the work.']} />
        </AbsoluteFill>
    );
};
