import React from 'react';
import { Composition } from 'remotion';
import { FilmFrame } from './Film';
import { Reel, REEL_FRAMES } from './Reel';
import { StoreFrame } from './Store';
import { fontsReady } from './theme';

void fontsReady;

export const RemotionRoot: React.FC = () => (
    <>
        <Composition
            id="Reel"
            component={Reel}
            durationInFrames={REEL_FRAMES}
            fps={30}
            width={1920}
            height={1080}
        />
        <Composition
            id="FilmFrame"
            component={FilmFrame}
            durationInFrames={1}
            fps={30}
            width={1920}
            height={1080}
            defaultProps={{ beat: 'herd' }}
        />
        <Composition
            id="StoreFrame"
            component={StoreFrame}
            durationInFrames={1}
            fps={30}
            width={1080}
            height={1920}
            defaultProps={{ shot: 'herd' }}
        />
    </>
);
