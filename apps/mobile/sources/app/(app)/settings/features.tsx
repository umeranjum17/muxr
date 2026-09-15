import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/catalog/store';
import { Switch } from '@/components/Switch';
import { t } from '@/text';

export default function PreferencesSettingsScreen() {
    const wakeLockSupported = Platform.OS !== 'web' || (typeof navigator !== 'undefined' && 'wakeLock' in navigator);
    const [terminalKeyboardDisabled, setTerminalKeyboardDisabled] = useLocalSettingMutable('terminalKeyboardDisabled');
    const [keepScreenAwakeWhileWatching, setKeepScreenAwakeWhileWatching] = useLocalSettingMutable('keepScreenAwakeWhileWatching');
    const [reopenLastTerminal, setReopenLastTerminal] = useLocalSettingMutable('reopenLastTerminal');
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [sortSessionsByActivity, setSortSessionsByActivity] = useSettingMutable('sortSessionsByActivity');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Sessions" footer="These choices apply now on this device. Hidden sessions stay on the computer.">
                <Item
                    title="Last terminal"
                    subtitle="Reopen on launch if available"
                    icon={<Ionicons name="return-down-back-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={reopenLastTerminal} onValueChange={setReopenLastTerminal} />}
                    showChevron={false}
                />
                <Item
                    title="Session order"
                    subtitle={sortSessionsByActivity ? 'Recent activity moves the latest session to the top' : 'Created order keeps the newest session first'}
                    detail={sortSessionsByActivity ? 'Recent activity' : 'Created'}
                    icon={<Ionicons name="swap-vertical-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={sortSessionsByActivity} onValueChange={setSortSessionsByActivity} accessibilityLabel="Sort sessions by recent activity" />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.hideInactiveSessions')}
                    subtitle={`${t('settingsFeatures.hideInactiveSessionsSubtitle')} · ${hideInactiveSessions ? 'On' : 'Off'}`}
                    icon={<Ionicons name="eye-off-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={hideInactiveSessions} onValueChange={setHideInactiveSessions} accessibilityLabel={t('settingsFeatures.hideInactiveSessions')} />}
                    showChevron={false}
                />
            </ItemGroup>
            <ItemGroup title="Watching agents" footer="The screen can stay awake only while this app is foregrounded on a working terminal.">
                <Item
                    title="Stay awake"
                    subtitle={!wakeLockSupported ? 'Screen Wake Lock is unavailable in this browser' : Platform.OS === 'web' ? 'While this tab is visible, if the browser permits it' : 'While viewing a working agent'}
                    icon={<Ionicons name="sunny-outline" size={29} color="#FF9500" />}
                    rightElement={<Switch value={keepScreenAwakeWhileWatching && wakeLockSupported} disabled={!wakeLockSupported} onValueChange={setKeepScreenAwakeWhileWatching} />}
                    showChevron={false}
                />
            </ItemGroup>
            {Platform.OS !== 'web' && (
                <ItemGroup title="Terminal keyboard" footer="The keyboard button in each terminal always lets you type. This preference applies on this device.">
                    <Item
                        title="Open keyboard on tap"
                        subtitle={`Show the keyboard when tapping shells, Terminal Browser or Terminal Code · ${terminalKeyboardDisabled ? 'Off' : 'On'}`}
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={!terminalKeyboardDisabled} onValueChange={(enabled) => setTerminalKeyboardDisabled(!enabled)} accessibilityLabel="Open keyboard on tap" />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
            {Platform.OS === 'web' && (
                <ItemGroup title="Advanced" footer="Web-only keyboard controls. This preference applies in this browser.">
                    <Item
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={`${commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')} · ${commandPaletteEnabled ? 'On' : 'Off'}`}
                        icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
                        rightElement={<Switch value={commandPaletteEnabled} onValueChange={setCommandPaletteEnabled} accessibilityLabel={t('settingsFeatures.commandPalette')} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
