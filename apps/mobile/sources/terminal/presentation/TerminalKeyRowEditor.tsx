import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsLight, hapticsSelection } from '@/components/haptics';
import { Switch } from '@/components/Switch';
import { ui } from '@/components/ui';
import { BUILTIN_KEY_CATALOG, CATALOG_GROUPS, TERMINAL_KEY_ROW_LIMIT, bytesToEscape, escapeToBytes, modifiedSend, resolveKeyRow, type RowEntry } from '../domain/keyRow';

/**
 * Arrange the live row, then edit one shortcut in a dedicated form. The
 * stored format is unchanged: catalog ids or named terminal byte sequences.
 */

// ponytail: rows live in one ScrollView; a drag cannot autoscroll the list,
// so a drag that reaches the visible edge stops there. Wrap or autoscroll if
// a longer row ever needs it.
const STEP = 62;
const CAP_NOTICE = `The row is full at ${TERMINAL_KEY_ROW_LIMIT} keys. Remove one to add another.`;

export function TerminalKeyRowEditor({ visible, entries, seed, onChange, onClose }: {
    visible: boolean;
    /** The stored row, or null while it follows the built-in row. */
    entries: RowEntry[] | null;
    /** The row to start from when nothing is stored yet (the built-in row). */
    seed: RowEntry[];
    onChange: (entries: RowEntry[] | null) => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const [working, setWorking] = React.useState<RowEntry[]>([]);
    const [formIndex, setFormIndex] = React.useState<number | null>(null);
    const [drag, setDrag] = React.useState<{ index: number; translate: number } | null>(null);
    // Drag math lives in refs: pan updates arrive faster than renders, so the
    // state used for painting must never be the state used for computing.
    const workingRef = React.useRef<RowEntry[]>([]);
    const dragIndex = React.useRef(0);
    const accumulated = React.useRef(0);
    const dragging = React.useRef(false);
    // Only the handle that started the drag may steer it: a second finger on
    // another handle owns a separate recognizer whose updates would otherwise
    // move the first handle's row.
    const dragOwner = React.useRef<object | null>(null);
    workingRef.current = working;

    // Re-seed only on the closed→open transition: commits during an open edit
    // come back through `entries`, and re-seeding then would drop the drag.
    const wasOpen = React.useRef(false);
    const openState = React.useRef({ entries, seed });
    openState.current = { entries, seed };
    React.useEffect(() => {
        if (visible && !wasOpen.current) {
            wasOpen.current = true;
            setWorking([...openState.current.seed]);
            setFormIndex(null);
            setDrag(null);
            dragging.current = false;
        }
        if (!visible) wasOpen.current = false;
    }, [visible]);

    const commit = (next: RowEntry[]) => {
        setWorking(next);
        onChange(next);
    };

    const removeAt = (index: number) => {
        if (dragging.current) return;
        hapticsSelection();
        commit(working.filter((_, i) => i !== index));
    };

    const saveKey = (entry: RowEntry) => {
        if (formIndex === null || dragging.current) return;
        const next = [...working];
        if (formIndex === next.length && next.length >= TERMINAL_KEY_ROW_LIMIT) return;
        next[formIndex] = entry;
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

    // Reordering without the drag gesture, for screen readers and anyone who
    // cannot hold and pan: the same swap the drag performs, one slot at a time.
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
    let title = 'Terminal keys';
    if (formIndex !== null) title = formIndex < working.length ? 'Edit key' : 'New key';

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
            <GestureHandlerRootView style={styles.root}>
            <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <Pressable style={styles.dismiss} onPress={close} accessibilityLabel="Close key row editor" />
                <View style={[styles.sheet, {
                    backgroundColor: theme.colors.surface,
                    maxHeight: sheetHeight,
                    paddingBottom: insets.bottom + 12,
                    borderColor: theme.colors.divider,
                }]}>
                    <View style={styles.header}>
                        <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
                        <Pressable onPress={close} accessibilityRole="button" accessibilityLabel={formIndex === null ? 'Done editing keys' : 'Cancel key changes'} style={styles.close}>
                            <Text style={{ color: theme.colors.accent, fontSize: 14 }}>{formIndex === null ? 'Done' : 'Cancel'}</Text>
                        </Pressable>
                    </View>

                    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                    {formIndex !== null ? <KeyForm entry={working[formIndex]} onSave={saveKey} onCancel={() => setFormIndex(null)} /> : <>
                    <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Your key row · scroll to preview</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3 }}>
                        {resolveKeyRow(working).map((key, index) => <View key={index} style={[styles.previewKey, { backgroundColor: theme.colors.surfaceHigh }]}>
                            <Text style={[styles.rowLabel, { color: theme.colors.text }]}>{key.label}</Text>
                        </View>)}
                    </ScrollView>
                    <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Tap to edit · hold a handle to reorder</Text>
                    {(() => {
                        const occurrence = new Map<string, number>();
                        return working.map((entry, index) => {
                            // Content identity, not position: a stable key keeps the dragged
                            // row's GestureDetector alive across the swaps it causes.
                            const id = typeof entry === 'string' ? entry : JSON.stringify([entry.label, entry.send]);
                            const nth = occurrence.get(id) ?? 0;
                            occurrence.set(id, nth + 1);
                            const label = typeof entry === 'string' ? BUILTIN_KEY_CATALOG[entry]?.label ?? entry : entry.label;
                            const send = typeof entry === 'string' ? BUILTIN_KEY_CATALOG[entry]?.send ?? '' : entry.send;
                            const isDragging = drag?.index === index;
                            return (
                                <View
                                    key={`${id}:${nth}`}
                                    style={[
                                        styles.row,
                                        { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider },
                                        isDragging && { transform: [{ translateY: drag.translate }], zIndex: 10, borderColor: theme.colors.accent },
                                    ]}
                                >
                                    <Handle index={index} label={label} onDrag={onDrag} onMove={moveBy} tint={theme.colors.textSecondary} />
                                    <Pressable onPress={() => setFormIndex(index)} accessibilityRole="button" accessibilityLabel={`Edit ${label}`} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
                                        <Text style={[styles.rowLabel, { color: theme.colors.text }]}>{label}</Text>
                                        <Text style={[styles.rowSend, { color: theme.colors.textSecondary }]} numberOfLines={1}>{bytesToEscape(send)}</Text>
                                    </Pressable>
                                    <Pressable onPress={() => removeAt(index)} accessibilityRole="button" accessibilityLabel={`Remove ${label}`} style={styles.close}>
                                        <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>
                            );
                        });
                    })()}

                    {working.length >= TERMINAL_KEY_ROW_LIMIT ? (
                        <Text style={[styles.caption, { color: theme.colors.warningCritical }]}>{CAP_NOTICE}</Text>
                    ) : (
                        <Pressable
                            onPress={() => setFormIndex(working.length)}
                            accessibilityRole="button"
                            accessibilityLabel="Add a key"
                            style={[styles.addRow, { borderColor: theme.colors.accent }]}
                        >
                            <Ionicons name="add" size={18} color={theme.colors.accent} />
                            <Text style={{ color: theme.colors.accent, fontSize: 14 }}>Add a key</Text>
                        </Pressable>
                    )}

                    {entries !== null && (
                        <Pressable onPress={() => { hapticsSelection(); onChange(null); onClose(); }} accessibilityRole="button" accessibilityLabel="Reset key row to the default row" style={styles.resetRow}>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Reset to the default row</Text>
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

/** Hold the handle to lift the row, then drag; the list swaps underneath. */
function Handle({ index, label, onDrag, onMove, tint }: {
    index: number;
    label: string;
    onDrag: (phase: 'start' | 'update' | 'end', index: number, translationY: number, owner: object) => void;
    onMove: (index: number, delta: number) => void;
    tint: string;
}) {
    // Built once per row; callbacks read the row's live position through a ref
    // so a swap never rebuilds (and cancels) the pan mid-gesture.
    const live = React.useRef({ index, onDrag, onMove });
    live.current = { index, onDrag, onMove };
    const pan = React.useMemo(() => Gesture.Pan()
        .activateAfterLongPress(250)
        .runOnJS(true)
        .onStart(() => live.current.onDrag('start', live.current.index, 0, live))
        .onUpdate((event) => live.current.onDrag('update', live.current.index, event.translationY, live))
        .onEnd(() => live.current.onDrag('end', live.current.index, 0, live))
        .onFinalize(() => live.current.onDrag('end', live.current.index, 0, live)), []);
    return (
        <GestureDetector gesture={pan}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reorder ${label}`}
                accessibilityHint="Hold and drag, or use the move up and move down actions"
                accessibilityActions={[{ name: 'moveUp', label: 'Move up' }, { name: 'moveDown', label: 'Move down' }]}
                onAccessibilityAction={(event) => live.current.onMove(live.current.index, event.nativeEvent.actionName === 'moveUp' ? -1 : 1)}
                hitSlop={8}
                style={styles.handle}
            >
                <Ionicons name="reorder-three-outline" size={22} color={tint} />
            </Pressable>
        </GestureDetector>
    );
}

function KeyForm({ entry, onSave, onCancel }: {
    entry: RowEntry | undefined;
    onSave: (entry: RowEntry) => void;
    onCancel: () => void;
}) {
    const { theme } = useUnistyles();
    const custom = typeof entry === 'object' ? entry : undefined;
    const [mode, setMode] = React.useState<'key' | 'text'>(custom ? 'text' : 'key');
    const [keyId, setKeyId] = React.useState(typeof entry === 'string' ? entry : 'esc');
    const [letter, setLetter] = React.useState('');
    const [ctrl, setCtrl] = React.useState(false);
    const [shift, setShift] = React.useState(false);
    const [label, setLabel] = React.useState(custom?.label ?? '');
    const [sendText, setSendText] = React.useState(custom ? bytesToEscape(custom.send) : '');
    const [repeat, setRepeat] = React.useState(custom?.repeat === true || BUILTIN_KEY_CATALOG[keyId]?.repeat === true);
    const selected = letter !== '' ? { label: letter, accessibilityLabel: letter, send: letter } : BUILTIN_KEY_CATALOG[keyId];
    const bytes = mode === 'text' ? escapeToBytes(sendText) : modifiedSend(selected, ctrl, shift);
    const suggestedLabel = [ctrl ? 'Ctrl' : '', shift ? 'Shift' : '', selected.label].filter(Boolean).join(' ');
    const savedLabel = label.trim() || (mode === 'key' ? suggestedLabel : '');
    const valid = bytes !== null && bytes.length <= 512 && savedLabel.length > 0 && savedLabel.length <= 12;
    const chip = (active: boolean) => [styles.gridChip, { backgroundColor: active ? theme.colors.accent : theme.colors.surfaceHigh }];
    const ink = (active: boolean) => ({ color: active ? theme.colors.button.primary.tint : theme.colors.text, fontSize: 13, ...Typography.mono() });
    return <View>
        <View style={styles.grid}>
            {(['key', 'text'] as const).map((value) => <Pressable key={value} onPress={() => setMode(value)} accessibilityRole="button" accessibilityState={{ selected: mode === value }} style={chip(mode === value)}>
                <Text style={ink(mode === value)}>{value === 'key' ? 'Key combination' : 'Text / escapes'}</Text>
            </Pressable>)}
        </View>
        <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Name on the key</Text>
        <TextInput value={label} onChangeText={setLabel} maxLength={12} accessibilityLabel="Key name" placeholder={mode === 'key' ? suggestedLabel : 'e.g. status'} placeholderTextColor={theme.colors.textSecondary} style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.divider }]} />
        {mode === 'key' ? <>
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Modifiers</Text>
            <View style={styles.grid}>
                <Pressable onPress={() => setCtrl(!ctrl)} accessibilityRole="button" accessibilityLabel="Control modifier" accessibilityState={{ selected: ctrl }} style={chip(ctrl)}><Text style={ink(ctrl)}>Ctrl</Text></Pressable>
                <Pressable onPress={() => setShift(!shift)} accessibilityRole="button" accessibilityLabel="Shift modifier" accessibilityState={{ selected: shift }} style={chip(shift)}><Text style={ink(shift)}>Shift</Text></Pressable>
                <TextInput value={letter} onChangeText={setLetter} maxLength={1} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Letter or character" placeholder="A–Z" placeholderTextColor={theme.colors.textSecondary} style={[styles.input, { minWidth: 64, color: theme.colors.text, borderColor: theme.colors.divider }]} />
            </View>
            {CATALOG_GROUPS.map((group) => <View key={group.title}>
                <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>{group.title}</Text>
                <View style={styles.grid}>{group.ids.map((id) => {
                    const active = keyId === id && letter === '';
                    return <Pressable key={id} onPress={() => { setKeyId(id); setLetter(''); setRepeat(BUILTIN_KEY_CATALOG[id].repeat === true); }} accessibilityRole="button" accessibilityLabel={`Choose ${BUILTIN_KEY_CATALOG[id].accessibilityLabel}`} accessibilityState={{ selected: active }} style={chip(active)}>
                        <Text style={ink(active)}>{BUILTIN_KEY_CATALOG[id].label}</Text>
                    </Pressable>;
                })}</View>
            </View>)}
        </> : <>
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Text or terminal escapes</Text>
            <TextInput value={sendText} onChangeText={setSendText} multiline autoCapitalize="none" autoCorrect={false} accessibilityLabel="Keys or text to send" placeholder={'e.g. git status\\r'} placeholderTextColor={theme.colors.textSecondary} style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.divider, ...Typography.mono() }]} />
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>{'\\e Escape · \\r Enter · \\t Tab · \\x03 Ctrl+C · \\\\ backslash'}</Text>
        </>}
        <View style={[styles.sequence, { backgroundColor: theme.colors.surfaceHigh }]}>
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Sends</Text>
            <Text selectable style={[styles.rowLabel, { color: theme.colors.text }]}>{bytes === null ? 'Choose a valid key combination or escape sequence.' : bytesToEscape(bytes)}</Text>
        </View>
        {savedLabel.length > 12 && <Text style={{ color: theme.colors.warningCritical }}>Keep the name to 12 characters.</Text>}
        {bytes !== null && bytes.length > 512 && <Text style={{ color: theme.colors.warningCritical }}>Keep the sequence to 512 characters.</Text>}
        <View style={styles.repeatRow}>
            <Text style={{ color: theme.colors.text, fontSize: 14 }}>Repeat while held</Text>
            <Switch value={repeat} onValueChange={setRepeat} accessibilityLabel="Repeat while held" />
        </View>
        <View style={styles.formActions}>
            <Pressable onPress={onCancel} accessibilityRole="button" style={styles.customDone}><Text style={{ color: theme.colors.textSecondary }}>Cancel</Text></Pressable>
            <Pressable disabled={!valid} accessibilityRole="button" accessibilityLabel="Save key" accessibilityState={{ disabled: !valid }} style={[styles.customAdd, { backgroundColor: theme.colors.accent, opacity: valid ? 1 : 0.4 }]} onPress={() => {
                if (!valid || bytes === null) return;
                const unchangedBuiltin = mode === 'key' && letter === '' && !ctrl && !shift && label.trim() === '' && repeat === (selected.repeat === true);
                onSave(unchangedBuiltin ? keyId : { label: savedLabel, send: bytes, ...(repeat ? { repeat: true } : {}) });
            }}><Text style={{ color: theme.colors.button.primary.tint, fontSize: 14, fontWeight: '600' }}>Save key</Text></Pressable>
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
    handle: { paddingHorizontal: 6, paddingVertical: 12 },
    rowLabel: { fontSize: 14, ...Typography.mono() },
    rowSend: { fontSize: 11, marginTop: 3, ...Typography.mono() },
    previewKey: { minWidth: 44, height: 44, paddingHorizontal: 8, borderRadius: ui.radius.control, alignItems: 'center', justifyContent: 'center' },
    close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 10, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    gridChip: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: ui.radius.control },
    input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: ui.radius.control, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
    sequence: { marginTop: 16, padding: 12, borderRadius: ui.radius.control },
    formActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
    repeatRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
    customAdd: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: ui.radius.control },
    customDone: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
    resetRow: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
});
