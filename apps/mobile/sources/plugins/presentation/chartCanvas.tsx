import * as React from 'react';
import { Text, View } from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { PolarChart, Pie } from 'victory-native';
import { Easing, useDerivedValue, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { toneColor } from '../domain/pluginTone';
import { useSkiaWebReady } from '@/utils/skiaWeb';
import type { PluginChartItem } from '../domain/chartModel';

/**
 * Wide-screen-only chart visuals, split out of screenCharts so victory-native
 * and the Skia JS stay out of the initial load graph. CanvasKit itself loads
 * on first mount here (never at root); until then an accessible meter
 * fallback holds the layout.
 */

function MeterFallback({ ratio, label }: { ratio: number; label: string }) {
    const { theme } = useUnistyles();
    return (
        <View accessible accessibilityRole="progressbar" accessibilityLabel={label}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
            style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surfaceHighest, overflow: 'hidden' }}>
            <View style={{ width: `${Math.round(ratio * 100)}%`, height: '100%', backgroundColor: theme.colors.accent }} />
        </View>
    );
}

export function GaugeArc({ ratio, size, color, track, label }: {
    ratio: number; size: number; color: string; track: string; label: string;
}) {
    const ready = useSkiaWebReady();
    const reduceMotion = useReducedMotion();
    const sweep = useSharedValue(reduceMotion ? ratio : 0);
    React.useEffect(() => {
        sweep.value = reduceMotion ? ratio : withTiming(ratio, { duration: 620, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    }, [ratio, reduceMotion, sweep]);
    const stroke = size * 0.085;
    const radius = (size - stroke) / 2;
    if (!ready) return <MeterFallback ratio={ratio} label={label} />;
    const box = Skia.XYWHRect(stroke / 2, stroke / 2, radius * 2, radius * 2);
    const START = 135;
    const SPAN = 270;
    return (
        <GaugeCanvas
            box={box}
            start={START}
            span={SPAN}
            sweep={sweep}
            size={size}
            color={color}
            track={track}
            stroke={stroke}
            label={label}
        />
    );
}

function GaugeCanvas({ box, start, span, sweep, size, color, track, stroke, label }: {
    box: ReturnType<typeof Skia.XYWHRect>;
    start: number;
    span: number;
    sweep: { value: number };
    size: number;
    color: string;
    track: string;
    stroke: number;
    label: string;
}) {
    const trackPath = React.useMemo(() => {
        const path = Skia.Path.Make();
        path.addArc(box, start, span);
        return path;
    }, [box, start, span]);
    const valuePath = useDerivedValue(() => {
        const path = Skia.Path.Make();
        path.addArc(box, start, Math.max(0.001, span * sweep.value));
        return path;
    });
    return (
        <Canvas style={{ width: size, height: size }} accessibilityLabel={label}>
            <Path path={trackPath} color={track} style="stroke" strokeWidth={stroke} strokeCap="round" />
            <Path path={valuePath} color={color} style="stroke" strokeWidth={stroke} strokeCap="round" />
        </Canvas>
    );
}

export function WideRingChart({ slices, heroLabel, heroValue, title, reduceMotion }: {
    slices: Array<{ label: string; value: number; color: string }>;
    heroLabel: string;
    heroValue: string;
    title?: string;
    reduceMotion: boolean;
}) {
    const { theme } = useUnistyles();
    const ready = useSkiaWebReady();
    if (!ready || slices.length === 0) {
        return <MeterFallback ratio={1} label={title ?? heroLabel} />;
    }
    return (
        <View style={{ alignItems: 'center' }}>
            <View style={{ width: 132, height: 132 }}>
                <PolarChart data={slices} labelKey="label" valueKey="value" colorKey="color" containerStyle={{ width: 132, height: 132 }}>
                    <Pie.Chart innerRadius="74%" startAngle={-90}>
                        {() => <Pie.Slice {...(reduceMotion ? {} : { animate: { type: 'timing', duration: 500, easing: Easing.bezier(0.23, 1, 0.32, 1) } })} />}
                    </Pie.Chart>
                </PolarChart>
                <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: theme.colors.text, fontSize: 24, letterSpacing: -0.5, ...Typography.mono('semiBold') }}>{heroValue}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 1 }}>{heroLabel}</Text>
                </View>
            </View>
        </View>
    );
}
