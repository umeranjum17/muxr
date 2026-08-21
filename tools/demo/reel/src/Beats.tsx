import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { Layer } from './Layer';
import { Head, Kicker } from './Type';
import { Desk } from './Desk';
import { MONO, SANS } from './theme';
import { dim, enter, ink, leave } from './motion';
import deskPanel from '../../lib/desk.json';
import authoringPanel from '../../lib/authoring.json';

type Beat = React.FC<{ total: number }>;

/** Ink, and one soft lift where the focal layer sits. */
const Ground: React.FC<{ children: React.ReactNode; bloomAt?: string }> = ({ children, bloomAt = '62%' }) => (
    <AbsoluteFill style={{ background: ink, overflow: 'hidden' }}>
        <AbsoluteFill
            style={{
                background: 'radial-gradient(closest-side, rgba(255,255,255,0.11), transparent)',
                width: 1600, height: 1200, left: bloomAt, marginLeft: -800, top: -140, filter: 'blur(24px)',
            }}
        />
        {children}
    </AbsoluteFill>
);

/** A real UI element sitting inside a sentence, at the height of the type. */
const Inline: React.FC<{ src: string; w: number; total: number; delay: number }> = ({ src, w, total, delay }) => {
    const frame = useCurrentFrame();
    const arrive = enter(frame, delay, 30);
    return (
        <div
            style={{
                width: w,
                borderRadius: 999,
                overflow: 'hidden',
                opacity: arrive * leave(frame, total),
                transform: `translateY(${(1 - arrive) * 26}px) scale(${0.94 + arrive * 0.06})`,
                boxShadow: '0 34px 70px -20px rgba(0,0,0,0.94), 0 0 0 1px rgba(255,255,255,0.11)',
            }}
        >
            <Img src={staticFile(`frag/${src}`)} style={{ width: '100%', display: 'block' }} />
        </div>
    );
};

/** The mark is a display matrix, so it assembles one cell column at a time. */
const WORDMARK_COLUMNS = 25;

export const Title: Beat = ({ total }) => {
    const frame = useCurrentFrame();
    const mark = enter(frame, 0, 34);
    const out = leave(frame, total, 16);
    return (
        <Ground bloomAt="50%">
            <Layer src="spaces.png" w={760} at={{ left: -180, top: 120 }} depth={3.2} tilt={12} total={total} delay={0} />
            <Layer src="termbody.png" w={700} at={{ right: -160, top: 40 }} depth={3.6} tilt={-12} total={total} delay={3} />
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
                <div style={{ width: 430, marginBottom: 62, clipPath: `inset(0 ${100 - Math.round(mark * WORDMARK_COLUMNS) * (100 / WORDMARK_COLUMNS)}% 0 0)` }}>
                    <Img src={staticFile('img/wordmark@3x.png')} style={{ width: '100%', display: 'block', filter: 'brightness(0) invert(1)' }} />
                </div>
                <Head lines={['Leave the desk.', 'Not the work.']} total={total} delay={12} size={124} style={{ textAlign: 'center' }} />
            </AbsoluteFill>
        </Ground>
    );
};

export const Herd: Beat = ({ total }) => (
    <Ground>
        <Layer src="spaces.png" w={780} at={{ right: -130, top: 62 }} depth={2.4} tilt={-17} total={total} delay={0} />
        <Layer src="spaces.png" w={920} at={{ right: 110, top: 196 }} depth={0} tilt={-11} total={total} delay={6} />
        <Layer src="chip-machine.png" w={206} at={{ left: 742, top: 94 }} depth={1.4} total={total} delay={12} pill />
        <Layer src="chip-usage.png" w={192} at={{ left: 1000, top: 58 }} depth={0} total={total} delay={16} pill />
        <Layer src="chip-files.png" w={170} at={{ left: 1232, top: 106 }} depth={0.7} total={total} delay={20} pill />
        <Layer src="chip-runbook.png" w={218} at={{ left: 1442, top: 56 }} depth={2.1} total={total} delay={24} pill />
        <Head lines={['Every agent,', 'one screen']} total={total} style={{ position: 'absolute', left: -14, top: 296 }} />
        <Kicker total={total} style={{ position: 'absolute', left: 26, top: 654 }}>Sixteen agents, one machine</Kicker>
    </Ground>
);

