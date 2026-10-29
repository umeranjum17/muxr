import * as React from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PhoneAccount, PhoneTurn } from '@byokit/phone';
import { ActionButton } from '@/components/ActionButton';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { PHONE_SUGGESTION } from '../domain/phone';

function Turn(props: { turn: PhoneTurn; busy: boolean; onTryAgain: (requestId: string) => void }) {
    const { turn } = props;
    const working = turn.state === 'running';
    return (
        <View style={styles.turn}>
            <View style={styles.mine}><Text style={styles.mineText} selectable>{turn.text}</Text></View>
            {turn.answer !== '' && <View style={styles.reply}><MarkdownView markdown={turn.answer} /></View>}
            {working && turn.answer === '' && <Text style={styles.hint}>Thinking…</Text>}
            {(turn.state === 'failed' || turn.state === 'interrupted') && (
                <View style={styles.reply}>
                    <Text style={styles.error} accessibilityRole="alert">{turn.words}</Text>
                    {turn.state === 'interrupted' && (
                        <ActionButton title="Try again" icon="refresh-outline" disabled={props.busy} onPress={() => props.onTryAgain(turn.requestId)} />
                    )}
                </View>
            )}
        </View>
    );
}

/** The chat on this phone: what was said, the account that answers, and one box to say more. */
export function PhoneChat(props: {
    account: PhoneAccount;
    turns: PhoneTurn[];
    busy: boolean;
    onSend: (text: string) => void;
    onTryAgain: (requestId: string) => void;
}) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [text, setText] = React.useState('');
    const scroll = React.useRef<ScrollView>(null);
    const blocked = props.turns.some((turn) => turn.state === 'interrupted');
    const canSend = text.trim() !== '' && !props.busy && !blocked;
    const send = (value: string) => {
        const said = value.trim();
        if (said === '' || props.busy || blocked) return;
        setText('');
        props.onSend(said);
    };
    // The window does not resize for the keyboard, so the composer clears it by its measured height.
    const keyboard = useKeyboardState((state) => state.isVisible ? state.height : 0);
    return (
        <View style={styles.fill}>
            <ScrollView
                ref={scroll}
                style={styles.fill}
                contentContainerStyle={styles.thread}
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
            >
                {props.turns.length === 0 ? (
                    <View style={styles.empty}>
                        <Text style={styles.emptyTitle}>Ask for something</Text>
                        <Text style={styles.hint}>This agent runs on your phone. It can change how muxr looks.</Text>
                        <Pressable
                            accessibilityRole="button"
                            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                            onPress={() => send(PHONE_SUGGESTION)}
                        >
                            <Text style={styles.chipText}>{PHONE_SUGGESTION}</Text>
                        </Pressable>
                    </View>
                ) : props.turns.map((turn) => (
                    <Turn key={turn.requestId} turn={turn} busy={props.busy} onTryAgain={props.onTryAgain} />
                ))}
            </ScrollView>
            <View style={[styles.composer, { paddingBottom: keyboard > 0 ? keyboard : Math.max(insets.bottom, 10) }]}>
                <Text style={styles.account}>{props.account.words}</Text>
                <View style={styles.row}>
                    <TextInput
                        accessibilityLabel="Message"
                        style={styles.input}
                        value={text}
                        onChangeText={setText}
                        placeholder={blocked ? 'Tap Try again first' : 'Type a message'}
                        placeholderTextColor={theme.colors.textSecondary}
                        multiline
                        numberOfLines={1}
                        editable={!blocked}
                    />
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Send"
                        accessibilityState={{ disabled: !canSend }}
                        disabled={!canSend}
                        style={[styles.send, !canSend && styles.sendOff]}
                        onPress={() => send(text)}
                    >
                        <Ionicons name="arrow-up" size={20} color={theme.colors.button.primary.tint} />
                    </Pressable>
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    fill: { flex: 1 },
    thread: { flexGrow: 1, width: '100%', maxWidth: 640, alignSelf: 'center', padding: 16, gap: 18 },
    turn: { gap: 10 },
    mine: {
        alignSelf: 'flex-end', maxWidth: '85%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16,
        backgroundColor: theme.colors.surfaceHighest,
    },
    mineText: { ...Typography.default(), fontSize: 16, lineHeight: 22, color: theme.colors.text },
    reply: { alignSelf: 'stretch', gap: 10 },
    hint: { ...Typography.default(), fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    error: { ...Typography.default(), fontSize: 14, lineHeight: 20, color: theme.colors.textDestructive },
    empty: { flexGrow: 1, justifyContent: 'center', alignItems: 'flex-start', gap: 10, paddingVertical: 24 },
    emptyTitle: { ...Typography.default('semiBold'), fontSize: 22, lineHeight: 28, color: theme.colors.text },
    chip: {
        minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 22,
        borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh,
    },
    chipPressed: { opacity: 0.85 },
    chipText: { ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.text },
    composer: {
        width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 8, gap: 6,
        borderTopWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.groupped.background,
    },
    account: { ...Typography.default(), fontSize: 12, lineHeight: 16, color: theme.colors.textSecondary },
    row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
    input: {
        ...Typography.default(), flex: 1, minHeight: 46, maxHeight: 120, paddingHorizontal: 14, paddingVertical: 11,
        borderRadius: 23, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh,
        color: theme.colors.text, fontSize: 16,
    },
    send: {
        width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    sendOff: { opacity: 0.4 },
}));
