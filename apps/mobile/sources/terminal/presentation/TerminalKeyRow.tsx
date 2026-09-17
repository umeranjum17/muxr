import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { ui } from '@/components/ui';
import { useLocalSettingMutable } from '@/catalog/store';
import { useOperatorTerminalKeys } from '../application/operatorTerminalKeys';
import { DEFAULT_ROW_IDS, resolveKeyRow, type RowEntry, type TerminalKey } from '../domain/keyRow';
import { TerminalKeyRowEditor } from './TerminalKeyRowEditor';

export type { TerminalKey };

export const TERMINAL_QUICK_REPLIES: readonly { label: string; text: string }[] = [
    { label: 'Continue', text: 'Continue with the current task.' },
    { label: 'Run tests', text: 'Run the relevant tests and report any failures.' },
    { label: 'Summarize', text: 'Summarize what changed and what remains.' },
];

function keyRowSend(key: TerminalKey, ctrl: boolean, shift: boolean): string {
    if (ctrl && shift) return key.ctrlShift ?? key.ctrl ?? key.shift ?? key.send;
    if (ctrl) return key.ctrl ?? key.send;
    if (shift) return key.shift ?? key.send;
    return key.send;
}

// Sticky modifiers a la Termux: tap = applies to the next key, tap again =
// locked until tapped once more. A touchscreen makes hold-and-reach a
// two-thumb dance; off-once-lock covers single chords and tmux prefixes alike.
type Modifier = 'off' | 'once' | 'lock';

const cycle = (state: Modifier): Modifier => (state === 'off' ? 'once' : state === 'once' ? 'lock' : 'off');

export function TerminalKeyRow({ channel }: { channel?: { sendText: (text: string) => void } }) {
    const { theme } = useUnistyles();
    const [rowEntries, setRowEntries] = useLocalSettingMutable('terminalKeyRow');
    const operatorKeys = useOperatorTerminalKeys();
    const [editing, setEditing] = React.useState(false);
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
        minHeight: 40,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderRadius: ui.radius.control,
        backgroundColor: selected || locked ? theme.colors.accent : theme.colors.surfaceHigh,
        borderWidth: locked ? 2 : 0,
        borderColor: locked ? theme.colors.button.primary.tint : 'transparent',
    });
    const labelStyle = (tint: string) => ({ color: tint, fontSize: 13, ...Typography.mono() });
    const tap = (key: TerminalKey) => () => {
        send(keyRowSend(key, ctrlRef.current !== 'off', shiftRef.current !== 'off'));
        applyMods(ctrlRef.current === 'once' ? 'off' : ctrlRef.current, shiftRef.current === 'once' ? 'off' : shiftRef.current);
    };
    const active = (state: Modifier) => state !== 'off';
    const keys = resolveKeyRow(rowEntries, operatorKeys?.keys);
    // Editing starts from the row the person sees today: their own arrangement,
    // else the operator's row inline (so it diverges as a local copy), else default.
    const seed = React.useMemo<RowEntry[]>(() => {
        if (rowEntries !== null) return rowEntries;
        const operator = operatorKeys?.keys;
        if (operator !== undefined && operator.length > 0) {
            return operator.map((key) => ({
                label: key.label,
                ...(key.accessibilityLabel === undefined ? {} : { accessibilityLabel: key.accessibilityLabel }),
                send: key.send,
                ...(key.repeat === true ? { repeat: true } : {}),
            }));
        }
        return [...DEFAULT_ROW_IDS];
    }, [rowEntries, operatorKeys]);
    return (
        <>
            <Pressable
                onPress={() => { hapticsSelection(); applyMods(cycle(ctrlRef.current), shiftRef.current); }}
                accessibilityRole="button"
                accessibilityLabel={`Control${ctrl === 'lock' ? ', locked' : ''}`}
                accessibilityState={{ selected: active(ctrl) }}
                style={({ pressed }) => [style(active(ctrl), ctrl === 'lock'), pressed && { opacity: 0.6 }]}
            >
                <Text style={labelStyle(active(ctrl) ? theme.colors.button.primary.tint : theme.colors.text)}>ctrl</Text>
            </Pressable>
            <Pressable
                onPress={() => { hapticsSelection(); applyMods(ctrlRef.current, cycle(shiftRef.current)); }}
                accessibilityRole="button"
                accessibilityLabel={`Shift${shift === 'lock' ? ', locked' : ''}`}
                accessibilityState={{ selected: active(shift) }}
                style={({ pressed }) => [style(active(shift), shift === 'lock'), pressed && { opacity: 0.6 }]}
            >
                <Text style={labelStyle(active(shift) ? theme.colors.button.primary.tint : theme.colors.text)}>shift</Text>
            </Pressable>
            {keys.map((key, index) => (
                <Pressable
                    key={`${key.label}:${key.send}:${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={key.accessibilityLabel}
                    onPress={tap(key)}
                    onLongPress={key.repeat !== true ? undefined : () => {
                        stopRepeat();
                        repeatTimer.current = setInterval(() => {
                            send(keyRowSend(key, ctrlRef.current !== 'off', shiftRef.current !== 'off'));
                            applyMods(ctrlRef.current === 'once' ? 'off' : ctrlRef.current, shiftRef.current === 'once' ? 'off' : shiftRef.current);
                        }, 80);
                    }}
                    delayLongPress={400}
                    onPressOut={stopRepeat}
                    style={({ pressed }) => [style(), pressed && { opacity: 0.6 }]}
                >
                    <Text style={labelStyle(theme.colors.text)}>{key.label}</Text>
                </Pressable>
            ))}
            <Pressable
                onPress={() => { stopRepeat(); setEditing(true); }}
                accessibilityRole="button"
                accessibilityLabel="Edit key row"
                style={({ pressed }) => [style(), pressed && { opacity: 0.6 }]}
            >
                <Ionicons name="pencil" size={15} color={theme.colors.text} />
            </Pressable>
            <TerminalKeyRowEditor
                visible={editing}
                entries={rowEntries}
                seed={seed}
                keys={keys}
                onChange={setRowEntries}
                onClose={() => setEditing(false)}
            />
        </>
    );
}
