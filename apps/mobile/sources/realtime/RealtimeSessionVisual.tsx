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
 * A cloud of dust with a light in the middle of it.
 *
 * Depth is the whole trick. The dust sits on a tilted disc, and where a mote is
 * in its orbit decides how bright and how large it draws: the near side of the
 * disc is close to you and catches the light, the far side is behind the core
 * and nearly gone. Three bands, three opacities, three draw calls -- enough for
 * an eye to read volume, cheap enough to build every frame on a phone.
 *
 * The dust orbits differentially, inner motes faster, the way anything held by
 * a central mass does. On spiral arms that shear is a bug, because arms smear
 * into a smudge within a few laps. On dust the smear is the point: the cloud
 * never repeats and never looks drawn with a compass.
 *
 * Voice moves it. Loudness lifts the motes off their radius and brightens the
 * core, and the direction of the conversation decides which way they go: what
 * it says pushes the cloud outward, what you say draws it in. Silence lets the
 * drag pull everything home.
 *
 * Monochrome, because the light is one light.
 */

const TWO_PI = Math.PI * 2;
/** Tilt reads as a disc; edge-on reads as a line and flat reads as a target. */
const FLATTEN = 0.46;
const MOTES = 260;
const R_MIN = 0.15;
const R_MAX = 0.47;

interface Mote {
    radius: number;
    angle: number;
    /** Inner dust laps the outer dust, as it must. */
    speed: number;
    size: number;
    twinkle: number;
    /** Fixed vertical offset so the cloud has thickness, not just a ring. */
    lift: number;
}

/** Deterministic scatter: populated, not random per launch. */
function scatter(index: number, salt: number): number {
    return ((Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453) % 1 + 1) % 1;
}

const DUST: Mote[] = Array.from({ length: MOTES }, (_, index) => {
    // Dense at the core, thin at the rim: what a bound cloud looks like. A
    // uniform draw looks like a sprayed ring.
    const radius = R_MIN + (R_MAX - R_MIN) * Math.pow(scatter(index, 1), 0.62);
    // Mostly specks, a few bright ones. Equal-sized dust is confetti.
    const grade = Math.pow(scatter(index, 3), 3.2);
    return {
        radius,
        angle: scatter(index, 2) * TWO_PI,
        speed: 0.6 / Math.pow(radius / R_MIN, 0.72),
        size: 0.0018 + grade * 0.0062,
        twinkle: scatter(index, 4) * TWO_PI,
        // Thickness, so the cloud is a lens rather than a hoop: without it the
        // near side of the orbit piles into a crescent along the bottom.
        lift: (scatter(index, 5) - 0.5) * 0.55,
    };
});

/** Still stars behind the cloud: without a fixed field, nothing has parallax. */
const FIELD = Array.from({ length: 22 }, (_, index) => ({
    x: scatter(index, 6),
    y: scatter(index, 7),
    size: 0.0028 + scatter(index, 8) * 0.0035,
    twinkle: scatter(index, 9) * TWO_PI,
}));

/**
 * One depth band as a single path. `band` picks the slice of the orbit facing
 * the viewer: 1 is the near edge, -1 the far one.
 */
function dustPath(size: number, turn: number, breath: number, band: number, spread: number) {
    'worklet';
    const half = size / 2;
    const path = Skia.Path.Make();
    // At pill size every second mote lands on the same pixel as its neighbour
    // and the cloud turns to static, so the small one carries fewer, bigger dust.
    const step = size < 90 ? 6 : 1;
    const swell = size < 90 ? 3.1 : 1;
    for (let index = 0; index < DUST.length; index += step) {
        const mote = DUST[index]!;
        const angle = mote.angle + turn * mote.speed;
        const depth = Math.sin(angle);
        // How lit a mote is: partly how near it is to you, partly how near it is
        // to the light. Depth alone piles every bright speck along the near edge
        // and leaves the middle of the cloud dead.
        const lit = depth * 0.32 + (1 - (mote.radius - R_MIN) / (R_MAX - R_MIN)) * 0.68;
        const near = lit > 0.42 ? 2 : lit > 0.1 ? 1 : lit > -0.28 ? 0 : -1;
        if (near !== band) continue;
        const radius = mote.radius * spread;
        const twinkle = 0.75 + 0.25 * Math.sin(breath * TWO_PI + mote.twinkle);
        const scale = (1 + depth * 0.28) * swell;
        const dot = Math.max(0.45, mote.size * size * scale * twinkle);
        const x = half + Math.cos(angle) * radius * size;
        const y = half + (Math.sin(angle) * FLATTEN + mote.lift) * radius * size;
        path.addCircle(x, y, dot);
        // The inner dust is the fast dust, so only it earns a trail; a streak on
        // everything reads as rain rather than orbit.
        if (mote.speed > 1.15 && size >= 90) {
            const tail = angle - 0.16 * mote.speed;
            const tx = half + Math.cos(tail) * radius * size;
            const ty = half + (Math.sin(tail) * FLATTEN + mote.lift) * radius * size;
            path.moveTo(x, y);
            path.lineTo(tx, ty);
        }
    }
    return path;
}



