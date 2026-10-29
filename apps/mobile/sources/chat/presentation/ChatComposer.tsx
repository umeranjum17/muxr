import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { withAlpha } from '@/components/ui';
import { DictationStrip, type useComposerDictation } from '@/components/ComposerDictation';
import { startRealtimeCapability, stopRealtimeSession, useRealtimeSessionState } from '@/conversation';
import { RealtimeGlyph } from '@/conversation/ui';
import { modelCommands, splitModelEffort } from '../domain/modelChip';

/** How long a press on the mic has to last before it is live voice rather than dictation. */
const HOLD_MS = 380;

type Dictation = ReturnType<typeof useComposerDictation>;

/**
 * The composer's one microphone. A tap starts dictation into the draft and a
 * second tap ends it; holding it starts live voice with the agent and
 * letting go ends that, so a hand on the glass is the whole of the gesture.
 */
export function ComposerMic({ sessionId, dictation, size }: { sessionId: string; dictation: Dictation; size: number }): React.JSX.Element {
    const { theme } = useUnistyles();
    const realtime = useRealtimeSessionState();
    const held = React.useRef(false);
    const live = realtime.state !== 'disconnected';
    const tint = live ? theme.colors.accent : dictation.recording ? theme.colors.status.error : theme.colors.textSecondary;
    return (
        <Pressable
            delayLongPress={HOLD_MS}
            disabled={dictation.transcribing}
            onPress={dictation.toggle}
            onLongPress={() => {
                held.current = true;
                void startRealtimeCapability({ sessionId }).finally(() => { if (!held.current) stopRealtimeSession(); });
            }}
            onPressOut={() => {
                if (!held.current) return;
                held.current = false;
                stopRealtimeSession();
            }}
            accessibilityRole="button"
            accessibilityLabel={dictation.recording ? 'Stop dictation' : 'Dictate. Hold for live voice'}
            accessibilityHint="Tap to dictate into the message. Hold to talk to the agent, and let go to end it."
            accessibilityState={{ busy: dictation.transcribing || realtime.state === 'connecting', selected: dictation.recording || live }}
            style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: live ? withAlpha(theme.colors.accent, 0.16) : withAlpha(theme.colors.text, 0.1), opacity: pressed ? 0.7 : 1 })}
        >
            {live
                ? <RealtimeGlyph size={Math.round(size * 0.45)} state={realtime.state} color={tint} />
                : <Ionicons name="mic-outline" size={Math.round(size * 0.5)} color={tint} />}
        </Pressable>
    );
}

/**
 * The card the message is written in: the field on top, the controls under it.
 * The chip shows what the harness reports as its model, with the effort dimmer.
 * It lists no models of its own: a tap offers the harness's own command and
 * sends it, and the harness asks.
 */
export function ChatComposerCard(props: {
    input: React.ReactNode;
    dictation: Dictation;
    dictating: boolean;
    controlSize: number;
    attach: React.ReactNode;
    reportedModel: string | undefined;
    agentKind: string | undefined;
    modelEnabled: boolean;
    onModelCommand: (command: string) => void;
    mic: React.ReactNode;
    send: React.ReactNode;
    stop: React.ReactNode;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const commands = modelCommands(props.agentKind);
    const parts = splitModelEffort(props.reportedModel);
    const strip = { width: props.controlSize, height: props.controlSize, borderRadius: props.controlSize / 2, alignItems: 'center' as const, justifyContent: 'center' as const };
    return (
        <View style={{ flex: 1, minWidth: 0, borderRadius: 26, backgroundColor: withAlpha(theme.colors.text, 0.07), borderWidth: 0.5, borderColor: theme.colors.divider, paddingTop: 4, paddingBottom: 8, paddingHorizontal: 8, gap: 4 }}>
            {props.dictating
                ? <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center' }}><DictationStrip dictation={props.dictation} control={strip} /></View>
                : props.input}
            {open && commands.map((entry) => (
                <Pressable key={entry.command} onPress={() => { setOpen(false); props.onModelCommand(entry.command); }} accessibilityRole="button" accessibilityLabel={`${entry.title}, sends ${entry.command}`}
                    style={({ pressed }) => ({ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 14, backgroundColor: withAlpha(theme.colors.text, pressed ? 0.12 : 0.06) })}>
                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.text, fontSize: 14.5, fontWeight: '500' }}>{entry.title}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{entry.command}</Text>
                </Pressable>
            ))}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {props.attach}
                {commands.length > 0 && (
                    <Pressable
                        onPress={() => setOpen((current) => !current)}
                        disabled={!props.modelEnabled}
                        accessibilityRole="button"
                        accessibilityLabel={parts === undefined ? 'Model' : `Model ${parts.model}${parts.effort === undefined ? '' : `, effort ${parts.effort}`}`}
                        accessibilityHint="Changes the model through the agent's own command"
                        accessibilityState={{ expanded: open, disabled: !props.modelEnabled }}
                        style={({ pressed }) => ({ flexShrink: 1, minWidth: 0, height: props.controlSize, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 8, borderRadius: props.controlSize / 2, backgroundColor: withAlpha(theme.colors.text, open ? 0.14 : 0.08), opacity: !props.modelEnabled ? 0.5 : pressed ? 0.7 : 1 })}
                    >
                        <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ flexShrink: 1, color: theme.colors.text, fontSize: 14, fontWeight: '600' }}>{parts?.model ?? 'Model'}</Text>
                        {parts?.effort !== undefined && <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ flexShrink: 0, color: theme.colors.textSecondary, fontSize: 14 }}>{parts.effort}</Text>}
                        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={theme.colors.textSecondary} />
                    </Pressable>
                )}
                <View style={{ flex: 1, minWidth: 0 }} />
                {props.mic}
                {props.send}
                {props.stop}
            </View>
        </View>
    );
}
