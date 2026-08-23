import React from 'react';
import { Composition, Sequence } from 'remotion';
import { Film } from './Film';
import { FPS, H, TOTAL, W, starts } from './config';

const Clip: React.FC<{ start: number }> = ({ start }) => (
    <Sequence from={-start}>
        <Film />
    </Sequence>
);

export const Root: React.FC = () => (
    <>
        <Composition id="film" component={Film} durationInFrames={TOTAL}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-hero" component={Clip} durationInFrames={540}
            fps={FPS} width={W} height={H} defaultProps={{ start: starts.approval }} />
        <Composition id="readme-unblock" component={Clip} durationInFrames={480}
            fps={FPS} width={W} height={H} defaultProps={{ start: starts.approval }} />
        <Composition id="readme-changes" component={Clip} durationInFrames={232}
            fps={FPS} width={W} height={H} defaultProps={{ start: starts.diffs + 8 }} />
        <Composition id="readme-voice" component={Clip} durationInFrames={262}
            fps={FPS} width={W} height={H} defaultProps={{ start: starts.voice + 8 }} />
        <Composition id="readme-self-host" component={Clip} durationInFrames={262}
            fps={FPS} width={W} height={H} defaultProps={{ start: starts.relay + 8 }} />
    </>
);
