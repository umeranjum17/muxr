import * as React from 'react';
import { Blur, Canvas, Circle, Group, Path, RadialGradient, Skia, vec } from '@shopify/react-native-skia';
import {
    cancelAnimation,
    Easing,
    useDerivedValue,
    useFrameCallback,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import { readEnergy } from './audioEnergy';
import type { RealtimeSessionState } from './realtimeSessionState';

/**
 * The conversation, drawn as the sound of itself.
 *
 * A polar waveform: one closed contour whose radius at each angle is the sum of
 * a few harmonics, and whose amplitude is the loudness of whoever is currently
 * talking. Silence leaves a circle breathing slowly; a voice pushes it out of
 * round, and the deformation lands on the syllable rather than on a timer, which
 * is the whole difference between something that is animating and something that
 * is listening.
 *
 * Direction carries meaning. What you say pulls inward, what it says radiates
 * outward, so the same shape tells you who holds the floor without a label.
 *
 * Three contours ride slightly different phases and alphas: one shape reads as
 * a line drawing, three read as a volume with a near and a far side. Colour is
 * the app's accent alone -- a spectrum here would be the one place the whole
 * interface breaks its own rule.
 */

const TWO_PI = Math.PI * 2;
/** Enough points that the curve reads as smooth, few enough to build per frame. */
const POINTS = 72;
const CONTOURS = [
    { scale: 1, alpha: 1, phase: 0, harmonic: 3 },
    { scale: 0.86, alpha: 0.5, phase: 1.9, harmonic: 4 },
    { scale: 0.72, alpha: 0.28, phase: 3.7, harmonic: 5 },
] as const;

/**
 * Radius at one angle: a base circle plus two harmonics that beat against each
 * other, so the shape never repeats on a short loop the way a single sine does.
 */
function contourPath(size: number, base: number, amplitude: number, turn: number, harmonic: number, inward: number) {
    'worklet';
    const half = size / 2;
    const path = Skia.Path.Make();
    for (let index = 0; index <= POINTS; index += 1) {
        const angle = (index / POINTS) * TWO_PI;
        const wave = Math.sin(angle * harmonic + turn) * 0.6 + Math.sin(angle * (harmonic + 2) - turn * 1.3) * 0.4;
        // Inward pull for the user's voice, outward push for the agent's.
        const radius = half * (base + wave * amplitude * inward);
        const x = half + Math.cos(angle) * radius;
        const y = half + Math.sin(angle) * radius;
        if (index === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
    }
    path.close();
    return path;
}

export const RealtimeSessionVisual = React.memo(function RealtimeSessionVisual({
    size,
    state,
    muted,
}: {
    size: number;
    state: RealtimeSessionState;
    muted: boolean;
}) {
    const reduceMotion = useReducedMotion();
    const half = size / 2;
    const turn = useSharedValue(0);
    const breath = useSharedValue(0);
    /** Smoothed loudness, and which way the conversation is flowing. */
    const energy = useSharedValue(0);
    const flow = useSharedValue(0);
    const live = state !== 'disconnected';

    React.useEffect(() => {
        if (reduceMotion || !live) {
            turn.value = 0;
            return;
        }
        // One slow revolution keeps the harmonics from standing still in silence.
        turn.value = withRepeat(withTiming(TWO_PI, { duration: 9_000, easing: Easing.linear }), -1, false);
        return () => cancelAnimation(turn);
    }, [live, reduceMotion, turn]);

    React.useEffect(() => {
        if (reduceMotion || !live) {
            breath.value = 0.5;
            return;
        }
        breath.value = withRepeat(withTiming(1, { duration: 2_600, easing: Easing.inOut(Easing.ease) }), -1, true);
        return () => cancelAnimation(breath);
    }, [breath, live, reduceMotion]);

    // Read loudness on the UI thread every frame, then chase it: attack fast so a
    // consonant is not missed, release slow so the shape falls instead of snapping.
    const frame = useFrameCallback(() => {
        'worklet';
        const target = muted ? 0 : Math.max(readEnergy('input'), readEnergy('output'));
        energy.value += (target - energy.value) * (target > energy.value ? 0.45 : 0.08);
        const direction = readEnergy('output') > readEnergy('input') ? 1 : -1;
        flow.value += (direction - flow.value) * 0.06;
    }, false);
    React.useEffect(() => {
        frame.setActive(live && !reduceMotion);
        return () => frame.setActive(false);
    }, [frame, live, reduceMotion]);

    const amplitude = useDerivedValue(() => {
        const idle = 0.02 + breath.value * 0.012;
        return idle + energy.value * 0.16;
    });
    const outer = useDerivedValue(() => contourPath(size, 0.62 + breath.value * 0.02, amplitude.value, turn.value, CONTOURS[0].harmonic, flow.value >= 0 ? 1 : -1));
    const middle = useDerivedValue(() => contourPath(size * CONTOURS[1].scale, 0.62, amplitude.value * 0.8, turn.value + CONTOURS[1].phase, CONTOURS[1].harmonic, flow.value >= 0 ? 1 : -1));
    const inner = useDerivedValue(() => contourPath(size * CONTOURS[2].scale, 0.62, amplitude.value * 0.6, turn.value + CONTOURS[2].phase, CONTOURS[2].harmonic, flow.value >= 0 ? 1 : -1));
    /** The core is the only thing that brightens: it is where the voice is. */
    const coreRadius = useDerivedValue(() => half * (0.16 + energy.value * 0.1));
    const stroke = Math.max(1, size * 0.012);

    const tint = muted ? '#8a8a8f' : '#ffffff';
    const offsets = [(size - size * CONTOURS[1].scale) / 2, (size - size * CONTOURS[2].scale) / 2];

    return (
        <Canvas style={{ width: size, height: size }}>
            {/* Bloom first, so the contours sit in their own light. */}
            <Group opacity={live ? 0.5 : 0.25}>
                <Circle cx={half} cy={half} r={half * 0.52}>
                    <RadialGradient c={vec(half, half)} r={half * 0.9} colors={[tint, 'transparent']} positions={[0, 1]} />
                </Circle>
                <Blur blur={size * 0.06} />
            </Group>
            <Group opacity={live ? 1 : 0.4}>
                <Path path={inner} style="stroke" strokeWidth={stroke} color={tint} opacity={CONTOURS[2].alpha}
                    transform={[{ translateX: offsets[1]! }, { translateY: offsets[1]! }]} />
                <Path path={middle} style="stroke" strokeWidth={stroke} color={tint} opacity={CONTOURS[1].alpha}
                    transform={[{ translateX: offsets[0]! }, { translateY: offsets[0]! }]} />
                <Path path={outer} style="stroke" strokeWidth={stroke} color={tint} opacity={CONTOURS[0].alpha} />
            </Group>
            <Circle cx={half} cy={half} r={coreRadius} color={tint} opacity={live ? 0.95 : 0.5} />
        </Canvas>
    );
});
