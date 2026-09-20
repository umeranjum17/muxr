import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsLight, hapticsSelection } from '@/components/haptics';
import { ui } from '@/components/ui';
import { randomUUID } from 'expo-crypto';
import { Handle } from './TerminalKeyRowEditor';
import { personalReplyErrors, QUICK_REPLY_LABEL_LIMIT, QUICK_REPLY_LIMIT, QUICK_REPLY_TEXT_LIMIT, type PersonalQuickReply } from '../domain/quickReplies';

/**
 * The person's own quick replies: this device's insert-only prompts. The list
 * follows the key-row editor's shape (arrange, then edit one in a form) and
 * the stored format is plain { id, label, text } in local settings.
 */

const STEP = 62;
const CAP_NOTICE = `The list is full at ${QUICK_REPLY_LIMIT} replies. Remove one to add another.`;

export function TerminalQuickReplyEditor({ visible, replies, onChange, onClose }: {
    visible: boolean;
    replies: PersonalQuickReply[];
    onChange: (replies: PersonalQuickReply[]) => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const [working, setWorking] = React.useState<PersonalQuickReply[]>([]);
    const [formIndex, setFormIndex] = React.useState<number | null>(null);
    const [drag, setDrag] = React.useState<{ index: number; translate: number } | null>(null);
    const workingRef = React.useRef<PersonalQuickReply[]>([]);
    const dragIndex = React.useRef(0);
    const accumulated = React.useRef(0);
    const dragging = React.useRef(false);
    const dragOwner = React.useRef<object | null>(null);
    workingRef.current = working;

    // Re-seed only on the closed→open transition, like the key-row editor.
    const wasOpen = React.useRef(false);
    const openState = React.useRef({ replies });
    openState.current = { replies };
    React.useEffect(() => {
        if (visible && !wasOpen.current) {
            wasOpen.current = true;
            setWorking([...openState.current.replies]);
            setFormIndex(null);
            setDrag(null);
            dragging.current = false;
        }
        if (!visible) wasOpen.current = false;
    }, [visible]);

    const commit = (next: PersonalQuickReply[]) => {
        setWorking(next);
        onChange(next);
    };

    const removeAt = (index: number) => {
        if (dragging.current) return;
        hapticsSelection();
        commit(working.filter((_, i) => i !== index));
    };

    const saveReply = (reply: PersonalQuickReply) => {
        if (formIndex === null || dragging.current) return;
        const next = [...working];
        if (formIndex === next.length && next.length >= QUICK_REPLY_LIMIT) return;
        next[formIndex] = reply;
        hapticsSelection();
        commit(next);
        setFormIndex(null);
    };
    const close = () => { if (formIndex !== null) setFormIndex(null); else onClose(); };

    const swap = (a: number, b: number) => {
        const next = [...workingRef.current];
        [next[a], next[b]] = [next[b], next[a]];
        workingRef.current = next;
        setWorking(next);
        onChange(next);
    };

    const moveBy = (index: number, delta: number) => {
        if (dragging.current) return;
        const target = index + delta;
        if (target < 0 || target >= workingRef.current.length) return;
        hapticsSelection();
        swap(index, target);
    };

    const onDrag = (phase: 'start' | 'update' | 'end', index: number, translationY: number, owner: object) => {
        if (phase === 'start') {
            if (dragging.current) return;
            dragging.current = true;
            dragOwner.current = owner;
            hapticsLight();
            dragIndex.current = index;
            accumulated.current = 0;
            setDrag({ index, translate: 0 });
            return;
        }
        if (!dragging.current || dragOwner.current !== owner) return;
        if (phase === 'end') {
            dragging.current = false;
            dragOwner.current = null;
            setDrag(null);
            return;
        }
        let translate = translationY - accumulated.current;
        const last = workingRef.current.length - 1;
        while (translate > STEP / 2 && dragIndex.current < last) {
            swap(dragIndex.current, dragIndex.current + 1);
            dragIndex.current += 1;
            accumulated.current += STEP;
            translate -= STEP;
        }
        while (translate < -STEP / 2 && dragIndex.current > 0) {
            swap(dragIndex.current, dragIndex.current - 1);
            dragIndex.current -= 1;
            accumulated.current -= STEP;
            translate += STEP;
        }
        setDrag({ index: dragIndex.current, translate });
    };

    const sheetHeight = Math.min(windowHeight * 0.85, windowHeight - insets.top - 24);
    const title = formIndex === null ? 'Quick replies' : formIndex < working.length ? 'Edit reply' : 'New reply';

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
            <GestureHandlerRootView style={styles.root}>
            <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <Pressable style={styles.dismiss} onPress={close} accessibilityLabel="Close quick reply editor" />
                <View style={[styles.sheet, {
                    backgroundColor: theme.colors.surface,
                    maxHeight: sheetHeight,
                    paddingBottom: insets.bottom + 12,
                    borderColor: theme.colors.divider,
                }]}>
                    <View style={styles.header}>
                        <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
                        <Pressable onPress={close} accessibilityRole="button" accessibilityLabel={formIndex === null ? 'Done editing replies' : 'Cancel reply changes'} style={styles.close}>
                            <Text style={{ color: theme.colors.accent, fontSize: 14 }}>{formIndex === null ? 'Done' : 'Cancel'}</Text>
                        </Pressable>
                    </View>

                    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                    {formIndex !== null ? <ReplyForm entry={working[formIndex]} onSave={saveReply} onCancel={() => setFormIndex(null)} /> : <>
                    <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Your replies · inserted into the prompt, never sent by themselves</Text>
                    {working.length === 0 && <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Nothing here yet. The built-in replies still live in the command palette.</Text>}
                    <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Tap to edit · hold a handle to reorder</Text>
                    {working.map((reply, index) => {
                        const isDragging = drag?.index === index;
                        return (
                            <View
                                key={reply.id}
                                style={[
                                    styles.row,
                                    { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider },
                                    isDragging && { transform: [{ translateY: drag.translate }], zIndex: 10, borderColor: theme.colors.accent },
                                ]}
                            >
                                <Handle index={index} label={reply.label} onDrag={onDrag} onMove={moveBy} tint={theme.colors.textSecondary} />
                                <Pressable onPress={() => setFormIndex(index)} accessibilityRole="button" accessibilityLabel={`Edit ${reply.label}`} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
                                    <Text style={[styles.rowLabel, { color: theme.colors.text }]} numberOfLines={1}>{reply.label}</Text>
                                    <Text style={[styles.rowSend, { color: theme.colors.textSecondary }]} numberOfLines={1}>{reply.text}</Text>
                                </Pressable>
                                <Pressable onPress={() => removeAt(index)} accessibilityRole="button" accessibilityLabel={`Remove ${reply.label}`} style={styles.close}>
                                    <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />
                                </Pressable>
                            </View>
                        );
                    })}

                    {working.length >= QUICK_REPLY_LIMIT ? (
                        <Text style={[styles.caption, { color: theme.colors.warningCritical }]}>{CAP_NOTICE}</Text>
                    ) : (
                        <Pressable
                            onPress={() => setFormIndex(working.length)}
                            accessibilityRole="button"
                            accessibilityLabel="Add a reply"
                            style={[styles.addRow, { borderColor: theme.colors.accent }]}
                        >
                            <Ionicons name="add" size={18} color={theme.colors.accent} />
                            <Text style={{ color: theme.colors.accent, fontSize: 14 }}>Add a reply</Text>
                        </Pressable>
                    )}
                    </>}
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
            </GestureHandlerRootView>
        </Modal>
    );
}

