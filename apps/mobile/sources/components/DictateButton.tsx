import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useUnistyles } from 'react-native-unistyles';
import Animated, { useAnimatedStyle, useReducedMotion, type SharedValue } from 'react-native-reanimated';
import { BubblePressable } from '@/components/BubblePressable';
import { useDictation } from '@/utils/dictation';
import { t } from '@/text';

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const BAR_MAX_HEIGHT = 18;
const BAR_MIN_HEIGHT = 4;
// Fixed per-bar weights so every bar follows the same live level honestly,
// taller in the middle like a voice waveform.
const BAR_WEIGHTS = [0.45, 0.65, 0.85, 1, 0.85, 0.65, 0.45];

function DictationWaveform({ level, live, barColor }: { level: SharedValue<number>; live: boolean; barColor: string }) {
    const reduceMotion = useReducedMotion();
    const animated = live && !reduceMotion;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {BAR_WEIGHTS.map((weight, index) => (
                <WaveBar key={index} level={level} animated={animated} weight={weight} barColor={barColor} width={BAR_WIDTH} first={index === 0} />
            ))}
        </View>
    );
}

function WaveBar({ level, animated, weight, barColor, width, first }: {
    level: SharedValue<number>;
    animated: boolean;
    weight: number;
    barColor: string;
    width: number;
    first: boolean;
}) {
    const bar = useAnimatedStyle(() => ({
        height: animated
            ? BAR_MIN_HEIGHT + level.value * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * weight
            : BAR_MIN_HEIGHT + 0.25 * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * weight,
    }));
    return <Animated.View style={[{ width, borderRadius: width / 2, backgroundColor: barColor, marginLeft: first ? 0 : BAR_GAP }, bar]} />;
}

export function DictateButton({ context }: {
    context: { getText: () => string; setText: (text: string) => void };
}) {
    const { theme } = useUnistyles();
    const dictation = useDictation(context.getText, context.setText);
    const pill = {
        borderRadius: 21,
        backgroundColor: theme.colors.code.surface,
    };
    const active = dictation.recording || dictation.transcribing;
    if (active) {
        const live = dictation.recording;
        const dotColor = live ? theme.colors.status.error : theme.colors.status.disconnected;
        return (
            <View style={{ position: 'relative', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
                <BubblePressable
                    onPress={dictation.toggle}
                    style={{
                        minHeight: 42,
                        maxWidth: '100%',
                        borderRadius: 21,
                        flexDirection: 'row',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        gap: 10,
                        backgroundColor: theme.colors.code.surface,
                    }}
                    pressedStyle={{ backgroundColor: theme.colors.code.pressed }}
                    accessibilityRole="button"
                    accessibilityLabel={t('plugins.dictate')}
                    accessibilityState={{ busy: dictation.transcribing, selected: dictation.recording }}
                >
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
                    <DictationWaveform level={dictation.level} live={live} barColor={theme.colors.code.text} />
                </BubblePressable>
                {live ? (
                    <View style={{ position: 'absolute', right: 0, bottom: -60 }}>
                        <BubblePressable
                            onPress={dictation.toggle}
                            style={{
                                width: 48,
                                height: 48,
                                borderRadius: 24,
                                alignItems: 'center',
                                justifyContent: 'center',
                                backgroundColor: theme.colors.code.surface,
                            }}
                            pressedStyle={{ backgroundColor: theme.colors.code.pressed }}
                            accessibilityRole="button"
                            accessibilityLabel={t('plugins.dictate')}
                            accessibilityState={{ selected: true }}
                        >
                            <Ionicons name="mic-off-outline" size={22} color={theme.colors.code.text} />
                        </BubblePressable>
                    </View>
                ) : null}
            </View>
        );
    }
    if (dictation.pending !== null) {
        const text = dictation.pending;
        return (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', maxWidth: '100%', ...pill, minHeight: 42, paddingHorizontal: 7, paddingVertical: 7, gap: 8 }}>
                <BubblePressable
                    onPress={dictation.discard}
                    style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.code.text }}
                    accessibilityRole="button"
                    accessibilityLabel="Discard dictation"
                >
                    <Ionicons name="close" size={16} color={theme.colors.code.surface} />
                </BubblePressable>
                <Text style={{ flexShrink: 1, flexWrap: 'wrap', maxWidth: '100%', color: theme.colors.code.text, fontSize: 14, lineHeight: 20 }}>
                    {text}
                </Text>
                <BubblePressable
                    onPress={() => { void Clipboard.setStringAsync(text); }}
                    style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.copy')}
                >
                    <Ionicons name="copy-outline" size={16} color={theme.colors.code.text} />
                </BubblePressable>
                <BubblePressable
                    onPress={dictation.accept}
                    style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.code.text }}
                    accessibilityRole="button"
                    accessibilityLabel="Accept dictation"
                >
                    <Ionicons name="checkmark" size={16} color={theme.colors.code.surface} />
                </BubblePressable>
            </View>
        );
    }
    if (dictation.finished !== null) {
        const text = dictation.finished;
        return (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', maxWidth: '100%', ...pill, minHeight: 42, paddingHorizontal: 14, paddingVertical: 10, gap: 10 }}>
                    <Text style={{ flexShrink: 1, flexWrap: 'wrap', maxWidth: '100%', color: theme.colors.code.text, fontSize: 14, lineHeight: 20 }}>
                        {text}
                    </Text>
                    <BubblePressable
                        onPress={() => { void Clipboard.setStringAsync(text); }}
                        style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.copy')}
                    >
                        <Ionicons name="copy-outline" size={16} color={theme.colors.code.text} />
                    </BubblePressable>
                </View>
                <BubblePressable
                    onPress={() => { dictation.clearFinished(); dictation.toggle(); }}
                    style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' }}
                    pressedStyle={{ backgroundColor: theme.colors.glass.backgroundSubtle }}
                    accessibilityRole="button"
                    accessibilityLabel={t('plugins.dictate')}
                >
                    <Ionicons name="mic-outline" size={22} color={theme.colors.textSecondary} />
                </BubblePressable>
            </View>
        );
    }
    return (
        <BubblePressable
            onPress={dictation.toggle}
            style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' }}
            pressedStyle={{ backgroundColor: theme.colors.glass.backgroundSubtle }}
            accessibilityRole="button"
            accessibilityLabel={t('plugins.dictate')}
            accessibilityState={{ busy: dictation.transcribing, selected: dictation.recording }}
        >
            <Ionicons name="mic-outline" size={22} color={theme.colors.textSecondary} />
        </BubblePressable>
    );
}
