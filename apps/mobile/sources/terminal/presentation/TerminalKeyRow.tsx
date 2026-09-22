import * as React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { useLocalSetting, useLocalSettingMutable } from '@/catalog/store';
import { modifiedSend, resolveKeyRow, type RowEntry, type TerminalKey, type TerminalKeyAction } from '../domain/keyRow';

/**
 * Keys that read better as a mark than as a word. An arrow rendered as the
 * character `\u2190` is a text glyph at text size — the thing on this row a
 * thumb reaches for most, drawn smallest. These are icons, at icon size, and
 * they keep the same 34dp target the text keys have.
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

// Sticky modifiers: tap = applies to the next key, tap again =
// locked until tapped once more. A touchscreen makes hold-and-reach a
// two-thumb dance; the lock covers a run of chords without re-arming between
// them. Byte keys the armed modifier cannot encode go dim rather than send
// bare; action keys (paste, hide kb) never arm or dim at all.
type Modifier = 'off' | 'once' | 'lock';

const cycle = (state: Modifier): Modifier => (state === 'off' ? 'once' : state === 'once' ? 'lock' : 'off');

// Memoised: the screen above re-renders on every keystroke in the composer,
// and rebuilding a dozen key marks per character is work nobody asked for. The
// row's props are all stable, including the plugin slot the screen memoises
// before handing it down.
export const TerminalKeyRow = React.memo(function TerminalKeyRow({ channel, children, entries, onEdit, onAction }: {
    channel?: { sendText: (text: string) => void };
    children?: React.ReactNode;
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
    const style = (locked = false) => ({
        minHeight: 34,
        minWidth: 34,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 6,
        // Round, like every other control on this plane: an armed modifier is a
        // pill, not the one rounded rectangle on the screen.
        borderRadius: 999,
        backgroundColor: locked ? theme.colors.accentSubtle : 'transparent',
        borderWidth: 0,
        borderColor: 'transparent',
    });
    const labelStyle = (tint: string) => ({ color: tint, fontSize: 12, ...Typography.mono() });
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
    return (
        <>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                style={{ flexGrow: 0, maxHeight: 36 }}
                contentContainerStyle={{ alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 18, paddingVertical: 0 }}
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
                <Text style={labelStyle(active(ctrl) ? theme.colors.accent : theme.colors.textSecondary)}>{modifierIcons === true ? '⌃' : 'ctrl'}</Text>
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
                <Text style={labelStyle(active(shift) ? theme.colors.accent : theme.colors.textSecondary)}>{modifierIcons === true ? '⇧' : 'shift'}</Text>
            </Pressable>
            {keys.map((key, index) => {
                // An action key never encodes modifiers, so an armed modifier
                // must not dim or disable it: modifiedSend answers null for a
                // key with no bytes, which is not the same as a chord the
                // terminal cannot express.
                const unavailable = key.action === undefined && modifiedSend(key, active(ctrl), active(shift)) === null;
                const icon = key.action === undefined ? KEY_ICONS[key.send] : ACTION_ICONS[key.action];
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
                            ? <Ionicons name={icon} size={KEY_ICON_SIZE} color={theme.colors.textSecondary} />
                            : <Text style={labelStyle(theme.colors.textSecondary)}>{key.label}</Text>}
                    </Pressable>
                );
            })}
            {children}
            </ScrollView>

        </>
    );
});
