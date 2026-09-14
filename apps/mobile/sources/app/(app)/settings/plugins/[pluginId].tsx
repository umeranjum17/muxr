import * as React from 'react';
import { ActivityIndicator, TextInput } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MUXR_UI_VERSION, pluginCompatibilityError } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { useSocketStatus } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { invalidatePlugins, pluginCatalogSnapshot, refreshPlugins, sourceLabel, subscribePlugins } from '@/plugins';
import { DeclarativeSettingsItems } from '@/plugins/ui';

const TITLE_PLUGIN = 'muxr.task-titles';
type TitleStatus = {
    enabled: boolean;
    status: 'ready' | 'conflict' | 'offline';
    writers?: Array<{ id: string; name: string; source: string }>;
    canRevert?: string | null;
    latest?: { status: string; title?: string; reason?: string; at?: string } | null;
    titleSource?: string;
    update?: string;
    manualRename?: string;
};
type Preview = { before: string; after: string; confidence?: string; reason?: string; source?: string };

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function ValueRow({ title, value }: { title: string; value: string }) {
    return <Item title={title} subtitle={value} subtitleLines={0} showChevron={false} />;
}

export default function PluginDetail() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { pluginId } = useLocalSearchParams<{ pluginId: string }>();
    const { status: socketStatus } = useSocketStatus();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const [, redraw] = React.useReducer((value) => value + 1, 0);
    const [titleStatus, setTitleStatus] = React.useState<TitleStatus>();
    const [preview, setPreview] = React.useState<Preview>();
    const [sample, setSample] = React.useState('Please audit plugin naming and task titles.');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string>();
    React.useEffect(() => subscribePlugins(redraw), []);
    React.useEffect(() => {
        if (socketStatus !== 'connected') return;
        void refreshPlugins().catch((cause: unknown) => setError(errorMessage(cause)));
    }, [socketStatus]);

    const entry = pluginCatalogSnapshot().find(({ summary }) => summary.pluginId === pluginId);
    const summary = entry?.summary;
    const manifest = entry?.manifest;
    const compatible = manifest === undefined ? undefined : pluginCompatibilityError(manifest, MUXR_UI_VERSION);
    const canManage = socketStatus === 'connected' && summary?.enabled !== false
        && summary?.manifestHash !== undefined && compatible === undefined && authority === 'control' && !authorityLoading;
    const canRead = socketStatus === 'connected' && summary?.enabled !== false && summary?.approved === true
        && summary.manifestHash !== undefined && compatible === undefined;
    const canWrite = canRead && canManage;
    const isTitle = pluginId === TITLE_PLUGIN;

    const callTitle = React.useCallback(async <T,>(contributionId: string, input?: unknown, write = false): Promise<T> => {
        if (!summary?.manifestHash) throw new Error('Task titles is unavailable on this machine.');
        return await sync.request('plugin.call', {
            pluginId: TITLE_PLUGIN, manifestHash: summary.manifestHash, contributionId,
            ...(input === undefined ? {} : { input }),
            ...(write ? { idempotencyKey: randomUUID() } : {}),
        }) as T;
    }, [summary?.manifestHash]);

    const loadTitle = React.useCallback(async () => {
        if (!isTitle || !canRead) return;
        try {
            setTitleStatus(await callTitle<TitleStatus>('status'));
            setError(undefined);
        } catch (cause) { setError(errorMessage(cause)); }
    }, [isTitle, canRead, callTitle]);
    React.useEffect(() => { void loadTitle(); }, [loadTitle]);

    const mutate = async (action: () => Promise<unknown>) => {
        if (!canWrite || busy) return;
        setBusy(true);
        try { await action(); await loadTitle(); setError(undefined); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(false); }
    };
    const approve = async (approved: boolean) => {
        if (!summary?.manifestHash || !canManage || busy) return;
        setBusy(true);
        try {
            await sync.request('plugin.approve', { pluginId, manifestHash: summary.manifestHash!, approved });
            invalidatePlugins();
            await refreshPlugins();
            setError(undefined);
        } catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(false); }
    };
    const previewTitle = async () => {
        if (!canRead || busy) return;
        setBusy(true);
        try { setPreview(await callTitle<Preview>('preview', { sample })); setError(undefined); }
        catch (cause) { setError(errorMessage(cause)); }
        finally { setBusy(false); }
    };
    const switchWriter = async (writer: { id: string; name: string }) => {
        if (!canWrite) return;
        const accepted = await Modal.confirm('Switch to Task titles?', `Turn off ${writer.name} in Herdr and let Task titles name future tasks? Its settings and earlier titles stay in place.`, { confirmText: 'Switch' });
        if (accepted) await mutate(() => callTitle('switch', { writerId: writer.id, confirm: true }, true));
    };
    const revert = async () => {
        if (!canWrite) return;
        const accepted = await Modal.confirm('Restore previous title plugin?', 'Restore the previous writer and both plugins’ prior settings. Existing titles stay in place; Task titles will avoid a writer conflict.', { confirmText: 'Restore' });
        if (accepted) await mutate(() => callTitle('revert', { confirm: true }, true));
    };

    if (summary === undefined) return <ItemList><ItemGroup title="Plugin unavailable" footer={socketStatus === 'connected' ? 'This plugin is not installed on this machine.' : 'Connect to inspect this machine’s plugins.'}><Item title="Back to Plugins" onPress={() => router.back()} showChevron /></ItemGroup></ItemList>;
    const reason = socketStatus !== 'connected' ? 'Connect to this machine to view live settings and make changes.'
        : summary.enabled === false ? `Disabled in Herdr. Run herdr plugin enable ${summary.pluginId} on this machine.`
        : compatible ?? summary.warnings[0]
        ?? (summary.manifestHash !== undefined && !summary.approved ? 'This device has not approved the muxr UI. Approve it below to configure.' : undefined);
    const hasSettingsItems = manifest?.contributions.some((item) => item.slot === 'settings.items') === true;

    return <ItemList>
        <ItemGroup title={summary.name} footer={[summary.description, reason].filter(Boolean).join('\n')}>
            <ValueRow title="State" value={socketStatus !== 'connected' ? 'Offline' : summary.enabled === false ? 'Off in Herdr' : compatible ? 'Incompatible' : summary.warnings.length > 0 ? 'Unavailable' : 'Installed'} />
            <ValueRow title="Source" value={sourceLabel(summary.source)} />
            <ValueRow title="Version" value={summary.version} />
            {summary.manifestHash !== undefined && <Item title="Allow on this device" subtitle={authority === 'observe' ? 'View-only browser; pair a control browser to change approval.' : 'Controls this plugin’s muxr UI and host calls.'} subtitleLines={0}
                rightElement={<Switch value={summary.approved} disabled={!canManage || busy} onValueChange={(next) => void approve(next)} />} showChevron={false} />}
        </ItemGroup>
        {summary.warnings.length > 0 && <ItemGroup title="Availability" footer={summary.warnings.join('\n')}><Item title="Check the plugin on this machine" showChevron={false} /></ItemGroup>}
        {isTitle && <>
            <ItemGroup title="Automatic task titles" footer="Agent identity stays separate. A manual title or pane rename always wins.">
                <ValueRow title="Title source" value={titleStatus?.titleSource ?? 'First task prompt'} />
                <ValueRow title="Update" value={titleStatus?.update ?? 'Once per task'} />
                <ValueRow title="Current status" value={!canRead ? 'Unavailable' : titleStatus?.enabled === false ? 'Off' : titleStatus?.status === 'conflict' ? 'Another writer active' : titleStatus?.status === 'offline' ? 'Herdr offline' : titleStatus?.status ?? 'Loading'} />
                {canRead && <Item title="Name new tasks" subtitle="Existing and manual titles remain untouched." subtitleLines={0}
                    rightElement={<Switch value={titleStatus?.enabled === true} disabled={!canWrite || busy || titleStatus === undefined} onValueChange={(enabled) => void mutate(() => callTitle('configure', { enabled }, true))} />} showChevron={false} />}
            </ItemGroup>
            {titleStatus?.latest && <ItemGroup title="Latest outcome" footer={titleStatus.latest.reason ?? (titleStatus.latest.at ? `Updated ${titleStatus.latest.at}` : undefined)}>
                <ValueRow title={titleStatus.latest.status} value={titleStatus.latest.title ?? 'No title written'} />
            </ItemGroup>}
            {titleStatus?.writers && titleStatus.writers.length > 0 && <ItemGroup title="Title writer conflict" footer="Task titles will not write while another title plugin is active.">
                {titleStatus.writers.map((writer) => <React.Fragment key={writer.id}>
                    <ValueRow title={writer.name} value={`Active title writer · ${writer.source === 'github' ? 'GitHub extension' : writer.source}`} />
                    {canWrite && <Item title="Switch title writer" subtitle={`Turn off ${writer.name}; keep its settings and earlier titles.`} subtitleLines={0} showChevron onPress={() => void switchWriter(writer)} />}
                </React.Fragment>)}
            </ItemGroup>}
            {titleStatus?.canRevert && <ItemGroup title="Previous plugin" footer="Restore its enabled state without deleting its settings or earlier titles.">
                <Item title="Restore previous title plugin" detail={canWrite ? 'Restore' : 'Control required'} showChevron={canWrite} onPress={canWrite ? () => void revert() : undefined} />
            </ItemGroup>}
            <ItemGroup title="Preview · example only" footer="Preview reads sample text only. It never changes a task title.">
                <TextInput value={sample} onChangeText={setSample} multiline maxLength={4096} editable={canRead && !busy}
                    accessibilityLabel="Sample task prompt" placeholder="Enter a sample task prompt" placeholderTextColor={theme.colors.textSecondary}
                    style={{ minHeight: 84, padding: 16, color: theme.colors.text, textAlignVertical: 'top' }} />
                <Item title="Preview title" detail={busy ? 'Working…' : undefined} showChevron={canRead} onPress={canRead ? () => void previewTitle() : undefined} />
                {preview && <>
                    <ValueRow title="Before" value={preview.before} />
                    <ValueRow title="After" value={preview.after} />
                    <ValueRow title="Confidence" value={preview.reason ? `${preview.confidence ?? 'Needs a title'} · ${preview.reason}` : preview.confidence ?? 'Needs a title'} />
                </>}
            </ItemGroup>
        </>}
        {!isTitle && canRead && hasSettingsItems && <ItemGroup title="Configuration" footer={authority === 'observe' ? 'View-only browser: settings changes require control access.' : undefined}>
            <DeclarativeSettingsItems pluginId={pluginId} readOnly={authority === 'observe'} />
        </ItemGroup>}
        {pluginId === 'muxr.voice' && canRead && <ItemGroup title="Realtime voice" footer="Speech-to-speech provider settings stay on this machine.">
            <Item title="Choose and configure provider" detail="Open" showChevron onPress={() => router.push('/settings/voice' as never)} />
        </ItemGroup>}
        {summary.manifestHash === undefined && <ItemGroup title="Manage in Herdr" footer="This plugin has no active muxr configuration screen. Its Herdr registration and settings are preserved.">
            <Item title={summary.enabled === false ? `herdr plugin enable ${pluginId}` : `herdr plugin disable ${pluginId}`} showChevron={false} copy />
        </ItemGroup>}
        {error && <ItemGroup title="Could not update" footer={error}><Item title="Retry" onPress={() => void loadTitle()} showChevron /></ItemGroup>}
        {busy && <ActivityIndicator />}
    </ItemList>;
}
