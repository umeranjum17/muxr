import React from 'react';
import { Composition } from 'remotion';
import { Reel, reelDuration } from './Reel';
import { StoreFrame } from './StoreFrame';
import { fontsReady } from './theme';
import { reel, timing } from '../../lib/scenes.mjs';

void fontsReady;

/** The README animation runs the three strongest beats at a shorter cadence. */
const loopTiming = { title: 44, beat: 66, end: 56, transition: 9 };
/** Herd, voice, away — what it is, what only it does, and why you would leave. */
const loopPick = [0, 2, 9];

const props = {
    tagline: reel.tagline,
    install: reel.install,
    site: reel.site,
    note: reel.note,
    timing,
};


export const RemotionRoot: React.FC = () => (
    <>
        <Composition
            id="Reel"
            component={Reel}
            durationInFrames={reelDuration(timing)}
            fps={30}
            width={1920}
            height={1080}
            defaultProps={props}
        />
        <Composition
            id="ReelVertical"
            component={Reel}
            durationInFrames={reelDuration(timing)}
            fps={30}
            width={1080}
            height={1920}
            defaultProps={props}
        />
        {/* One Play Store screenshot, rendered on the film's stage. Driven per
            scene from the command line with --props. */}
        <Composition
            id="StoreFrame"
            component={StoreFrame}
            durationInFrames={1}
            fps={30}
            width={1080}
            height={1920}
            defaultProps={{ id: 'herd', theme: 'dark' as const, caption: 'Every agent, one screen.', sub: '' }}
        />
        <Composition
            id="ReelLoop"
            component={Reel}
            durationInFrames={reelDuration(loopTiming, loopPick)}
            fps={24}
            width={1280}
            height={720}
            defaultProps={{ ...props, timing: loopTiming, pick: loopPick }}
        />
    </>
);
