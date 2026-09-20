import * as React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { ui } from '@/components/ui';
import { useLocalSetting } from '@/catalog/store';
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
// them. Keys the armed modifier cannot encode go dim rather than send bare.
type Modifier = 'off' | 'once' | 'lock';

const cycle = (state: Modifier): Modifier => (state === 'off' ? 'once' : state === 'once' ? 'lock' : 'off');

export function TerminalKeyRow({ channel, children, onEdit, onAction }: { channel?: { sendText: (text: string) => void }; children?: React.ReactNode; onEdit: () => void; onAction?: (action: TerminalKeyAction) => void }) {
    const { theme } = useUnistyles();
    const rowEntries = useLocalSetting('terminalKeyRow');
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
        minWidth: 44,
        minHeight: 44,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 8,
        paddingVertical: 9,
        borderRadius: ui.radius.control,
        backgroundColor: selected || locked ? theme.colors.accent : theme.colors.surfaceHigh,
        borderWidth: locked ? 2 : 0,
        borderColor: locked ? theme.colors.button.primary.tint : 'transparent',
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
                style={{ flex: 1, maxHeight: 48 }}
                contentContainerStyle={{ alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 2 }}
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
                <Text style={labelStyle(active(ctrl) ? theme.colors.button.primary.tint : theme.colors.text)}>ctrl</Text>
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
                <Text style={labelStyle(active(shift) ? theme.colors.button.primary.tint : theme.colors.text)}>shift</Text>
            </Pressable>
            {keys.map((key, index) => {
                const unavailable = modifiedSend(key, active(ctrl), active(shift)) === null;
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
                            ? <Ionicons name={ARROWS[key.send]} size={18} color={theme.colors.text} />
                            : <Text style={labelStyle(theme.colors.text)}>{key.label}</Text>}
                    </Pressable>
                );
            })}
            {children}
            </ScrollView>

        </>
    );
}
