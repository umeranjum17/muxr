import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { callPlugin, pluginHref } from '@/plugins';
import { pluginCatalogSnapshot, refreshPlugins } from '@/plugins';
import { voicePluginFromCatalog } from '@/plugins/application/voicePluginAccess';
import { useLocalSetting, useSocketStatus } from '@/catalog/store';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { configureVadStandby } from '@/conversation/session';
import { ensureRealtimeProviderConfigured, requestRealtimePermission } from '@/conversation';

type ProviderOption = { id: string; name: string; selected: boolean };
type ProviderList = { selected: string; providers: ProviderOption[] };

async function loadVoicePlugin() {
    await refreshPlugins();
    return voicePluginFromCatalog(pluginCatalogSnapshot());
}

export default function VoiceProviderScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const [providers, setProviders] = React.useState<ProviderOption[]>([]);
    const [busy, setBusy] = React.useState<string>();
    const [loaded, setLoaded] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const [disabled, setDisabled] = React.useState(false);
    const busyRef = React.useRef(false);
    const vadStandbyEnabled = useLocalSetting('vadStandbyEnabled');

    const load = React.useCallback(async () => {
        if (status !== 'connected') { setLoaded(true); return; }
        setLoaded(false);
        try {
            const access = await loadVoicePlugin();
            if (access.status !== 'ready') {
                setDisabled(access.status === 'disabled');
                setProviders([]);
                setError(access.status === 'missing' ? 'No voice plugin is available on this machine.' : undefined);
                return;
            }
            setDisabled(false);
            setProviders((await callPlugin<ProviderList>('voice.provider.list')).providers);
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoaded(true);
        }
    }, [status]);

    React.useEffect(() => { void load(); }, [load]);

    const select = React.useCallback(async (provider: ProviderOption) => {
        if (provider.selected || busyRef.current) return;
        busyRef.current = true;
        setBusy(provider.id);
        try {
            setProviders((await callPlugin<ProviderList>('voice.provider.set', { providerId: provider.id })).providers);
            setError(undefined);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            Modal.alert('Could not switch voice provider', message);
            await load();
        } finally {
            busyRef.current = false;
            setBusy(undefined);
        }
    }, [load]);

    const selected = providers.find((provider) => provider.selected);
    const configure = React.useCallback(async () => {
        if (selected === undefined || busyRef.current) return;
        busyRef.current = true;
        setBusy(selected.id);
        try {
            const access = await loadVoicePlugin();
            if (access.status === 'disabled') {
                router.push('/settings/plugins' as any);
                return;
            }
            const plugin = access.plugin;
            const settings = plugin?.manifest?.contributions.find((contribution) => contribution.slot === 'settings.items' && contribution.type === 'settings-item');
            if (settings?.action.type !== 'screen') throw new Error('This provider has no configuration screen.');
            router.push(pluginHref(plugin!.summary.pluginId, settings.action.contributionId) as any);
        } catch (cause) {
            Modal.alert('Provider settings unavailable', cause instanceof Error ? cause.message : String(cause));
        } finally {
            busyRef.current = false;
            setBusy(undefined);
        }
    }, [router, selected]);

    const setVadStandby = React.useCallback(async (enabled: boolean) => {
        if (!enabled) return void configureVadStandby(false);
        if (!(await requestRealtimePermission()) || !(await ensureRealtimeProviderConfigured())) return;
        if (!(await configureVadStandby(true))) {
            Modal.alert('Wake on speech unavailable', 'Start or connect an agent first, then try again.');
        }
    }, []);

    if (status === 'connected' && !loaded) return <ActivityIndicator style={{ flex: 1 }} />;

    const providerFooter = error
        ?? (disabled ? 'Realtime voice is turned off for this device. Enable it from Plugins if you want it back.' : undefined)
        ?? (status === 'connected' ? 'One provider runs on this machine at a time.' : 'Connect to a machine to choose its voice provider.');

    return (
        <ItemList>
            <ItemGroup title="Provider" footer={providerFooter}>
                {disabled ? (
                    <Item
                        title="Voice plugin disabled"
                        subtitle="Open Plugins to enable it"
                        icon={<Ionicons name="settings-outline" size={28} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/settings/plugins' as any)}
                    />
                ) : providers.map((provider) => (
                    <Item
                        key={provider.id}
                        title={provider.name}
                        subtitle={provider.selected ? 'Selected' : 'Tap to use on this machine'}
                        selected={provider.selected}
                        loading={busy === provider.id}
                        showChevron={false}
                        onPress={() => void select(provider)}
                        rightElement={provider.selected ? <Ionicons name="checkmark-circle" size={24} color={theme.colors.textLink} /> : undefined}
                    />
                ))}
            </ItemGroup>
            {selected !== undefined && (
                <ItemGroup title="Setup">
                    <Item
                        title={`Configure ${selected.name}`}
                        subtitle="Open the provider's settings on the connected machine"
                        icon={<Ionicons name="settings-outline" size={28} color={theme.colors.textSecondary} />}
                        loading={busy === selected.id}
                        onPress={() => void configure()}
                    />
                </ItemGroup>
            )}
            <ItemGroup title="Hands-free" footer="Listens only on this device until speech is detected. The setting stays enabled until you disable it and uses additional battery.">
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
