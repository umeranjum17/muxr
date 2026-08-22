import React from 'react';
import { Composition } from 'remotion';
import { Film } from './Film';
import { FPS, H, TOTAL, W } from './config';

export const Root: React.FC = () => (
    <Composition id="film" component={Film} durationInFrames={TOTAL}
        fps={FPS} width={W} height={H} />
);
