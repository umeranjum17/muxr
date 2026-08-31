import * as React from 'react';
import { ActivityIndicator, Switch } from 'react-native';
import { MUXR_UI_VERSION, pluginCompatibilityError, type PluginManifestV1, type PluginSummary } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { useSocketStatus } from '@/catalog/store';
import { invalidateSessionPlugins } from '@/plugins';
import { invalidatePlugins } from '@/plugins';
import { resolvePluginText } from '@/plugins';
import { pluginCatalogLoaded, pluginCatalogSnapshot, refreshPlugins, subscribePlugins } from '@/plugins';
import { sourceLabel } from '@/plugins';
import { t } from '@/text';

export default function PluginsScreen() {
    const { status } = useSocketStatus();
    const [, redraw] = React.useReducer((value) => value + 1, 0);
    const [optimistic, setOptimistic] = React.useState<Record<string, boolean>>({});
    const [loadError, setLoadError] = React.useState<string>();
    React.useEffect(() => subscribePlugins(redraw), []);
    React.useEffect(() => {
        if (status !== 'connected') return;
        void refreshPlugins().then(() => setLoadError(undefined)).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));
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

    if (!pluginCatalogLoaded() && entries.length === 0) return <ActivityIndicator style={{ flex: 1 }} />;

    const withUi = plugins.filter((plugin) => plugin.manifestHash !== undefined);
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
            <ItemGroup title={t('plugins.settingsTitle')} footer={loadError ?? (withUi.length === 0
                ? (status === 'connected' ? t('plugins.linkHost') : t('plugins.waitingHost'))
                : `${enabledCount}/${withUi.length} ${t('plugins.enabled')}`)}>
                <Item title={t('plugins.enableAll')} detail={withUi.length - enabledCount > 0 ? `${withUi.length - enabledCount} ${t('plugins.off')}` : undefined}
                    onPress={() => void enableAll()} showChevron={false} disabled={withUi.length - enabledCount === 0} />
                <Item title={t('plugins.disableAll')} onPress={() => void setApproved(withUi, false)} showChevron={false} disabled={enabledCount === 0} />
            </ItemGroup>
            {([
                ['herdr', t('plugins.herdrDriven'), t('plugins.herdrDrivenFooter'), withUi.filter((plugin) => plugin.herdrBackend)],
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
                            subtitle={[...(blocked === undefined ? [] : [t('plugins.unavailableLabel')]), blocked ?? plugin.description ?? describe(manifests[plugin.pluginId]), trust, requestedContexts(manifests[plugin.pluginId])].filter(Boolean).join(' · ')}
                            subtitleLines={2}
                            showChevron={false}
                            rightElement={<Switch value={plugin.approved} onValueChange={(next) => void setApproved([plugin], next)} />}
                        />;
                    })}
                </ItemGroup>
            ))}
            {plugins.filter((plugin) => plugin.manifestHash === undefined).map((plugin) => (
                <Item key={plugin.pluginId} title={plugin.name}
                    subtitle={[plugin.warnings[0] ?? plugin.description, sourceLabel(plugin.source), plugin.hasBackend ? t('plugins.runsCode') : t('plugins.uiOnly')].filter(Boolean).join(' · ')}
                    detail={plugin.warnings.length > 0 ? t('plugins.unavailableLabel') : 'Herdr'} showChevron={false} />
            ))}
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

/** Fall back to what the plugin actually adds when it ships no description. */
function describe(manifest: PluginManifestV1 | undefined): string | undefined {
    if (manifest === undefined) return undefined;
    const places = [...new Set(manifest.contributions.map((item) => SLOT_LABELS[item.slot] ?? item.slot))].filter((label) => label !== '');
    return places.length === 0 ? undefined : `Adds ${places.join(', ')}`;
}

function requestedContexts(manifest: PluginManifestV1 | undefined): string | undefined {
    if (manifest === undefined) return undefined;
    const contexts = [...new Set(manifest.contributions.flatMap((item) => item.slot === 'host.rpc' ? item.context ?? [] : []))];
    return contexts.length === 0 ? undefined : contexts.map((context) => context === 'sessions' ? t('plugins.readsSessions') : t('plugins.readsTree')).join(' · ');
}

const SLOT_LABELS: Record<string, string> = {
    'host.rpc': '',
    'navigation.primary': 'a tab',
    'navigation.content': 'a screen',
    'home.cards': 'a home card',
    'session.header.trailing': 'a header control',
    'session.pills': 'a session pill',
    'session.toolbar': 'a toolbar action',
    'terminal.key-row': 'terminal keys',
    'settings.items': 'a settings row',
    'settings.sections': 'a settings section',
    'app.overlay': 'an overlay',
    'session.overlay': 'a session overlay',
    'home.composer.leading': 'a composer button',
    'home.composer.trailing': 'a composer button',
    'session.composer.trailing': 'a composer button',
    'shortcuts': 'a launcher shortcut',
    'events': 'an event trigger',
};
