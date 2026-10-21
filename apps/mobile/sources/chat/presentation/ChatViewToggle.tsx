import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { withAlpha } from '@/components/ui';
import type { PaneView } from '../domain/sessionView';

/**
 * The header's chat / terminal switch. An agent with no chat keeps both marks
 * so the header never changes shape; the chat one is dimmed and says why.
 */
export function ChatViewToggle(props: { view: PaneView; chatAvailable: boolean; onChange: (view: PaneView) => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const mark = (view: PaneView, icon: 'chatbubble-outline' | 'terminal-outline', label: string) => {
        const active = props.view === view;
        const dimmed = view === 'chat' && !props.chatAvailable;
        return (
            <Pressable
                onPress={dimmed ? undefined : () => props.onChange(view)}
                accessibilityRole="button"
                accessibilityLabel={dimmed ? `${label}, available for Claude and Pi` : label}
                accessibilityState={{ selected: active, disabled: dimmed }}
                hitSlop={4}
                style={{ width: 28, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? withAlpha(theme.colors.text, 0.14) : 'transparent', opacity: dimmed ? 0.35 : 1 }}
            >
                <Ionicons name={icon} size={15} color={active ? theme.colors.text : theme.colors.textSecondary} />
            </Pressable>
        );
    };
    return (
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', padding: 2, borderRadius: 15, backgroundColor: withAlpha(theme.colors.text, 0.07) }}>
            {mark('chat', 'chatbubble-outline', 'Chat view')}
            {mark('terminal', 'terminal-outline', 'Terminal view')}
        </View>
    );
}
