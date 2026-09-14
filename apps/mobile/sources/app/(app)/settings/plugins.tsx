import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { MUXR_UI_VERSION, pluginCompatibilityError } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { sync } from '@/catalog/sync';
import { useSocketStatus } from '@/catalog/store';
import { pluginCatalogLoaded, pluginCatalogSnapshot, refreshPlugins, subscribePlugins } from '@/plugins';

const GROUPS = [
    { title: 'Agent workflow', ids: ['muxr.task-titles'] },
    { title: 'Files & changes', ids: ['muxr.code', 'muxr.attachments'] },
    { title: 'Terminal & layout', ids: ['muxr.panes', 'muxr.control', 'muxr.workspace-hierarchy', 'muxr.terminal-keys'] },
    { title: 'Voice & input', ids: ['muxr.voice', 'muxr.dictation'] },
    { title: 'Usage & machine', ids: ['muxr.status'] },
] as const;
const SHORT_DESCRIPTIONS: Record<string, string> = {
    'muxr.task-titles': 'Names new tasks',
    'muxr.code': 'Browse files, diffs, and git history',
    'muxr.attachments': 'Open shared files and images',
    'muxr.panes': 'Open shells and plugin tools',
    'muxr.control': 'Control panes and tabs',
    'muxr.workspace-hierarchy': 'Browse workspaces, tabs, and agents',
    'muxr.terminal-keys': 'Extra keys above the phone keyboard',
    'muxr.voice': 'Live speech-to-speech with an agent',
    'muxr.dictation': 'Speak a prompt on your device',
    'muxr.status': 'Usage, limits, and machine health',
};

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
        void Promise.allSettled([read('muxr.task-titles', 'status'), read('muxr.voice', 'provider-list')]).then(([titles, voice]) => {
            if (cancelled) return;
            const title = titles.status === 'fulfilled' ? titles.value as { enabled?: boolean; status?: string; writers?: Array<{ name: string }> } | undefined : undefined;
            const provider = voice.status === 'fulfilled' ? voice.value as { selected?: string; providers?: Array<{ id: string; name: string }> } | undefined : undefined;
            setEffective({
                ...(title === undefined ? {} : { 'muxr.task-titles': title.enabled === false ? 'Off' : title.status === 'conflict' ? `Conflict · ${title.writers?.[0]?.name ?? 'title writer'}` : title.status === 'offline' ? 'Host offline' : 'On' }),
                ...(provider?.selected === undefined ? {} : { 'muxr.voice': `On · ${provider.providers?.find((item) => item.id === provider.selected)?.name ?? provider.selected}` }),
            });
        });
        return () => { cancelled = true; };
    }, [status, catalogKey]);
    if (!pluginCatalogLoaded() && status === 'connected') return <ActivityIndicator style={{ flex: 1 }} />;
    const byId = new Map(entries.map((entry) => [entry.summary.pluginId, entry]));
    const known = new Set<string>(GROUPS.flatMap((group) => [...group.ids]));
    const open = (pluginId: string) => router.push({ pathname: '/settings/plugins/[pluginId]', params: { pluginId } } as never);
    const row = (pluginId: string) => {
        const entry = byId.get(pluginId);
        if (entry === undefined) return null;
        const { summary, manifest } = entry;
        const incompatible = manifest === undefined ? undefined : pluginCompatibilityError(manifest, MUXR_UI_VERSION);
        const state = status !== 'connected' ? 'Offline'
            : summary.enabled === false ? 'Off in Herdr'
            : incompatible !== undefined ? 'Update muxr'
            : summary.manifestHash !== undefined && !summary.approved ? 'Approve'
            : summary.warnings.length > 0 ? 'Unavailable'
            : 'On';
        let value = state === 'On' && (pluginId === 'muxr.task-titles' || pluginId === 'muxr.voice') ? 'Checking…' : state;
        if (state === 'On' && effective[pluginId]) {
            value = effective[pluginId].startsWith('Conflict') ? 'Conflict'
                : effective[pluginId].replace(' (experimental)', '');
        }
        const description = SHORT_DESCRIPTIONS[pluginId] ?? summary.description ?? 'Herdr extension';
        return <Item key={pluginId} title={summary.name} subtitle={`${value}\n${description}`}
            subtitleLines={3} style={{ paddingVertical: 10 }} showChevron onPress={() => open(pluginId)} />;
    };

    return <ItemList>
        {GROUPS.map((group) => {
            const ids = group.ids.filter((id) => byId.has(id));
            return ids.length === 0 ? null : <ItemGroup key={group.title} title={group.title}>{ids.map(row)}</ItemGroup>;
        })}
        {entries.some(({ summary }) => !known.has(summary.pluginId)) && <ItemGroup title="Installed extensions" footer="Herdr extensions remain installed even when disabled.">
            {entries.filter(({ summary }) => !known.has(summary.pluginId)).map(({ summary }) => row(summary.pluginId))}
        </ItemGroup>}
        <ItemGroup title="About plugins" footer={error ?? (status === 'connected' ? 'Installed plugins run on this machine. Device approval controls their muxr UI.' : 'Connect to inspect this machine’s plugins.')}>
            <Item title="Plugin guide" subtitle="Setup, permissions, title conflicts, and removal" detail="Docs" showChevron
                onPress={() => router.push('/settings/plugins/guide' as never)} />
        </ItemGroup>
    </ItemList>;
}
