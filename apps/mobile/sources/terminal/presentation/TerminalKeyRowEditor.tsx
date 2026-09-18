import * as React from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsLight, hapticsSelection } from '@/components/haptics';
import { Switch } from '@/components/Switch';
import { ui } from '@/components/ui';
import { BUILTIN_KEY_CATALOG, CATALOG_GROUPS, TERMINAL_KEY_ROW_LIMIT, bytesToEscape, escapeToBytes, type CustomKey, type RowEntry } from '../domain/keyRow';

/**
 * Edit the key row at the point of use: a sheet over the terminal that shows
 * the live row, one editable line per key (hold the handle, drag to reorder,
 * minus to remove), the add-key grid, and a custom-key form speaking the
 * `\e` `\n` `\xHH` escape syntax.
 */

// ponytail: rows live in one ScrollView; a drag cannot autoscroll the list,
// so a drag that reaches the visible edge stops there. Wrap or autoscroll if
// a longer row ever needs it.
const STEP = 62;
const CAP_NOTICE = `The row is full at ${TERMINAL_KEY_ROW_LIMIT} keys. Remove one to add another.`;

export function TerminalKeyRowEditor({ visible, entries, seed, keys, onChange, onClose }: {
    visible: boolean;
    /** The stored row, or null while it follows the built-in row. */
    entries: RowEntry[] | null;
    /** The row to start from when nothing is stored yet (the built-in row). */
    seed: RowEntry[];
    keys: { label: string; accessibilityLabel: string; send: string }[];
    onChange: (entries: RowEntry[] | null) => void;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const [working, setWorking] = React.useState<RowEntry[]>([]);
    const [adding, setAdding] = React.useState(false);
    const [drag, setDrag] = React.useState<{ index: number; translate: number } | null>(null);
    // Drag math lives in refs: pan updates arrive faster than renders, so the
    // state used for painting must never be the state used for computing.
    const workingRef = React.useRef<RowEntry[]>([]);
    const dragIndex = React.useRef(0);
    const accumulated = React.useRef(0);
    const dragging = React.useRef(false);
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
            setAdding(false);
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

    const appendEntry = (entry: RowEntry) => {
        if (dragging.current || working.length >= TERMINAL_KEY_ROW_LIMIT) return;
        hapticsSelection();
        commit([...working, entry]);
    };

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

    const onDrag = (phase: 'start' | 'update' | 'end', index: number, translationY: number) => {
        if (phase === 'start') {
            if (dragging.current) return;
            dragging.current = true;
            hapticsLight();
            dragIndex.current = index;
            accumulated.current = 0;
            setDrag({ index, translate: 0 });
            return;
        }
        if (!dragging.current) return;
        if (phase === 'end') {
            dragging.current = false;
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

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <GestureHandlerRootView style={styles.backdrop}>
                <Pressable style={styles.dismiss} onPress={onClose} accessibilityLabel="Close key row editor" />
                <View style={[styles.sheet, {
                    backgroundColor: theme.colors.surface,
                    height: sheetHeight,
                    paddingBottom: insets.bottom + 12,
                    borderColor: theme.colors.divider,
                }]}>
                    <View style={styles.header}>
                        <Text style={[styles.title, { color: theme.colors.text }]}>Key row</Text>
                        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Done" hitSlop={8}>
                            <Ionicons name="close" size={22} color={theme.colors.text} />
                        </Pressable>
                    </View>

                    <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                    <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Live preview</Text>
                    <View style={[styles.preview, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                        {keys.map((key, index) => (
                            <View key={`${key.label}:${index}`} style={styles.previewChip}>
                                <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.mono() }}>{key.label}</Text>
                            </View>
                        ))}
                        {keys.length === 0 && <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Empty row</Text>}
                    </View>

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
                                    <Text style={[styles.rowLabel, { color: theme.colors.text }]}>{label}</Text>
                                    <Text style={[styles.rowSend, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                        sends {bytesToEscape(send)}
                                    </Text>
                                    <Pressable onPress={() => removeAt(index)} accessibilityRole="button" accessibilityLabel={`Remove ${label}`} hitSlop={6}>
                                        <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>
                            );
                        });
                    })()}

                    {adding ? (
                        <AddPanel atLimit={working.length >= TERMINAL_KEY_ROW_LIMIT} onAppend={appendEntry} onDone={() => setAdding(false)} />
                    ) : working.length >= TERMINAL_KEY_ROW_LIMIT ? (
                        <Text style={[styles.caption, { color: theme.colors.warningCritical }]}>{CAP_NOTICE}</Text>
                    ) : (
                        <Pressable
                            onPress={() => setAdding(true)}
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
                    </ScrollView>
                </View>
            </GestureHandlerRootView>
        </Modal>
    );
}

