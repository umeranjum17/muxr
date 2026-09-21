import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { Switch } from '@/components/Switch';
import { ui } from '@/components/ui';
import { useLocalSettingMutable } from '@/catalog/store';
import { BUILTIN_KEY_CATALOG, CATALOG_GROUPS, TERMINAL_KEY_ROW_LIMIT, bytesToEscape, escapeToBytes, modifiedSend, resolveKeyRow, type RowEntry } from '../domain/keyRow';
import { useReorderableList } from './useReorderableList';
import { randomUUID } from 'expo-crypto';
import { personalReplyErrors, QUICK_REPLY_LABEL_LIMIT, QUICK_REPLY_LIMIT, QUICK_REPLY_TEXT_LIMIT, type PersonalQuickReply } from '../domain/quickReplies';

/**
 * The terminal control grid: one dense, categorised sheet for everything the
 * terminal's controls can become — the key row (with a live preview), the
 * person's own snippets, recent links, appearance, and keyboard actions.
 * Arrangement and the stored formats are unchanged: catalog ids or named
 * terminal byte sequences, and plain { id, label, text } replies.
 */

export type ControlGridCategory = 'keys' | 'snippets' | 'recents' | 'appearance' | 'keyboard';

const CATEGORIES: readonly { id: ControlGridCategory; label: string }[] = [
    { id: 'keys', label: 'Keys' },
    { id: 'snippets', label: 'Snippets' },
    { id: 'recents', label: 'Recents' },
    { id: 'appearance', label: 'Look' },
    { id: 'keyboard', label: 'Keyboard' },
];

/** A screen-owned command the grid can run: zoom, keyboard, and their kind. */
export type GridCommand = { label: string; run: () => void; disabled?: boolean };

// ponytail: rows live in one ScrollView; a drag cannot autoscroll the list,
// so a drag that reaches the visible edge stops there. Wrap or autoscroll if
// a longer row ever needs it.
const CAP_NOTICE = `The row is full at ${TERMINAL_KEY_ROW_LIMIT} keys.`;
const REPLY_CAP_NOTICE = `The list is full at ${QUICK_REPLY_LIMIT} snippets.`;

