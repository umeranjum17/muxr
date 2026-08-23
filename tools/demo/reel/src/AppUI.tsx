import React from 'react';
import { Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { app } from './appTheme';
import { ICONS, MONO, SANS } from './fonts';

const c = app.light;
const d = app.dark;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const glyphs: Record<string, number> = {
    search: 62815, settings: 62828, speed: 62864, file: 62132, inbox: 62199,
    branch: 62267, play: 62670, pulse: 62710, mic: 62548, up: 61765,
    image: 62351, back: 61993, list: 62399, globe: 62288, more: 62164,
    stop: 62880, enter: 62776, desktop: 62111, folder: 62249, check: 61982,
    help: 62333, hand: 62299, alert: 61715, tools: 62087,
};

export const Icon: React.FC<{ name: keyof typeof glyphs; size?: number; color?: string }> = ({ name, size = 20, color = c.text }) => (
    <span style={{ fontFamily: ICONS, fontSize: size, color, lineHeight: 1 }}>{String.fromCodePoint(glyphs[name])}</span>
);

export const Dot: React.FC<{ color: string; size?: number; pulse?: boolean }> = ({ color, size = 7, pulse }) => {
    const frame = useCurrentFrame();
    const opacity = pulse ? 0.65 + 0.35 * Math.cos(frame / 60 * Math.PI) : 1;
    return <span style={{ width: size, height: size, borderRadius: size / 2, background: color, opacity, flexShrink: 0 }} />;
};

const Avatar: React.FC<{ image: string; size?: number }> = ({ image, size = 34 }) => (
    <Img src={staticFile(`app/gradients/${image}.png`)} style={{ width: size, height: size, borderRadius: size / 2, flexShrink: 0 }} />
);

const StatusBar: React.FC<{ dark?: boolean }> = ({ dark }) => (
    <div style={{ height: 28, display: 'flex', alignItems: 'center', padding: '0 16px', font: `12px ${SANS}`, color: dark ? '#777' : '#555' }}>
        9:41 <span style={{ marginLeft: 'auto', letterSpacing: 2 }}>● ▮▮ 100%</span>
    </div>
);

export const Phone: React.FC<{ children: React.ReactNode; dark?: boolean; style?: React.CSSProperties }> = ({ children, dark, style }) => (
    <div style={{
        position: 'absolute', width: 430, height: 956, borderRadius: 42, overflow: 'hidden',
        background: dark ? '#030405' : c.grouped, border: '1px solid rgba(0,0,0,.12)',
        boxShadow: '0 32px 90px rgba(18,24,32,.22), 0 4px 18px rgba(18,24,32,.12)', ...style,
    }}>
        <StatusBar dark={dark} />
        <div style={{ position: 'absolute', inset: '28px 0 0' }}>{children}</div>
        <div style={{ position: 'absolute', width: 118, height: 4, borderRadius: 3, bottom: 8, left: 156, background: dark ? '#f3f3f3' : '#555' }} />
    </div>
);

const Round: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size = 42 }) => (
    <div style={{ width: size, height: size, borderRadius: size / 2, background: 'rgba(255,255,255,.9)', display: 'grid', placeItems: 'center', boxShadow: '0 6px 18px rgba(30,40,48,.07)' }}>{children}</div>
);

const HomeHeader = () => (
    <div style={{ height: 86, display: 'flex', alignItems: 'center', padding: '8px 14px 6px', gap: 10 }}>
        <Round size={50}><Img src={staticFile('app/glyph.png')} style={{ width: 28, height: 18, objectFit: 'contain' }} /></Round>
        <div><div style={{ font: `600 22px ${SANS}`, color: c.text }}>Herd</div><div style={{ display: 'flex', alignItems: 'center', gap: 5, font: `13px ${SANS}`, color: c.success }}><Dot color={c.success} />connected</div></div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 9 }}><Round><Icon name="search" size={22} /></Round><Round><Icon name="settings" size={22} /></Round></div>
    </div>
);

