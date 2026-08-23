import React from 'react';
import { Composition } from 'remotion';
import { Film } from './Film';
import { FPS, H, TOTAL, W } from './config';
import {
    ChangesStory,
    ConnectionStory,
    HerdStory,
    HeroStory,
    InboxStory,
    TerminalStory,
    VoiceStory,
} from './ReadmeStories';

export const Root: React.FC = () => (
    <>
        <Composition id="film" component={Film} durationInFrames={TOTAL}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-hero" component={HeroStory} durationInFrames={600}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-terminal" component={TerminalStory} durationInFrames={360}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-herd" component={HerdStory} durationInFrames={360}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-inbox" component={InboxStory} durationInFrames={360}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-changes" component={ChangesStory} durationInFrames={360}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-voice" component={VoiceStory} durationInFrames={360}
            fps={FPS} width={W} height={H} />
        <Composition id="readme-self-host" component={ConnectionStory} durationInFrames={360}
            fps={FPS} width={W} height={H} />
    </>
);