export function TerminalControlGrid({
    visible,
    category,
    onCategoryChange,
    onClose,
    entries,
    seed,
    onChange,
    replies,
    onRepliesChange,
    recentLinks,
    onRecentLink,
    viewCommands,
    keyboardDisabled,
    onKeyboardDisabledChange,
}: {
    visible: boolean;
    category: ControlGridCategory;
    onCategoryChange: (category: ControlGridCategory) => void;
    onClose: () => void;
    /** The stored row, or null while it follows the built-in row. */
    entries: RowEntry[] | null;
    /** The row to start from when nothing is stored yet (the built-in row). */
    seed: RowEntry[];
    onChange: (entries: RowEntry[] | null) => void;
    replies: PersonalQuickReply[];
    onRepliesChange: (replies: PersonalQuickReply[]) => void;
    recentLinks: readonly string[];
    onRecentLink: (url: string, action: 'open' | 'copy') => void;
    viewCommands: readonly GridCommand[];
    keyboardDisabled: boolean;
    onKeyboardDisabledChange: (value: boolean) => void;
}) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const [modifierIcons, setModifierIcons] = useLocalSettingMutable('terminalModifierIcons');
    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
            <GestureHandlerRootView style={[styles.page, { backgroundColor: theme.colors.surface, paddingTop: insets.top }]}>
                <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                    <View style={styles.header}>
                        <Text style={[styles.title, { color: theme.colors.text }]}>Controls</Text>
                        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Done editing controls" style={styles.closeText}>
                            <Text style={{ color: theme.colors.accent, fontSize: 15, fontWeight: '600' }}>Done</Text>
                        </Pressable>
                    </View>

                    {/* The category tabs: the grid's own switch row, all five visible. */}
                    <View style={styles.categoryRow}>
                        {CATEGORIES.map((entry) => {
                            const active = entry.id === category;
                            return <Pressable key={entry.id} onPress={() => { hapticsSelection(); onCategoryChange(entry.id); }}
                                accessibilityRole="button" accessibilityLabel={`${entry.label} category`} accessibilityState={{ selected: active }}
                                style={[styles.categoryChip, { backgroundColor: active ? theme.colors.accent : theme.colors.surfaceHigh }]}>
                                <Text style={{ color: active ? theme.colors.button.primary.tint : theme.colors.text, fontSize: 13, fontWeight: active ? '600' : '400' }}>{entry.label}</Text>
                            </Pressable>;
                        })}
                    </View>

                        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                            {category === 'keys' && <KeysCategory entries={entries} seed={seed} onChange={onChange} modifierIcons={modifierIcons === true} onChangeModifierIcons={(value) => { hapticsSelection(); setModifierIcons(value); }} />}
                            {category === 'snippets' && <SnippetsCategory replies={replies} onRepliesChange={onRepliesChange} />}
                            {category === 'recents' && (
                                recentLinks.length === 0
                                    ? <SectionNote>Links printed by the terminal gather here.</SectionNote>
                                    : <View style={[styles.card, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                                        {recentLinks.map((url, index) => (
                                            <View key={`${url}:${index}`} style={[styles.cardRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }]}>
                                                <Pressable accessibilityRole="button" accessibilityLabel={`Open ${url}`} onPress={() => onRecentLink(url, 'open')} style={styles.cardRowMain}>
                                                    <Text numberOfLines={1} style={[styles.rowLabel, { color: theme.colors.text }]}>{url}</Text>
                                                </Pressable>
                                                <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${url}`} onPress={() => onRecentLink(url, 'copy')} style={styles.cardRowAction}>
                                                    <Ionicons name="copy-outline" size={18} color={theme.colors.textSecondary} />
                                                </Pressable>
                                                <Pressable accessibilityRole="button" accessibilityLabel={`Open link ${url}`} onPress={() => onRecentLink(url, 'open')} style={styles.cardRowAction}>
                                                    <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
                                                </Pressable>
                                            </View>
                                        ))}
                                    </View>
                            )}
                            {category === 'appearance' && (
                                <View style={[styles.card, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                                    {viewCommands.map((command, index) => (
                                        <Pressable key={command.label} disabled={command.disabled === true} accessibilityRole="button" accessibilityLabel={command.label} accessibilityState={{ disabled: command.disabled === true }}
                                            onPress={() => { onClose(); command.run(); }}
                                            style={[styles.cardRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }, command.disabled === true && { opacity: 0.4 }]}>
                                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{command.label}</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ))}
                                </View>
                            )}
                            {category === 'keyboard' && (
                                <View style={[styles.card, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                                    {viewCommands.filter((command) => command.label.toLowerCase().includes('keyboard')).map((command) => (
                                        <Pressable key={command.label} accessibilityRole="button" accessibilityLabel={command.label} onPress={() => { onClose(); command.run(); }}
                                            style={[styles.cardRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }]}>
                                            <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>{command.label}</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ))}
                                    <View style={[styles.cardRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }]}>
                                        <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Keyboard opens from the key row only</Text>
                                        <Switch value={keyboardDisabled} onValueChange={onKeyboardDisabledChange} accessibilityLabel="Keyboard opens from the key row only" />
                                    </View>
                                </View>
                            )}
                        </ScrollView>
                    </KeyboardAvoidingView>
                </GestureHandlerRootView>
        </Modal>
    );
}

function SectionNote({ children }: { children: React.ReactNode }) {
    return <Text style={[styles.caption, { marginTop: 16 }]}>{children}</Text>;
}

/** Section label in the reference's small-caps voice. */
function SectionLabel({ children }: { children: React.ReactNode }) {
    return <Text style={[styles.sectionLabel, { marginTop: 14, marginBottom: 6 }]}>{children}</Text>;
}

function KeysCategory({ entries, seed, onChange, modifierIcons, onChangeModifierIcons }: {
    entries: RowEntry[] | null;
    seed: RowEntry[];
    onChange: (entries: RowEntry[] | null) => void;
    modifierIcons: boolean;
    onChangeModifierIcons: (value: boolean) => void;
}) {
    const { theme } = useUnistyles();
    const { working, drag, commit, removeAt, moveBy, onDrag, isDragging } = useReorderableList<RowEntry>(true, seed, onChange);
    const [formIndex, setFormIndex] = React.useState<number | null>(null);

    const saveKey = (entry: RowEntry) => {
        if (formIndex === null || isDragging()) return;
        const next = [...working];
        if (formIndex === next.length && next.length >= TERMINAL_KEY_ROW_LIMIT) return;
        next[formIndex] = entry;
        hapticsSelection();
        commit(next);
        setFormIndex(null);
    };

    if (formIndex !== null) {
        return <KeyForm entry={working[formIndex]} onSave={saveKey} onCancel={() => setFormIndex(null)} />;
    }
    return <View>
        <SectionLabel>LIVE PREVIEW</SectionLabel>
        <View style={[styles.previewBox, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4, alignItems: 'center' }}>
                {['ctrl', 'shift'].map((label) => <View key={label} style={[styles.previewKey, { backgroundColor: theme.colors.glass.backgroundSubtle }]}>
                    <Text style={[styles.rowLabel, { color: theme.colors.textSecondary }]}>{modifierIcons ? (label === 'ctrl' ? '\u2303' : '\u21e7') : label}</Text>
                </View>)}
                {resolveKeyRow(working).map((key, index) => <View key={index} style={[styles.previewKey, { backgroundColor: theme.colors.glass.backgroundSubtle }]}>
                    <Text style={[styles.rowLabel, { color: theme.colors.text }]}>{key.label}</Text>
                </View>)}
            </ScrollView>
        </View>

        <SectionLabel>DISPLAY</SectionLabel>
        <View style={[styles.card, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
            <View style={styles.cardRow}>
                <Text style={{ flex: 1, color: theme.colors.text, fontSize: 15 }}>Use Icons for Modifier Keys</Text>
                <Switch value={modifierIcons} onValueChange={onChangeModifierIcons} accessibilityLabel="Use Icons for Modifier Keys" />
            </View>
        </View>

        <SectionLabel>TOOLBAR BUTTONS</SectionLabel>
        <Text style={[styles.caption]}>Tap to edit · hold a handle to reorder</Text>
        <View style={[styles.card, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
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
                    const dragging = drag?.index === index;
                    return (
                        <View
                            key={`${id}:${nth}`}
                            style={[
                                styles.cardRow,
                                index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
                                dragging && { transform: [{ translateY: drag.translate }], zIndex: 10, borderColor: theme.colors.accent },
                            ]}
                        >
                            <Pressable onPress={() => removeAt(index)} accessibilityRole="button" accessibilityLabel={`Remove ${label}`} style={styles.cardRowAction}>
                                <Ionicons name="remove-circle-outline" size={22} color={theme.colors.status.error} />
                            </Pressable>
                            <Pressable onPress={() => setFormIndex(index)} accessibilityRole="button" accessibilityLabel={`Edit ${label}`} style={{ flex: 1, minHeight: 56, justifyContent: 'center' }}>
                                <Text style={[styles.rowLabel, { color: theme.colors.text }]}>{label}</Text>
                                <Text style={[styles.rowSend, { color: theme.colors.textSecondary }]} numberOfLines={1}>{bytesToEscape(send)}</Text>
                            </Pressable>
                            <Handle index={index} label={label} onDrag={onDrag} onMove={moveBy} tint={theme.colors.textSecondary} />
                        </View>
                    );
                });
            })()}
        </View>

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
            <Pressable onPress={() => { hapticsSelection(); onChange(null); }} accessibilityRole="button" accessibilityLabel="Reset key row to the default row" style={styles.resetRow}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Reset to the default row</Text>
            </Pressable>
        )}
    </View>;
}

// The toggle lives in local settings; the grid owns it and passes it down.

function SnippetsCategory({ replies, onRepliesChange }: {
    replies: PersonalQuickReply[];
    onRepliesChange: (replies: PersonalQuickReply[]) => void;
}) {
    const { theme } = useUnistyles();
    const { working, drag, commit, removeAt, onDrag, moveBy, isDragging } = useReorderableList<PersonalQuickReply>(true, replies, onRepliesChange);
    const [formIndex, setFormIndex] = React.useState<number | null>(null);

    const saveReply = (reply: PersonalQuickReply) => {
        if (formIndex === null || isDragging()) return;
        const next = [...working];
        if (formIndex === next.length && next.length >= QUICK_REPLY_LIMIT) return;
        next[formIndex] = reply;
        hapticsSelection();
        commit(next);
        setFormIndex(null);
    };

    if (formIndex !== null) {
        return <ReplyForm entry={working[formIndex]} onSave={saveReply} onCancel={() => setFormIndex(null)} />;
    }
    return <View>
        <Text style={[styles.caption]}>Your snippets · inserted into the prompt, never sent by themselves</Text>
        {working.length === 0 && <Text style={[styles.caption]}>Nothing here yet. The built-in replies still live in the command palette.</Text>}
        <View style={[styles.card, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
            {working.map((reply, index) => {
                const dragging = drag?.index === index;
                return (
                    <View
                        key={reply.id}
                        style={[
                            styles.cardRow,
                            index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
                            dragging && { transform: [{ translateY: drag.translate }], zIndex: 10, borderColor: theme.colors.accent },
                        ]}
                    >
                        <Pressable onPress={() => removeAt(index)} accessibilityRole="button" accessibilityLabel={`Remove ${reply.label}`} style={styles.cardRowAction}>
                            <Ionicons name="remove-circle-outline" size={22} color={theme.colors.status.error} />
                        </Pressable>
                        <Pressable onPress={() => setFormIndex(index)} accessibilityRole="button" accessibilityLabel={`Edit ${reply.label}`} style={{ flex: 1, minHeight: 56, justifyContent: 'center' }}>
                            <Text style={[styles.rowLabel, { color: theme.colors.text }]} numberOfLines={1}>{reply.label}</Text>
                            <Text style={[styles.rowSend, { color: theme.colors.textSecondary }]} numberOfLines={1}>{reply.text}</Text>
                        </Pressable>
                        <Handle index={index} label={reply.label} onDrag={onDrag} onMove={moveBy} tint={theme.colors.textSecondary} />
                    </View>
                );
            })}
        </View>

        {working.length >= QUICK_REPLY_LIMIT ? (
            <Text style={[styles.caption, { color: theme.colors.warningCritical }]}>{REPLY_CAP_NOTICE}</Text>
        ) : (
            <Pressable
                onPress={() => setFormIndex(working.length)}
                accessibilityRole="button"
                accessibilityLabel="Add a reply"
                style={[styles.addRow, { borderColor: theme.colors.accent }]}
            >
                <Ionicons name="add" size={18} color={theme.colors.accent} />
                <Text style={{ color: theme.colors.accent, fontSize: 14 }}>Add a snippet</Text>
            </Pressable>
        )}
    </View>;
}

/** Hold the handle to lift the row, then drag; the list swaps underneath. Shared by the key-row and snippet reorder cards. */
export function Handle({ index, label, onDrag, onMove, tint }: {
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

/** The key form, exported so a test can drive the picker and the save rule. */
export function KeyForm({ entry, onSave, onCancel }: {
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
    // An action key is the catalog key itself: it carries no bytes, so the name,
    // the modifiers, the letter and Repeat are all inapplicable to it and are
    // hidden rather than offering a choice that could not be stored.
    const isAction = mode === 'key' && selected.action !== undefined;
    const actionNote = selected.action === 'paste'
        ? 'Inserts the clipboard into the prompt. It never sends by itself.'
        : selected.action === 'hide-keyboard'
            ? 'Dismisses the keyboard when it is up. Nothing else changes.'
            : null;
    const bytes = mode === 'text' ? escapeToBytes(sendText) : modifiedSend(selected, ctrl, shift);
    const suggestedLabel = [ctrl ? 'Ctrl' : '', shift ? 'Shift' : '', selected.label].filter(Boolean).join(' ');
    // An action key is saved as the catalog key itself and the name field is
    // hidden for it, so a name typed before the selection must not be able to
    // disable Save: what is hidden cannot block the choice.
    const savedLabel = isAction ? selected.label : label.trim() || (mode === 'key' ? suggestedLabel : '');
    const valid = (isAction || (bytes !== null && bytes.length <= 512)) && savedLabel.length > 0 && savedLabel.length <= 12;
    const chip = (active: boolean) => [styles.gridChip, { backgroundColor: active ? theme.colors.accent : theme.colors.surfaceHigh }];
    const ink = (active: boolean) => ({ color: active ? theme.colors.button.primary.tint : theme.colors.text, fontSize: 13, ...Typography.mono() });
    return <View>
        <View style={styles.grid}>
            {(['key', 'text'] as const).map((value) => <Pressable key={value} onPress={() => setMode(value)} accessibilityRole="button" accessibilityState={{ selected: mode === value }} style={chip(mode === value)}>
                <Text style={ink(mode === value)}>{value === 'key' ? 'Key combination' : 'Text / escapes'}</Text>
            </Pressable>)}
        </View>
        {!(mode === 'key' && isAction) && <>
        <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Name on the key</Text>
        <TextInput value={label} onChangeText={setLabel} maxLength={12} accessibilityLabel="Key name" placeholder={mode === 'key' ? suggestedLabel : 'e.g. status'} placeholderTextColor={theme.colors.textSecondary} style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.divider }]} />
        </>}
        {mode === 'key' ? <>
            {actionNote !== null && <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>{actionNote}</Text>}
            {!isAction && <>
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>Modifiers</Text>
            <View style={styles.grid}>
                <Pressable onPress={() => setCtrl(!ctrl)} accessibilityRole="button" accessibilityLabel="Control modifier" accessibilityState={{ selected: ctrl }} style={chip(ctrl)}><Text style={ink(ctrl)}>Ctrl</Text></Pressable>
                <Pressable onPress={() => setShift(!shift)} accessibilityRole="button" accessibilityLabel="Shift modifier" accessibilityState={{ selected: shift }} style={chip(shift)}><Text style={ink(shift)}>Shift</Text></Pressable>
                <TextInput value={letter} onChangeText={setLetter} maxLength={1} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Letter or character" placeholder="A–Z" placeholderTextColor={theme.colors.textSecondary} style={[styles.input, { minWidth: 64, color: theme.colors.text, borderColor: theme.colors.divider }]} />
            </View>
            </>}
            {CATALOG_GROUPS.map((group) => <View key={group.title}>
                <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>{group.title}</Text>
                <View style={styles.grid}>{group.ids.map((id) => {
                    const active = keyId === id && letter === '';
                    // Picking an action key clears the modifiers it cannot use, so
                    // the form never shows an arming that has no effect; picking a
                    // byte key leaves them armed the way the row does.
                    return <Pressable key={id} onPress={() => { setKeyId(id); setLetter(''); setRepeat(BUILTIN_KEY_CATALOG[id].repeat === true); if (BUILTIN_KEY_CATALOG[id].action !== undefined) { setCtrl(false); setShift(false); } }} accessibilityRole="button" accessibilityLabel={`Choose ${BUILTIN_KEY_CATALOG[id].accessibilityLabel}`} accessibilityState={{ selected: active }} style={chip(active)}>
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
            <Text selectable style={[styles.rowLabel, { color: theme.colors.text }]}>{isAction && actionNote !== null ? actionNote : bytes === null ? 'Choose a valid key combination or escape sequence.' : bytesToEscape(bytes)}</Text>
        </View>
        {savedLabel.length > 12 && <Text style={{ color: theme.colors.warningCritical }}>Keep the name to 12 characters.</Text>}
        {bytes !== null && bytes.length > 512 && <Text style={{ color: theme.colors.warningCritical }}>Keep the sequence to 512 characters.</Text>}
        {!isAction && <View style={styles.repeatRow}>
            <Text style={{ color: theme.colors.text, fontSize: 14 }}>Repeat while held</Text>
            <Switch value={repeat} onValueChange={setRepeat} accessibilityLabel="Repeat while held" />
        </View>}
        <View style={styles.formActions}>
            <Pressable onPress={onCancel} accessibilityRole="button" style={styles.customDone}><Text style={{ color: theme.colors.textSecondary }}>Cancel</Text></Pressable>
            <Pressable disabled={!valid} accessibilityRole="button" accessibilityLabel="Save key" accessibilityState={{ disabled: !valid }} style={[styles.customAdd, { backgroundColor: theme.colors.accent, opacity: valid ? 1 : 0.4 }]} onPress={() => {
                if (!valid) return;
                // An action key is stored as the catalog id it is: a hand-rolled
                // { label, send: '' } entry would fail the stored schema and take
                // the whole customised row down with it.
                if (isAction) { onSave(keyId); return; }
                if (bytes === null) return;
                const unchangedBuiltin = mode === 'key' && letter === '' && !ctrl && !shift && label.trim() === '' && repeat === (selected.repeat === true);
                onSave(unchangedBuiltin ? keyId : { label: savedLabel, send: bytes, ...(repeat ? { repeat: true } : {}) });
            }}><Text style={{ color: theme.colors.button.primary.tint, fontSize: 14, fontWeight: '600' }}>Save key</Text></Pressable>
        </View>
    </View>;
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
    page: { flex: 1, paddingHorizontal: 16 },
    root: { flex: 1 },
    backdrop: { flex: 1 },
    sheet: { flexShrink: 1, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 12 },
    body: { flex: 1 },
    bodyContent: { paddingBottom: 24, paddingTop: 6 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 6 },
    title: { fontSize: 20, fontWeight: '700' },
    categoryRow: { flexDirection: 'row', gap: 5, paddingBottom: 10 },
    categoryChip: { flex: 1, minHeight: 34, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderRadius: 17 },
    sectionLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 1.2, color: '#8e8e93' },
    caption: { fontSize: 12, marginTop: 8, marginBottom: 6, color: '#8e8e93' },
    card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', marginTop: 2 },
    cardRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 6 },
    cardRowMain: { flex: 1, minHeight: 64, justifyContent: 'center' },
    cardRowAction: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 54, paddingHorizontal: 8, marginTop: 8, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },
    handle: { paddingHorizontal: 10, paddingVertical: 14 },
    rowLabel: { fontSize: 15, ...Typography.mono() },
    rowSend: { fontSize: 11.5, marginTop: 3, ...Typography.mono() },
    previewBox: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10 },
    previewKey: { minWidth: 42, height: 30, paddingHorizontal: 9, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
    close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    closeText: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 12, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },

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
