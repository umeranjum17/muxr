import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { ChangesScreen, HerdScreen, InboxScreen, Phone, TerminalScreen, VoiceScreen } from './AppUI';
import { SANS } from './fonts';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const Canvas: React.FC<{ children: React.ReactNode; dark?: boolean; photo?: boolean }> = ({ children, dark, photo }) => (
    <AbsoluteFill style={{
        background: dark
            ? 'radial-gradient(circle at 28% 45%, #15181b 0%, #050607 58%, #020303 100%)'
            : 'radial-gradient(circle at 24% 44%, #ffffff 0%, #f2f4f5 52%, #e8ebed 100%)',
        overflow: 'hidden',
    }}>
        {photo ? <><Img src={staticFile('generated/workspace.webp')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: .42 }} /><AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(242,244,245,.2), rgba(242,244,245,.82) 58%, rgba(242,244,245,.95))' }} /></> : null}
        {children}
    </AbsoluteFill>
);

const Caption: React.FC<{ eyebrow: string; lines: string[]; dark?: boolean; opacity?: number }> = ({ eyebrow, lines, dark, opacity = 1 }) => (
    <div style={{ position: 'absolute', left: 720, right: 90, bottom: 92, opacity, color: dark ? '#f7f8fb' : '#17171a', fontFamily: SANS }}>
        <div style={{ marginBottom: 14, fontSize: 20, fontWeight: 600, letterSpacing: '.09em', textTransform: 'uppercase', color: dark ? '#7f8794' : '#6f7378' }}>{eyebrow}</div>
        {lines.map((line) => <div key={line} style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.03, letterSpacing: '-.035em' }}>{line}</div>)}
    </div>
);

const AppPhone: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <Phone style={{ left: 132, top: 62 }}>{children}</Phone>
);

const Crop: React.FC<{ children: React.ReactNode; top: number; scale?: number; dark?: boolean; opacity?: number }> = ({ children, top, scale = 2.3, dark, opacity = 1 }) => (
    <div style={{ position: 'absolute', left: 680, top: 78, width: 1140, height: 610, borderRadius: 28, overflow: 'hidden', opacity, background: dark ? '#050607' : '#fff', border: `1px solid ${dark ? '#24272b' : '#dfe3e6'}`, boxShadow: dark ? '0 28px 72px rgba(0,0,0,.44)' : '0 28px 72px rgba(40,52,61,.14)' }}>
        <div style={{ position: 'absolute', width: 430, height: 928, left: 36, top, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
    </div>
);

const prompt = 'Fix the root cause and rerun checkout.';

export const HeroStory = () => {
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    const terminalIn = interpolate(frame, [168, 198], [0, 1], clamp);
    const reset = interpolate(frame, [durationInFrames - 28, durationInFrames - 1], [0, 1], clamp);
    const typed = prompt.slice(0, Math.floor(interpolate(frame, [246, 382], [0, prompt.length], clamp)));
    const sent = frame >= 406;
    const running = frame >= 432;
    const intro = (1 - interpolate(frame, [126, 154], [0, 1], clamp)) * (1 - reset) + reset;
    const exact = interpolate(frame, [186, 210, 238, 258], [0, 1, 1, 0], clamp) * (1 - reset);
    const steer = interpolate(frame, [258, 282, 390, 410], [0, 1, 1, 0], clamp) * (1 - reset);
    const local = interpolate(frame, [432, 456, durationInFrames - 54, durationInFrames - 28], [0, 1, 1, 0], clamp);
    return <Canvas photo>
        <AppPhone><div style={{ position: 'absolute', inset: 0, opacity: Math.max(1 - terminalIn, reset) }}><HerdScreen /></div><div style={{ position: 'absolute', inset: 0, opacity: terminalIn * (1 - reset) }}><TerminalScreen typed={sent ? '' : typed} running={running} /></div></AppPhone>
        <Crop top={-240} opacity={Math.max(1 - terminalIn, reset)}><HerdScreen /></Crop>
        <Crop top={-450} opacity={terminalIn * (1 - reset)}><TerminalScreen typed={sent ? '' : typed} running={running} /></Crop>
        <Caption eyebrow="The herd" lines={['Every agent.', 'One mobile surface.']} opacity={intro} />
        <Caption eyebrow="Live terminal" lines={['The exact session,', 'not a summary.']} opacity={exact} />
        <Caption eyebrow="Prompt from anywhere" lines={['Type it here.', 'It lands there.']} opacity={steer} />
        <Caption eyebrow="Execution stays local" lines={['Your computer keeps', 'doing the work.']} opacity={local} />
    </Canvas>;
};

export const TerminalStory = () => {
    const frame = useCurrentFrame();
    const typed = prompt.slice(0, Math.floor(interpolate(frame, [70, 220], [0, prompt.length], clamp)));
    const running = frame >= 252;
    return <Canvas><AppPhone><TerminalScreen typed={running ? '' : typed} running={running} /></AppPhone><Crop top={-1660}><TerminalScreen typed={running ? '' : typed} running={running} /></Crop><Caption eyebrow="Ghostty, native" lines={['ctrl. tab. ^C.', 'A real terminal for thumbs.']} /></Canvas>;
};

export const HerdStory = () => <Canvas><AppPhone><HerdScreen /></AppPhone><Crop top={-240}><HerdScreen /></Crop><Caption eyebrow="Every machine" lines={['Working. Needs you.', 'Done. One glance.']} /></Canvas>;

export const InboxStory = () => <Canvas><AppPhone><InboxScreen /></AppPhone><Crop top={-240}><InboxScreen /></Crop><Caption eyebrow="Attention, sorted" lines={['Know who needs you.', 'Tap straight into context.']} /></Canvas>;

export const ChangesStory = () => {
    const frame = useCurrentFrame();
    const scroll = interpolate(frame, [55, 300], [0, 72], clamp);
    return <Canvas><AppPhone><ChangesScreen scroll={scroll} /></AppPhone><Crop top={-210}><ChangesScreen scroll={scroll} /></Crop><Caption eyebrow="Changes" lines={['Review every line', 'before it ships.']} /></Canvas>;
};

export const VoiceStory = () => <Canvas dark><Phone dark style={{ left: 132, top: 62 }}><VoiceScreen /></Phone><Crop dark top={-520} scale={2.2}><VoiceScreen /></Crop><Caption dark eyebrow="Native realtime voice" lines={['Talk to the herd.', 'Keep the same context.']} /></Canvas>;
