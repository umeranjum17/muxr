import * as React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { ui } from '@/components/ui';
import { useLocalSetting, useLocalSettingMutable } from '@/catalog/store';
import { modifiedSend, resolveKeyRow, type TerminalKey, type TerminalKeyAction } from '../domain/keyRow';

const ARROWS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
    '\u001b[D': 'arrow-back', '\u001b[A': 'arrow-up', '\u001b[B': 'arrow-down', '\u001b[C': 'arrow-forward',
};

export const TERMINAL_QUICK_REPLIES: readonly { label: string; text: string }[] = [
    { label: 'Continue', text: 'Continue with the current task.' },
    { label: 'Run tests', text: 'Run the relevant tests and report any failures.' },
    { label: 'Summarize', text: 'Summarize what changed and what remains.' },
];

// Sticky modifiers: tap = applies to the next key, tap again =
// locked until tapped once more. A touchscreen makes hold-and-reach a
// two-thumb dance; the lock covers a run of chords without re-arming between
// them. Byte keys the armed modifier cannot encode go dim rather than send
// bare; action keys (paste, hide kb) never arm or dim at all.
type Modifier = 'off' | 'once' | 'lock';

const cycle = (state: Modifier): Modifier => (state === 'off' ? 'once' : state === 'once' ? 'lock' : 'off');

export function TerminalKeyRow({ channel, children, onEdit, onAction }: { channel?: { sendText: (text: string) => void }; children?: React.ReactNode; onEdit: () => void; onAction?: (action: TerminalKeyAction) => void }) {
    const { theme } = useUnistyles();
    const rowEntries = useLocalSetting('terminalKeyRow');
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
    const style = (selected = false, locked = false) => ({
        minHeight: 30,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 8,
        // Subordinate to the terminal: quiet caps that only light up when a
        // modifier is armed, never a band of chrome.
        backgroundColor: selected || locked ? theme.colors.accentSubtle : theme.colors.glass.backgroundSubtle,
        borderWidth: locked ? 1 : 0,
        borderColor: locked ? theme.colors.accent : 'transparent',
    });
    const labelStyle = (tint: string) => ({ color: tint, fontSize: 11, ...Typography.mono() });
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
    const keys = resolveKeyRow(rowEntries);
    const openEditor = React.useCallback(() => {
        stopRepeat();
        onEdit();
    }, [stopRepeat, onEdit]);
    return (
        <>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                style={{ flexGrow: 0, maxHeight: 38 }}
                contentContainerStyle={{ alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 3 }}
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
                style={({ pressed }) => [style(active(ctrl), ctrl === 'lock'), pressed && { opacity: 0.6 }]}
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
                style={({ pressed }) => [style(active(shift), shift === 'lock'), pressed && { opacity: 0.6 }]}
            >
                <Text style={labelStyle(active(shift) ? theme.colors.accent : theme.colors.textSecondary)}>{modifierIcons === true ? '⇧' : 'shift'}</Text>
            </Pressable>
            {keys.map((key, index) => {
                // An action key never encodes modifiers, so an armed modifier
                // must not dim or disable it: modifiedSend answers null for a
                // key with no bytes, which is not the same as a chord the
                // terminal cannot express.
                const unavailable = key.action === undefined && modifiedSend(key, active(ctrl), active(shift)) === null;
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
                        {ARROWS[key.send] !== undefined
                            ? <Ionicons name={ARROWS[key.send]} size={14} color={theme.colors.textSecondary} />
                            : <Text style={labelStyle(theme.colors.textSecondary)}>{key.label}</Text>}
                    </Pressable>
                );
            })}
            {children}
            </ScrollView>

        </>
    );
}
