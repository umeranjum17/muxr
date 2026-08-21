import React from 'react';
import { Composition } from 'remotion';
import { Reel, reelDuration } from './Reel';
import { ShotSpec } from './Shot';
import { fontsReady } from './theme';
import { reel, scenes } from '../../lib/scenes.mjs';

void fontsReady;

const shots: ShotSpec[] = scenes
    .filter((scene) => scene.reel)
    .sort((a, b) => a.reel.order - b.reel.order)
    .map((scene) => ({
        id: scene.id,
        kicker: scene.reel.kicker,
        headline: scene.reel.headline,
        body: scene.reel.body,
        startFrom: scene.reel.startFrom ?? 0,
    }));

const props = {
    shots,
    tagline: reel.tagline,
    install: reel.install,
    site: reel.site,
    note: reel.note,
};

const duration = reelDuration(shots.length);

// The README animation has to stay small enough to sit in a git repo, so it
// runs the three strongest shots at roughly half length.
const loopShots = shots.slice(0, 3);
const loopTiming = { title: 44, shot: 92, end: 66, transition: 12 };

export const RemotionRoot: React.FC = () => (
    <>
        <Composition
            id="Reel"
            component={Reel}
            durationInFrames={duration}
            fps={30}
            width={1920}
            height={1080}
            defaultProps={props}
        />
        <Composition
            id="ReelVertical"
            component={Reel}
            durationInFrames={duration}
            fps={30}
            width={1080}
            height={1920}
            defaultProps={props}
        />
        {/* Short, wide, and light enough to inline in the README as an animation. */}
        <Composition
            id="ReelLoop"
            component={Reel}
            durationInFrames={reelDuration(loopShots.length, loopTiming)}
            fps={24}
            width={1280}
            height={720}
            defaultProps={{ ...props, shots: loopShots, timing: loopTiming }}
        />
    </>
);
