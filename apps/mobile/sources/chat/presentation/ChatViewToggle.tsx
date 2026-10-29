import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { withAlpha } from '@/components/ui';
import type { PaneView } from '../domain/sessionView';

/**
 * The header's Chat | Terminal switch. It names both views where the header has
 * room for words and shrinks to the two marks where it does not, so the switch
 * is always in the header and the title keeps the rest. An agent with no chat
 * keeps both so the header never changes shape; the chat one is dimmed and
 * says why.
 */
export function ChatViewToggle(props: { view: PaneView; chatAvailable: boolean; labelled: boolean; onChange: (view: PaneView) => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const mark = (view: PaneView, icon: 'chatbubble-outline' | 'terminal-outline', word: string, label: string) => {
        const active = props.view === view;
        const dimmed = view === 'chat' && !props.chatAvailable;
        return (
            <Pressable
                onPress={dimmed ? undefined : () => props.onChange(view)}
                accessibilityRole="button"
                accessibilityLabel={dimmed ? `${label}, available for Claude and Pi` : label}
                accessibilityState={{ selected: active, disabled: dimmed }}
                hitSlop={4}
                style={{ minWidth: props.labelled ? undefined : 28, height: 26, paddingHorizontal: props.labelled ? 10 : 0, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? (theme.dark ? withAlpha(theme.colors.text, 0.9) : theme.colors.surface) : 'transparent', opacity: dimmed ? 0.35 : 1, ...(active && !theme.dark ? { borderWidth: 0.5, borderColor: theme.colors.divider } : {}) }}
            >
                {props.labelled
                    ? <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ fontSize: 13, fontWeight: '600', color: active ? (theme.dark ? '#111111' : theme.colors.text) : theme.colors.textSecondary }}>{word}</Text>
                    : <Ionicons name={icon} size={15} color={active ? (theme.dark ? '#111111' : theme.colors.text) : theme.colors.textSecondary} />}
            </Pressable>
        );
    };
    return (
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', padding: 2, borderRadius: 15, flexShrink: 0, backgroundColor: withAlpha(theme.colors.text, theme.dark ? 0.12 : 0.07) }}>
            {mark('chat', 'chatbubble-outline', 'Chat', 'Chat view')}
            {mark('terminal', 'terminal-outline', 'Terminal', 'Terminal view')}
        </View>
    );
}
