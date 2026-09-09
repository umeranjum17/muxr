import { Ionicons } from '@expo/vector-icons';
import type { LifecycleNotificationLevel } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useLocalSettingMutable } from '@/catalog/store';
import { updateNativePushNotificationLevel } from '@/utils/nativePushNotifications';

const OPTIONS: ReadonlyArray<{
    key: LifecycleNotificationLevel;
    title: string;
    summary: string;
}> = [
    { key: 'off', title: 'Off', summary: 'No agent lifecycle alerts' },
    { key: 'important', title: 'Important', summary: 'Blocked and failed agents' },
    { key: 'all', title: 'All activity', summary: 'Blocked, failed, and completed agents' },
];

export default function NotificationSettingsScreen() {
    const [level, setLevel] = useLocalSettingMutable('lifecycleNotificationLevel');

    const select = (next: LifecycleNotificationLevel) => {
        if (next === level) return;
        setLevel(next);
        void updateNativePushNotificationLevel(next);
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Lifecycle alerts"
                footer="While You Were Away still shows blocked, failed, and completed activity at every level."
            >
                {OPTIONS.map((option) => {
                    const selected = option.key === level;
                    return (
                        <Item
                            key={option.key}
                            title={option.title}
                            subtitle={option.summary}
                            icon={<Ionicons name="notifications-outline" size={29} color="#FF9500" />}
                            rightElement={selected ? <Ionicons name="checkmark" size={20} color="#007AFF" /> : null}
                            selected={selected}
                            showChevron={false}
                            onPress={() => select(option.key)}
                            accessibilityLabel={`${option.title}. ${option.summary}`}
                        />
                    );
                })}
            </ItemGroup>
        </ItemList>
    );
}
