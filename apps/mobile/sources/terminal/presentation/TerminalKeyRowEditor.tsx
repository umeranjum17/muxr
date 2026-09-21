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
import { BUILTIN_KEY_CATALOG, CATALOG_GROUPS, DEFAULT_ROW_IDS, TERMINAL_KEY_ROW_LIMIT, bytesToEscape, escapeToBytes, modifiedSend, resolveKeyRow, type RowEntry } from '../domain/keyRow';
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
    { id: 'appearance', label: 'Appearance' },
    { id: 'keyboard', label: 'Keyboard' },
];

/** A screen-owned command the grid can run: zoom, keyboard, and their kind. */
export type GridCommand = { label: string; run: () => void; disabled?: boolean; icon?: string };

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
    // Whichever category has a form open registers the way back to its list.
    const closeForm = React.useRef<(() => void) | null>(null);
    return (
        <Modal visible={visible} animationType="slide" onRequestClose={() => {
            // Back comes out of a half-finished edit before it comes out of the
            // grid: losing a form and the sheet to one press is not a choice
            // anyone made deliberately.
            if (closeForm.current !== null) { closeForm.current(); return; }
            onClose();
        }}>
            <GestureHandlerRootView style={[styles.page, { backgroundColor: theme.colors.surface, paddingTop: insets.top }]}>
                <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                    <View style={styles.header}>
                        <Text style={[styles.title, { color: theme.colors.text }]}>Controls</Text>
                        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Done editing controls" style={styles.closeText}>
                            <Text style={{ color: theme.colors.accent, fontSize: 15, fontWeight: '600' }}>Done</Text>
                        </Pressable>
                    </View>

                    {/* The category tabs: the grid's own switch row. It scrolls
                        when the pane is narrow so chips never collide. */}
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always"
                        style={{ flexGrow: 0 }}
                        contentContainerStyle={{ gap: 8, paddingBottom: 10, paddingRight: 20, alignItems: 'center' }}>
                        {CATEGORIES.map((entry) => {
                            const active = entry.id === category;
                            // A selected segment, not a call to action: the chosen
                            // category is raised by a step of surface and a hairline,
                            // never by a filled accent pill shouting over the content
                            // it is only a switch for.
                            return <Pressable key={entry.id} onPress={() => { hapticsSelection(); onCategoryChange(entry.id); }}
                                accessibilityRole="button" accessibilityLabel={`${entry.label} category`} accessibilityState={{ selected: active }}
                                style={[styles.categoryChip, {
                                    backgroundColor: active ? theme.colors.surfaceHighest : 'transparent',
                                    borderWidth: StyleSheet.hairlineWidth,
                                    borderColor: active ? theme.colors.divider : 'transparent',
                                }]}>
                                <Text style={{ color: active ? theme.colors.text : theme.colors.textSecondary, fontSize: 13.5, fontWeight: active ? '600' : '400' }}>{entry.label}</Text>
                            </Pressable>;
                        })}
                    </ScrollView>

                        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                            {category === 'keys' && <KeysCategory entries={entries} seed={seed} onChange={onChange} closeForm={closeForm} modifierIcons={modifierIcons === true} onChangeModifierIcons={(value) => { hapticsSelection(); setModifierIcons(value); }} />}
                            {category === 'snippets' && <SnippetsCategory replies={replies} onRepliesChange={onRepliesChange} closeForm={closeForm} />}
                            {category === 'recents' && (
                                recentLinks.length === 0
                                    ? <SectionNote>Links printed by the terminal gather here.</SectionNote>
                                    : <View style={[styles.card, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.divider }]}>
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
                                <View style={[styles.card, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.divider }]}>
                                    {viewCommands.map((command, index) => (
                                        <Pressable key={command.label} disabled={command.disabled === true} accessibilityRole="button" accessibilityLabel={command.label} accessibilityState={{ disabled: command.disabled === true }}
                                            onPress={() => { onClose(); command.run(); }}
                                            style={[styles.cardRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }, command.disabled === true && { opacity: 0.4 }]}>
                                            <Text style={{ flex: 1, paddingLeft: 8, color: theme.colors.text, fontSize: 16 }}>{command.label}</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ))}
                                </View>
                            )}
                            {category === 'keyboard' && (
                                <View style={[styles.card, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.divider }]}>
                                    {/* Identity, not spelling: the ring slot already
                                        resolves this command by its icon, and a
                                        substring match emptied the category the
                                        moment a label was reworded. */}
                                    {viewCommands.filter((command) => command.icon === 'keyboard').map((command) => (
                                        <Pressable key={command.label} accessibilityRole="button" accessibilityLabel={command.label} onPress={() => { onClose(); command.run(); }}
                                            style={[styles.cardRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }]}>
                                            <Text style={{ flex: 1, paddingLeft: 8, color: theme.colors.text, fontSize: 16 }}>{command.label}</Text>
                                            <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ))}
                                    <View style={[styles.cardRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }]}>
                                        <Text style={{ flex: 1, paddingLeft: 8, color: theme.colors.text, fontSize: 15 }}>Keyboard opens from the key row only</Text>
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
    return <Text style={[styles.sectionLabel, { marginTop: 26, marginBottom: 10 }]}>{children}</Text>;
}

