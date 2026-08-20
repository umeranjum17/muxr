import * as React from 'react';
import { Canvas, Circle, Group, Path, RadialGradient, Skia, vec } from '@shopify/react-native-skia';
import Animated, {
    cancelAnimation,
    Easing,
    useAnimatedStyle,
    useDerivedValue,
    useReducedMotion,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';
import type { RealtimeSessionState } from './realtimeSessionState';

/**
 * The session as a barred spiral: a bulge for the conversation and two arms of
 * agents sweeping around it. Drawn rather than played back from an animation
 * file, because the same artwork answers for four states at two sizes and only
 * geometry survives being shrunk to the 40pt pill.
 *
 * The arms turn rigidly. Real discs rotate differentially, which would shear
 * them into a smear within a few laps -- correct, and useless as an indicator.
 */

const TWO_PI = Math.PI * 2;
/** Enough tilt to read as depth without going edge-on. */
const TILT = -0.34;
const FLATTEN = 0.4;
const ARMS = 2;
/** How tightly the arms wind. Higher coils them in on themselves. */
const WIND = 2.35;
const R_MIN = 0.1;
const R_MAX = 0.46;

interface Star {
    /** Fraction of the visual's size. */
    radius: number;
    angle: number;
    /** Distance along the arm, 0 at the bulge. */
    along: number;
    dot: number;
    streak: number;
}

/** Deterministic scatter: the arms look populated, not drawn with a compass. */
function scatter(index: number): number {
    return ((Math.sin((index + 1) * 12.9898) * 43758.5453) % 1 + 1) % 1;
}

function armAngle(radius: number, arm: number): number {
    return arm * (TWO_PI / ARMS) + WIND * Math.log(radius / R_MIN);
}

function buildStars(count: number): Star[] {
    const stars: Star[] = [];
    for (let index = 0; index < count; index += 1) {
        const along = (index + 0.5) / count;
        const radius = R_MIN + (R_MAX - R_MIN) * Math.pow(along, 0.78);
        const spread = (scatter(index) - 0.5) * 0.42 * (0.35 + along);
        stars.push({
            radius,
            angle: armAngle(radius, index % ARMS) + spread,
            along,
            dot: 0.011 - along * 0.005,
            streak: 0.1 + along * 0.16,
        });
    }
    return stars;
}

const STARS = buildStars(46);
const INNER = STARS.filter((star) => star.along < 0.45);
const OUTER = STARS.filter((star) => star.along >= 0.45);
/** Static backdrop; only the disc turns. */
const FIELD = Array.from({ length: 26 }, (_, index) => ({
    angle: scatter(index + 3) * TWO_PI,
    radius: 0.3 + scatter(index + 9) * 0.19,
    alpha: 0.4 + scatter(index + 3),
}));

function streakPath(stars: Star[], turns: number, half: number, size: number) {
    'worklet';
    const path = Skia.Path.Make();
    const turn = turns * TWO_PI;
    for (const star of stars) {
        const angle = star.angle + turn;
        const tail = angle + star.streak * 0.5;
        path.moveTo(half + Math.cos(angle) * star.radius * size, half + Math.sin(angle) * star.radius * size * FLATTEN);
        path.lineTo(half + Math.cos(tail) * star.radius * size, half + Math.sin(tail) * star.radius * size * FLATTEN);
    }
    return path;
}

function dotPath(stars: Star[], turns: number, half: number, size: number) {
    'worklet';
    const path = Skia.Path.Make();
    const turn = turns * TWO_PI;
    for (const star of stars) {
        const angle = star.angle + turn;
        path.addCircle(
            half + Math.cos(angle) * star.radius * size,
            half + Math.sin(angle) * star.radius * size * FLATTEN,
            // Floored: at the pill an unclamped dot rounds away to nothing.
            Math.max(0.5, star.dot * size),
        );
    }
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
    const phase = useSharedValue(0.35);
    const spin = useSharedValue(0);
    const active = !muted && (state === 'speaking' || state === 'thinking' || state === 'connecting');
    const half = size / 2;

    React.useEffect(() => {
        if (reduceMotion) {
            phase.value = 0.5;
            return;
        }
        phase.value = withRepeat(withTiming(1, { duration: state === 'speaking' ? 700 : 1800 }), -1, true);
        return () => cancelAnimation(phase);
    }, [phase, reduceMotion, state]);

    React.useEffect(() => {
        if (reduceMotion) {
            spin.value = 0.12;
            return;
        }
        // Muted still turns, slowly: a frozen disc reads as a hung session.
        const duration = muted ? 40_000
            : state === 'speaking' ? 9_000
            : state === 'thinking' || state === 'connecting' ? 15_000
            : 26_000;
        spin.value = 0;
        spin.value = withRepeat(withTiming(1, { duration, easing: Easing.linear }), -1, false);
        return () => cancelAnimation(spin);
    }, [muted, reduceMotion, spin, state]);

    const breathe = useAnimatedStyle(() => ({
        transform: reduceMotion ? [] : [{ scale: 0.97 + phase.value * 0.03 }],
    }));

    // Tapered ribbons, built as filled outlines: a stroked path is one width for
    // its whole length, and a lane that never thins reads as a painted stripe.
    const dustPath = useDerivedValue(() => {
        const path = Skia.Path.Make();
        const turn = spin.value * TWO_PI;
        for (let arm = 0; arm < ARMS; arm += 1) {
            const left: number[] = [];
            const right: number[] = [];
            for (let step = 0; step <= 40; step += 1) {
                const along = step / 40;
                const radius = R_MIN + (R_MAX - R_MIN) * Math.pow(along, 0.78);
                const angle = arm * (TWO_PI / ARMS) + WIND * Math.log(radius / R_MIN) + turn;
                const width = size * (0.048 - along * 0.031);
                const x = half + Math.cos(angle) * radius * size;
                const y = half + Math.sin(angle) * radius * size * FLATTEN;
                // Widen across the lane, not along it.
                left.push(x, y - width);
                right.push(x, y + width);
            }
            path.moveTo(left[0] as number, left[1] as number);
            for (let index = 2; index < left.length; index += 2) path.lineTo(left[index] as number, left[index + 1] as number);
            for (let index = right.length - 2; index >= 0; index -= 2) path.lineTo(right[index] as number, right[index + 1] as number);
            path.close();
        }
        return path;
    });

    const innerStreaks = useDerivedValue(() => streakPath(INNER, spin.value, half, size));
    const outerStreaks = useDerivedValue(() => streakPath(OUTER, spin.value, half, size));
    const innerDots = useDerivedValue(() => dotPath(INNER, spin.value, half, size));
    const outerDots = useDerivedValue(() => dotPath(OUTER, spin.value, half, size));

    const fieldPath = React.useMemo(() => {
        const path = Skia.Path.Make();
        for (const star of FIELD) {
            path.addCircle(
                half + Math.cos(star.angle) * star.radius * size,
                half + Math.sin(star.angle) * star.radius * size,
                Math.max(0.4, size * 0.0045),
            );
        }
        return path;
    }, [half, size]);

    const palette = muted
        ? { field: '#1c1416', arm: '#7a4550', core: '#f0cdd2', star: '#e8b6bc' }
        : state === 'speaking'
          ? { field: '#0f1826', arm: '#4a76c8', core: '#eaf2ff', star: '#d8e8ff' }
          : state === 'thinking' || state === 'connecting'
            ? { field: '#151425', arm: '#5b57a8', core: '#efeaff', star: '#ddd6ff' }
            : { field: '#0e1a17', arm: '#3f7d6c', core: '#e6fff5', star: '#d6f4e6' };
    const label = muted
        ? 'Realtime session indicator, microphone muted'
        : state === 'speaking'
          ? 'Realtime session indicator, speaking'
          : state === 'thinking' || state === 'connecting'
            ? 'Realtime session indicator, thinking'
            : 'Realtime session indicator, listening';
    const bulge = size * (active ? 0.2 : 0.16);

    return (
        <Animated.View
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
            style={[
                {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    overflow: 'hidden',
                    backgroundColor: '#07080a',
                    elevation: Math.round(size * 0.05),
                },
                breathe,
            ]}
        >
            <Canvas style={{ width: size, height: size }}>
                {/* Near-black field, so the arms stay the brightest thing in it. */}
                <Circle cx={half} cy={half} r={size * 0.5}>
                    <RadialGradient c={vec(half, half * 1.05)} r={size * 0.55} colors={[palette.field, '#080a0d', '#06070a']} />
                </Circle>

                <Path path={fieldPath} color="#ffffff" opacity={muted ? 0.1 : 0.22} />

                <Group transform={[{ rotate: TILT }]} origin={vec(half, half)}>
                    <Path path={dustPath} color={palette.arm} opacity={muted ? 0.1 : 0.22} />
                    <Path path={outerStreaks} color={palette.star} style="stroke" strokeWidth={Math.max(0.6, size * 0.007)} strokeCap="round" opacity={muted ? 0.14 : 0.34} />
                    <Path path={innerStreaks} color={palette.star} style="stroke" strokeWidth={Math.max(0.7, size * 0.011)} strokeCap="round" opacity={muted ? 0.2 : 0.48} />
                    <Path path={outerDots} color={palette.star} opacity={muted ? 0.26 : 0.62} />
                    <Path path={innerDots} color={palette.star} opacity={muted ? 0.35 : 0.95} />
                </Group>

                {/* Bulge, flattened with the disc rather than pasted on as a ball. */}
                <Group transform={[{ rotate: TILT }, { scaleY: 0.62 }]} origin={vec(half, half)}>
                    <Circle cx={half} cy={half} r={bulge} opacity={muted ? 0.75 : 1}>
                        <RadialGradient c={vec(half, half)} r={bulge} colors={[palette.core, palette.arm, 'rgba(0,0,0,0)']} />
                    </Circle>
                </Group>

                {/* Rim: puts the disc inside a sphere. */}
                <Circle cx={half} cy={half} r={size * 0.49} style="stroke" strokeWidth={size * 0.012}>
                    <RadialGradient c={vec(size * 0.3, size * 0.25)} r={size * 0.8} colors={['rgba(255,255,255,0.2)', 'rgba(255,255,255,0.03)']} />
                </Circle>
            </Canvas>
        </Animated.View>
    );
});
