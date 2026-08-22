import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { cameraAt, translationOf } from './camera';
import { BEATS, FPS, starts } from './config';
import { Ground, Grain } from './Ground';
import { DeskPanel, PhonePanel } from './panels';
import { BeatText, Counter, EndCard } from './type';

/**
 * The film. One world, one camera, two screens, and the script beside the
 * picture: every line shares the frame with the footage that proves it.
 */
export const Film: React.FC = () => {
    const frame = useCurrentFrame();
    const pose = cameraAt(frame);
    const { tx, ty } = translationOf(pose);

    return (
        <AbsoluteFill style={{ background: '#0a0a0b' }}>
            <Ground />
            <AbsoluteFill style={{
                transform: `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${pose.s.toFixed(4)})`,
                transformOrigin: '0 0',
            }}>
                <DeskPanel dim={1} />
                <PhonePanel dim={1} />
            </AbsoluteFill>
            <Grain />
            {BEATS.filter((beat) => beat.lines.length > 0).map((beat) => (
                <BeatText key={beat.id} beat={beat} at={starts[beat.id]} />
            ))}
            <Counter
                at={starts.wall}
                frames={BEATS.find((b) => b.id === 'wall')!.frames}
                seconds={(f) => 38 + (f - starts.wall) / FPS}
            />
            <EndCard at={starts.end} />
        </AbsoluteFill>
    );
};
