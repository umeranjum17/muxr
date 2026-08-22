import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { VoiceProviderOption } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { sourceLabel } from '@/plugins/pluginActions';
import { pluginHref } from '@/plugins/pluginHref';
import { pluginCatalogSnapshot, refreshPlugins } from '@/plugins/pluginStore';
import { sync } from '@/sync/sync';
import { useSocketStatus } from '@/sync/storage';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

export default function VoiceProviderScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const [providers, setProviders] = React.useState<VoiceProviderOption[]>([]);
    const [busy, setBusy] = React.useState<string>();
    const [loaded, setLoaded] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const busyRef = React.useRef(false);

    const load = React.useCallback(async () => {
        if (status !== 'connected') { setLoaded(true); return; }
        setLoaded(false);
        try {
            setProviders(await sync.request('voice.provider.list', {}));
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoaded(true);
        }
    }, [status]);

    React.useEffect(() => { void load(); }, [load]);

    const approveProvider = React.useCallback(async (providerId: string) => {
        await refreshPlugins();
        let plugin = pluginCatalogSnapshot().find(({ summary }) => summary.pluginId === providerId);
        if (plugin?.summary.manifestHash !== undefined && !plugin.summary.approved) {
            await sync.request('plugin.approve', {
                pluginId: plugin.summary.pluginId,
                manifestHash: plugin.summary.manifestHash,
                approved: true,
            });
            await refreshPlugins();
            plugin = pluginCatalogSnapshot().find(({ summary }) => summary.pluginId === providerId);
        }
        return plugin;
    }, []);

    const select = React.useCallback(async (provider: VoiceProviderOption) => {
        if ((provider.selected && providers.filter((candidate) => candidate.selected).length === 1) || busyRef.current) return;
        busyRef.current = true;
        setBusy(provider.id);
        let switched = false;
        try {
            const next = await sync.request('voice.provider.select', { providerId: provider.id });
            switched = true;
            setProviders(next);
            await approveProvider(provider.id);
            setError(undefined);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            Modal.alert(switched ? 'Provider selected, but setup failed' : 'Could not switch voice provider', message);
            await load();
        } finally {
            busyRef.current = false;
            setBusy(undefined);
        }
    }, [approveProvider, load, providers]);

    const selected = providers.find((provider) => provider.selected);
    const configure = React.useCallback(async () => {
        if (selected === undefined || busyRef.current) return;
        busyRef.current = true;
        setBusy(selected.id);
        try {
            const plugin = await approveProvider(selected.id);
            const settings = plugin?.manifest?.contributions.find((contribution) => contribution.slot === 'settings.items' && contribution.type === 'settings-item');
            if (settings?.action.type !== 'screen') throw new Error('Open Settings → Plugins and enable this provider, then try again.');
            router.push(pluginHref(selected.id, settings.action.contributionId) as any);
        } catch (cause) {
            Modal.alert('Provider settings unavailable', cause instanceof Error ? cause.message : String(cause));
        } finally {
            busyRef.current = false;
            setBusy(undefined);
        }
    }, [approveProvider, router, selected]);

    if (status === 'connected' && !loaded) return <ActivityIndicator style={{ flex: 1 }} />;

    return (
        <ItemList>
            <ItemGroup title="Provider" footer={error ?? (status === 'connected' ? 'Exactly one provider runs on this machine. Only installed providers are shown.' : 'Connect to a machine to choose its voice provider.')}>
                {providers.map((provider) => (
                    <Item
                        key={provider.id}
                        title={provider.name}
                        subtitle={`${provider.selected ? 'Selected' : 'Tap to use on this machine'} · ${sourceLabel(provider.source)} · ${provider.hasBackend ? 'Runs code on this machine' : 'UI only'}`}
                        subtitleLines={2}
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
                        subtitle="Set or replace its API key on the connected machine"
                        icon={<Ionicons name="key-outline" size={28} color={theme.colors.textSecondary} />}
                        loading={busy === selected.id}
                        onPress={() => void configure()}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
