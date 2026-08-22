import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { cameraAt, translationOf } from './camera';
import { ACTS, AT, FPS, TOKENS, starts } from './config';
import { Ground, Grain } from './Ground';
import { DeskPanel, PhonePanel, cardDim } from './panels';
import { Caption, Counter, EndCard } from './type';

const CARDS = ACTS.filter((act) => act.kind === 'card')
    .map((act) => ({ ...act, at: starts[act.id] }));

/**
 * The film. One world, one camera, two screens, seven sentences.
 *
 * Everything inside the camera is world space; captions ride a ground plane
 * at 0.85x the camera's translation; grain and the end card live on the
 * glass. The footage is the take, untouched — the composition is the only
 * thing that is new.
 */
export const Film: React.FC = () => {
    const frame = useCurrentFrame();
    const pose = cameraAt(frame);
    const { tx, ty } = translationOf(pose);
    const dim = cardDim(frame, CARDS);

    return (
        <AbsoluteFill style={{ background: '#0a0a0b' }}>
            <Ground />
            <AbsoluteFill style={{
                transform: `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${pose.s.toFixed(4)})`,
                transformOrigin: '0 0',
            }}>
                <DeskPanel dim={dim} />
                <PhonePanel dim={dim} />
                <Counter
                    at={starts.waiting}
                    frames={ACTS.find((a) => a.id === 'waiting')!.frames}
                    seconds={(f) => AT.waiting + (f - starts.waiting) / FPS - AT.approvalUp}
                />
            </AbsoluteFill>
            <Grain />
            {CARDS.map((card) => {
                const atStart = translationOf(cameraAt(card.at));
                // The ground-plane drift, clamped: on a big glide the raw
                // fifteen percent walks the sentence into a corner.
                const clamp = (v: number) => Math.max(-44, Math.min(44, v));
                return (
                    <Caption
                        key={card.id}
                        text={card.text}
                        at={card.at}
                        frames={card.frames}
                        parallax={{
                            dx: clamp((tx - atStart.tx) * (1 - TOKENS.caption.parallax)),
                            dy: clamp((ty - atStart.ty) * (1 - TOKENS.caption.parallax)),
                        }}
                    />
                );
            })}
            <EndCard at={starts.end} />
        </AbsoluteFill>
    );
};
