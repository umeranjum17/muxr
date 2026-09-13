import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useSettingMutable, useLocalSettingMutable } from '@/catalog/store';
import { Switch } from '@/components/Switch';
import { t } from '@/text';

const ORDER_OPTIONS = [
    { key: 'created', label: 'Created' },
    { key: 'activity', label: 'Recent activity' },
] as const;

export default function PreferencesSettingsScreen() {
    const { theme } = useUnistyles();
    const [terminalKeyboardDisabled, setTerminalKeyboardDisabled] = useLocalSettingMutable('terminalKeyboardDisabled');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [sortSessionsByActivity, setSortSessionsByActivity] = useSettingMutable('sortSessionsByActivity');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Order sessions by"
                footer={sortSessionsByActivity
                    ? 'Recent activity lifts a session when its agent last spoke. Applies now on this device.'
                    : 'Created lists the newest session first. Applies now on this device.'}
            >
                <SegmentedControl accessibilityLabel="Order sessions by" options={ORDER_OPTIONS}
                    value={sortSessionsByActivity ? 'activity' : 'created'} onChange={(key) => setSortSessionsByActivity(key === 'activity')} />
            </ItemGroup>
            <ItemGroup title="Sessions" footer="Inactive means the session's agent is not running. Hidden sessions stay on the computer. Applies now on this device.">
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color={theme.colors.textSecondary} />}
                    rightElement={<Switch value={hideInactiveSessions} onValueChange={setHideInactiveSessions} accessibilityLabel={t('settingsFeatures.hideInactiveSessions')} />}
                    showChevron={false}
                />
            </ItemGroup>
            {Platform.OS !== 'web' && (
                <ItemGroup title="Terminal keyboard" footer="The keyboard button in each terminal always lets you type. Applies now on this device.">
                    <Item
                        title="Open keyboard on tap"
                        subtitle="Show the keyboard when tapping shells, Terminal Browser or Terminal Code"
                        icon={<Ionicons name="keypad-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={<Switch value={!terminalKeyboardDisabled} onValueChange={(enabled) => setTerminalKeyboardDisabled(!enabled)} accessibilityLabel="Open keyboard on tap" />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
            {Platform.OS === 'web' && (
                <ItemGroup title="Advanced" footer="Web-only keyboard controls. Applies now in this browser.">
                    <Item
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
                        icon={<Ionicons name="keypad-outline" size={29} color={theme.colors.textSecondary} />}
                        rightElement={<Switch value={commandPaletteEnabled} onValueChange={setCommandPaletteEnabled} accessibilityLabel={t('settingsFeatures.commandPalette')} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
