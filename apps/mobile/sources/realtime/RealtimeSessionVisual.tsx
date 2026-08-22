import * as React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
    cancelAnimation,
    Easing,
    ReduceMotion,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { subscribeEnergy } from './audioEnergy';
import type { RealtimeSessionState } from './realtimeSessionState';

/**
 * A cloud of dust with a light in the middle of it.
 *
 * Every mote is placed once, at module load, and never moves again: a band is a
 * plain View full of plain Views, and the orbit is one rotation on its parent.
 * Nothing is rebuilt per frame and nothing is drawn on a GPU surface of its own,
 * which is what the Skia scene this replaces could not promise on Android.
 *
 * Depth comes from the bands rather than from per-frame maths. Each is tilted
 * and flattened a little differently, so together they read as a disc rather
 * than a hoop, and each laps at its own rate the way anything held by a central
 * mass does -- so the cloud never repeats and never looks drawn with a compass.
 *
 * Voice moves it: what it says pushes the cloud outward and brightens the core,
 * what you say draws it in. Only transform and opacity ever change, and the
 * loudness arrives as a bounded number set from JS, so the UI thread never calls
 * back across runtimes.
 *
 * Monochrome, because the light is one light.
 */

const TWO_PI = Math.PI * 2;
/** One turn of the shared clock. A cloud that hurries reads as a spinner. */
const LAP_MS = 62_000;
const LIT = '247, 248, 251';
const DIM = '154, 160, 168';

function tone(muted: boolean, alpha: number): string {
    return `rgba(${muted ? DIM : LIT}, ${alpha.toFixed(3)})`;
}

/** Deterministic scatter: populated once, not random per launch. */
function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = state + 0x6D2B79F5 | 0;
        let value = Math.imul(state ^ state >>> 15, 1 | state);
        value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
        return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
    };
}

interface Mote {
    /** Offset from the centre, as a fraction of the box. */
    x: number;
    y: number;
    /** Diameter, also a fraction of the box. */
    d: number;
    alpha: number;
}

function dust(count: number, inner: number, outer: number, seed: number): Mote[] {
    const next = rng(seed);
    return Array.from({ length: count }, () => {
        const angle = next() * TWO_PI;
        // Dense at the inner edge, thin at the rim: what a bound cloud looks
        // like. A uniform draw looks like a sprayed ring.
        const radius = inner + (outer - inner) * Math.pow(next(), 0.78);
        // Mostly specks, a few bright ones. Equal-sized dust is confetti.
        const grade = Math.pow(next(), 2.2);
        // Near the light is lit; the rim is only lit by what it is made of.
        const litness = 1 - (radius - 0.1) * 0.9;
        return {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
            d: 0.004 + grade * 0.009,
            alpha: Math.min(0.95, (0.16 + grade * 0.66) * litness),
        };
    });
}

interface Band {
    /** Laps per turn of the shared clock; whole numbers keep the loop seamless. */
    laps: number;
    /**
     * Mild on purpose. A hard flatten squashes each mote along with the band and
     * the dust turns into a field of parallel scratches.
     */
    flatten: number;
    tilt: string;
    motes: Mote[];
    /** At pill size neighbouring motes land on one pixel and read as static. */
    sparse: Mote[];
}

const BANDS: Band[] = [
    { laps: 3, flatten: 0.62, tilt: '-12deg', inner: 0.1, outer: 0.25, count: 56, seed: 1 },
    { laps: 2, flatten: 0.56, tilt: '-16deg', inner: 0.24, outer: 0.37, count: 52, seed: 11 },
    { laps: 1, flatten: 0.5, tilt: '-20deg', inner: 0.36, outer: 0.49, count: 40, seed: 21 },
].map(({ count, inner, outer, seed, ...rest }) => {
    const motes = dust(count, inner, outer, seed);
    return { ...rest, motes, sparse: motes.filter((_, index) => index % 5 === 0) };
});

/** Still stars behind the cloud: without a fixed field, nothing has parallax. */
const STARS = (() => {
    const next = rng(31);
    return Array.from({ length: 16 }, () => ({
        x: next(),
        y: next(),
        d: 0.004 + next() * 0.004,
        alpha: 0.06 + next() * 0.16,
    }));
})();

/** Gradient ids are global to the renderer, and two of these can be on screen. */
let instances = 0;

/** Memoized: the dust is the same from connecting to speaking, so a state change
    must not walk a hundred and fifty host views to say nothing. */
const DustBand = React.memo(function DustBand({ band, size, muted, live, turn, input, output }: {
    band: Band;
    size: number;
    muted: boolean;
    live: boolean;
    turn: SharedValue<number>;
    input: SharedValue<number>;
    output: SharedValue<number>;
}) {
    // Primitives, not the band: a worklet closure copies whatever it names, and
    // naming the band would ship its whole mote list to the UI runtime.
    const { flatten, laps, tilt } = band;
    const style = useAnimatedStyle(() => {
        const level = Math.max(input.get(), output.get());
        return {
            opacity: live ? 0.62 + level * 0.38 : 0.3,
            transform: [
                { scale: 1 + output.get() * 0.17 - input.get() * 0.07 },
                { rotate: tilt },
                { scaleY: flatten },
                { rotate: `${turn.get() * 360 * laps}deg` },
            ],
        };
    });
    const small = size < 90;
    return (
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size }, style]}>
            {(small ? band.sparse : band.motes).map((mote, index) => {
                const d = Math.max(small ? 1.2 : 1, mote.d * size * (small ? 2.4 : 1));
                return <View key={index} style={{
                    position: 'absolute',
                    left: size * (0.5 + mote.x) - d / 2,
                    top: size * (0.5 + mote.y) - d / 2,
                    width: d,
                    height: d,
                    borderRadius: d / 2,
                    backgroundColor: tone(muted, mote.alpha),
                }} />;
            })}
        </Animated.View>
    );
});

