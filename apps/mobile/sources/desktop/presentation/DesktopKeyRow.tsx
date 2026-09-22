import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { DesktopSession, StickyModifier } from '@desklink/react-native';

import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { useLocalSetting } from '@/catalog/store';

/** The row's height, so the chrome floating above it can clear it. */
export const DESKTOP_KEY_ROW_HEIGHT = 36;

const MODIFIERS: readonly { name: StickyModifier; label: string; glyph: string }[] = [
    { name: 'Control', label: 'ctrl', glyph: '⌃' },
    { name: 'Shift', label: 'shift', glyph: '⇧' },
];

const KEYS: readonly {
    name: string;
    accessibilityLabel: string;
    label?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
}[] = [
    { name: 'Escape', accessibilityLabel: 'Escape', label: 'esc' },
    { name: 'Tab', accessibilityLabel: 'Tab', label: 'tab' },
    { name: 'ArrowLeft', accessibilityLabel: 'Left arrow', icon: 'arrow-back' },
    { name: 'ArrowUp', accessibilityLabel: 'Up arrow', icon: 'arrow-up' },
    { name: 'ArrowDown', accessibilityLabel: 'Down arrow', icon: 'arrow-down' },
    { name: 'ArrowRight', accessibilityLabel: 'Right arrow', icon: 'arrow-forward' },
];

/**
 * The keys a phone keyboard does not have, for the desktop: sticky Ctrl and
 * Shift, Esc, Tab and the arrows.
 *
 * It is the terminal key row's own look — unboxed marks on the canvas, where
 * only an armed modifier takes colour and a locked one a wash — but the eight
 * keys share the width rather than scroll, so all of them fit a narrow phone.
 * Ctrl and Shift cycle the way the terminal's do: tap for the next key, tap
 * again to lock, once more to let go. What the phone's keyboard types next is
 * chorded by the session, so Ctrl then "v" is Ctrl+V.
 */
export function DesktopKeyRow({ session }: { session: Pick<DesktopSession, 'modifiers' | 'tapModifier' | 'pressKey'> }) {
    const { theme } = useUnistyles();
    const glyphs = useLocalSetting('terminalModifierIcons') === true;
    const { modifiers, tapModifier, pressKey } = session;

    // A held arrow is held on the desktop too, which repeats it with the
    // modifiers it went down with. Lifting the finger lets it go, and so does
    // the row closing under the finger.
    const held = React.useRef<(() => void) | null>(null);
    const release = React.useCallback(() => {
        held.current?.();
        held.current = null;
    }, []);
    React.useEffect(() => release, [release]);

    const label = (text: string, tint: string) => (
        <Text style={{ color: tint, fontSize: 12, ...Typography.mono() }}>{text}</Text>
    );

    return (
        <View style={{ height: DESKTOP_KEY_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
            {MODIFIERS.map(({ name, label: text, glyph }) => {
                const state = modifiers[name];
                return (
                    <Pressable
                        key={name}
                        onPress={() => {
                            hapticsSelection();
                            tapModifier(name);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`${name}${state === 'lock' ? ', locked' : ''}`}
                        accessibilityHint="Tap for the next key, tap again to lock."
                        accessibilityState={{ selected: state !== 'off' }}
                        style={({ pressed }) => [
                            styles.key,
                            { flex: 1.3 },
                            state === 'lock' && { backgroundColor: theme.colors.accentSubtle },
                            pressed && styles.pressed,
                        ]}
                    >
                        {label(glyphs ? glyph : text, state === 'off' ? theme.colors.textSecondary : theme.colors.accent)}
                    </Pressable>
                );
            })}
            {KEYS.map((key) => (
                <Pressable
                    key={key.name}
                    onPress={() => {
                        hapticsSelection();
                        pressKey(key.name)();
                    }}
                    onLongPress={key.icon === undefined ? undefined : () => {
                        release();
                        hapticsSelection();
                        held.current = pressKey(key.name);
                    }}
                    delayLongPress={400}
                    onPressOut={release}
                    accessibilityRole="button"
                    accessibilityLabel={key.accessibilityLabel}
                    style={({ pressed }) => [styles.key, { flex: 1 }, pressed && styles.pressed]}
                >
                    {key.icon !== undefined
                        ? <Ionicons name={key.icon} size={12} color={theme.colors.textSecondary} />
                        : label(key.label ?? key.name, theme.colors.textSecondary)}
                </Pressable>
            ))}
        </View>
    );
}

const styles = {
    key: { height: 34, maxWidth: 72, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
    pressed: { opacity: 0.6 },
} as const;
