import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { Layer } from './Layer';
import { GRID } from './system';
import { Head, Label } from './Type';
import { Desk } from './Desk';
import { MONO, SANS } from './theme';
import {
    arrive, base, cadenceOf, Cadence, col, colFromRight, COPY_W, depart, dim, ink, sideOf, span,
    STAGE_W, STAGE_X, status, TYPE,
} from './system';
import deskPanel from '../../lib/desk.json';
import authoringPanel from '../../lib/authoring.json';

export type BeatProps = { total: number; index: number };
type Beat = React.FC<BeatProps>;

/**
 * Every beat is the same frame: a copy column on one side, a stage on the
 * other, both on the grid. Which side, and whether type or image arrives first,
 * alternates — so the film has a pulse without any beat being placed by hand.
 */
const Frame: React.FC<{
    index: number;
    total: number;
    lines: string[];
    label: React.ReactNode;
    tone?: keyof typeof status;
    bloom?: string;
    children: React.ReactNode;
}> = ({ index, total, lines, label, tone = 'working', bloom, children }) => {
    const side = sideOf(index);
    const cadence = cadenceOf(index);
    const copyLeft = side === 'left';

    return (
        <AbsoluteFill style={{ background: ink, overflow: 'hidden' }}>
            <AbsoluteFill
                style={{
                    background: 'radial-gradient(closest-side, rgba(255,255,255,0.11), transparent)',
                    width: 1500, height: 1200,
                    left: bloom ?? (copyLeft ? '68%' : '32%'), marginLeft: -750, top: -120,
                    filter: 'blur(26px)',
                }}
            />
            {/* The stage: the half the copy is not on, with a column of air
                between them. A fragment may bleed off the outer edge; it may
                never cross the gutter into the type. */}
            <div
                style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: copyLeft ? STAGE_X : 0,
                    width: STAGE_W,
                }}
            >
                {children}
            </div>
            <div
                style={{
                    position: 'absolute',
                    left: copyLeft ? col(0) : undefined,
                    right: copyLeft ? undefined : GRID.margin,
                    width: COPY_W,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: copyLeft ? 'flex-start' : 'flex-end',
                }}
            >
                <Head lines={lines} total={total} cadence={cadence} align={copyLeft ? 'left' : 'right'} />
                <Label total={total} cadence={cadence} tone={tone} align={copyLeft ? 'left' : 'right'} style={{ marginTop: base(5) }}>
                    {label}
                </Label>
            </div>
        </AbsoluteFill>
    );
};

/** The stage half, so panel coordinates read the same on either side. */
const stageAt = (index: number, offset: number) =>
    sideOf(index) === 'left' ? { left: colFromRight(0) + offset } : { right: colFromRight(0) + offset };

export const Herd: Beat = ({ total, index }) => {
    const c = cadenceOf(index);
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['Every agent.', 'One screen.']} label="Sixteen agents, one machine">
            <Layer src="spaces.png" w={700} total={total} cadence={c} depth={2.4} tilt={left ? -16 : 16} order={1}
                at={{ [left ? 'right' : 'left']: -base(16), top: base(9) }} />
            <Layer src="spaces.png" w={800} total={total} cadence={c} depth={0} tilt={left ? -10 : 10} order={0}
                at={{ [left ? 'right' : 'left']: base(9), top: base(26) }} />
            {['machine', 'usage', 'files', 'runbook'].map((chip, i) => (
                <Layer key={chip} src={`chip-${chip}.png`} w={[206, 192, 170, 218][i]!} role="chip" order={i}
                    total={total} cadence={c} depth={[1.4, 0, 0.7, 2.1][i]!}
                    at={{ left: base(2) + i * base(28), top: base(7) + (i % 2) * base(6) }} />
            ))}
        </Frame>
    );
};

export const Same: Beat = ({ total, index }) => {
    const frame = useCurrentFrame();
    const c = cadenceOf(index);
    const t = frame / Math.max(1, total - 1);
    const a = arrive(frame, 'panel');
    return (
        <Frame index={index} total={total} lines={['Nothing', 'to hand off.']} label="The same pane, desk and pocket">
            <div
                style={{
                    position: 'absolute', right: base(6), top: base(11), width: 860, height: base(64),
                    transform: `perspective(2600px) rotateY(10deg) translateY(${(1 - a) * 22}px) scale(${0.982 + a * 0.018})`,
                    opacity: a * depart(frame, total, 'panel'),
                }}
            >
                <Desk panel={deskPanel} theme="dark" t={t} delay={0} />
            </div>
            <Layer src="termbody.png" w={340} total={total} cadence={c} depth={0} tilt={-7} order={1}
                at={{ right: base(4), top: base(46) }} />
        </Frame>
    );
};

