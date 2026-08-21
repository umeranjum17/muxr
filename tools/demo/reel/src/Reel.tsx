import React from 'react';
import { AbsoluteFill } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { Shot, ShotSpec } from './Shot';
import { EndCard, TitleCard } from './Cards';
import { ink } from './theme';

export type Timing = { title: number; shot: number; end: number; transition: number };

export const reelDuration = (shots: number, t: Timing) =>
    t.title + shots * t.shot + t.end - (shots + 1) * t.transition;

export type ReelProps = {
    shots: ShotSpec[];
    tagline: string;
    install: string;
    site: string;
    note: string;
    timing: Timing;
};

// Cuts are fades, not slides. A film whose shots already move the camera does
// not need the edit to move as well; two motions at once reads as a template.
export const Reel: React.FC<ReelProps> = ({ shots, tagline, install, site, note, timing }) => (
    <AbsoluteFill style={{ backgroundColor: ink }}>
        <TransitionSeries>
            <TransitionSeries.Sequence durationInFrames={timing.title}>
                <TitleCard tagline={tagline} durationInFrames={timing.title} />
            </TransitionSeries.Sequence>

            {shots.flatMap((spec) => [
                <TransitionSeries.Transition
                    key={`t-${spec.id}`}
                    presentation={fade()}
                    timing={linearTiming({ durationInFrames: timing.transition })}
                />,
                <TransitionSeries.Sequence key={spec.id} durationInFrames={timing.shot}>
                    <Shot spec={spec} durationInFrames={timing.shot} />
                </TransitionSeries.Sequence>,
            ])}

            <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({ durationInFrames: timing.transition })}
            />
            <TransitionSeries.Sequence durationInFrames={timing.end}>
                <EndCard install={install} site={site} note={note} />
            </TransitionSeries.Sequence>
        </TransitionSeries>
    </AbsoluteFill>
);