/**
 * Two lights: a wide haze the cloud sits inside, and a tight one that makes the
 * centre read as hot rather than merely bright. Stacked flat discs would band
 * into visible rings, so this is the one place a real gradient is worth a view.
 */
const Glow = React.memo(function Glow({ size, muted, live, input, output }: {
    size: number;
    muted: boolean;
    live: boolean;
    input: SharedValue<number>;
    output: SharedValue<number>;
}) {
    const id = React.useMemo(() => `realtime-glow-${++instances}`, []);
    const color = muted ? `rgb(${DIM})` : `rgb(${LIT})`;
    const half = size / 2;
    const style = useAnimatedStyle(() => {
        const level = Math.max(input.get(), output.get());
        return { opacity: (live ? 0.8 : 0.34) + level * 0.2, transform: [{ scale: 1 + level * 0.12 }] };
    });
    return (
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size }, style]}>
            <Svg width={size} height={size}>
                <Defs>
                    <RadialGradient id={`${id}-haze`} cx="50%" cy="50%" r="50%">
                        <Stop offset="0" stopColor={color} stopOpacity={0.2} />
                        <Stop offset="0.22" stopColor={color} stopOpacity={0.07} />
                        <Stop offset="0.46" stopColor={color} stopOpacity={0.02} />
                        <Stop offset="1" stopColor={color} stopOpacity={0} />
                    </RadialGradient>
                    <RadialGradient id={`${id}-core`} cx="50%" cy="50%" r="50%">
                        <Stop offset="0" stopColor={color} stopOpacity={0.55} />
                        <Stop offset="0.34" stopColor={color} stopOpacity={0.14} />
                        <Stop offset="1" stopColor={color} stopOpacity={0} />
                    </RadialGradient>
                </Defs>
                <Circle cx={half} cy={half} r={half} fill={`url(#${id}-haze)`} />
                <Circle cx={half} cy={half} r={size * 0.17} fill={`url(#${id}-core)`} />
            </Svg>
        </Animated.View>
    );
});

const Core = React.memo(function Core({ size, muted, live, breath, input, output }: {
    size: number;
    muted: boolean;
    live: boolean;
    breath: SharedValue<number>;
    input: SharedValue<number>;
    output: SharedValue<number>;
}) {
    const dot = Math.max(3, size * 0.045);
    const style = useAnimatedStyle(() => {
        const level = Math.max(input.get(), output.get());
        return {
            opacity: (live ? 0.86 : 0.42) + level * 0.14,
            transform: [{ scale: 1 + level * 0.5 + (breath.get() - 0.5) * 0.08 }],
        };
    });
    return <Animated.View pointerEvents="none" style={[{
        width: dot,
        height: dot,
        borderRadius: dot / 2,
        backgroundColor: tone(muted, 0.95),
    }, style]} />;
});

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
    const turn = useSharedValue(0);
    const breath = useSharedValue(0.5);
    const input = useSharedValue(0);
    const output = useSharedValue(0);
    const live = state !== 'disconnected';

    React.useEffect(() => {
        if (reduceMotion) {
            turn.set(0.12);
            return;
        }
        turn.set(0);
        turn.set(withRepeat(withTiming(1, { duration: live ? LAP_MS : LAP_MS * 2.4, easing: Easing.linear }), -1, false));
        return () => cancelAnimation(turn);
    }, [live, reduceMotion, turn]);

    React.useEffect(() => {
        if (reduceMotion) {
            breath.set(0.5);
            return;
        }
        breath.set(withRepeat(withTiming(1, { duration: 3_400, easing: Easing.inOut(Easing.ease) }), -1, true));
        return () => cancelAnimation(breath);
    }, [breath, reduceMotion]);

    // PCM arrives on the JS side; only a bounded level crosses into the UI
    // thread, and it falls back on its own like a VU needle.
    React.useEffect(() => subscribeEnergy((direction, raw) => {
        const level = muted ? 0 : Math.max(0, Math.min(1, raw));
        const target = direction === 'input' ? input : output;
        target.set(withSequence(
            withTiming(level, { duration: 70, reduceMotion: ReduceMotion.System }),
            withDelay(90, withTiming(0, { duration: 420, reduceMotion: ReduceMotion.System })),
        ));
    }), [input, muted, output]);

    return (
        <View pointerEvents="none" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            {size >= 90 && STARS.map((star, index) => {
                const d = Math.max(1, star.d * size);
                return <View key={index} style={{
                    position: 'absolute',
                    left: star.x * (size - d),
                    top: star.y * (size - d),
                    width: d,
                    height: d,
                    borderRadius: d / 2,
                    backgroundColor: tone(muted, live ? star.alpha : star.alpha * 0.5),
                }} />;
            })}
            <Glow size={size} muted={muted} live={live} input={input} output={output} />
            {BANDS.map((band) => (
                <DustBand key={band.laps} band={band} size={size} muted={muted} live={live} turn={turn} input={input} output={output} />
            ))}
            <Core size={size} muted={muted} live={live} breath={breath} input={input} output={output} />
        </View>
    );
});
