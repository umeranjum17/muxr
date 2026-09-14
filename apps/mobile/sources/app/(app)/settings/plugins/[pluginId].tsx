import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MUXR_UI_VERSION, pluginCompatibilityError } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { sync } from '@/catalog/sync';
import { useSocketStatus } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { invalidatePlugins, pluginCatalogSnapshot, refreshPlugins, sourceLabel, subscribePlugins } from '@/plugins';
import { pluginDescription, pluginDisplayName } from '@/plugins/presentation/PluginCatalogRow';
import { DeclarativeSettingsItems } from '@/plugins/ui';

const NAMING_NOTES: Record<string, string> = {
    'animal-namer': 'Gives agents animal identities. It does not supply task titles.',
    'auto-namer': 'Can name agents, panes, tabs, and workspaces. Configure it in Herdr.',
    'herdr-plugin-renamer': 'Can name tasks, panes, and generated worktrees from prompts. Configure it in Herdr.',
};

function ValueRow({ title, value }: { title: string; value: string }) {
    return <Item title={title} subtitle={value} subtitleLines={0} showChevron={false} />;
}

export default function PluginDetail() {
    const router = useRouter();
    const { pluginId } = useLocalSearchParams<{ pluginId: string }>();
    const { status } = useSocketStatus();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const [, redraw] = React.useReducer((value) => value + 1, 0);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string>();
    React.useEffect(() => subscribePlugins(redraw), []);
    React.useEffect(() => {
        if (status !== 'connected') return;
        void refreshPlugins().then(() => setError(undefined)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, [status]);

    const entry = pluginCatalogSnapshot().find(({ summary }) => summary.pluginId === pluginId);
    const summary = entry?.summary;
    const manifest = entry?.manifest;
    const compatible = manifest === undefined ? undefined : pluginCompatibilityError(manifest, MUXR_UI_VERSION);
    const canManage = status === 'connected' && summary?.enabled !== false && summary?.manifestHash !== undefined
        && compatible === undefined && authority === 'control' && !authorityLoading;
    const canRead = status === 'connected' && summary?.enabled !== false && summary?.approved === true
        && summary.manifestHash !== undefined && compatible === undefined;
    const approve = async (approved: boolean) => {
        if (!summary?.manifestHash || !canManage || busy) return;
        setBusy(true);
        try {
            await sync.request('plugin.approve', { pluginId, manifestHash: summary.manifestHash, approved });
            invalidatePlugins();
            await refreshPlugins();
            setError(undefined);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(false); }
    };

    if (summary === undefined) return <ItemList><ItemGroup title="Plugin unavailable" footer={status === 'connected' ? 'This plugin is not installed on this machine.' : 'Connect to inspect this machine’s plugins.'}>
        <Item title="Back to Plugins" onPress={() => router.back()} showChevron />
    </ItemGroup></ItemList>;

    const reason = status !== 'connected' ? 'Connect to this machine to view live settings and make changes.'
        : summary.enabled === false ? `Disabled in Herdr. Run herdr plugin enable ${pluginId} on this machine.`
        : compatible ?? summary.warnings[0]
        ?? (summary.manifestHash !== undefined && !summary.approved ? 'Approve this plugin on your device to open its muxr controls.' : undefined);
    const hasSettingsItems = manifest?.contributions.some((item) => item.slot === 'settings.items') === true;
    const olderLauncher = pluginId === 'zenbu-labs.terminal-browser' ? 'Browser' : pluginId === 'zenbu-labs.tode' ? 'Code' : undefined;

    return <ItemList>
        <ItemGroup title={pluginDisplayName(pluginId, summary.name)} footer={[pluginDescription(pluginId, summary.description), reason].filter(Boolean).join('\n')}>
            <ValueRow title="State" value={status !== 'connected' ? 'Offline' : summary.enabled === false ? 'Off in Herdr' : compatible ? 'Incompatible' : summary.warnings.length > 0 ? 'Unavailable' : 'Installed'} />
            <ValueRow title="Source" value={sourceLabel(summary.source)} />
            <ValueRow title="Version" value={summary.version} />
            {summary.manifestHash !== undefined && <Item title="Allow on this device" subtitle={authority === 'observe' ? 'View-only browser. Use a control device to change approval.' : 'Allow this plugin’s muxr controls on this device.'} subtitleLines={0}
                rightElement={<Switch value={summary.approved} disabled={!canManage || busy} onValueChange={(next) => void approve(next)} />} showChevron={false} />}
        </ItemGroup>
        {summary.warnings.length > 0 && <ItemGroup title="Availability" footer={summary.warnings.join('\n')}><Item title="Check the plugin on this machine" showChevron={false} /></ItemGroup>}
        {NAMING_NOTES[pluginId] && <ItemGroup title="Names from Herdr" footer="muxr displays the agent names and task titles Herdr supplies, including manual changes.">
            <ValueRow title="This extension" value={NAMING_NOTES[pluginId]} />
        </ItemGroup>}
        {olderLauncher && <ItemGroup title="Older terminal launcher" footer={`Use the current ${olderLauncher} plugin for new work. Existing panes and this registration are separate.`}>
            <ValueRow title="Current plugin" value={olderLauncher} />
        </ItemGroup>}
        {canRead && hasSettingsItems && <ItemGroup title="Configuration" footer={authority === 'observe' ? 'View-only browser: settings changes require control access.' : undefined}>
            <DeclarativeSettingsItems pluginId={pluginId} readOnly={authority !== 'control'} />
        </ItemGroup>}
        {pluginId === 'muxr.voice' && canRead && <ItemGroup title="Realtime voice" footer="Speech-to-speech provider settings stay on this machine.">
            <Item title="Choose and configure provider" detail="Open" showChevron onPress={() => router.push('/settings/voice' as never)} />
        </ItemGroup>}
        {summary.manifestHash === undefined && <ItemGroup title="Manage in Herdr" footer="This plugin has no muxr configuration screen. Its Herdr registration and settings remain on this computer.">
            <Item title={summary.enabled === false ? `herdr plugin enable ${pluginId}` : `herdr plugin disable ${pluginId}`} showChevron={false} copy />
        </ItemGroup>}
        {error && <ItemGroup title="Could not refresh" footer={error}><Item title="Retry" onPress={() => void refreshPlugins()} showChevron /></ItemGroup>}
        {busy && <ActivityIndicator />}
    </ItemList>;
}
