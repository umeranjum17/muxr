import React from 'react';
import { Composition } from 'remotion';
import { Reel, reelDuration } from './Reel';
import { StoreFrame } from './StoreFrame';
import { ShotSpec } from './Shot';
import { fontsReady } from './theme';
import { reel, scenes, timing } from '../../lib/scenes.mjs';

void fontsReady;

const shots: ShotSpec[] = scenes
    .filter((scene) => scene.reel)
    .sort((a, b) => a.reel.order - b.reel.order)
    .map((scene) => ({ id: scene.id, ...scene.reel }));

const props = {
    shots,
    tagline: reel.tagline,
    install: reel.install,
    site: reel.site,
    note: reel.note,
    timing,
};

// The README animation has to stay small enough to sit in a git repo, so it
// runs the three strongest shots at roughly half length.
const loopShots = [shots[0], shots[1], shots[6]].filter(Boolean);
const loopTiming = { title: 40, shot: 74, end: 56, transition: 10 };

export const RemotionRoot: React.FC = () => (
    <>
        <Composition
            id="Reel"
            component={Reel}
            durationInFrames={reelDuration(shots.length, timing)}
            fps={30}
            width={1920}
            height={1080}
            defaultProps={props}
        />
        <Composition
            id="ReelVertical"
            component={Reel}
            durationInFrames={reelDuration(shots.length, timing)}
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
            durationInFrames={reelDuration(loopShots.length, loopTiming)}
            fps={24}
            width={1280}
            height={720}
            defaultProps={{ ...props, shots: loopShots, timing: loopTiming }}
        />
    </>
);
