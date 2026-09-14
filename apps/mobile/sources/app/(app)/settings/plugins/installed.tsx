import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSocketStatus } from '@/catalog/store';
import { pluginCatalogLoaded, pluginCatalogSnapshot, refreshPlugins, subscribePlugins } from '@/plugins';
import { BUILTIN_IDS, PluginCatalogRow } from '@/plugins/presentation/PluginCatalogRow';

const SECTIONS = [
    { title: 'Naming extensions', ids: ['animal-namer', 'herdr-plugin-renamer', 'auto-namer'], footer: 'These extensions name different things. muxr displays the names and titles Herdr supplies.' },
    { title: 'Older terminal launchers', ids: ['zenbu-labs.terminal-browser', 'zenbu-labs.tode'], footer: 'Browser and Code are the current muxr surfaces. Existing terminal panes remain yours.' },
] as const;
const CLASSIFIED_IDS = new Set<string>(SECTIONS.flatMap((section) => [...section.ids]));

export default function InstalledExtensionsScreen() {
    const router = useRouter();
    const { status } = useSocketStatus();
    const [, redraw] = React.useReducer((value) => value + 1, 0);
    const [error, setError] = React.useState<string>();
    React.useEffect(() => subscribePlugins(redraw), []);
    React.useEffect(() => {
        if (status !== 'connected') return;
        void refreshPlugins().then(() => setError(undefined)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, [status]);
    if (!pluginCatalogLoaded() && status === 'connected') return <ActivityIndicator style={{ flex: 1 }} />;

    const entries = pluginCatalogSnapshot().filter(({ summary }) => !BUILTIN_IDS.has(summary.pluginId));
    const byId = new Map(entries.map((entry) => [entry.summary.pluginId, entry]));
    const open = (pluginId: string) => router.push({ pathname: '/settings/plugins/[pluginId]', params: { pluginId } } as never);
    const row = (pluginId: string) => {
        const entry = byId.get(pluginId);
        return entry === undefined ? null : <PluginCatalogRow key={pluginId} entry={entry} connected={status === 'connected'} onPress={() => open(pluginId)} />;
    };
    const other = entries.filter(({ summary }) => !CLASSIFIED_IDS.has(summary.pluginId));
    return <ItemList>
        {SECTIONS.map((section) => {
            const ids = section.ids.filter((id) => byId.has(id));
            return ids.length === 0 ? null : <ItemGroup key={section.title} title={section.title} footer={section.footer}>{ids.map(row)}</ItemGroup>;
        })}
        {other.length > 0 && <ItemGroup title="Other Herdr extensions" footer="These remain installed on this computer, including any disabled extensions.">
            {other.map(({ summary }) => row(summary.pluginId))}
        </ItemGroup>}
        {entries.length === 0 && <ItemGroup title="No other extensions" footer={status === 'connected' ? 'Only bundled muxr plugins are installed.' : 'Connect to inspect this computer.'}>
            <Item title="Back to Plugins" showChevron onPress={() => router.back()} />
        </ItemGroup>}
        {error && <ItemGroup title="Could not refresh" footer={error}><Item title="Retry" showChevron onPress={() => void refreshPlugins()} /></ItemGroup>}
    </ItemList>;
}
