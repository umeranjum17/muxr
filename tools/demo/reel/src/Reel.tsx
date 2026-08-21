import React from 'react';
import { AbsoluteFill } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { slide } from '@remotion/transitions/slide';
import { fade } from '@remotion/transitions/fade';
import { Shot, ShotSpec } from './Shot';
import { EndCard, TitleCard } from './Cards';
import { ink } from './theme';

export const TITLE_FRAMES = 78;
export const SHOT_FRAMES = 180;
export const END_FRAMES = 138;
export const TRANSITION_FRAMES = 18;

export type Timing = {
    title: number;
    shot: number;
    end: number;
    transition: number;
};

export const defaultTiming: Timing = {
    title: TITLE_FRAMES,
    shot: SHOT_FRAMES,
    end: END_FRAMES,
    transition: TRANSITION_FRAMES,
};

export const reelDuration = (shots: number, timing: Timing = defaultTiming) =>
    timing.title + shots * timing.shot + timing.end - (shots + 1) * timing.transition;

export type ReelProps = {
    shots: ShotSpec[];
    tagline: string;
    install: string;
    site: string;
    note: string;
    timing?: Timing;
};

export const Reel: React.FC<ReelProps> = ({ shots, tagline, install, site, note, timing = defaultTiming }) => (
    <AbsoluteFill style={{ backgroundColor: ink }}>
        <TransitionSeries>
            <TransitionSeries.Sequence durationInFrames={timing.title}>
                <TitleCard tagline={tagline} />
            </TransitionSeries.Sequence>

            {shots.flatMap((spec, i) => [
                <TransitionSeries.Transition
                    key={`t-${spec.id}`}
                    presentation={i % 2 === 0 ? slide({ direction: 'from-right' }) : fade()}
                    timing={linearTiming({ durationInFrames: timing.transition })}
                />,
                <TransitionSeries.Sequence key={spec.id} durationInFrames={timing.shot}>
                    <Shot spec={spec} />
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
