import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { withAlpha } from '@/components/ui';
import { useLocalSetting, useLocalSettingMutable } from '@/catalog/store';
import { BUILTIN_KEY_CATALOG, modifiedSend, resolveKeyRow, type RowEntry, type TerminalKey, type TerminalKeyAction } from '../domain/keyRow';

/**
 * Keys that read better as a mark than as a word. An arrow rendered as the
 * character `\u2190` is a text glyph at text size — the thing on this row a
 * thumb reaches for most, drawn smallest. These are icons, at icon size, and
 * they keep the same target the text keys have.
 */
const KEY_ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
    '\u001b[D': 'arrow-back', '\u001b[A': 'arrow-up', '\u001b[B': 'arrow-down', '\u001b[C': 'arrow-forward',
    '\r': 'return-down-back',
};
const ACTION_ICONS: Record<TerminalKeyAction, React.ComponentProps<typeof Ionicons>['name']> = {
    paste: 'clipboard-outline',
    'hide-keyboard': 'chevron-down',
};
/** An icon carries less ink than a mono glyph, so it is drawn larger to weigh
 *  the same beside one. */
const KEY_ICON_SIZE = 18;
/** The row's trailing inset, and the fade drawn over it: a key running off
 *  the edge dissolves into the chrome instead of being cut through its glyph,
 *  and at the end of the row the fade covers only this empty inset. */
const TRAILING_EDGE = 32;
/** The row keeps one height and one key width; at Android font scale 2.0 the
 *  labels grew both ways, pushing keys off the trailing edge and past the row's
 *  height. Capped, the same as the pane-tabs chip, so the labels stay whole and
 *  every key stays reachable at the largest text size. */
const KEY_LABEL_MAX_SCALE = 1.5;
/** Every key is a 48dp touch target, the platform minimum: keys packed to fit
 *  the width put ctrl and shift so close that one landed on the other. A row
 *  wider than the screen scrolls, and the arrows are in the quick-actions
 *  cluster too. */
const KEY_TARGET = 48;
/** The mark inside the target: an armed modifier's pill, and the label's own
 *  padding within it. */
const KEY_MARK_HEIGHT = 32;
const KEY_PADDING = 8;
/** Clear space between two targets, so a thumb on one edge is never read as
 *  the neighbour. */
const KEY_GAP = 4;

// Sticky modifiers: tap = applies to the next key, tap again =
// locked until tapped once more. A touchscreen makes hold-and-reach a
// two-thumb dance; the lock covers a run of chords without re-arming between
// them. Byte keys the armed modifier cannot encode go dim rather than send
// bare; action keys (paste, hide kb) never arm or dim at all.
type Modifier = 'off' | 'once' | 'lock';

const cycle = (state: Modifier): Modifier => (state === 'off' ? 'once' : state === 'once' ? 'lock' : 'off');

