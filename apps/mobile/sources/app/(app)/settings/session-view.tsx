import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useLocalSettingMutable } from '@/catalog/store';
import { SESSION_VIEW_CHOICES } from '@/chat';

/** Which view an agent opens in. A choice made in an agent's own header outranks it for that agent. */
export default function SessionViewSettingsScreen() {
    const { theme } = useUnistyles();
    const [sessionView, setSessionView] = useLocalSettingMutable('sessionView');
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Open sessions in"
                footer="Each session can switch with the chat and terminal buttons in its header, and remembers the choice. Chat reads Claude and Pi sessions only."
            >
                {SESSION_VIEW_CHOICES.map((choice) => (
                    <Item
                        key={choice.key}
                        title={choice.title}
                        subtitle={choice.subtitle}
                        subtitleLines={0}
                        showChevron={false}
                        selected={sessionView === choice.key}
                        rightElement={sessionView === choice.key ? <Ionicons name="checkmark" size={22} color={theme.colors.textLink} /> : undefined}
                        onPress={() => setSessionView(choice.key)}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}
