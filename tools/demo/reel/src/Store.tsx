import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { baseline, col, css, ground, span, store, type as scale } from './design';
import { Headline } from './Headline';
import { STORE } from './beats';

const G = store;

/** The screen starts here and runs to the frame's bottom edge — the box is the
 *  visible band, so the cut is the frame, not a shelf inside it. */
const BOX_TOP = baseline(45);
const BOX_H = baseline(195);

/**
 * A store frame is the same idea as a film frame turned upright: one headline on
 * the grid at the top, the screen cropped by the frame below it. Nothing else —
 * at Play carousel width the whole asset is ~150px across, where a second line
 * of type is a smudge and a 2px outline is a quarter of a pixel.
 */
export const StoreFrame: React.FC<{ shot: string }> = ({ shot: id }) => {
    const s = STORE.find((x) => x.id === id) ?? STORE[0];
    const g = ground[s.ground];
    const t = scale.store;

    return (
        <AbsoluteFill style={{ background: g.bg }}>
            <div style={{ position: 'absolute', left: col(G, 1), top: G.margin, width: span(G, 6) }}>
                <Headline text={s.headline} color={g.text} kind="store" />
            </div>
            <div style={{ position: 'absolute', left: col(G, 1), top: BOX_TOP, width: span(G, 6), height: BOX_H }}>
                <Img
                    src={staticFile(`stills/${s.capture}/${s.id}.png`)}
                    style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        // Which band of the capture the frame shows. Chosen per
                        // shot so the bottom edge falls between rows instead of
                        // through one.
                        objectPosition: `50% ${s.crop ?? 50}%`,
                    }}
                />
            </div>
        </AbsoluteFill>
    );
};
