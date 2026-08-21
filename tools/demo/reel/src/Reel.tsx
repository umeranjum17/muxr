import React from 'react';
import { AbsoluteFill } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { Away, Authoring, Diff, End, Files, Herd, Plugins, SelfHosted, Same, Spend, Title, Voice } from './Beats';
import { ink } from './system';

export type Timing = { title: number; beat: number; end: number; transition: number };

/** Order is the argument: what it is, that it is the same pane, then what you
 *  can do with it, then that it is yours. */
const BEATS = [Herd, Same, Voice, Diff, Files, Spend, Plugins, Authoring, SelfHosted, Away];

export const reelDuration = (t: Timing, pick?: number[]) => {
    const n = pick?.length ?? BEATS.length;
    return t.title + n * t.beat + t.end - (n + 1) * t.transition;
};

export type ReelProps = {
    tagline: string;
    install: string;
    site: string;
    note: string;
    timing: Timing;
    /** Beat indices, for the shorter cut the README embeds. */
    pick?: number[];
};

// Cuts are short fades. Each beat already moves — its layers drift on their own
// depth — so an edit that moves as well reads as a template.
export const Reel: React.FC<ReelProps> = ({ tagline, install, site, note, timing, pick }) => {
    const beats = pick === undefined ? BEATS : pick.map((i) => BEATS[i]!);
    return (
    <AbsoluteFill style={{ backgroundColor: ink }}>
        <TransitionSeries>
            <TransitionSeries.Sequence durationInFrames={timing.title}>
                <Title total={timing.title} tagline={tagline} />
            </TransitionSeries.Sequence>

            {beats.flatMap((BeatComponent, i) => [
                <TransitionSeries.Transition
                    key={`t-${i}`}
                    presentation={fade()}
                    timing={linearTiming({ durationInFrames: timing.transition })}
                />,
                <TransitionSeries.Sequence key={`b-${i}`} durationInFrames={timing.beat}>
                    <BeatComponent total={timing.beat} index={i} />
                </TransitionSeries.Sequence>,
            ])}

            <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({ durationInFrames: timing.transition })}
            />
            <TransitionSeries.Sequence durationInFrames={timing.end}>
                <End total={timing.end} install={install} site={site} note={note} />
            </TransitionSeries.Sequence>
        </TransitionSeries>
    </AbsoluteFill>
    );
};