export const Voice: Beat = ({ total, index }) => {
    const frame = useCurrentFrame();
    const c = cadenceOf(index);
    const t = arrive(frame, 'inline');
    return (
        <AbsoluteFill style={{ background: ink, overflow: 'hidden' }}>
            <AbsoluteFill
                style={{
                    background: 'radial-gradient(closest-side, rgba(255,255,255,0.13), transparent)',
                    width: 1400, height: 1100, left: '74%', marginLeft: -700, top: -100, filter: 'blur(26px)',
                }}
            />
            <Layer src="orb.png" w={span(4)} total={total} cadence={c} depth={1.1} order={0} radius={999}
                at={{ right: colFromRight(0), top: base(11) }} />
            {/* The one beat where a real control sits inside the sentence. */}
            <div style={{ position: 'absolute', left: col(0), top: '50%', transform: 'translateY(-50%)', width: span(10) }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: base(4) }}>
                    <Head lines={['Just']} total={total} cadence={c} />
                    <div
                        style={{
                            width: span(5), borderRadius: 999, overflow: 'hidden',
                            opacity: t * depart(frame, total, 'inline'),
                            transform: `translateY(${(1 - t) * 16}px) scale(${0.94 + t * 0.06})`,
                            filter: `blur(${(1 - t) * 4}px)`,
                            boxShadow: '0 34px 70px -20px rgba(0,0,0,0.94), 0 0 0 1px rgba(255,255,255,0.11)',
                        }}
                    >
                        <Img src={staticFile('frag/composer.png')} style={{ width: '100%', display: 'block' }} />
                    </div>
                    <Head lines={['it.']} total={total} cadence={c} />
                </div>
                <Label total={total} cadence={c} style={{ marginTop: base(5) }}>Type it or say it, same composer</Label>
            </div>
        </AbsoluteFill>
    );
};

export const Diff: Beat = ({ total, index }) => {
    const c = cadenceOf(index);
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['See the diff', 'then approve']} label="Approvals stay yours" tone="blocked">
            <Layer src="diff.png" w={800} total={total} cadence={c} depth={0} tilt={left ? -9 : 9} order={0}
                at={{ [left ? 'right' : 'left']: base(9), top: base(18) }} />
            <Layer src="difftabs.png" w={560} total={total} cadence={c} depth={1.2} order={1} radius={18}
                at={{ [left ? 'right' : 'left']: base(24), top: base(8) }} />
        </Frame>
    );
};

export const Files: Beat = ({ total, index }) => {
    const c = cadenceOf(index);
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['The repo,', 'one tap deep']} label="1,463 files, from your pocket">
            <Layer src="tree.png" w={720} total={total} cadence={c} depth={0} tilt={left ? -9 : 9} order={0}
                at={{ [left ? 'right' : 'left']: base(12), top: base(15) }} />
            <Layer src="chip-files.png" w={196} role="chip" order={0} total={total} cadence={c} depth={0}
                at={{ [left ? 'left' : 'right']: base(6), top: base(24) }} />
        </Frame>
    );
};

export const Spend: Beat = ({ total, index }) => {
    const c = cadenceOf(index);
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['Know what', 'it costs.']} label="Read from local agent logs" tone="done">
            <Layer src="spend.png" w={820} total={total} cadence={c} depth={0} tilt={left ? -8 : 8} order={0}
                at={{ [left ? 'right' : 'left']: base(8), top: base(32) }} />
            <Layer src="chip-usage.png" w={210} role="chip" order={0} total={total} cadence={c} depth={0.8}
                at={{ [left ? 'right' : 'left']: base(26), top: base(16) }} />
        </Frame>
    );
};

export const Plugins: Beat = ({ total, index }) => {
    const c = cadenceOf(index);
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['Extensions', 'you approve']} label="Native UI, never downloaded" tone="done">
            <Layer src="plugrows.png" w={740} total={total} cadence={c} depth={0} tilt={left ? -8 : 8} order={0}
                at={{ [left ? 'right' : 'left']: base(11), top: base(14) }} />
            <Layer src="keys.png" w={600} total={total} cadence={c} depth={1.8} order={1} radius={16}
                at={{ [left ? 'right' : 'left']: base(5), bottom: base(16) }} />
        </Frame>
    );
};

export const Authoring: Beat = ({ total, index }) => {
    const frame = useCurrentFrame();
    const c = cadenceOf(index);
    const t = frame / Math.max(1, total - 1);
    const a = arrive(frame, 'panel');
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['Write', 'your own.']} label="One manifest. Native screens." tone="done">
            <div
                style={{
                    position: 'absolute', [left ? 'right' : 'left']: base(8), top: base(17),
                    width: 840, height: base(94),
                    transform: `perspective(2600px) rotateY(${left ? -9 : 9}deg) translateY(${(1 - a) * 22}px) scale(${0.982 + a * 0.018})`,
                    opacity: a * depart(frame, total, 'panel'),
                }}
            >
                <Desk panel={authoringPanel} theme="dark" t={t} delay={0} scrollBy={-150} />
            </div>
        </Frame>
    );
};

