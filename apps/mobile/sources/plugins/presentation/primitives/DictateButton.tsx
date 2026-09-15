import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useReducedMotion } from 'react-native-reanimated';
import { BubblePressable } from '@/components/BubblePressable';
import { useDictation } from '@/utils/dictation';
import type { PrimitiveProps } from '../../domain/primitiveTypes'
import { t } from '@/text';

const BAR_COUNT = 7;
const BAR_WIDTH = 3;
const BAR_GAP = 3;
const BAR_MAX_HEIGHT = 18;
const BAR_MIN_HEIGHT = 4;
// Fixed per-bar weights so every bar follows the same live level honestly,
// taller in the middle like a voice waveform.
const BAR_WEIGHTS = [0.45, 0.65, 0.85, 1, 0.85, 0.65, 0.45];

/**
 * The dictation control reads as a dark capsule while it holds the
 * microphone: a red dot plus bars that follow the real input level while
 * recording, a muted grey dot plus still bars while the capture waits for
 * transcription. Idle it is the plain mic button it always was.
 */
function DictationWaveform({ level, live, barColor }: { level: number; live: boolean; barColor: string }) {
    const reduceMotion = useReducedMotion();
    const animated = live && !reduceMotion;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {BAR_WEIGHTS.slice(0, BAR_COUNT).map((weight, index) => {
                const height = animated
                    ? BAR_MIN_HEIGHT + level * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * weight
                    : BAR_MIN_HEIGHT + 0.25 * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * weight;
                return (
                    <View
                        key={index}
                        style={{
                            width: BAR_WIDTH,
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

export function DictateButton({ context }: PrimitiveProps) {
    const { theme } = useUnistyles();
    const ready = 'getText' in context && 'setText' in context;
    const getText = ready ? context.getText : () => '';
    const setText = ready ? context.setText : () => {};
    const dictation = useDictation(getText, setText);
    if (!ready) return null;
    const active = dictation.recording || dictation.transcribing;
    if (!active) {
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
    const live = dictation.recording;
    const dotColor = live ? theme.colors.status.error : theme.colors.status.disconnected;
    return (
        <BubblePressable
            onPress={dictation.toggle}
            style={{
                height: 42,
                borderRadius: 21,
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                gap: 10,
                // The code panel is the app's own dark object in both themes.
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
    );
}
