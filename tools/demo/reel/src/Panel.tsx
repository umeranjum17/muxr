import React from 'react';
import { baseline, ground, hairline, type as scale } from './design';
import desk from '../../lib/desk.json';
import authoring from '../../lib/authoring.json';

const SOURCES = { desk, authoring } as const;
const t = scale.film;
/** One scrollback row. Body size, so the pane is read, not looked at. */
const ROW = baseline(4);
/** A pane is a dark object on any ground. On paper a white plate on a near-white
 *  page is a 5% step, which reads as grey monospace on a page rather than as the
 *  thing the beat is claiming — the pane your desk has. */
const g = ground.ink;

/**
 * A terminal plate: real scrollback from a real pane, snapshotted by
 * capture/desk.mjs and capture/authoring.mjs. Nothing here is typed for the
 * camera, which is why the wrapping is imperfect in places.
 *
 * Every plate is the same box — header, a fixed row count, the same padding top
 * and bottom — so the two panel beats cut into each other without the object
 * changing size under the cut. A short source is padded, never shrunk.
 */
export const Panel: React.FC<{
    which: keyof typeof SOURCES;
    /** Both come from `col`/`span` in the caller — never a raw coordinate. */
    left: number;
    width: number;
    lines?: number;
}> = ({ which, left, width, lines = 14 }) => {
    const src = SOURCES[which];
    const rows = [...src.lines.slice(-lines)];
    while (rows.length < lines) rows.unshift('');
    // The plate bleeds off the outer edge, so the inner padding on that side is
    // the frame, not a margin: 24px there reads as neither.
    const bleedsLeft = left === 0;
    const pad = { paddingLeft: bleedsLeft ? 0 : baseline(3), paddingRight: bleedsLeft ? baseline(3) : 0 };
    return (
        <div
            style={{
                position: 'absolute',
                left,
                top: baseline(33),
                width,
                height: baseline(12) + ROW * lines,
                // The raised plane is the edge. A border as well would draw a
                // line off the frame on the side the plate bleeds through.
                background: g.raised,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    height: baseline(6),
                    boxSizing: 'border-box',
                    borderBottom: `${hairline}px solid ${g.rule}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: baseline(2),
                    ...pad,
                    fontFamily: 'PlexMono',
                    fontSize: t.micro.size,
                    color: g.dim,
                }}
            >
                <span style={{ color: g.text }}>{src.label}</span>
                <span>{src.agent}</span>
                <span style={{ marginLeft: 'auto' }}>{src.branch}</span>
            </div>
            <div
                style={{
                    paddingBlock: baseline(3),
                    ...pad,
                    fontFamily: 'PlexMono',
                    fontSize: t.body.size,
                    lineHeight: `${ROW}px`,
                    color: g.dim,
                    whiteSpace: 'pre',
                }}
            >
                {rows.map((line, i) => (
                    <div key={i} style={{ color: line.startsWith('$') ? g.text : g.dim }}>
                        {line || ' '}
                    </div>
                ))}
            </div>
        </div>
    );
};