export const SelfHosted: Beat = ({ total, index }) => {
    const c = cadenceOf(index);
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['Your relay.', 'Your rules.']} label="Tailscale, Cloudflare, or LAN" tone="done">
            <Layer src="conn.png" w={720} total={total} cadence={c} depth={0} tilt={left ? -10 : 10} order={0}
                at={{ [left ? 'right' : 'left']: base(12), top: base(15) }} />
        </Frame>
    );
};

export const Away: Beat = ({ total, index }) => {
    const c = cadenceOf(index);
    const left = sideOf(index) === 'left';
    return (
        <Frame index={index} total={total} lines={['It finds you', 'day or night']} label="Finished, blocked, or gone quiet" tone="done">
            <Layer src="inboxrows.png" w={700} total={total} cadence={c} depth={2.6} tilt={left ? -16 : 16} order={1}
                at={{ [left ? 'right' : 'left']: -base(12), top: base(8) }} />
            <Layer src="inboxrows.png" w={800} total={total} cadence={c} depth={0} tilt={left ? -10 : 10} order={0}
                at={{ [left ? 'right' : 'left']: base(9), top: base(24) }} />
        </Frame>
    );
};

const WORDMARK_COLUMNS = 25;

export const Title: React.FC<{ total: number; tagline: string }> = ({ total, tagline }) => {
    const frame = useCurrentFrame();
    const mark = arrive(frame, 'panel');
    const out = depart(frame, total, 'display');
    const lines = tagline.split(/(?<=\.)\s+/);
    return (
        <AbsoluteFill style={{ background: ink, overflow: 'hidden' }}>
            <AbsoluteFill
                style={{
                    background: 'radial-gradient(closest-side, rgba(255,255,255,0.10), transparent)',
                    width: 1500, height: 1200, left: '50%', marginLeft: -750, top: -140, filter: 'blur(26px)',
                }}
            />
            <Layer src="spaces.png" w={span(6)} total={total} cadence="image-first" depth={3.2} tilt={13} order={0}
                at={{ left: -base(22), top: base(15) }} />
            <Layer src="termbody.png" w={span(5)} total={total} cadence="image-first" depth={3.6} tilt={-13} order={1}
                at={{ right: -base(20), top: base(5) }} />
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
                {/* The mark is a display matrix; it assembles a cell column at a time. */}
                <div style={{ width: span(4), marginBottom: base(8), clipPath: `inset(0 ${100 - Math.round(mark * WORDMARK_COLUMNS) * (100 / WORDMARK_COLUMNS)}% 0 0)` }}>
                    <Img src={staticFile('img/wordmark@3x.png')} style={{ width: '100%', display: 'block', filter: 'brightness(0) invert(1)' }} />
                </div>
                <Head lines={lines} total={total} cadence="image-first" style={{ textAlign: 'center' }} />
            </AbsoluteFill>
        </AbsoluteFill>
    );
};

export const End: React.FC<{ total: number; install: string; site: string; note: string }> = ({
    total, install, site, note,
}) => {
    const frame = useCurrentFrame();
    const a = arrive(frame, 'panel');
    const b = arrive(frame, 'inline');
    const c = arrive(frame, 'label');
    const out = depart(frame, total, 'display');
    return (
        <AbsoluteFill style={{ background: ink, overflow: 'hidden' }}>
            <AbsoluteFill
                style={{
                    background: 'radial-gradient(closest-side, rgba(255,255,255,0.10), transparent)',
                    width: 1400, height: 1100, left: '50%', marginLeft: -700, top: -80, filter: 'blur(26px)',
                }}
            />
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: out }}>
                <Img src={staticFile('img/glyph@3x.png')}
                    style={{ width: 112, opacity: a, transform: `translateY(${(1 - a) * 12}px)`, filter: 'brightness(0) invert(1)' }} />
                <div
                    style={{
                        fontFamily: MONO, fontSize: 40, color: '#f4f4f5',
                        background: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 14, padding: `${base(3)}px ${base(4)}px`, marginTop: base(7),
                        opacity: b, transform: `translateY(${(1 - b) * 14}px)`,
                    }}
                >
                    {install}
                </div>
                <div style={{ marginTop: base(6) }}>
                    <Head lines={[site]} total={total} cadence="type-first" style={{ textAlign: 'center' }} />
                </div>
                <div style={{ fontFamily: SANS, fontSize: 30, color: dim, marginTop: base(2), opacity: c }}>{note}</div>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
