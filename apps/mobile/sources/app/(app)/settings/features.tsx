import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/catalog/store';
import { Switch } from '@/components/Switch';
import { t } from '@/text';

export default function PreferencesSettingsScreen() {
    const [terminalAutoShowKeyboard, setTerminalAutoShowKeyboard] = useLocalSettingMutable('terminalAutoShowKeyboard');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [sortSessionsByActivity, setSortSessionsByActivity] = useSettingMutable('sortSessionsByActivity');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Sessions" footer="Choose how existing sessions are ordered and filtered.">
                <Item
                    title="Sort by Recent Activity"
                    subtitle="Order sessions by last activity"
                    icon={<Ionicons name="swap-vertical-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={sortSessionsByActivity} onValueChange={setSortSessionsByActivity} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={t('settingsFeatures.hideInactiveSessionsSubtitle')}
                    icon={<Ionicons name="eye-off-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={hideInactiveSessions} onValueChange={setHideInactiveSessions} />}
                    showChevron={false}
                />
            </ItemGroup>
            {Platform.OS === 'android' && (
                <ItemGroup title="Terminal keyboard" footer="The keyboard button in each terminal always lets you type. This preference stays on this device.">
                    <Item
                        title="Open keyboard on tap"
                        subtitle="Show the keyboard when tapping shells, Terminal Browser or Terminal Code"
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={terminalAutoShowKeyboard} onValueChange={setTerminalAutoShowKeyboard} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
            {Platform.OS === 'web' && (
                <ItemGroup title="Advanced" footer="Web-only keyboard controls.">
                    <Item
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={commandPaletteEnabled} onValueChange={setCommandPaletteEnabled} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
