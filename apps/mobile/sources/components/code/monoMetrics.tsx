import * as React from 'react';
import { Text, View, type TextLayoutEventData, type NativeSyntheticEvent } from 'react-native';
import { Typography } from '@/constants/Typography';
import { CHAR_WIDTH_RATIO } from '@/components/code/codeLayout';

const SAMPLE = '0'.repeat(40);

/**
 * The 0.6 em advance is IBM Plex Mono's nominal figure; the rendered advance
 * depends on the device's font scaling and rounding, and every column budget
 * in the viewers is derived from it. So measure it once per size with a hidden
 * sample and fall back to the nominal value until the measurement lands.
 */
export function useMonoCharWidth(sizes: readonly number[]): {
    charWidth: (size: number) => number;
    probe: React.ReactNode;
} {
    const [measured, setMeasured] = React.useState<Record<number, number>>({});
    const wanted = React.useMemo(() => [...new Set(sizes.filter((size) => size > 0))].sort((a, b) => a - b), [sizes]);
    const charWidth = React.useCallback(
        (size: number) => measured[size] ?? CHAR_WIDTH_RATIO * size,
        [measured],
    );
    const record = React.useCallback((size: number, event: NativeSyntheticEvent<TextLayoutEventData>) => {
        const width = event.nativeEvent.lines[0]?.width;
        if (width === undefined || width <= 0) return;
        const advance = width / SAMPLE.length;
        setMeasured((current) => Math.abs((current[size] ?? 0) - advance) < 0.01 ? current : { ...current, [size]: advance });
    }, []);
    const probe = (
        <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            pointerEvents="none"
            style={{ position: 'absolute', top: -1000, left: 0, opacity: 0 }}
        >
            {wanted.map((size) => (
                <Text
                    key={size}
                    numberOfLines={1}
                    onTextLayout={(event) => record(size, event)}
                    style={{ ...Typography.mono(), fontSize: size }}
                >
                    {SAMPLE}
                </Text>
            ))}
        </View>
    );
    return { charWidth, probe };
}
