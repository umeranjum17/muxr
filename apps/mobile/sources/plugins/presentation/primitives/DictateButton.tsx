import * as React from 'react';
import { ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { BubblePressable } from '@/components/BubblePressable';
import { useDictation } from '@/utils/dictation';
import { webSpeechDictationSupported } from '@/utils/webSpeechDictation';
import type { PrimitiveProps } from '../../domain/primitiveTypes'
import { t } from '@/text';

export function DictateButton({ context }: PrimitiveProps) {
    const { theme } = useUnistyles();
    const ready = 'getText' in context && 'setText' in context;
    const getText = ready ? context.getText : () => '';
    const setText = ready ? context.setText : () => {};
    const dictation = useDictation(getText, setText);
    if (!ready) return null;
    // Native apps transcribe on device; a browser dictates through its own
    // speech recognition when it has one. A control that cannot act here is
    // disabled with the exact reason, never a post-tap alert.
    const unavailable = Platform.OS === 'web' && !webSpeechDictationSupported();
    return (
        <BubblePressable
            onPress={unavailable ? undefined : dictation.toggle}
            disabled={unavailable}
            style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: unavailable ? 0.4 : 1 }}
            pressedStyle={{ backgroundColor: theme.colors.glass.backgroundSubtle }}
            accessibilityRole="button"
            accessibilityLabel={t('plugins.dictate')}
            accessibilityHint={unavailable ? 'This browser has no built-in speech recognition; dictation works in Chrome, Edge, Safari and the native apps' : Platform.OS === 'web' ? 'Uses this browser\'s speech recognition to edit the draft' : undefined}
            accessibilityState={{ busy: dictation.transcribing, selected: dictation.recording, disabled: unavailable }}
        >
            {dictation.transcribing
                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                : <Ionicons
                    name={dictation.recording ? 'stop-circle' : 'mic-outline'}
                    size={22}
                    color={dictation.recording ? theme.colors.status.error : theme.colors.textSecondary}
                />}
        </BubblePressable>
    );
}
