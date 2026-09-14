import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { sync } from '@/catalog/sync';
import { useSocketStatus } from '@/catalog/store';
import { pluginCatalogLoaded, pluginCatalogSnapshot, refreshPlugins, subscribePlugins } from '@/plugins';
import { BUILTIN_GROUPS, BUILTIN_IDS, PluginCatalogRow } from '@/plugins/presentation/PluginCatalogRow';

export default function PluginsScreen() {
    const router = useRouter();
    const { status } = useSocketStatus();
    const [, redraw] = React.useReducer((value) => value + 1, 0);
    const [error, setError] = React.useState<string>();
    const [effective, setEffective] = React.useState<Record<string, string>>({});
    React.useEffect(() => subscribePlugins(redraw), []);
    React.useEffect(() => {
        if (status !== 'connected') return;
        void refreshPlugins().then(() => setError(undefined)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, [status]);

    const entries = pluginCatalogSnapshot();
    const catalogKey = JSON.stringify(entries.map(({ summary }) => [summary.pluginId, summary.manifestHash, summary.enabled, summary.approved]));
    React.useEffect(() => {
        if (status !== 'connected') return;
        let cancelled = false;
        const read = async (pluginId: string, contributionId: string): Promise<unknown> => {
            const summary = pluginCatalogSnapshot().find((entry) => entry.summary.pluginId === pluginId)?.summary;
            if (summary?.enabled === false || !summary?.approved || !summary.manifestHash) return undefined;
            return sync.request('plugin.call', { pluginId, manifestHash: summary.manifestHash, contributionId });
        };
        void read('muxr.voice', 'provider-list').then((value) => {
            if (cancelled) return;
            const provider = value as { selected?: string; providers?: Array<{ id: string; name: string }> } | undefined;
            setEffective({
                ...(provider?.selected === undefined ? {} : { 'muxr.voice': `On · ${provider.providers?.find((item) => item.id === provider.selected)?.name ?? provider.selected}` }),
            });
        }).catch(() => { /* The row keeps its regular availability state. */ });
        return () => { cancelled = true; };
    }, [status, catalogKey]);
    if (!pluginCatalogLoaded() && status === 'connected') return <ActivityIndicator style={{ flex: 1 }} />;
    const byId = new Map(entries.map((entry) => [entry.summary.pluginId, entry]));
    const extensions = entries.filter(({ summary }) => !BUILTIN_IDS.has(summary.pluginId));
    const enabledExtensions = extensions.filter(({ summary }) => summary.enabled).length;
    const open = (pluginId: string) => router.push({ pathname: '/settings/plugins/[pluginId]', params: { pluginId } } as never);
    const row = (pluginId: string) => {
        const entry = byId.get(pluginId);
        if (entry === undefined) return null;
        return <PluginCatalogRow key={pluginId} entry={entry} connected={status === 'connected'} effective={effective[pluginId]} onPress={() => open(pluginId)} />;
    };

    return <ItemList>
        {BUILTIN_GROUPS.map((group) => {
            const ids = group.ids.filter((id) => byId.has(id));
            return ids.length === 0 ? null : <ItemGroup key={group.title} title={group.title}>{ids.map(row)}</ItemGroup>;
        })}
        {extensions.length > 0 && <ItemGroup title="Other installed extensions" footer="Community and older Herdr registrations stay visible here, including disabled ones.">
            <Item title="Review Herdr extensions" subtitle={`${enabledExtensions} on · ${extensions.length - enabledExtensions} off\nSee identity, older tools, and other installed plugins`}
                subtitleLines={3} showChevron onPress={() => router.push('/settings/plugins/installed' as never)} />
        </ItemGroup>}
        <ItemGroup title="About plugins" footer={error ?? (status === 'connected' ? 'Installed plugins run on this machine. Device approval controls their muxr UI.' : 'Connect to inspect this machine’s plugins.')}>
            <Item title="Plugin guide" subtitle="Setup, permissions, optional naming, and removal" detail="Docs" showChevron
                onPress={() => router.push('/settings/plugins/guide' as never)} />
        </ItemGroup>
    </ItemList>;
}
