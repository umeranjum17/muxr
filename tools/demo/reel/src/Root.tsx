import React from 'react';
import { Composition } from 'remotion';
import { Film } from './Film';
import { FPS, H, TOTAL, W, starts } from './config';
import { PhoneScreen } from './screens';

const Phone: React.FC = () => <PhoneScreen tapAt={starts.approval + 120} />;

export const Root: React.FC = () => (
    <>
        <Composition id="film" component={Film} durationInFrames={TOTAL}
            fps={FPS} width={W} height={H} />
        <Composition id="phone" component={Phone} durationInFrames={TOTAL}
            fps={FPS} width={403} height={896} />
    </>
);