function KeysCategory({ entries, seed, onChange, closeForm, modifierIcons, onChangeModifierIcons }: {
    entries: RowEntry[] | null;
    seed: RowEntry[];
    onChange: (entries: RowEntry[] | null) => void;
    closeForm: React.MutableRefObject<(() => void) | null>;
    modifierIcons: boolean;
    onChangeModifierIcons: (value: boolean) => void;
}) {
    const { theme } = useUnistyles();
    const { height: windowHeight } = useWindowDimensions();
    const { working, drag, commit, reseed, removeAt, moveBy, onDrag, isDragging } = useReorderableList<RowEntry>(true, seed, onChange);
    const [formIndex, setFormIndex] = React.useState<number | null>(null);

    // The way back to this list must not outlive the list: a stale closer would
    // make hardware back a no-op on a component that is no longer mounted. The
    // layout effect clears it in the same commit that removes the list, so no
    // back press can land on the stale one.
    React.useLayoutEffect(() => () => { closeForm.current = null; }, [closeForm]);

    const saveKey = (entry: RowEntry) => {
        if (formIndex === null || isDragging()) return;
        const next = [...working];
        if (formIndex === next.length && next.length >= TERMINAL_KEY_ROW_LIMIT) return;
        next[formIndex] = entry;
        hapticsSelection();
        commit(next);
        setFormIndex(null);
    };

    closeForm.current = formIndex === null ? null : () => setFormIndex(null);
    if (formIndex !== null) {
        return <KeyForm entry={working[formIndex]} onSave={saveKey} onCancel={() => setFormIndex(null)} />;
    }
    return <View>
        <SectionLabel>LIVE PREVIEW</SectionLabel>
        {/* The stage is the dominant first section, but never at the cost of the
            sections under it: on a short pane a fixed 300dp block would push
            DISPLAY and the reorder card clean off the screen. */}
        <View style={[styles.previewStage, { height: Math.min(300, Math.round(windowHeight * 0.34)), backgroundColor: '#0c0c0b', borderColor: theme.colors.divider }]}>
            {/* Restrained copy holds the stage's center; the actual toolbar
                anchors near the stage bottom, as in the reference. */}
            <View style={styles.previewCopyWrap}>
                <Text style={styles.previewCopy}>Live preview of your toolbar.</Text>
            </View>
            {/* The actual toolbar staged inside the stage, at natural size. */}
            <View style={[styles.previewRail, {
                backgroundColor: theme.colors.glass.backgroundStrong,
                borderColor: theme.colors.glass.border,
            }]}>
            {/* The caps need a step of their own against the rail they sit in,
                or the toolbar renders as one undifferentiated pill. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, alignItems: 'center', paddingRight: 4 }}>
                {['ctrl', 'shift'].map((label) => <View key={label} style={[styles.previewKey, { backgroundColor: theme.colors.surfaceHighest }]}>
                    <Text style={[styles.rowLabel, { color: theme.colors.textSecondary }]}>{modifierIcons ? (label === 'ctrl' ? '\u2303' : '\u21e7') : label}</Text>
                </View>)}
                {resolveKeyRow(working).map((key, index) => <View key={index} style={[styles.previewKey, { backgroundColor: theme.colors.surfaceHighest }]}>
                    <Text style={[styles.rowLabel, { color: theme.colors.text }]}>{key.label}</Text>
                </View>)}
            </ScrollView>
            </View>
        </View>

        <SectionLabel>DISPLAY</SectionLabel>
        <View style={[styles.card, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.divider }]}>
            <View style={styles.cardRow}>
                <Text style={{ flex: 1, paddingLeft: 8, color: theme.colors.text, fontSize: 16 }}>Use Icons for Modifier Keys</Text>
                <Switch value={modifierIcons} onValueChange={onChangeModifierIcons} accessibilityLabel="Use Icons for Modifier Keys" />
            </View>
        </View>

        <SectionLabel>TOOLBAR BUTTONS</SectionLabel>
        <Text style={[styles.caption]}>Tap to edit · hold a handle to reorder</Text>
        <View style={[styles.card, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.divider }]}>
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
            <Pressable onPress={() => {
                if (isDragging()) return;
                hapticsSelection();
                reseed([...DEFAULT_ROW_IDS]);
                onChange(null);
            }} accessibilityRole="button" accessibilityLabel="Reset key row to the default row" style={styles.resetRow}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Reset to the default row</Text>
            </Pressable>
        )}
    </View>;
}

// The toggle lives in local settings; the grid owns it and passes it down.

function SnippetsCategory({ replies, onRepliesChange, closeForm }: {
    replies: PersonalQuickReply[];
    onRepliesChange: (replies: PersonalQuickReply[]) => void;
    closeForm: React.MutableRefObject<(() => void) | null>;
}) {
    const { theme } = useUnistyles();
    const { working, drag, commit, removeAt, onDrag, moveBy, isDragging } = useReorderableList<PersonalQuickReply>(true, replies, onRepliesChange);
    const [formIndex, setFormIndex] = React.useState<number | null>(null);

    // Same rule as the key list: the closer goes away with its owner.
    React.useLayoutEffect(() => () => { closeForm.current = null; }, [closeForm]);

    const saveReply = (reply: PersonalQuickReply) => {
        if (formIndex === null || isDragging()) return;
        const next = [...working];
        if (formIndex === next.length && next.length >= QUICK_REPLY_LIMIT) return;
        next[formIndex] = reply;
        hapticsSelection();
        commit(next);
        setFormIndex(null);
    };

    closeForm.current = formIndex === null ? null : () => setFormIndex(null);
    if (formIndex !== null) {
        return <ReplyForm entry={working[formIndex]} onSave={saveReply} onCancel={() => setFormIndex(null)} />;
    }
    return <View>
        <Text style={[styles.caption]}>Your snippets · inserted into the prompt, never sent by themselves</Text>
        {working.length === 0 && <Text style={[styles.caption]}>Nothing here yet. The built-in replies still live in the command palette.</Text>}
        <View style={[styles.card, { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.divider }]}>
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
    const chip = (active: boolean) => [styles.gridChip, { backgroundColor: active ? theme.colors.accent : theme.colors.surfaceHighest }];
    const ink = (active: boolean) => ({ color: active ? theme.colors.button.primary.tint : theme.colors.text, fontSize: 13, ...Typography.mono() });
    // The mode row is a segmented switch, not a choice being made: it wears the
    // same quiet selection as the category rail so the only filled control on
    // the form is the key actually picked, and the only accent is Save.
    const segment = (active: boolean) => [styles.gridChip, {
        backgroundColor: active ? theme.colors.surfaceHighest : 'transparent',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: active ? theme.colors.divider : 'transparent',
    }];
    const segmentInk = (active: boolean) => ({ color: active ? theme.colors.text : theme.colors.textSecondary, fontSize: 13, fontWeight: active ? '600' as const : '400' as const });
    return <View>
        <View style={styles.grid}>
            {(['key', 'text'] as const).map((value) => <Pressable key={value} onPress={() => setMode(value)} accessibilityRole="button" accessibilityState={{ selected: mode === value }} style={segment(mode === value)}>
                <Text style={segmentInk(mode === value)}>{value === 'key' ? 'Key combination' : 'Text / escapes'}</Text>
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
        <View style={[styles.sequence, { backgroundColor: theme.colors.surfaceHighest }]}>
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
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 6, paddingBottom: 14 },
    title: { fontSize: 28, fontWeight: '600', letterSpacing: -0.4 },
    categoryChip: { minHeight: 34, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 15, borderRadius: 17 },
    sectionLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 1.4, color: '#8e8e93' },
    caption: { fontSize: 12, marginTop: 8, marginBottom: 6, color: '#8e8e93' },
    card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', marginTop: 2 },
    // Every card row earns the reference's height whether or not its content
    // asks for it; a lone switch row used to collapse to the switch.
    cardRow: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingLeft: 6, paddingRight: 2 },
    cardRowMain: { flex: 1, minHeight: 64, paddingLeft: 8, justifyContent: 'center' },
    cardRowAction: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 54, paddingHorizontal: 8, marginTop: 8, borderRadius: ui.radius.control, borderWidth: StyleSheet.hairlineWidth },
    handle: { paddingHorizontal: 10, paddingVertical: 14 },
    rowLabel: { fontSize: 16, ...Typography.mono() },
    rowSend: { fontSize: 12, marginTop: 3, ...Typography.mono() },
    previewStage: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, backgroundColor: '#0c0c0b', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 12, paddingBottom: 16 },
    previewCopyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    previewCopy: { color: '#8e8e93', fontSize: 15 },
    // A fixed height, not a minimum: on native the scroll view inside grows to
    // fill whatever the column will give it, and the rail swallowed the whole
    // stage — copy and all — instead of standing in it as one pill.
    previewRail: { height: 48, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, justifyContent: 'center', maxWidth: '100%' },
    previewKey: { minWidth: 44, height: 32, paddingHorizontal: 10, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
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
