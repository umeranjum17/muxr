import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { MUXR_UI_VERSION, pluginCompatibilityError, type PluginManifestV1, type PluginSummary } from '@muxr/contract';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { useSocketStatus } from '@/catalog/store';
import { Switch } from '@/components/Switch';
import { useDeviceAuthority } from '@/pairing';
import { invalidateSessionPlugins } from '@/plugins';
import { invalidatePlugins } from '@/plugins';
import { resolvePluginText } from '@/plugins';
import { pluginCatalogLoaded, pluginCatalogSnapshot, refreshPlugins, subscribePlugins } from '@/plugins';
import { sourceLabel } from '@/plugins';
import { t } from '@/text';
import { IconTile } from '@/components/ui';

export default function PluginsScreen() {
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const changeBlocked = status !== 'connected'
        ? 'Connect to this computer to change plugins.'
        : authorityLoading
            ? 'Checking device access.'
            : authority !== 'control' ? 'View-only access cannot change plugins.' : undefined;
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

    if (status === 'connected' && !pluginCatalogLoaded() && entries.length === 0) return <ActivityIndicator style={{ flex: 1 }} />;

    const withUi = plugins.filter((plugin) => plugin.manifestHash !== undefined);
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
                        const manifest = manifests[plugin.pluginId];
                        const blocked = incompatibility ?? warning;
                        const description = blocked === undefined
                            ? plugin.description ?? describe(manifest)
                            : `${t('plugins.unavailableLabel')} · ${blocked}`;
                        // Why a switch is disabled is the group footer's to say
                        // once, not every row's.
                        const facts = [pluginFacts(plugin), requestedContexts(manifest)].filter(Boolean).join(' · ');
                        const unavailable = blocked !== undefined;
                        return <Item
                            key={plugin.pluginId}
                            title={plugin.name}
                            subtitle={description}
                            subtitleStyle={unavailable ? { color: theme.colors.box.error.text } : undefined}
                            subtitleLines={unavailable ? 2 : 1}
                            meta={facts}
                            leftElement={<PluginTile icon={pluginIcon(manifest)} unavailable={unavailable} />}
                            showChevron={false}
                            rightElement={<Switch value={plugin.approved} disabled={changeBlocked !== undefined} accessibilityLabel={plugin.name} onValueChange={changeBlocked === undefined ? (next) => void setApproved([plugin], next) : undefined} />}
                        />;
                    })}
                </ItemGroup>
            ))}
            {herdrOnly.length > 0 && (
                <ItemGroup title={t('plugins.herdrOnly')} footer={t('plugins.herdrOnlyFooter')}>
                    {herdrOnly.map((plugin) => {
                        const warning = plugin.warnings[0];
                        return <Item key={plugin.pluginId} title={plugin.name}
                            subtitle={warning ?? plugin.description}
                            subtitleStyle={warning === undefined ? undefined : { color: theme.colors.box.error.text }}
                            subtitleLines={warning === undefined ? 1 : 2}
                            meta={pluginFacts(plugin)}
                            leftElement={<PluginTile icon="extension-puzzle-outline" unavailable={warning !== undefined} />}
                            showChevron={false} />;
                    })}
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

/** Row identity: the plugin's own mark, or a warning mark when it cannot run. */
function PluginTile({ icon, unavailable }: { icon: string; unavailable: boolean }) {
    const { theme } = useUnistyles();
    return <IconTile
        name={unavailable ? 'warning-outline' : icon}
        color={unavailable ? theme.colors.box.warning.text : undefined}
        backgroundColor={unavailable ? theme.colors.box.warning.background : undefined}
        style={{ width: 32, height: 32 }}
    />;
}

/** Where the plugin comes from and what it runs, in one quiet line. */
function pluginFacts(plugin: PluginSummary): string {
    return `${sourceLabel(plugin.source)} · ${plugin.hasBackend ? t('plugins.runsCode') : t('plugins.uiOnly')}`;
}

/** Pick the first declared mark in the Settings grammar; unknown manifests get a stable tile. */
function pluginIcon(manifest: PluginManifestV1 | undefined): string {
    if (manifest === undefined) return 'extension-puzzle-outline';
    const candidates = [
        manifest.contributions.find((item) => item.slot === 'navigation.primary'),
        manifest.contributions.find((item) => 'type' in item && item.type === 'screen-button'),
        manifest.contributions.find((item) => item.slot === 'settings.items'),
        manifest.contributions.find((item) => 'type' in item && item.type === 'native'),
        manifest.contributions.find((item) => 'type' in item && item.type === 'data-card'),
    ];
    for (const candidate of candidates) {
        if (candidate !== undefined && 'icon' in candidate && typeof candidate.icon === 'string' && candidate.icon !== '') return candidate.icon;
    }
    return 'extension-puzzle-outline';
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
    'navigation.primary': 'a home chip or sidebar tool',
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