export const Same: Beat = ({ total }) => {
    const frame = useCurrentFrame();
    const t = frame / Math.max(1, total - 1);
    return (
        <Ground bloomAt="46%">
            <div
                style={{
                    position: 'absolute', left: 268, top: 62, width: 940, height: 560,
                    transform: `perspective(2600px) rotateY(-10deg) translateY(${(1 - enter(frame, 0, 32)) * 40}px)`,
                    opacity: enter(frame, 0, 32) * leave(frame, total),
                }}
            >
                <Desk panel={deskPanel} theme="dark" t={t} delay={0} />
            </div>
            <Layer src="termbody.png" w={400} at={{ right: 150, top: 250 }} depth={0} tilt={-7} total={total} delay={10} />
            <Head lines={['Nothing', 'to hand off']} total={total} delay={14} size={132} style={{ position: 'absolute', left: -10, bottom: 148 }} />
            <Kicker total={total} delay={26} style={{ position: 'absolute', left: 26, bottom: 86 }}>The same pane, desk and pocket</Kicker>
        </Ground>
    );
};

export const Voice: Beat = ({ total }) => (
    <Ground bloomAt="72%">
        <Layer src="orb.png" w={620} at={{ right: 120, top: 90 }} depth={1.1} total={total} delay={0} radius={999} />
        <div style={{ position: 'absolute', left: 118, top: 392, right: 100, display: 'flex', alignItems: 'center', gap: 30 }}>
            <Head lines={['Just']} total={total} delay={4} size={146} />
            <Inline src="composer.png" w={700} total={total} delay={14} />
            <Head lines={['it.']} total={total} delay={22} size={146} />
        </div>
        <Kicker total={total} delay={30} style={{ position: 'absolute', left: 124, top: 640 }}>Type it or say it. Same composer.</Kicker>
    </Ground>
);

export const Diff: Beat = ({ total }) => (
    <Ground>
        <Layer src="diff.png" w={1000} at={{ right: 90, top: 150 }} depth={0} tilt={-9} total={total} delay={4} />
        <Layer src="difftabs.png" w={700} at={{ left: 700, top: 68 }} depth={1.2} total={total} delay={14} radius={18} />
        <Head lines={['Read the diff', 'before you', 'approve']} total={total} size={124} style={{ position: 'absolute', left: -8, top: 250 }} />
        <Kicker total={total} tone="blocked" style={{ position: 'absolute', left: 26, top: 700 }}>Approvals stay yours</Kicker>
    </Ground>
);

export const Files: Beat = ({ total }) => (
    <Ground bloomAt="34%">
        <Layer src="tree.png" w={880} at={{ left: 130, top: 130 }} depth={0} tilt={9} total={total} delay={4} />
        <Layer src="chip-files.png" w={196} at={{ left: 940, top: 190 }} depth={0} total={total} delay={16} pill />
        <Head lines={['The whole repo,', 'one level', 'at a time']} total={total} size={112} style={{ position: 'absolute', right: 70, top: 250, textAlign: 'right' }} />
        <Kicker total={total} style={{ position: 'absolute', right: 74, top: 700, justifyContent: 'flex-end' }}>1,463 files, from your pocket</Kicker>
    </Ground>
);

export const Spend: Beat = ({ total }) => (
    <Ground>
        <Layer src="spend.png" w={1020} at={{ right: 110, top: 250 }} depth={0} tilt={-8} total={total} delay={4} />
        <Layer src="chip-usage.png" w={210} at={{ left: 1060, top: 120 }} depth={0.8} total={total} delay={16} pill />
        <Head lines={['Know what', 'the work', 'costs']} total={total} size={128} style={{ position: 'absolute', left: -8, top: 240 }} />
        <Kicker total={total} tone="done" style={{ position: 'absolute', left: 26, top: 700 }}>Read from local agent logs</Kicker>
    </Ground>
);

