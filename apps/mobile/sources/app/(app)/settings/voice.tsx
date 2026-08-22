import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { VoiceProviderOption } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
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
    const [error, setError] = React.useState<string>();

    const load = React.useCallback(async () => {
        if (status !== 'connected') return;
        try {
            setProviders(await sync.request('voice.provider.list', {}));
            setError(undefined);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [status]);

    React.useEffect(() => { void load(); }, [load]);

    const select = React.useCallback(async (provider: VoiceProviderOption) => {
        if ((provider.selected && providers.filter((candidate) => candidate.selected).length === 1) || busy !== undefined) return;
        setBusy(provider.id);
        try {
            const next = await sync.request('voice.provider.select', { providerId: provider.id });
            setProviders(next);
            await refreshPlugins();
            const plugin = pluginCatalogSnapshot().find(({ summary }) => summary.pluginId === provider.id);
            if (plugin?.summary.manifestHash !== undefined && !plugin.summary.approved) {
                await sync.request('plugin.approve', {
                    pluginId: plugin.summary.pluginId,
                    manifestHash: plugin.summary.manifestHash,
                    approved: true,
                });
                await refreshPlugins();
            }
            setError(undefined);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            Modal.alert('Could not switch voice provider', message);
            await load();
        } finally {
            setBusy(undefined);
        }
    }, [busy, load, providers]);

    const selected = providers.find((provider) => provider.selected);
    const configure = React.useCallback(() => {
        if (selected === undefined) return;
        const plugin = pluginCatalogSnapshot().find(({ summary }) => summary.pluginId === selected.id && summary.approved);
        const settings = plugin?.manifest?.contributions.find((contribution) => contribution.slot === 'settings.items' && contribution.type === 'settings-item');
        if (settings?.action.type !== 'screen') {
            Modal.alert('Provider settings unavailable', 'Reconnect to this machine and try again.');
            return;
        }
        router.push(pluginHref(selected.id, settings.action.contributionId) as any);
    }, [router, selected]);

    if (status === 'connected' && providers.length === 0 && error === undefined) return <ActivityIndicator style={{ flex: 1 }} />;

    return (
        <ItemList>
            <ItemGroup title="Provider" footer={error ?? (status === 'connected' ? 'Exactly one realtime speech-to-speech provider runs on this machine.' : 'Connect to a machine to choose its voice provider.')}>
                {providers.map((provider) => (
                    <Item
                        key={provider.id}
                        title={provider.name}
                        subtitle={provider.available ? (provider.selected ? 'Selected' : 'Tap to use on this machine') : 'Not installed — update muxr on this machine'}
                        selected={provider.selected}
                        disabled={!provider.available}
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
                        onPress={configure}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}
