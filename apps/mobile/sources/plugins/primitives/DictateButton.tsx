import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { BubblePressable } from '@/components/BubblePressable';
import { useDictation } from '@/utils/dictation';
import type { PrimitiveProps } from '../primitiveRegistry';
import { t } from '@/text';

export function DictateButton({ context }: PrimitiveProps) {
    const { theme } = useUnistyles();
    const ready = 'getText' in context && 'setText' in context;
    const getText = ready ? context.getText : () => '';
    const setText = ready ? context.setText : () => {};
    const dictation = useDictation(getText, setText);
    if (!ready) return null;
    return (
        <BubblePressable
            onPress={dictation.toggle}
            style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' }}
            pressedStyle={{ backgroundColor: theme.colors.glass.backgroundSubtle }}
            accessibilityRole="button"
            accessibilityLabel={t('plugins.dictate')}
            accessibilityState={{ busy: dictation.transcribing, selected: dictation.recording }}
        >
            <Ionicons
                name={dictation.recording ? 'stop-circle' : dictation.transcribing ? 'hourglass-outline' : 'mic-outline'}
                size={22}
                color={dictation.recording ? theme.colors.status.error : theme.colors.textSecondary}
            />
        </BubblePressable>
    );
}