function fieldPath(size: number, breath: number) {
    'worklet';
    const path = Skia.Path.Make();
    for (let index = 0; index < FIELD.length; index += 1) {
        const star = FIELD[index]!;
        const twinkle = 0.5 + 0.5 * Math.sin(breath * TWO_PI * 0.7 + star.twinkle);
        path.addCircle(star.x * size, star.y * size, Math.max(0.35, star.size * size * twinkle));
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
    const half = size / 2;
    const turn = useSharedValue(0);
    const breath = useSharedValue(0);
    const energy = useSharedValue(0);
    const flow = useSharedValue(0);
    const live = state !== 'disconnected';

    React.useEffect(() => {
        if (reduceMotion) {
            turn.value = 0.6;
            return;
        }
        // Long lap: a cloud that hurries reads as a spinner, and a spinner is a
        // thing that is waiting rather than a thing that is alive.
        turn.value = withRepeat(withTiming(TWO_PI, { duration: live ? 26_000 : 60_000, easing: Easing.linear }), -1, false);
        return () => cancelAnimation(turn);
    }, [live, reduceMotion, turn]);

    React.useEffect(() => {
        if (reduceMotion) {
            breath.value = 0.5;
            return;
        }
        breath.value = withRepeat(withTiming(1, { duration: 3_400, easing: Easing.inOut(Easing.ease) }), -1, true);
        return () => cancelAnimation(breath);
    }, [breath, live, reduceMotion]);

    // Loudness read on the UI thread: attack fast so a consonant lands, release
    // slow so the cloud falls back instead of snapping.
    const frame = useFrameCallback(() => {
        'worklet';
        const heard = readEnergy('input');
        const said = readEnergy('output');
        const target = muted ? 0 : Math.max(heard, said);
        energy.value += (target - energy.value) * (target > energy.value ? 0.4 : 0.06);
        flow.value += ((said >= heard ? 1 : -1) - flow.value) * 0.05;
    }, false);
    React.useEffect(() => {
        frame.setActive(live && !reduceMotion);
        return () => frame.setActive(false);
    }, [frame, live, reduceMotion]);

    /** Its voice pushes the cloud out; yours draws it in. */
    const spread = useDerivedValue(() => 1 + energy.value * 0.3 * (flow.value >= 0 ? 1 : -0.55) + Math.sin(breath.value * TWO_PI) * 0.012);
    const nearest = useDerivedValue(() => dustPath(size, turn.value, breath.value, 2, spread.value));
    const near = useDerivedValue(() => dustPath(size, turn.value, breath.value, 1, spread.value));
    const mid = useDerivedValue(() => dustPath(size, turn.value, breath.value, 0, spread.value));
    const far = useDerivedValue(() => dustPath(size, turn.value, breath.value, -1, spread.value));
    const stars = useDerivedValue(() => fieldPath(size, breath.value));
    const coreRadius = useDerivedValue(() => half * (0.03 + energy.value * 0.03));
    const spikes = useDerivedValue(() => {
        const reach = half * (0.16 + energy.value * 0.22);
        const path = Skia.Path.Make();
        path.moveTo(half - reach, half);
        path.lineTo(half + reach, half);
        path.moveTo(half, half - reach * 0.62);
        path.lineTo(half, half + reach * 0.62);
        return path;
    });
    const glowOpacity = useDerivedValue(() => (live ? 0.34 + energy.value * 0.4 : 0.14));

    const stroke = Math.max(0.5, size * 0.0045);
    const tint = muted ? '#9aa0a8' : '#ffffff';

    return (
        <Canvas style={{ width: size, height: size }}>
            <Path path={stars} color={tint} opacity={live ? 0.16 : 0.08} />
            {/* Far dust sits behind the light and loses most of itself to it. */}
            <Path path={far} color={tint} opacity={live ? 0.16 : 0.09} />
            {/* Two layers of light: a wide haze the cloud sits inside, and a
                tight one that makes the centre read as hot rather than lit. */}
            <Group opacity={glowOpacity}>
                <Circle cx={half} cy={half} r={half * 0.62}>
                    <RadialGradient c={vec(half, half)} r={half * 0.62} colors={[tint, 'transparent']} positions={[0, 1]} />
                </Circle>
                <Blur blur={size * 0.09} />
            </Group>
            <Group opacity={glowOpacity}>
                <Circle cx={half} cy={half} r={half * 0.2}>
                    <RadialGradient c={vec(half, half)} r={half * 0.2} colors={[tint, 'transparent']} positions={[0, 1]} />
                </Circle>
                <Blur blur={size * 0.03} />
            </Group>
            <Group opacity={live ? 0.95 : 0.5}>
                <Circle cx={half} cy={half} r={half * 0.1}>
                    <RadialGradient c={vec(half, half)} r={half * 0.1} colors={[tint, 'transparent']} positions={[0.15, 1]} />
                </Circle>
                <Blur blur={size * 0.012} />
            </Group>
            <Circle cx={half} cy={half} r={coreRadius} color={tint} opacity={live ? 0.9 : 0.45}>
                <Blur blur={size * 0.006} />
            </Circle>
            {/* The cross a bright point throws through a lens. Faint enough to
                be felt rather than seen, and it is what says "star" instead of
                "white circle". */}
            <Group opacity={live ? 0.5 : 0.2}>
                <Path path={spikes} style="stroke" strokeWidth={Math.max(0.6, size * 0.006)} color={tint} />
                <Blur blur={size * 0.01} />
            </Group>
            <Path path={mid} color={tint} opacity={live ? 0.4 : 0.2} />
            <Path path={mid} style="stroke" strokeWidth={stroke} color={tint} opacity={live ? 0.22 : 0.1} />
            <Path path={near} color={tint} opacity={live ? 0.72 : 0.32} />
            <Path path={near} style="stroke" strokeWidth={stroke} color={tint} opacity={live ? 0.35 : 0.14} />
            <Path path={nearest} color={tint} opacity={live ? 0.98 : 0.42} />
            <Path path={nearest} style="stroke" strokeWidth={stroke} color={tint} opacity={live ? 0.5 : 0.2} />
        </Canvas>
    );
});
