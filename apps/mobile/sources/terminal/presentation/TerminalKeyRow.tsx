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
/** A key's padding at full size and at its tightest, and the smallest its
 *  label and icon may draw. */
const KEY_PADDING = 8;
const KEY_PADDING_MIN = 2;
const KEY_SCALE_MIN = 0.8;
const ROW_INSET = KEY_PADDING + TRAILING_EDGE;

/**
 * How tight the row draws to fit its width: a 270dp phone has room for half
 * the default row at full size, which put the arrows off the edge. Padding
 * gives way first, then the marks shrink; past both floors the row scrolls.
 * `marks` is the row's width with no padding at full size.
 */
function keyRowFit(width: number, marks: number, count: number): { padding: number; scale: number } {
    const room = width - ROW_INSET;
    const padding = (room - marks) / (2 * count);
    if (padding >= KEY_PADDING_MIN) return { padding: Math.min(KEY_PADDING, padding), scale: 1 };
    return { padding: KEY_PADDING_MIN, scale: Math.max(KEY_SCALE_MIN, (room - 2 * KEY_PADDING_MIN * count) / marks) };
}

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
    // Equal padding and no gap: every glyph sits the same distance from the
    // next (16dp at full size), whatever its width, instead of a minimum box re-centring the short ones.
    // The minimum width tightens with the padding and scale, so a key's width
    // stays linear in both and one measurement of the row sizes the fit.
    const style = (locked = false) => ({
        minHeight: 32,
        minWidth: 2 * fit.padding + 16 * fit.scale,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: fit.padding,
        // Round, like every other control on this plane: an armed modifier is a
        // pill, not the one rounded rectangle on the screen.
        borderRadius: 999,
        backgroundColor: locked ? theme.colors.accentSubtle : 'transparent',
        borderWidth: 0,
        borderColor: 'transparent',
    });
    const labelStyle = (tint: string) => ({ color: tint, fontSize: 13 * fit.scale, ...Typography.mono() });
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
    // ctrl and shift lead every row.
    const count = keys.length + 2;
    const [width, setWidth] = React.useState(0);
    const [marks, setMarks] = React.useState(0);
    const fit = width > 0 && marks > 0 ? keyRowFit(width, marks, count) : { padding: KEY_PADDING, scale: 1 };
    // The drawn row is ROW_INSET + 2 * padding * count + scale * marks; solve
    // back for marks, and ignore sub-dp rounding so the fit cannot oscillate.
    const measured = (contentWidth: number) => {
        const next = (contentWidth - ROW_INSET - 2 * fit.padding * count) / fit.scale;
        setMarks((previous) => (Math.abs(previous - next) > 1 ? next : previous));
    };
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
                style={{ flexGrow: 0, maxHeight: 32 }}
                onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
                onContentSizeChange={measured}
                contentContainerStyle={{ alignItems: 'center', gap: 0, paddingLeft: KEY_PADDING, paddingRight: TRAILING_EDGE, paddingVertical: 0 }}
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
                style={({ pressed }) => [style(ctrl === 'lock'), pressed && { opacity: 0.6 }]}
            >
                <Text maxFontSizeMultiplier={KEY_LABEL_MAX_SCALE} style={labelStyle(active(ctrl) ? theme.colors.accent : theme.colors.textSecondary)}>{modifierIcons === true ? '⌃' : 'ctrl'}</Text>
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
                style={({ pressed }) => [style(shift === 'lock'), pressed && { opacity: 0.6 }]}
            >
                <Text maxFontSizeMultiplier={KEY_LABEL_MAX_SCALE} style={labelStyle(active(shift) ? theme.colors.accent : theme.colors.textSecondary)}>{modifierIcons === true ? '⇧' : 'shift'}</Text>
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
                        style={({ pressed }) => [style(), unavailable && { opacity: 0.35 }, pressed && { opacity: 0.6 }]}
                    >
                        {icon !== undefined
                            ? <Ionicons name={icon} size={KEY_ICON_SIZE * fit.scale} color={theme.colors.textSecondary} />
                            : <Text maxFontSizeMultiplier={KEY_LABEL_MAX_SCALE} style={labelStyle(theme.colors.textSecondary)}>{key.label}</Text>}
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