/** Hold the handle to lift the row, then drag; the list swaps underneath. */
function Handle({ index, label, onDrag, onMove, tint }: {
    index: number;
    label: string;
    onDrag: (phase: 'start' | 'update' | 'end', index: number, translationY: number) => void;
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
        .onStart(() => live.current.onDrag('start', live.current.index, 0))
        .onUpdate((event) => live.current.onDrag('update', live.current.index, event.translationY))
        .onEnd(() => live.current.onDrag('end', live.current.index, 0))
        .onFinalize(() => live.current.onDrag('end', live.current.index, 0)), []);
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

function AddPanel({ atLimit, onAppend, onDone }: {
    atLimit: boolean;
    onAppend: (entry: RowEntry) => void;
    onDone: () => void;
}) {
    const { theme } = useUnistyles();
    const [label, setLabel] = React.useState('');
    const [sendText, setSendText] = React.useState('');
    const [repeat, setRepeat] = React.useState(false);
    const bytes = escapeToBytes(sendText);
    const canAdd = !atLimit && label.trim() !== '' && bytes !== null && bytes.length <= 512;
    const problem = sendText.trim() === '' ? null
        : bytes === null ? 'That escape is unfinished, or names a byte above \\x7f. Use \\\\ for a literal backslash.'
        : bytes.length > 512 ? `That sends ${bytes.length} characters; the limit is 512.`
        : null;
    return (
        <View style={styles.addPanel}>
            {atLimit && <Text style={[styles.caption, { color: theme.colors.warningCritical }]}>{CAP_NOTICE}</Text>}
            {CATALOG_GROUPS.map((group) => (
                <View key={group.title}>
                    <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>{group.title}</Text>
                    <View style={styles.grid}>
                        {group.ids.map((id) => (
                            <Pressable
                                key={id}
                                onPress={() => onAppend(id)}
                                disabled={atLimit}
                                accessibilityRole="button"
                                accessibilityState={{ disabled: atLimit }}
                                accessibilityLabel={`Add ${BUILTIN_KEY_CATALOG[id].accessibilityLabel}`}
                                style={({ pressed }) => [styles.gridChip, { backgroundColor: theme.colors.surfaceHigh }, atLimit && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
                            >
                                <Text style={{ color: theme.colors.text, fontSize: 12, ...Typography.mono() }}>{BUILTIN_KEY_CATALOG[id].label}</Text>
                            </Pressable>
                        ))}
                    </View>
                </View>
            ))}
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Custom key</Text>
            <View style={styles.customForm}>
                <TextInput
                    value={label}
                    onChangeText={setLabel}
                    maxLength={12}
                    placeholder="Label"
                    placeholderTextColor={theme.colors.textSecondary}
                    style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.divider }]}
                />
                <TextInput
                    value={sendText}
                    onChangeText={setSendText}
                    placeholder="Keys or text to send"
                    placeholderTextColor={theme.colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.input, styles.sendInput, { color: theme.colors.text, borderColor: theme.colors.divider }]}
                />
            </View>
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>
                {'Escapes: \\e Esc · \\n Enter · \\t Tab · \\x03 Ctrl+C · \\\\ backslash. Anything else sends as typed.'}
            </Text>
            {problem !== null && <Text style={[styles.caption, { color: theme.colors.warningCritical }]}>{problem}</Text>}
            <View style={styles.repeatRow}>
                <Text style={{ color: theme.colors.text, fontSize: 13 }}>Repeat while held</Text>
                <Switch value={repeat} onValueChange={setRepeat} />
            </View>
            <View style={styles.addRow}>
                <Pressable
                    onPress={() => {
                        if (!canAdd || bytes === null) return;
                        const custom: CustomKey = {
                            label: label.trim(),
                            send: bytes,
                            ...(repeat ? { repeat: true } : {}),
                        };
                        onAppend(custom);
                        setLabel('');
                        setSendText('');
                        setRepeat(false);
                    }}
                    disabled={!canAdd}
                    accessibilityRole="button"
                    accessibilityLabel="Add custom key"
                    style={[styles.customAdd, { backgroundColor: canAdd ? theme.colors.accent : theme.colors.surfaceHigh }]}
                >
                    <Text style={{ color: canAdd ? '#fff' : theme.colors.textSecondary, fontSize: 14 }}>Add key</Text>
                </Pressable>
                <Pressable onPress={onDone} accessibilityRole="button" accessibilityLabel="Done adding keys" style={styles.customDone}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>Done</Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    dismiss: { flex: 1 },
    sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
    body: { flex: 1 },
    bodyContent: { paddingBottom: 8 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    title: { fontSize: 17, fontWeight: '600' },
    caption: { fontSize: 12, marginTop: 10, marginBottom: 6 },
    preview: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 8, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },
    previewChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: ui.radius.control, backgroundColor: 'rgba(127,127,127,0.18)' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 54, paddingHorizontal: 8, marginTop: 8, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },
    handle: { paddingHorizontal: 6, paddingVertical: 12 },
    rowLabel: { fontSize: 14, width: 56, ...Typography.mono() },
    rowSend: { fontSize: 12, flex: 1 },
    addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 10, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },
    addPanel: { marginTop: 4 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    gridChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: ui.radius.control },
    customForm: { flexDirection: 'row', gap: 8 },
    input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: ui.radius.control, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, minWidth: 80 },
    sendInput: { flex: 1 },
    repeatRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
    customAdd: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: ui.radius.control },
    customDone: { paddingHorizontal: 16, paddingVertical: 10 },
    resetRow: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
});
