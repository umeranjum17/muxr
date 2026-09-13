import type { LifecycleNotificationLevel } from '@muxr/contract';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useLocalSettingMutable } from '@/catalog/store';
import { updateNativePushNotificationLevel } from '@/utils/nativePushNotifications';

const OPTIONS = [
    { key: 'off', label: 'Off' },
    { key: 'important', label: 'Important' },
    { key: 'all', label: 'All activity' },
] as const satisfies ReadonlyArray<{ key: LifecycleNotificationLevel; label: string }>;

// The current choice, explained in one line under the control.
const EXPLAINED: Record<LifecycleNotificationLevel, string> = {
    off: 'No agent lifecycle alerts. Applies now on this device.',
    important: 'Blocked and failed agents. Applies now on this device.',
    all: 'Blocked, failed and completed agents. Applies now on this device.',
};

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
                footer={`${EXPLAINED[level]} While You Were Away still shows blocked, failed, and completed activity at every level.`}
            >
                <SegmentedControl accessibilityLabel="Lifecycle alerts" options={OPTIONS} value={level} onChange={select} />
            </ItemGroup>
        </ItemList>
    );
}
