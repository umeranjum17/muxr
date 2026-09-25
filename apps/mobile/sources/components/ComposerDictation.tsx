import * as React from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, ReduceMotion, useAnimatedStyle, useReducedMotion, type SharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { withAlpha } from '@/components/ui';
import { useDictation } from '@/utils/dictation';
import { t } from '@/text';

/**
 * Dictation inside a composer pill, shared by every composer so they read
 * the same: the mic sits in the field, and while it is live the same pill
 * reads Dictating…, then Transcribing…, then commits into the draft. The
 * words land in the draft as they settle, so there is no review step and
 * never a second copy of the transcript beside the field.
 */
export function useComposerDictation(getText: () => string, setText: (text: string) => void) {
    const dictation = useDictation(getText, setText);
    const { pending, accept } = dictation;
    React.useEffect(() => { if (pending !== null) accept(); }, [pending, accept]);
    return { ...dictation, active: dictation.recording || dictation.transcribing || dictation.discarded };
}

type ComposerDictation = ReturnType<typeof useComposerDictation>;

// Live recording level as five honest bars; the same fixed weights keep every
// bar following the real input level, taller through the middle. The level is
// a shared value read on the UI thread, so a recording chunk never re-renders
// the composer around the bars.
const BAR_WEIGHTS = [0.45, 0.7, 1, 0.7, 0.45];
function DictationBars({ level, color }: { level: SharedValue<number>; color: string }) {
    return <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 10 }}>
        {BAR_WEIGHTS.map((weight, index) => (
            <DictationBar key={index} level={level} weight={weight} color={color} first={index === 0} />
        ))}
    </View>;
}

function DictationBar({ level, weight, color, first }: { level: SharedValue<number>; weight: number; color: string; first: boolean }) {
    const bar = useAnimatedStyle(() => ({ height: 4 + level.value * 11 * weight }));
    return <Animated.View style={[{ width: 2.5, borderRadius: 1.25, backgroundColor: color, marginLeft: first ? 0 : 3 }, bar]} />;
}

/** The restrained resolving state: three dots that breathe while text lands. */
function TranscribingDots({ color }: { color: string }) {
    const reduceMotion = useReducedMotion();
    const [phase, setPhase] = React.useState(0);
    React.useEffect(() => {
        if (reduceMotion === true) return;
        const timer = setInterval(() => setPhase((current) => (current + 1) % 3), 380);
        return () => clearInterval(timer);
    }, [reduceMotion]);
    return <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 10 }}>
        {[0, 1, 2].map((index) => (
            <View key={index} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color, opacity: reduceMotion === true ? 0.6 : phase === index ? 1 : 0.35, marginLeft: index === 0 ? 0 : 3 }} />
        ))}
    </View>;
}

/** The in-field microphone. `control` sizes it to the composer's circles. */
export function DictateAction({ dictation, control, iconSize = 18 }: { dictation: ComposerDictation; control: ViewStyle; iconSize?: number }) {
    const { theme } = useUnistyles();
    const { recording, transcribing } = dictation;
    return <Pressable onPress={dictation.toggle} disabled={transcribing} accessibilityRole="button"
        accessibilityLabel={recording ? t('plugins.stopDictation') : t('plugins.dictate')}
        accessibilityHint={recording ? t('plugins.stopDictationHint') : 'Adds what you say to the prompt. It never sends by itself.'}
        accessibilityState={{ busy: transcribing, selected: recording, disabled: transcribing }}
        style={({ pressed }) => ({ ...control, opacity: pressed ? 0.6 : 1 })}>
        <Ionicons name="mic-outline" size={iconSize} color={theme.colors.textSecondary} />
    </Pressable>;
}

/**
 * What fills the pill while dictation owns it, or nothing when it is idle.
 * Heard words replace the label as they settle; the newest stay in view and
 * older ones slide off the start. `showLive={false}` keeps the label for a
 * composer whose field stays visible and already shows the words.
 *
 * Stop sits at the trailing end and cancel at the leading one: a stop tap
 * that lands twice puts its second tap on the label, never on cancel. And a
 * cancel is a few seconds of Undo, not a loss.
 */
export function DictationStrip({ dictation, control, showLive = true }: { dictation: ComposerDictation; control: ViewStyle; showLive?: boolean }) {
    const { theme } = useUnistyles();
    const live = showLive ? dictation.live : '';
    // Listening is a state, not an alarm: the level and the stop carry the
    // one red between them, and the stop is a tinted target rather than a
    // solid disc the size of the send.
    if (dictation.recording) return <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
        <DictationBars level={dictation.level} color={theme.colors.status.error} />
        <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: theme.colors.text, fontSize: 15, marginLeft: 10 }}>{live || 'Dictating…'}</Text>
        <Pressable onPress={dictation.toggle} accessibilityRole="button" accessibilityLabel={t('plugins.stopDictation')}
            accessibilityHint={t('plugins.stopDictationHint')}
            style={({ pressed }) => ({ ...control, backgroundColor: withAlpha(theme.colors.status.error, pressed ? 0.28 : 0.18), transform: [{ scale: pressed ? 0.94 : 1 }] })}>
            <Ionicons name="stop" size={13} color={theme.colors.status.error} />
        </Pressable>
    </Animated.View>;
    if (dictation.discarded) return <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
        <Text numberOfLines={1} accessibilityLiveRegion="polite" style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 15, marginLeft: 14 }}>Dictation discarded</Text>
        <Pressable onPress={dictation.undoCancel} accessibilityRole="button" accessibilityLabel="Undo discard"
            accessibilityHint="Puts the dictated words back in the prompt"
            style={({ pressed }) => ({ ...control, width: undefined, paddingHorizontal: 12, opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ color: theme.colors.text, fontSize: 15, fontWeight: '600' }}>Undo</Text>
        </Pressable>
    </Animated.View>;
    if (dictation.transcribing) return <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
        <Pressable onPress={dictation.cancel} accessibilityRole="button" accessibilityLabel="Cancel dictation"
            style={({ pressed }) => ({ ...control, opacity: pressed ? 0.6 : 1 })}>
            <Ionicons name="close" size={19} color={theme.colors.textSecondary} />
        </Pressable>
        <TranscribingDots color={theme.colors.textSecondary} />
        <Text numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, color: theme.colors.textSecondary, fontSize: 15, marginLeft: 10, marginRight: 14 }}>{live || 'Transcribing…'}</Text>
    </Animated.View>;
    return null;
}
