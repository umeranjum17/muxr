import * as React from 'react';
import { AppState, Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import type { LifecycleNotificationLevel } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useLocalSettingMutable } from '@/catalog/store';
import { Modal } from '@/modal';
import { browserNotificationSummary } from '@/settings';
import { requestNotificationPermission } from '@/utils/microphonePermissions';
import { registerNativePushNotifications, updateNativePushNotificationLevel } from '@/utils/nativePushNotifications';
import {
    refreshPushState,
    requestPermissionAndSubscribe,
    storeWebPushNotificationLevel,
    unsubscribeWebPush,
    updateWebPushNotificationLevel,
    type PushState,
} from '@/utils/pushNotifications';
import {
    canPostPromotedNotifications,
    openBackgroundActivitySettings,
    openPromotedNotificationSettings,
    supportsPromotedNotifications,
} from '@/../modules/voice-overlay';

const SYSTEM = Platform.OS === 'ios' ? 'iOS Settings' : 'Android settings';

/** Sound, vibration and banners belong to the system; this opens muxr's page there. */
function openSystemNotificationSettings(): void {
    const packageName = Application.applicationId;
    if (Platform.OS === 'android' && packageName !== null) {
        Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
            { key: 'android.provider.extra.APP_PACKAGE', value: packageName },
        ]).catch(() => Linking.openSettings());
        return;
    }
    void Linking.openSettings();
}

/** Each platform names its own surface; neither promises the other's. */
function liveUpdatesSummary(enabled: boolean): string {
    if (Platform.OS === 'ios') {
        return enabled ? 'On · working agents show on the Lock Screen' : 'Off · allow Live Activities in iOS Settings';
    }
    return enabled ? 'On · working agents show in the status bar' : 'Off · turn on Live Updates in Android settings';
}

export default function NotificationSettingsScreen() {
    const web = Platform.OS === 'web';
    const [level, setLevel] = useLocalSettingMutable('lifecycleNotificationLevel');
    const [browser, setBrowser] = React.useState<PushState>('unsupported');
    const [browserBusy, setBrowserBusy] = React.useState(false);
    const [levelBusy, setLevelBusy] = React.useState(false);
    const [error, setError] = React.useState<'browser' | 'level' | null>(null);
    const [allowed, setAllowed] = React.useState(true);
    const liveSupported = supportsPromotedNotifications();
    const [liveOn, setLiveOn] = React.useState(() => !liveSupported || canPostPromotedNotifications());

    // Permission, browser subscription and Live Updates are owned by the
    // system, so read them again whenever the person comes back from there.
    React.useEffect(() => {
        let live = true;
        if (web) void storeWebPushNotificationLevel(level);
        const read = () => {
            if (web) {
                void refreshPushState().then((state) => { if (live) setBrowser(state); });
                return;
            }
            void Notifications.getPermissionsAsync().then((permission) => { if (live) setAllowed(permission.granted); }, () => {});
            if (liveSupported) setLiveOn(canPostPromotedNotifications());
        };
        read();
        const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
        return () => {
            live = false;
            subscription.remove();
        };
    }, [liveSupported, web]);

    const choose = async (next: LifecycleNotificationLevel) => {
        if (next === level || levelBusy || browserBusy) return;
        setLevelBusy(true);
        setError(null);
        const previous = level;
        try {
            if (web && !await storeWebPushNotificationLevel(next)) {
                setError('level');
                return;
            }
            setLevel(next);
            const synced = web
                ? (await refreshPushState()) !== 'subscribed' || await updateWebPushNotificationLevel(next)
                : Platform.OS !== 'ios' || await updateNativePushNotificationLevel(next);
            if (!synced) {
                if (web) await storeWebPushNotificationLevel(previous);
                setLevel(previous);
                setError('level');
            }
        } finally {
            setLevelBusy(false);
        }
    };

    const setBrowserNotifications = async (on: boolean) => {
        if (browserBusy || levelBusy) return;
        setBrowserBusy(true);
        setError(null);
        try {
            if (on && !await requestPermissionAndSubscribe()) {
                await unsubscribeWebPush();
                setError('browser');
            } else if (!on) {
                await unsubscribeWebPush();
            }
            setBrowser(await refreshPushState());
        } finally {
            setBrowserBusy(false);
        }
    };

    const allow = async () => {
        if (allowed) {
            openSystemNotificationSettings();
            return;
        }
        await requestNotificationPermission();
        const granted = (await Notifications.getPermissionsAsync()).granted;
        setAllowed(granted);
        if (granted) {
            if (Platform.OS === 'ios') void registerNativePushNotifications();
            return;
        }
        if (await Modal.confirm('Allow notifications?', `Turn on notifications for muxr in ${SYSTEM}.`, { confirmText: 'Open settings' })) {
            openSystemNotificationSettings();
        }
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {web ? (
                <ItemGroup footer={error === 'browser' ? "Couldn't update — try again" : browser === 'denied'
                    ? 'Allow notifications for this site in the browser, then come back here.'
                    : 'Sound follows your browser and system settings.'}>
                    <Item
                        title="Browser notifications"
                        subtitle={browser === 'subscribed' ? 'On' : browserNotificationSummary(browser, level)}
                        showChevron={false}
                        loading={browserBusy}
                        rightElement={browserBusy ? undefined : (
                            <Switch
                                accessibilityLabel="Browser notifications"
                                value={browser === 'subscribed'}
                                disabled={browser === 'denied' || browser === 'unsupported' || levelBusy}
                                onValueChange={(on) => setBrowserNotifications(on)}
                            />
                        )}
                    />
                </ItemGroup>
            ) : (
                <ItemGroup footer={`Sound, vibration and banners are set in ${SYSTEM}.`}>
                    <Item title="Allow notifications" subtitle={allowed ? 'On' : 'Off'} onPress={() => void allow()} />
                    <Item
                        title={Platform.OS === 'ios' ? 'Sounds and banners' : 'Sound and vibration'}
                        subtitle={`Set in ${SYSTEM}`}
                        onPress={openSystemNotificationSettings}
                    />
                </ItemGroup>
            )}

            <ItemGroup title="Alert me when" footer={error === 'level' ? "Couldn't update — try again" : 'Home still shows what happened while you were away.'}>
                <Item
                    title="An agent needs you"
                    subtitle="It asks for approval or stops with an error"
                    subtitleLines={2}
                    showChevron={false}
                    rightElement={<Switch accessibilityLabel="An agent needs you" value={level !== 'off'} disabled={levelBusy || browserBusy} onValueChange={(on) => choose(on ? 'important' : 'off')} />}
                />
                {level !== 'off' && (
                    <Item
                        title="An agent finishes"
                        subtitle="Its work is done"
                        showChevron={false}
                        rightElement={<Switch accessibilityLabel="An agent finishes" value={level === 'all'} disabled={levelBusy || browserBusy} onValueChange={(on) => choose(on ? 'all' : 'important')} />}
                    />
                )}
            </ItemGroup>

            {(Platform.OS === 'android' || liveSupported) && (
                <ItemGroup title="Staying connected">
                    {Platform.OS === 'android' && (
                        <Item
                            title="Background connection"
                            subtitle="Allow background activity so alerts keep arriving after you leave muxr"
                            subtitleLines={2}
                            onPress={openBackgroundActivitySettings}
                        />
                    )}
                    {liveSupported && (
                        <Item title="Live agent updates" subtitle={liveUpdatesSummary(liveOn)} subtitleLines={2} onPress={openPromotedNotificationSettings} />
                    )}
                </ItemGroup>
            )}
        </ItemList>
    );
}
