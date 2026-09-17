import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { ui } from '@/components/ui';

export interface TerminalKey {
    label: string;
    accessibilityLabel: string;
    send: string;
    ctrl?: string;
    shift?: string;
    ctrlShift?: string;
    repeat?: boolean;
}

/** The phone terminal's built-in key row. Furniture, not a feature pack. */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
    { label: 'esc', accessibilityLabel: 'Escape', send: '\u001b' },
    { label: 'tab', accessibilityLabel: 'Tab', send: '\t', shift: '\u001b[Z' },
    { label: '^C', accessibilityLabel: 'Control C', send: '\u0003' },
    { label: '^D', accessibilityLabel: 'Control D', send: '\u0004' },
    { label: '\u23ce', accessibilityLabel: 'Enter', send: '\r' },
    { label: '\u2190', accessibilityLabel: 'Left arrow', send: '\u001b[D', ctrl: '\u001b[1;5D', shift: '\u001b[1;2D', ctrlShift: '\u001b[1;6D', repeat: true },
    { label: '\u2191', accessibilityLabel: 'Up arrow', send: '\u001b[A', ctrl: '\u001b[1;5A', shift: '\u001b[1;2A', ctrlShift: '\u001b[1;6A', repeat: true },
    { label: '\u2193', accessibilityLabel: 'Down arrow', send: '\u001b[B', ctrl: '\u001b[1;5B', shift: '\u001b[1;2B', ctrlShift: '\u001b[1;6B', repeat: true },
    { label: '\u2192', accessibilityLabel: 'Right arrow', send: '\u001b[C', ctrl: '\u001b[1;5C', shift: '\u001b[1;2C', ctrlShift: '\u001b[1;6C', repeat: true },
];

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

export function TerminalKeyRow({ channel }: { channel?: { sendText: (text: string) => void } }) {
    const { theme } = useUnistyles();
    const [ctrl, setCtrl] = React.useState(false);
    const [shift, setShift] = React.useState(false);
    const ctrlRef = React.useRef(false);
    const shiftRef = React.useRef(false);
    const applyMods = (nextCtrl: boolean, nextShift: boolean) => {
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
    const style = (selected = false) => ({
        minWidth: 44,
        minHeight: 40,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderRadius: ui.radius.control,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surfaceHigh,
    });
    const labelStyle = (tint: string) => ({ color: tint, fontSize: 13, ...Typography.mono() });
    const tap = (key: TerminalKey) => () => {
        send(keyRowSend(key, ctrlRef.current, shiftRef.current));
        applyMods(false, false);
    };
    return (
        <>
            <Pressable
                onPress={() => applyMods(!ctrlRef.current, shiftRef.current)}
                accessibilityRole="button"
                accessibilityLabel="Control"
                accessibilityState={{ selected: ctrl }}
                style={({ pressed }) => [style(ctrl), pressed && { opacity: 0.6 }]}
            >
                <Text style={labelStyle(ctrl ? theme.colors.button.primary.tint : theme.colors.text)}>ctrl</Text>
            </Pressable>
            <Pressable
                onPress={() => applyMods(ctrlRef.current, !shiftRef.current)}
                accessibilityRole="button"
                accessibilityLabel="Shift"
                accessibilityState={{ selected: shift }}
                style={({ pressed }) => [style(shift), pressed && { opacity: 0.6 }]}
            >
                <Text style={labelStyle(shift ? theme.colors.button.primary.tint : theme.colors.text)}>shift</Text>
            </Pressable>
            {TERMINAL_KEYS.map((key) => (
                <Pressable
                    key={key.label}
                    accessibilityRole="button"
                    accessibilityLabel={key.accessibilityLabel}
                    onPress={tap(key)}
                    onLongPress={key.repeat !== true ? undefined : () => {
                        stopRepeat();
                        repeatTimer.current = setInterval(() => {
                            send(keyRowSend(key, ctrlRef.current, shiftRef.current));
                            applyMods(false, false);
                        }, 80);
                    }}
                    delayLongPress={400}
                    onPressOut={stopRepeat}
                    style={({ pressed }) => [style(), pressed && { opacity: 0.6 }]}
                >
                    <Text style={labelStyle(theme.colors.text)}>{key.label}</Text>
                </Pressable>
            ))}
        </>
    );
}
