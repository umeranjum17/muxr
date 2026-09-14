import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { MUXR_UI_VERSION, pluginCompatibilityError, type PluginManifestV1, type PluginSummary } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { sync } from '@/catalog/sync';
import { useSocketStatus } from '@/catalog/store';
import { Switch } from '@/components/Switch';
import { useDeviceAuthority } from '@/pairing';
import { invalidateSessionPlugins } from '@/plugins';
import { invalidatePlugins } from '@/plugins';
import { resolvePluginText } from '@/plugins';
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
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const changeBlocked = status !== 'connected'
        ? 'Connect to this computer to change plugins.'
        : authorityLoading
            ? 'Checking device access.'
            : authority !== 'control' ? 'View-only access cannot change plugins.' : undefined;
    const [, redraw] = React.useReducer((value) => value + 1, 0);
    const [error, setError] = React.useState<string>();
    const [effective, setEffective] = React.useState<Record<string, string>>({});
    React.useEffect(() => subscribePlugins(redraw), []);
    React.useEffect(() => {
        if (status !== 'connected') return;
        void refreshPlugins().then(() => setError(undefined)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, [status]);

    const entries = pluginCatalogSnapshot();
    const plugins = entries.map(({ summary }) => ({ ...summary, approved: optimistic[summary.pluginId] ?? summary.approved }));
    const manifests = Object.fromEntries(entries.flatMap(({ summary, manifest }) => manifest === undefined ? [] : [[summary.pluginId, manifest] as const]));

    const setApproved = React.useCallback(async (targets: PluginSummary[], approved: boolean) => {
        const changing = targets.filter((plugin) => plugin.manifestHash !== undefined && plugin.approved !== approved);
        if (changing.length === 0) return;
        setOptimistic((current) => ({ ...current, ...Object.fromEntries(changing.map((plugin) => [plugin.pluginId, approved])) }));
        const failures: string[] = [];
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(3, changing.length) }, async () => {
            while (cursor < changing.length) {
                const plugin = changing[cursor++]!;
                try {
                    await sync.request('plugin.approve', { pluginId: plugin.pluginId, manifestHash: plugin.manifestHash!, approved });
                } catch (error) {
                    failures.push(`${plugin.name}: ${error instanceof Error ? error.message : String(error)}`);
                    setOptimistic((current) => ({ ...current, [plugin.pluginId]: plugin.approved }));
                }
            }
        }));
        invalidateSessionPlugins();
        invalidatePlugins();
        await refreshPlugins().catch(() => undefined);
        setOptimistic({});
        if (failures.length > 0) Modal.alert(t('common.error'), failures.join('\n'));
    }, []);

    if (status === 'connected' && !pluginCatalogLoaded() && entries.length === 0) return <ActivityIndicator style={{ flex: 1 }} />;

    const withUi = plugins.filter((plugin) => plugin.manifestHash !== undefined);
    // Registered with Herdr but contributing no muxr UI: nothing to approve here.
    const herdrOnly = plugins.filter((plugin) => plugin.manifestHash === undefined);
    const enabledCount = withUi.filter((plugin) => plugin.approved).length;
    const runsCode = withUi.filter((plugin) => plugin.hasBackend).length;

    /** One aggregate consent instead of one dialog per plugin. */
    const enableAll = async () => {
        const pending = withUi.filter((plugin) => !plugin.approved);
        if (pending.length === 0) return;
        const accepted = await Modal.confirm(`${t('plugins.enableAll')} (${pending.length})`,
            `${pending.map((plugin) => plugin.name).join(', ')}\n\n${runsCode > 0 ? t('plugins.runsCode') : t('plugins.uiOnly')}`,
            { confirmText: t('plugins.enableAll') });
        if (accepted) await setApproved(pending, true);
    };

    return (
        <ItemList>
            <ItemGroup title={t('plugins.settingsTitle')} footer={loadError ?? changeBlocked ?? (withUi.length === 0
                ? (status === 'connected' ? t('plugins.linkHost') : t('plugins.waitingHost'))
                : `${enabledCount}/${withUi.length} ${t('plugins.enabled')}`)}>
                <Item title={t('plugins.enableAll')} subtitle={changeBlocked} detail={withUi.length - enabledCount > 0 ? `${withUi.length - enabledCount} ${t('plugins.off')}` : undefined}
                    onPress={changeBlocked === undefined ? () => void enableAll() : undefined} showChevron={false} disabled={withUi.length - enabledCount === 0 || changeBlocked !== undefined} />
                <Item title={t('plugins.disableAll')} subtitle={changeBlocked} onPress={changeBlocked === undefined ? () => void setApproved(withUi, false) : undefined} showChevron={false} disabled={enabledCount === 0 || changeBlocked !== undefined} />
            </ItemGroup>
            {([
                ['both', t('plugins.herdrAndMuxr'), t('plugins.herdrAndMuxrFooter'), withUi.filter((plugin) => plugin.herdrBackend)],
                ['muxr', t('plugins.muxrOnly'), t('plugins.muxrOnlyFooter'), withUi.filter((plugin) => !plugin.herdrBackend)],
            ] as const).filter(([, , , group]) => group.length > 0).map(([key, title, footer, group]) => (
                <ItemGroup key={key} title={title} footer={footer}>
                    {group.map((plugin) => {
                        const incompatibility = manifests[plugin.pluginId] === undefined
                            ? undefined
                            : pluginCompatibilityError(manifests[plugin.pluginId], MUXR_UI_VERSION);
                        const warning = plugin.warnings[0];
                        const trust = `${sourceLabel(plugin.source)} · ${plugin.hasBackend ? t('plugins.runsCode') : t('plugins.uiOnly')}`;
                        const blocked = incompatibility ?? warning;
                        return <Item
                            key={plugin.pluginId}
                            title={plugin.name}
                            subtitle={[...(blocked === undefined ? [] : [t('plugins.unavailableLabel')]), blocked ?? plugin.description ?? describe(manifests[plugin.pluginId]), trust, requestedContexts(manifests[plugin.pluginId]), changeBlocked].filter(Boolean).join(' · ')}
                            subtitleLines={2}
                            showChevron={false}
                            rightElement={<Switch value={plugin.approved} disabled={changeBlocked !== undefined} accessibilityLabel={plugin.name} onValueChange={changeBlocked === undefined ? (next) => void setApproved([plugin], next) : undefined} />}
                        />;
                    })}
                </ItemGroup>
            ))}
            {herdrOnly.length > 0 && (
                <ItemGroup title={t('plugins.herdrOnly')} footer={t('plugins.herdrOnlyFooter')}>
                    {herdrOnly.map((plugin) => (
                        <Item key={plugin.pluginId} title={plugin.name}
                            subtitle={[plugin.warnings[0] ?? plugin.description, sourceLabel(plugin.source), plugin.hasBackend ? t('plugins.runsCode') : t('plugins.uiOnly')].filter(Boolean).join(' · ')}
                            subtitleLines={2}
                            detail={plugin.warnings.length > 0 ? t('plugins.unavailableLabel') : undefined} showChevron={false} />
                    ))}
                </ItemGroup>
            )}
            {plugins.flatMap((plugin) => plugin.approved
                ? (manifests[plugin.pluginId]?.contributions.filter((item) => item.slot === 'settings.sections') ?? []).map((section) => (
                    <ItemGroup key={`${plugin.pluginId}:${section.id}`} title={`${resolvePluginText(section.title)} · Plugin`}>
                        {section.children.map((row, index) => <Item key={index} title={resolvePluginText(row.title)} subtitle={row.subtitle === undefined ? undefined : resolvePluginText(row.subtitle)} showChevron={false} />)}
                    </ItemGroup>
                ))
                : [])}
        </ItemList>
    );
}