const Usage = () => (
    <div style={{ margin: '0 10px 10px', height: 30, borderRadius: 15, background: 'rgba(255,255,255,.62)', border: `1px solid ${c.divider}`, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', font: `600 12px ${SANS}` }}><Icon name="speed" size={13} color="#56545f" />12</div>
);

const chips: Array<[keyof typeof glyphs, string]> = [['desktop', 'Machine'], ['file', 'Files'], ['inbox', 'Inbox'], ['branch', 'Ports']];
const NavChips = () => (
    <div style={{ display: 'flex', gap: 8, overflow: 'hidden', padding: '0 14px 12px' }}>{chips.map(([icon, label]) => <div key={label} style={{ flexShrink: 0, height: 38, padding: '0 13px', borderRadius: 19, background: 'rgba(255,255,255,.78)', display: 'flex', alignItems: 'center', gap: 7, font: `600 13px ${SANS}` }}><Icon name={icon} size={16} color="#4d4a54" />{label}</div>)}</div>
);

const terminalLines = [
    '<!doctype html><html><head>',
    '<title>demo-shop</title>',
    '<body><main id="items">',
    'Built checkout summary',
    '',
    'Done — footer added.',
];

const MiniTerminal = ({ active = false }: { active?: boolean }) => (
    <div style={{ height: 110, background: '#0c0c0b', padding: '9px 10px', font: `10px/14px ${MONO}`, color: '#e8e8e8', overflow: 'hidden' }}>
        {terminalLines.map((line, i) => <div key={i} style={{ color: active && i === 5 ? '#82dca0' : '#e8e8e8' }}>{line || '\u00a0'}</div>)}
    </div>
);

const LiveCard: React.FC<{ title: string; status: string; color: string; active?: boolean }> = ({ title, status, color, active }) => (
    <div style={{ width: 190, height: 178, flexShrink: 0, borderRadius: 12, overflow: 'hidden', background: c.surfaceHigh, border: `1px solid ${c.divider}` }}>
        <MiniTerminal active={active} />
        <div style={{ padding: '8px 10px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `600 13px ${SANS}` }}><Dot color={color} pulse={status === 'Working'} />{title}</div><div style={{ marginTop: 3, display: 'flex', gap: 6, font: `11px ${SANS}` }}><span style={{ color, fontWeight: 600 }}>{status}</span><span style={{ color: c.textSecondary }}>Pi · feat/checkout</span></div></div>
    </div>
);

const AgentRow: React.FC<{ image: string; name: string; sub: string; color: string; pulse?: boolean; first?: boolean }> = ({ image, name, sub, color, pulse, first }) => (
    <div style={{ minHeight: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderTop: first ? undefined : `1px solid ${c.divider}` }}>
        <Avatar image={image} />
        <div style={{ minWidth: 0, flex: 1 }}><div style={{ font: `600 14px ${SANS}`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div><div style={{ marginTop: 2, font: `12px ${MONO}`, color: c.textSecondary }}>{sub}</div></div>
        <Dot color={color} pulse={pulse} />
    </div>
);

const SpaceCard = () => (
    <div style={{ margin: '0 12px', borderRadius: 14, overflow: 'hidden', background: c.surfaceHigh, border: `1px solid ${c.divider}` }}>
        <div style={{ minHeight: 48, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: `1px solid ${c.divider}` }}><span style={{ color: c.chevron }}>⌄</span><Dot color="#007AFF" size={8} pulse /><strong style={{ font: `600 15px ${SANS}` }}>demo-shop</strong><span style={{ background: c.surface, borderRadius: 5, padding: '2px 6px', font: `10px ${SANS}`, color: c.textSecondary }}>feat/checkout</span><span style={{ marginLeft: 'auto', font: `600 12px ${SANS}`, color: c.textSecondary }}>4 agents</span></div>
        <AgentRow first image="05" name="Pi — HTML footer" sub="~/demo-shop · pi" color={c.success} />
        <AgentRow image="18" name="Codex — Checkout fix" sub="~/demo-shop · codex" color="#007AFF" pulse />
        <AgentRow image="42" name="Claude — Needs direction" sub="~/demo-shop · claude" color="#FF3B30" pulse />
        <AgentRow image="77" name="Kimi — Cart refactor" sub="~/demo-shop · kimi" color="#8E8E93" />
    </div>
);

const HomeComposer: React.FC<{ prompt?: string }> = ({ prompt }) => (
    <div style={{ position: 'absolute', left: 14, right: 14, bottom: 14, height: 56, borderRadius: 28, background: 'rgba(255,255,255,.88)', border: '1px solid rgba(255,255,255,.92)', boxShadow: '0 12px 32px rgba(30,40,48,.14)', display: 'flex', alignItems: 'center', padding: '0 7px 0 14px', gap: 8 }}>
        <Icon name="pulse" size={22} color="#4c4a53" /><span style={{ flex: 1, font: `17px ${SANS}`, color: prompt ? c.text : c.textSecondary }}>{prompt || 'Plan, ask, build…'}</span><Icon name="mic" size={21} color="#4c4a53" /><div style={{ width: 40, height: 40, borderRadius: 20, background: prompt ? '#000' : c.surfaceHighest, display: 'grid', placeItems: 'center' }}><Icon name="up" size={17} color={prompt ? '#fff' : c.textSecondary} /></div>
    </div>
);

export const HerdScreen: React.FC<{ prompt?: string }> = ({ prompt }) => (
    <div style={{ position: 'absolute', inset: 0, background: c.grouped, fontFamily: SANS, color: c.text, overflow: 'hidden' }}>
        <HomeHeader /><Usage /><NavChips />
        <div style={{ padding: '0 16px 8px', font: `700 11px ${SANS}`, letterSpacing: 1.5, color: '#56545f' }}>LIVE</div>
        <div style={{ display: 'flex', gap: 10, padding: '0 16px 14px', overflow: 'hidden' }}><LiveCard active title="Pi — HTML footer" status="Done" color={c.success} /><LiveCard title="Codex — Checkout fix" status="Working" color="#007AFF" /></div>
        <div style={{ padding: '4px 16px 8px', font: `600 13px ${SANS}`, letterSpacing: .2, color: c.textSecondary }}>SPACES</div>
        <SpaceCard /><HomeComposer prompt={prompt} />
    </div>
);

const TermHeader = () => (
    <div style={{ height: 58, background: c.surface, display: 'flex', alignItems: 'center', gap: 9, padding: '0 11px', borderBottom: `1px solid ${c.divider}` }}><Icon name="back" size={25} /><Dot color={c.success} /><strong style={{ font: `600 14px ${SANS}` }}>Codex — Checkout fix</strong><span style={{ marginLeft: 'auto', display: 'flex', gap: 13 }}><Icon name="list" size={19} color="#595660" /><Icon name="globe" size={19} color="#595660" /><Icon name="branch" size={19} color="#595660" /><Icon name="speed" size={19} color="#595660" /><Icon name="more" size={20} color="#595660" /><Icon name="stop" size={20} color="#595660" /></span></div>
);

const terminalOutput = [
    { t: '◆ Checkout fails after refresh', c: '#5eb4ff' },
    { t: '  auth state reaches cart one tick late.', c: '#d5d5d5' },
    { t: '', c: '#ddd' },
    { t: '● Read src/auth/session-store.ts', c: '#7ee787' },
    { t: '● Found the stale handoff in rotate().', c: '#e8e8e8' },
    { t: '', c: '#ddd' },
    { t: '❯ Fix the root cause and rerun checkout.', c: '#f5cf66' },
];

const KeyRow = () => (
    <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: c.surface, overflow: 'hidden' }}>{[['branch', '3'], [null, 'ctrl'], [null, 'shift'], [null, 'esc'], [null, 'tab'], [null, '^C'], [null, '^D'], ['enter', '']].map(([icon, label], i) => <div key={i} style={{ height: 40, minWidth: i === 0 ? 56 : 48, borderRadius: 12, background: c.surfaceHigh, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '0 10px', font: `15px ${SANS}` }}>{icon ? <Icon name={icon as keyof typeof glyphs} size={15} color="#555" /> : null}{label}</div>)}</div>
);

const TermComposer: React.FC<{ typed: string }> = ({ typed }) => (
    <div style={{ height: 70, background: c.surface, display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px 14px' }}><Icon name="image" size={25} color="#57545e" /><div style={{ flex: 1, height: 42, borderRadius: 9, background: c.surfaceHigh, padding: '0 12px', display: 'flex', alignItems: 'center', font: `15px ${SANS}`, color: typed ? c.text : c.textSecondary }}>{typed || 'Type a prompt…'}</div><Icon name="mic" size={22} color="#57545e" /><div style={{ width: 42, height: 42, borderRadius: 21, background: c.surfaceHigh, display: 'grid', placeItems: 'center' }}><Icon name="pulse" size={22} color="#57545e" /></div><div style={{ opacity: typed ? 1 : .4 }}><Icon name="up" size={28} color="#17171a" /></div></div>
);

export const TerminalScreen: React.FC<{ typed?: string; running?: boolean }> = ({ typed = '', running }) => (
    <div style={{ position: 'absolute', inset: 0, background: '#000', color: '#e8e8e8', overflow: 'hidden' }}>
        <TermHeader />
        <div style={{ position: 'absolute', inset: '58px 0 122px', background: d.terminal, padding: '28px 20px', font: `14px/23px ${MONO}` }}>{terminalOutput.map((line, i) => <div key={i} style={{ color: line.c }}>{line.t || '\u00a0'}</div>)}{running ? <><div style={{ marginTop: 14, color: '#7ee787' }}>● Updating session-store.ts</div><div style={{ color: '#5eb4ff' }}>● Running checkout flow…</div></> : null}<div style={{ marginTop: 20, border: '1px solid #4a4a4a', height: 42, display: 'flex', alignItems: 'center', padding: '0 12px' }}>❯ <span style={{ width: 8, height: 18, background: '#fff', marginLeft: 8 }} /></div><div style={{ marginTop: 8, color: '#aaa', display: 'flex' }}><span>high · ~/demo-shop</span><span style={{ marginLeft: 'auto' }}>feat/checkout <span style={{ color: '#58d68d' }}>+9</span> <span style={{ color: '#ff6b6b' }}>−2</span></span></div></div>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}><KeyRow /><TermComposer typed={typed} /></div>
    </div>
);

const InboxRow: React.FC<{ glyph: string; name: string; sub: string; meta: string; color: string; first?: boolean; done?: boolean }> = ({ glyph, name, sub, meta, color, first, done }) => (
    <div style={{ minHeight: 98, opacity: done ? .75 : 1, background: c.surface, display: 'flex', alignItems: 'center', padding: '14px 16px', gap: 14, borderTop: first ? undefined : `1px solid ${c.divider}` }}><div style={{ width: 36, height: 36, borderRadius: 10, background: c.surfaceHigh, border: `1px solid ${c.divider}`, display: 'grid', placeItems: 'center', color: c.textSecondary, font: `600 15px ${SANS}` }}>{glyph.slice(0, 1).toUpperCase()}</div><div style={{ minWidth: 0, flex: 1 }}><div style={{ font: `600 17px ${SANS}` }}>{name}</div><div style={{ font: `15px/20px ${SANS}`, color: c.textSecondary, marginTop: 4 }}>{sub}</div><div style={{ font: `13px ${SANS}`, color: c.textSecondary, marginTop: 5 }}>{meta}</div></div><Dot color={color} pulse={color === '#FF3B30' || color === '#FF9F0A'} size={8} /></div>
);

export const InboxScreen = () => (
    <div style={{ position: 'absolute', inset: 0, background: c.grouped, color: c.text }}><div style={{ height: 76, display: 'flex', alignItems: 'center', gap: 14, padding: '8px 16px' }}><Round><Icon name="back" size={26} /></Round><strong style={{ font: `600 22px ${SANS}` }}>Inbox</strong></div><div style={{ padding: '20px 24px 8px', font: `600 14px ${SANS}`, color: c.textSecondary }}>DEMO-SHOP</div><div style={{ margin: '0 16px 14px', borderRadius: 18, overflow: 'hidden' }}><InboxRow first glyph="Claude" name="Claude — Needs direction" sub="Waiting for a decision on checkout state" meta="claude · just now" color="#FF3B30" /><InboxRow glyph="Codex" name="Codex — Checkout fix" sub="Tracing auth → cart handoff" meta="codex · 4 minutes ago" color="#FF9F0A" /><InboxRow done glyph="Pi" name="Pi — HTML footer" sub="Footer added and verified" meta="pi · 12 minutes ago" color={c.success} /></div><div style={{ padding: '10px 24px 8px', font: `600 14px ${SANS}`, color: c.textSecondary }}>SITE-RELEASE</div><div style={{ margin: '0 16px', borderRadius: 18, overflow: 'hidden' }}><InboxRow first done glyph="Gemini" name="Gemini — Release notes" sub="Draft ready for review" meta="gemini · 18 minutes ago" color={c.success} /></div></div>
);

const diffRows = [
    ['81', '81', ' ', 'const items = [\'keyboard\', \'mouse\'];', 'ctx'],
    ['82', '', '-', 'document.getElementById(\'items\').innerHTML =', 'del'],
    ['83', '', '-', '  items.map(i => `<li>${i}</li>`).join(\'\');', 'del'],
    ['', '82', '+', 'const list = document.getElementById(\'items\');', 'add'],
    ['', '83', '+', 'list.replaceChildren(...items.map(item => {', 'add'],
    ['', '84', '+', '  const li = document.createElement(\'li\');', 'add'],
    ['', '85', '+', '  li.textContent = item;', 'add'],
    ['', '86', '+', '  return li;', 'add'],
    ['', '87', '+', '}));', 'add'],
];

export const ChangesScreen: React.FC<{ scroll?: number }> = ({ scroll = 0 }) => (
    <div style={{ position: 'absolute', inset: 0, background: c.grouped, color: c.text, overflow: 'hidden' }}><div style={{ height: 68, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 10, background: c.surface }}><span style={{ color: '#e0aa00', font: `600 15px ${MONO}` }}>JS</span><strong style={{ font: `600 16px ${SANS}` }}>app.js</strong><span style={{ color: c.textSecondary, font: `14px ${MONO}` }}>~/demo-shop</span><span style={{ marginLeft: 'auto', color: '#24a148', font: `600 13px ${MONO}` }}>+9</span><span style={{ color: '#da3b3b', font: `600 13px ${MONO}` }}>−2</span></div><div style={{ display: 'flex', padding: '10px 18px', gap: 6 }}><span style={{ borderRadius: 10, background: c.surface, padding: '8px 16px', font: `600 14px ${SANS}` }}>Diff</span><span style={{ padding: '8px 16px', color: c.textSecondary, font: `14px ${SANS}` }}>File</span></div><div style={{ margin: '0 16px', borderRadius: 12, overflow: 'hidden', border: `1px solid ${c.diff.outline}`, background: c.surface, transform: `translateY(${-scroll}px)` }}><div style={{ minHeight: 36, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 7, background: c.surfaceHigh, borderBottom: `1px solid ${c.diff.outline}` }}><Icon name="file" size={15} color={c.textSecondary} /><strong style={{ font: `600 12px ${MONO}` }}>app.js</strong><span style={{ color: c.textSecondary, font: `11px ${MONO}` }}>demo-shop</span></div><div style={{ minHeight: 32, padding: '0 10px', display: 'flex', alignItems: 'center', background: c.diff.hunkHeaderBg, color: c.diff.hunkHeaderText, font: `600 11px ${MONO}` }}>−81  +81&nbsp;&nbsp; renderItems()</div>{diffRows.map(([oldNo, newNo, prefix, text, kind], i) => { const add = kind === 'add', del = kind === 'del'; return <div key={i} style={{ minHeight: 31, display: 'flex', alignItems: 'flex-start', background: add ? 'rgba(40,167,69,.08)' : del ? 'rgba(220,53,69,.08)' : 'transparent', borderLeft: `2px solid ${add ? c.diff.success : del ? c.diff.error : 'transparent'}`, color: add ? c.diff.addedText : del ? c.diff.removedText : c.diff.contextText, font: `13px/29px ${MONO}` }}><span style={{ width: 25, textAlign: 'right', color: c.diff.lineNumberText }}>{oldNo}</span><span style={{ width: 25, textAlign: 'right', color: c.diff.lineNumberText }}>{newNo}</span><span style={{ width: 20, textAlign: 'center', fontWeight: add || del ? 600 : 400 }}>{prefix}</span><span>{text}</span></div>; })}</div></div>
);

const rng = (seed: number) => { const x = Math.sin(seed * 127.1) * 43758.5453; return x - Math.floor(x); };
export const VoiceScreen = () => { const frame = useCurrentFrame(); const turn = frame / 60 / 62 * Math.PI * 2; return <div style={{ position: 'absolute', inset: 0, background: '#030405', color: '#f7f8fb' }}><div style={{ height: 76, display: 'flex', alignItems: 'center', padding: '10px 16px' }}><Round size={44}><span style={{ fontSize: 25 }}>⌄</span></Round><strong style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', font: `600 18px ${SANS}` }}>Realtime</strong></div><div style={{ position: 'absolute', left: 65, top: 230, width: 300, height: 300, borderRadius: 150, background: 'radial-gradient(circle, rgba(247,248,251,.55) 0%, rgba(247,248,251,.12) 18%, transparent 55%)' }}>{Array.from({ length: 130 }, (_, i) => { const a = rng(i + 1) * Math.PI * 2 + turn * (1 + i % 3); const r = 25 + Math.pow(rng(i + 44), .78) * 120; const s = 1 + rng(i + 78) * 3; return <span key={i} style={{ position: 'absolute', left: 150 + Math.cos(a) * r, top: 150 + Math.sin(a) * r * .62, width: s, height: s, borderRadius: s, background: '#f7f8fb', opacity: .2 + rng(i + 90) * .7 }} />; })}</div><div style={{ position: 'absolute', top: 550, left: 0, right: 0, textAlign: 'center', font: `600 28px ${SANS}` }}>Listening</div><div style={{ position: 'absolute', left: 26, right: 26, top: 640, display: 'grid', gap: 12, font: `15px/21px ${SANS}` }}><div style={{ color: '#7f8794' }}>you&nbsp;&nbsp; What changed while I was out?</div><div>muxr&nbsp;&nbsp; Checkout is waiting. The footer agent finished.</div></div><div style={{ position: 'absolute', bottom: 42, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 28 }}><Round size={58}><Icon name="mic" size={28} /></Round><Round size={58}><span style={{ fontSize: 34 }}>×</span></Round></div></div>; };