// Memoised: the screen above re-renders on every keystroke in the composer,
// and rebuilding a dozen key marks per character is work nobody asked for. The
// row's props are all stable.
export const TerminalKeyRow = React.memo(function TerminalKeyRow({ channel, entries, onEdit, onAction }: {
    channel?: { sendText: (text: string) => void };
    /** Draw this row instead of the stored one: the key editor previews its working copy through this same component. */
    entries?: readonly RowEntry[];
    onEdit?: () => void;
    onAction?: (action: TerminalKeyAction) => void;
}) {
    const { theme } = useUnistyles();
    const storedEntries = useLocalSetting('terminalKeyRow');
    // "Use Icons for Modifier Keys": the control grid's display toggle swaps
    // the modifier captions for glyphs.
    const [modifierIcons] = useLocalSettingMutable('terminalModifierIcons');
    const [ctrl, setCtrl] = React.useState<Modifier>('off');
    const [shift, setShift] = React.useState<Modifier>('off');
    const ctrlRef = React.useRef<Modifier>('off');
    const shiftRef = React.useRef<Modifier>('off');
    const applyMods = (nextCtrl: Modifier, nextShift: Modifier) => {
        ctrlRef.current = nextCtrl;
        shiftRef.current = nextShift;
        setCtrl(nextCtrl);
        setShift(nextShift);
    };
    const repeatTimer = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const stopRepeat = React.useCallback(() => {
        if (repeatTimer.current !== null) {
            clearInterval(repeatTimer.current);
            repeatTimer.current = null;
        }
    }, []);
    React.useEffect(() => stopRepeat, [stopRepeat]);
    const send = React.useCallback((text: string) => {
        channel?.sendText(text);
        hapticsSelection();
    }, [channel]);
    // Marks on the terminal's own plane, not keycaps on a strip. A run of
    // filled caps at a single grey was most of what read as a band of chrome
    // under the terminal; unboxed, the row disappears until it is wanted and
    // an armed modifier is the only thing that takes colour.
    // The target is the whole 48dp square; the mark sits centred in it.
    const target = {
        minWidth: KEY_TARGET,
        height: KEY_TARGET,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
    };
    const mark = (locked = false) => ({
        height: KEY_MARK_HEIGHT,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: KEY_PADDING,
        // Round, like every other control on this plane: an armed modifier is a
        // pill, not the one rounded rectangle on the screen.
        borderRadius: 999,
        backgroundColor: locked ? theme.colors.accentSubtle : 'transparent',
    });
    const labelStyle = (tint: string) => ({ color: tint, fontSize: 13, ...Typography.mono() });
    const fire = (key: TerminalKey) => {
        if (key.action !== undefined) {
            hapticsSelection();
            onAction?.(key.action);
            return;
        }
        const bytes = modifiedSend(key, ctrlRef.current !== 'off', shiftRef.current !== 'off');
        if (bytes === null) return;
        send(bytes);
        applyMods(ctrlRef.current === 'once' ? 'off' : ctrlRef.current, shiftRef.current === 'once' ? 'off' : shiftRef.current);
    };
    const active = (state: Modifier) => state !== 'off';
    const keys = resolveKeyRow(entries ?? storedEntries);
    const openEditor = React.useCallback(() => {
        stopRepeat();
        onEdit?.();
    }, [stopRepeat, onEdit]);
    const chrome = theme.colors.terminalChrome[useLocalSetting('darkSurfaces') === 'raised' ? 'chrome' : 'canvas'];
    return (
        <View>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                style={{ flexGrow: 0, maxHeight: KEY_TARGET }}
                contentContainerStyle={{ alignItems: 'center', gap: KEY_GAP, paddingLeft: KEY_GAP, paddingRight: TRAILING_EDGE, paddingVertical: 0 }}
            >
            <Pressable
                onPress={() => { hapticsSelection(); applyMods(cycle(ctrlRef.current), shiftRef.current); }}
                onLongPress={openEditor}
                accessibilityActions={[{ name: 'edit', label: 'Edit key row' }]}
                onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'edit') openEditor(); }}
                accessibilityRole="button"
                accessibilityLabel={`Control${ctrl === 'lock' ? ', locked' : ''}`}
                accessibilityHint="Tap for the next key, double tap to lock. Hold to edit terminal keys."
                accessibilityState={{ selected: active(ctrl) }}
                style={({ pressed }) => [target, pressed && { opacity: 0.6 }]}
            >
                <View style={mark(ctrl === 'lock')}>
                    <Text maxFontSizeMultiplier={KEY_LABEL_MAX_SCALE} style={labelStyle(active(ctrl) ? theme.colors.accent : theme.colors.textSecondary)}>{modifierIcons === true ? '⌃' : 'ctrl'}</Text>
                </View>
            </Pressable>
            <Pressable
                onPress={() => { hapticsSelection(); applyMods(ctrlRef.current, cycle(shiftRef.current)); }}
                onLongPress={openEditor}
                accessibilityRole="button"
                accessibilityLabel={`Shift${shift === 'lock' ? ', locked' : ''}`}
                accessibilityHint="Tap for the next key, double tap to lock. Hold to edit terminal keys."
                accessibilityActions={[{ name: 'edit', label: 'Edit key row' }]}
                onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'edit') openEditor(); }}
                accessibilityState={{ selected: active(shift) }}
                style={({ pressed }) => [target, pressed && { opacity: 0.6 }]}
            >
                <View style={mark(shift === 'lock')}>
                    <Text maxFontSizeMultiplier={KEY_LABEL_MAX_SCALE} style={labelStyle(active(shift) ? theme.colors.accent : theme.colors.textSecondary)}>{modifierIcons === true ? '⇧' : 'shift'}</Text>
                </View>
            </Pressable>
            {keys.map((key, index) => {
                // An action key never encodes modifiers, so an armed modifier
                // must not dim or disable it: modifiedSend answers null for a
                // key with no bytes, which is not the same as a chord the
                // terminal cannot express.
                const unavailable = key.action === undefined && modifiedSend(key, active(ctrl), active(shift)) === null;
                const icon = key.action !== undefined ? ACTION_ICONS[key.action]
                    : Object.values(BUILTIN_KEY_CATALOG).includes(key) ? KEY_ICONS[key.send] : undefined;
                return (
                    <Pressable
                        key={`${key.label}:${key.send}:${index}`}
                        accessibilityRole="button"
                        accessibilityLabel={key.accessibilityLabel}
                        accessibilityState={{ disabled: unavailable }}
                        disabled={unavailable}
                        onPress={() => fire(key)}
                        onLongPress={key.repeat !== true ? undefined : () => {
                            stopRepeat();
                            repeatTimer.current = setInterval(() => fire(key), 80);
                        }}
                        delayLongPress={400}
                        onPressOut={stopRepeat}
                        style={({ pressed }) => [target, unavailable && { opacity: 0.35 }, pressed && { opacity: 0.6 }]}
                    >
                        <View style={mark()}>
                            {icon !== undefined
                                ? <Ionicons name={icon} size={KEY_ICON_SIZE} color={theme.colors.textSecondary} />
                                : <Text maxFontSizeMultiplier={KEY_LABEL_MAX_SCALE} style={labelStyle(theme.colors.textSecondary)}>{key.label}</Text>}
                        </View>
                    </Pressable>
                );
            })}
            </ScrollView>
            {/* The live row sits on the terminal chrome; the editor's preview
                (`entries`) sits on its own sheet and keeps a plain edge. */}
            {entries === undefined && (
                <LinearGradient
                    pointerEvents="none"
                    colors={[withAlpha(chrome, 0), chrome]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: TRAILING_EDGE }}
                />
            )}
        </View>
    );
});
