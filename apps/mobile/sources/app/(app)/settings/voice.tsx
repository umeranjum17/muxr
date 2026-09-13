import * as React from 'react';
import { ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { callPlugin } from '@/plugins';
import { pluginCatalogSnapshot, refreshPlugins } from '@/plugins';
import { voicePluginFromCatalog } from '@/plugins/application/voicePluginAccess';
import { useLocalSetting, useSocketStatus } from '@/catalog/store';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { configureVadStandby } from '@/conversation/session';
import { ensureRealtimeProviderConfigured, requestRealtimePermission } from '@/conversation';
import { failureText } from '@/utils/errors';

/**
 * Realtime voice readiness. Which provider answers, its account, model and
 * credentials are decided on the computer (`muxr voice`); this screen only
 * shows whether that computer is ready and where to set it up.
 */
type VoiceStatus = { configured: boolean; statusLabel: string };

async function loadVoicePlugin() {
    await refreshPlugins();
    return voicePluginFromCatalog(pluginCatalogSnapshot());
}

export default function VoiceReadinessScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const [ready, setReady] = React.useState<VoiceStatus>();
    const [loaded, setLoaded] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const [disabled, setDisabled] = React.useState(false);
    const vadStandbyEnabled = useLocalSetting('vadStandbyEnabled');

    const load = React.useCallback(async () => {
        if (status !== 'connected') { setLoaded(true); return; }
        setLoaded(false);
        try {
            const access = await loadVoicePlugin();
            if (access.status !== 'ready') {
                setDisabled(access.status === 'disabled');
                setReady(undefined);
                setError(access.status === 'missing' ? 'No voice plugin is available on this computer.' : undefined);
                return;
            }
            setDisabled(false);
            setReady(await callPlugin<VoiceStatus>('voice.status'));
            setError(undefined);
        } catch (cause) {
            setError(failureText(cause));
        } finally {
            setLoaded(true);
        }
    }, [status]);

    React.useEffect(() => { void load(); }, [load]);

    const setVadStandby = React.useCallback(async (enabled: boolean) => {
        if (!enabled) return void configureVadStandby(false);
        if (!(await requestRealtimePermission()) || !(await ensureRealtimeProviderConfigured())) return;
        if (!(await configureVadStandby(true))) {
            Modal.alert('Wake on speech unavailable', 'Start or connect an agent first, then try again.');
        }
    }, []);

    if (status === 'connected' && !loaded) return <ActivityIndicator style={{ flex: 1 }} />;

    const readinessFooter = error
        ?? (disabled ? 'Realtime voice is turned off for this device. Enable it from Plugins if you want it back.' : undefined)
        ?? (status === 'connected'
            ? 'Voice is set up on the computer, not here: on it, run muxr voice, or open the muxr host voice pane in Herdr. This app never sees which provider answers or any key.'
            : 'Connect to a computer to see whether its realtime voice is ready.');

    return (
        <ItemList>
            <ItemGroup title="On this computer" footer={readinessFooter}>
                {disabled ? (
                    <Item
                        title="Voice plugin disabled"
                        subtitle="Open Plugins to enable it"
                        icon={<Ionicons name="settings-outline" size={28} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/settings/plugins' as any)}
                    />
                ) : (
                    <Item
                        title="Realtime voice"
                        subtitle={ready === undefined ? 'Unavailable' : ready.statusLabel}
                        icon={<Ionicons name={ready?.configured ? 'checkmark-circle-outline' : 'alert-circle-outline'} size={28} color={ready?.configured ? theme.colors.success : theme.colors.textSecondary} />}
                        showChevron={false}
                        onPress={() => void load()}
                    />
                )}
            </ItemGroup>
            <ItemGroup
                title="Hands-free"
                footer={
                    Platform.OS === 'web'
                        ? 'Listens only while this app is open and visible. Browsers cannot listen in the background; keep this tab in the foreground.'
                        : 'Listens only on this device until speech is detected. The setting stays enabled until you disable it and uses additional battery.'
                }
            >
                <Item
                    title="Wake on speech"
                    subtitle="Reconnect realtime voice when someone starts talking"
                    icon={<Ionicons name="ear-outline" size={28} color={theme.colors.textSecondary} />}
                    showChevron={false}
                    rightElement={<Switch value={vadStandbyEnabled} onValueChange={(value) => void setVadStandby(value)} />}
                />
            </ItemGroup>
        </ItemList>
    );
}