function ReplyForm({ entry, onSave, onCancel }: {
    entry: PersonalQuickReply | undefined;
    onSave: (reply: PersonalQuickReply) => void;
    onCancel: () => void;
}) {
    const { theme } = useUnistyles();
    const [label, setLabel] = React.useState(entry?.label ?? '');
    const [text, setText] = React.useState(entry?.text ?? '');
    const errors = personalReplyErrors(label, text);
    const valid = errors.length === 0;
    return <View>
        <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Name on the list</Text>
        <TextInput value={label} onChangeText={setLabel} maxLength={QUICK_REPLY_LABEL_LIMIT} accessibilityLabel="Reply name" placeholder="e.g. Ship it" placeholderTextColor={theme.colors.textSecondary} style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.divider }]} />
        <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Text inserted into the prompt</Text>
        <TextInput value={text} onChangeText={setText} multiline maxLength={QUICK_REPLY_TEXT_LIMIT} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Reply text" placeholder="What should be inserted when this reply is tapped" placeholderTextColor={theme.colors.textSecondary} style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.divider, minHeight: 96, textAlignVertical: 'top' }]} />
        {errors.map((error) => <Text key={error} style={{ color: theme.colors.warningCritical, fontSize: 13, marginTop: 4 }}>{error}</Text>)}
        <View style={styles.formActions}>
            <Pressable onPress={onCancel} accessibilityRole="button" style={styles.customDone}><Text style={{ color: theme.colors.textSecondary }}>Cancel</Text></Pressable>
            <Pressable disabled={!valid} accessibilityRole="button" accessibilityLabel="Save reply" accessibilityState={{ disabled: !valid }} style={[styles.customAdd, { backgroundColor: theme.colors.accent, opacity: valid ? 1 : 0.4 }]} onPress={() => {
                if (!valid) return;
                onSave({ id: entry?.id ?? randomUUID(), label: label.trim(), text });
            }}><Text style={{ color: theme.colors.button.primary.tint, fontSize: 14, fontWeight: '600' }}>Save reply</Text></Pressable>
        </View>
    </View>;
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    dismiss: { flex: 1 },
    sheet: { flexShrink: 1, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
    body: { flexShrink: 1 },
    bodyContent: { paddingBottom: 8 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    title: { fontSize: 17, fontWeight: '600' },
    caption: { fontSize: 12, marginTop: 10, marginBottom: 6 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 54, paddingHorizontal: 8, marginTop: 8, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },
    rowLabel: { fontSize: 14, ...Typography.mono() },
    rowSend: { fontSize: 11, marginTop: 3, ...Typography.mono() },
    close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 10, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },
    input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: ui.radius.control, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
    formActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
    customAdd: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: ui.radius.control },
    customDone: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
});
