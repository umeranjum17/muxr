import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type { DesktopSession, StickyModifier } from '@desklink/react-native';

import { Typography } from '@/constants/Typography';
import { hapticsSelection } from '@/components/haptics';
import { useLocalSetting } from '@/catalog/store';

/**
 * In a browser a pressed key would take focus from the desktop's hidden text
 * field, and the phone's keyboard would close under the finger: Ctrl, then a
 * letter, could never be typed. Keeping the press from moving focus keeps the
 * keyboard up; the press itself still happens.
 */
const KEEP_KEYBOARD = Platform.OS === 'web'
    ? { onMouseDown: (event: { preventDefault(): void }) => event.preventDefault() } as object
    : {};

/** The row's height, so the chrome floating above it can clear it. */
export const DESKTOP_KEY_ROW_HEIGHT = 36;
const KEY_TINT = '#B5B7C2'; // Desktop canvas is black even in the light app theme.

const MODIFIERS: readonly { name: StickyModifier; label: string; glyph: string }[] = [
    { name: 'Control', label: 'ctrl', glyph: '⌃' },
    { name: 'Shift', label: 'shift', glyph: '⇧' },
    { name: 'Alt', label: 'alt', glyph: '⌥' },
    { name: 'Meta', label: 'super', glyph: '◆' },
];

type DesktopKey = {
    name: string;
    accessibilityLabel: string;
    label?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
};

const KEYS: readonly DesktopKey[] = [
    { name: 'Escape', accessibilityLabel: 'Escape', label: 'esc' },
    { name: 'Tab', accessibilityLabel: 'Tab', label: 'tab' },
    { name: 'ArrowLeft', accessibilityLabel: 'Left arrow', icon: 'arrow-back' },
    { name: 'ArrowUp', accessibilityLabel: 'Up arrow', icon: 'arrow-up' },
    { name: 'ArrowDown', accessibilityLabel: 'Down arrow', icon: 'arrow-down' },
    { name: 'ArrowRight', accessibilityLabel: 'Right arrow', icon: 'arrow-forward' },
];

const MORE_KEYS: readonly DesktopKey[] = [
    { name: 'Delete', accessibilityLabel: 'Delete', label: 'del' },
    { name: 'Home', accessibilityLabel: 'Home', label: 'home' },
    { name: 'End', accessibilityLabel: 'End', label: 'end' },
    { name: 'PageUp', accessibilityLabel: 'Page Up', label: 'pg↑' },
    { name: 'PageDown', accessibilityLabel: 'Page Down', label: 'pg↓' },
    { name: 'Enter', accessibilityLabel: 'Enter', label: 'enter' },
    ...Array.from({ length: 12 }, (_, index) => ({ name: `F${index + 1}`, accessibilityLabel: `F${index + 1}`, label: `F${index + 1}` })),
];

/**
 * Desktop keys a phone keyboard lacks. Modifiers cycle once, lock, off;
 * the session chords the next phone key or a key in either row.
 */
export function DesktopKeyRow({ session }: { session: Pick<DesktopSession, 'modifiers' | 'tapModifier' | 'pressKey'> }) {
    const { theme } = useUnistyles();
    const glyphs = useLocalSetting('terminalModifierIcons') === true;
    const [more, setMore] = React.useState(false);
    const { modifiers, tapModifier, pressKey } = session;

    // A held arrow is held on the desktop too, which repeats it with the
    // modifiers it went down with. Lifting the finger lets it go, and so does
    // the row closing under the finger.
    const held = React.useRef<(() => void) | null>(null);
    const row = React.useRef<ScrollView>(null);
    const release = React.useCallback(() => {
        held.current?.();
        held.current = null;
    }, []);
    React.useEffect(() => release, [release]);

    const label = (text: string, tint: string) => (
        <Text style={{ color: tint, fontSize: 12, ...Typography.mono() }}>{text}</Text>
    );

    return (
        <View {...KEEP_KEYBOARD} style={{ height: DESKTOP_KEY_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
            <ScrollView ref={row} horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ alignItems: 'center' }}>
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
                        accessibilityLabel={`${name === 'Meta' ? 'Super' : name}${state === 'lock' ? ', locked' : ''}`}
                        accessibilityHint="Tap for the next key, tap again to lock."
                        accessibilityState={{ selected: state !== 'off' }}
                        style={({ pressed }) => [
                            styles.key,
                            { minWidth: 42 },
                            state === 'lock' && { backgroundColor: theme.colors.accentSubtle },
                            pressed && styles.pressed,
                        ]}
                    >
                        {label(glyphs ? glyph : text, state === 'off' ? KEY_TINT : theme.colors.accent)}
                    </Pressable>
                );
            })}
            {(more ? MORE_KEYS : KEYS).map((key) => (
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
                    style={({ pressed }) => [styles.key, { minWidth: 34, paddingHorizontal: 5 }, pressed && styles.pressed]}
                >
                    {key.icon !== undefined
                        ? <Ionicons name={key.icon} size={12} color={KEY_TINT} />
                        : label(key.label ?? key.name, KEY_TINT)}
                </Pressable>
            ))}
            </ScrollView>
            <Pressable
                onPress={() => { release(); hapticsSelection(); row.current?.scrollTo({ x: 0, animated: false }); setMore(!more); }}
                accessibilityRole="button"
                accessibilityLabel={more ? 'Back to main desktop keys' : 'More desktop keys'}
                accessibilityState={{ selected: more }}
                style={({ pressed }) => [styles.key, { minWidth: 38 }, more && { backgroundColor: theme.colors.accentSubtle }, pressed && styles.pressed]}
            >
                {label(more ? '‹' : 'more', more ? theme.colors.accent : KEY_TINT)}
            </Pressable>
        </View>
    );
}

const styles = {
    key: { height: 34, maxWidth: 72, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
    pressed: { opacity: 0.6 },
} as const;
