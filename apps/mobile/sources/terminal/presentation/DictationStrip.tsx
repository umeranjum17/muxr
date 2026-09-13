import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useDictationStatus } from '@/utils/dictation';

const BAR_COUNT = 5;
const BAR_WIDTH = 4;
const BAR_GAP = 4;
const BAR_MIN = 8;
const BAR_SPAN = 20;
// Middle bars run tallest, edge bars shortest.
const BAR_GAINS = [0.7, 1.1, 1.5, 1.1, 0.7];

/**
 * One rounded amplitude bar. Heights come straight from the recorder's
 * smoothed input level — no decorative loop — so a quiet room reads low
 * and near-uniform.
 */
function WaveformBars({ level, live, color }: { level: number; live: boolean; color: string }) {
    return (
        <View
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            style={{ flexDirection: 'row', alignItems: 'center', gap: BAR_GAP, height: BAR_MIN + BAR_SPAN }}
        >
            {BAR_GAINS.map((gain, index) => (
                <View
                    key={index}
                    style={{
                        width: BAR_WIDTH,
                        height: BAR_MIN + Math.min(1, level * gain) * BAR_SPAN,
                        borderRadius: BAR_WIDTH / 2,
                        backgroundColor: color,
                        // Frozen bars hold their snapshot without dimming into the background.
                        opacity: live ? 1 : 0.85,
                    }}
                />
            ))}
        </View>
    );
}

/** Indeterminate arc: one teal segment rotating at constant speed. */
function ArcSpinner({ color }: { color: string }) {
    const rotation = useSharedValue(0);
    React.useEffect(() => {
        rotation.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1, false);
    }, [rotation]);
    const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
    return (
        <Animated.View
            style={[{
                width: 18, height: 18, borderRadius: 9,
                borderWidth: 2, borderColor: 'transparent', borderTopColor: color,
            }, style]}
        />
    );
}

/**
 * The composer's voice status strip, mounted between the key row and the
 * composer. Moshi's transcription arc, adapted to a batch engine:
 *
 * - idle: the strip is gone entirely (the mic button is the idle state);
 * - tap: hard swap — red amplitude bars + "Listening…" appear at once;
 * - listening: only the bars move, driven by mic input level;
 * - stop tap: hard swap — bars freeze grey, teal arc spins, "Transcribing…";
 * - result: the final text lands in the composer in one append (batch —
 *   there are no live partials to re-render) and the strip dissolves.
 */
export function DictationStrip() {
    const { theme } = useUnistyles();
    const { recording, transcribing } = useDictationStatus();
    const level = useDictationStatus((state) => state.level);
    if (!recording && !transcribing) return null;
    const listening = recording;
    return (
        <Animated.View
            accessibilityLabel={listening ? t('plugins.dictating') : t('plugins.transcribing')}
            accessibilityLiveRegion="polite"
            exiting={FadeOut.duration(250)}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                minHeight: 44,
                paddingHorizontal: 14,
                backgroundColor: theme.colors.surface,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.colors.divider,
            }}
        >
            <WaveformBars
                level={level}
                live={listening}
                color={listening ? theme.colors.status.error : theme.colors.textSecondary}
            />
            <Text style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 13 }}>
                {listening ? t('plugins.dictating') : t('plugins.transcribing')}
            </Text>
            {!listening && (
                <View style={{ marginLeft: 'auto' }}>
                    <ArcSpinner color={theme.colors.success} />
                </View>
            )}
        </Animated.View>
    );
}