export const Plugins: Beat = ({ total }) => (
    <Ground bloomAt="38%">
        <Layer src="plugrows.png" w={900} at={{ left: 120, top: 110 }} depth={0} tilt={8} total={total} delay={4} />
        <Layer src="keys.png" w={660} at={{ right: 90, bottom: 150 }} depth={1.8} total={total} delay={16} radius={16} />
        <Head lines={['Extensions', 'your machine', 'approves']} total={total} size={118} style={{ position: 'absolute', right: 80, top: 210, textAlign: 'right' }} />
        <Kicker total={total} tone="done" style={{ position: 'absolute', right: 84, top: 640, justifyContent: 'flex-end' }}>Native UI, never downloaded HTML</Kicker>
    </Ground>
);

export const Authoring: Beat = ({ total }) => {
    const frame = useCurrentFrame();
    const t = frame / Math.max(1, total - 1);
    return (
        <Ground bloomAt="66%">
            <div
                style={{
                    position: 'absolute', right: 110, top: 130, width: 940, height: 800,
                    transform: `perspective(2600px) rotateY(-9deg) translateY(${(1 - enter(frame, 4, 32)) * 42}px)`,
                    opacity: enter(frame, 4, 32) * leave(frame, total),
                }}
            >
                <Desk panel={authoringPanel} theme="dark" t={t} delay={0} scrollBy={-150} />
            </div>
            <Head lines={['Write', 'your own', 'extension']} total={total} size={130} style={{ position: 'absolute', left: -8, top: 250 }} />
            <Kicker total={total} tone="done" style={{ position: 'absolute', left: 26, top: 720 }}>One manifest. Native screens.</Kicker>
        </Ground>
    );
};

export const SelfHosted: Beat = ({ total }) => (
    <Ground bloomAt="32%">
        <Layer src="conn.png" w={880} at={{ left: 140, top: 120 }} depth={0} tilt={10} total={total} delay={4} />
        <Head lines={['Your relay.', 'Your rules.']} total={total} size={140} style={{ position: 'absolute', right: 80, top: 300, textAlign: 'right' }} />
        <Kicker total={total} tone="done" style={{ position: 'absolute', right: 84, top: 620, justifyContent: 'flex-end' }}>Tailscale, Cloudflare, or your own VPS</Kicker>
    </Ground>
);

export const Away: Beat = ({ total }) => (
    <Ground>
        <Layer src="inboxrows.png" w={780} at={{ right: -110, top: 70 }} depth={2.6} tilt={-16} total={total} delay={0} />
        <Layer src="inboxrows.png" w={920} at={{ right: 120, top: 190 }} depth={0} tilt={-10} total={total} delay={6} />
        <Head lines={['It finds you,', 'day or night']} total={total} style={{ position: 'absolute', left: -12, top: 320 }} />
        <Kicker total={total} tone="done" style={{ position: 'absolute', left: 26, top: 660 }}>Finished, blocked, or gone quiet</Kicker>
    </Ground>
);

export const End: React.FC<{ total: number; install: string; site: string; note: string }> = ({
    total, install, site, note,
}) => {
    const frame = useCurrentFrame();
    const a = enter(frame, 0, 26);
    const b = enter(frame, 12, 28);
    const c = enter(frame, 24, 28);
    return (
        <Ground bloomAt="50%">
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
                <Img
                    src={staticFile('img/glyph@3x.png')}
                    style={{ width: 112, opacity: a, transform: `translateY(${(1 - a) * 14}px)`, filter: 'brightness(0) invert(1)' }}
                />
                <div
                    style={{
                        fontFamily: MONO, fontSize: 40, color: '#f4f4f5',
                        background: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 14, padding: '20px 32px', marginTop: 54,
                        opacity: b, transform: `translateY(${(1 - b) * 14}px)`,
                    }}
                >
                    {install}
                </div>
                <div style={{ marginTop: 46, opacity: c }}>
                    <Head lines={[site]} total={total} delay={24} size={72} />
                </div>
                <div style={{ fontFamily: SANS, fontSize: 30, color: dim, marginTop: 16, opacity: c }}>{note}</div>
            </AbsoluteFill>
        </Ground>
    );
};
