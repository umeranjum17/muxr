import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useUnistyles } from 'react-native-unistyles';
import { useReducedMotion } from 'react-native-reanimated';
import { BubblePressable } from '@/components/BubblePressable';
import { useDictation } from '@/utils/dictation';
import { t } from '@/text';

const BAR_COUNT = 7;
const BAR_WIDTH = 3;
const BAR_GAP = 3;
const BAR_MAX_HEIGHT = 18;
const BAR_MIN_HEIGHT = 4;
// Fixed per-bar weights so every bar follows the same live level honestly,
// taller in the middle like a voice waveform.
const BAR_WEIGHTS = [0.45, 0.65, 0.85, 1, 0.85, 0.65, 0.45];

function DictationWaveform({ level, live, barColor, compact = false }: { level: number; live: boolean; barColor: string; compact?: boolean }) {
    const reduceMotion = useReducedMotion();
    const animated = live && !reduceMotion;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {(compact ? BAR_WEIGHTS.slice(2, 5) : BAR_WEIGHTS.slice(0, BAR_COUNT)).map((weight, index) => {
                const height = animated
                    ? BAR_MIN_HEIGHT + level * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * weight
                    : BAR_MIN_HEIGHT + 0.25 * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * weight;
                return (
                    <View
                        key={index}
                        style={{
                            width: compact ? 2 : BAR_WIDTH,
                            height,
                            borderRadius: BAR_WIDTH / 2,
                            backgroundColor: barColor,
                            marginLeft: index === 0 ? 0 : BAR_GAP,
                        }}
                    />
                );
            })}
        </View>
    );
}

export function DictateButton({ context, compact = false, onActiveChange }: {
    context: { getText: () => string; setText: (text: string) => void };
    compact?: boolean;
    onActiveChange?: (active: boolean) => void;
}) {
    const { theme } = useUnistyles();
    const dictation = useDictation(context.getText, context.setText);
    const pill = {
        borderRadius: 21,
        backgroundColor: theme.colors.code.surface,
    };
    const active = dictation.recording || dictation.transcribing;
    React.useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);
    // The terminal already owns an editable draft. Never draw a second copy
    // of the transcript next to it; Home keeps its existing review treatment.
    const { pending, accept } = dictation;
    React.useEffect(() => { if (compact && pending !== null) accept(); }, [compact, pending, accept]);
    if (compact) {
        const target = { width: 44, height: 44, borderRadius: 22, alignItems: 'center' as const, justifyContent: 'center' as const };
        let control = <Ionicons name="mic-outline" size={20} color={theme.colors.textSecondary} />;
        let label = t('plugins.dictate');
        if (dictation.recording) {
            label = t('plugins.stopDictation');
            control = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: theme.colors.status.error }} />
                <DictationWaveform compact level={dictation.level} live barColor={theme.colors.status.error} />
            </View>;
        }
        if (dictation.transcribing) {
            label = 'Transcribing dictation';
            control = <ActivityIndicator size="small" color={theme.colors.textSecondary} />;
        }
        return <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
            <BubblePressable onPress={dictation.toggle} disabled={dictation.transcribing} style={target}
                pressedStyle={{ backgroundColor: theme.colors.code.pressed }} accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={dictation.recording ? t('plugins.stopDictationHint') : undefined}
                accessibilityState={{ busy: dictation.transcribing, selected: dictation.recording, disabled: dictation.transcribing }}>
                {control}
            </BubblePressable>
            {active && <BubblePressable onPress={dictation.cancel} style={target} pressedStyle={{ backgroundColor: theme.colors.code.pressed }} accessibilityRole="button" accessibilityLabel="Cancel dictation">
                <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
            </BubblePressable>}
        </View>;
    }
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
