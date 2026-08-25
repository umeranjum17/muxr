import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { OptionSheet } from '@/components/OptionSheet';
import { StatusDot } from '@/components/StatusDot';
import { hapticsError, hapticsLight } from '@/components/haptics';
import type { PrimitiveProps } from '../primitiveRegistry';
import type { PluginSlotContexts } from '../slotTypes';
import { asPluginTree, type PluginTreeNode } from '../treeModel';
import { dispatchPluginAction, validatePluginAction } from '../pluginActions';
import { pluginSnapshot } from '../pluginStore';
import { subscribePluginDataInvalidation } from '../pluginDataInvalidation';
import { toneColor } from '../pluginTone';
import { resolvePluginText } from '../pluginText';
import { t } from '@/text';

function flatten(nodes: PluginTreeNode[], depth = 0): Array<{ node: PluginTreeNode; depth: number }> {
    return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children ?? [], depth + 1)]);
}

export function TreeSheet({ context, pluginId, manifestHash, contribution }: PrimitiveProps) {
    const { sessionId, visible, onClose, openMenu } = context as PluginSlotContexts['session.overlay'];
    const { theme } = useUnistyles();
    const router = useRouter();
    const source = contribution.source!;
    const entry = pluginSnapshot().find((candidate) => candidate.summary.pluginId === pluginId && candidate.summary.manifestHash === manifestHash);
    const manifest = entry?.manifest;
    const manifestTitle = contribution.title === undefined ? 'Tree' : resolvePluginText(contribution.title);
    const [title, setTitle] = React.useState(manifestTitle);
    const [nodes, setNodes] = React.useState<PluginTreeNode[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const loadingRef = React.useRef(false);
    const reloadQueued = React.useRef(false);
    const latestLoad = React.useRef<() => Promise<void>>(async () => {});

    const load = React.useCallback(async () => {
        if (manifest === undefined) return;
        if (loadingRef.current) { reloadQueued.current = true; return; }
        loadingRef.current = true;
        setLoading(true);
        try {
            const result = await sync.request('plugin.call', {
                pluginId,
                manifestHash,
                contributionId: source.contributionId,
                input: { sessionId },
            }, PLUGIN_CALL_CLIENT_TIMEOUT_MS);
            const parsed = asPluginTree(result, (value) => validatePluginAction(value, { pluginId, manifestHash, manifest, sessionId }));
            setTitle(parsed.title ?? manifestTitle);
            setNodes(parsed.nodes);
            setFailed(false);
        } catch {
            setFailed(true);
        } finally {
            loadingRef.current = false;
            setLoading(false);
            if (reloadQueued.current) {
                reloadQueued.current = false;
                setTimeout(() => void latestLoad.current(), 0);
            }
        }
    }, [manifest, manifestHash, manifestTitle, pluginId, sessionId, source.contributionId]);

    latestLoad.current = load;
    React.useEffect(() => {
        if (visible) void load();
    }, [load, visible]);
    React.useEffect(() => subscribePluginDataInvalidation(pluginId, () => {
        if (visible) void load();
    }), [load, pluginId, visible]);

    const runAction = React.useCallback(async (node: PluginTreeNode, action = node.action) => {
        if (manifest === undefined || action === undefined) return;
        try {
            await dispatchPluginAction(action, { router, pluginId, manifestHash, manifest, sessionId });
            hapticsLight();
            if (action.type === 'kernel.navigate' || action.type === 'screen') onClose();
            else await load();
        } catch (error) {
            hapticsError();
            Modal.alert(t('plugins.actionFailed'), error instanceof Error ? error.message : String(error));
        }
    }, [load, manifest, manifestHash, onClose, pluginId, router, sessionId]);

    const rows = flatten(nodes);
    return <OptionSheet
        visible={visible}
        title={title}
        options={[]}
        onSelect={() => {}}
        onClose={onClose}
        body={<View style={{ paddingBottom: 8 }}>
            {failed && <Pressable onPress={() => void load()} accessibilityRole="button" accessibilityLabel={`${t('plugins.treeUnavailable')} ${t('plugins.retry')}`}
                style={{ marginHorizontal: 18, marginTop: 8, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="warning-outline" size={16} color={theme.colors.textDestructive} />
                <Text style={{ color: theme.colors.textDestructive, flex: 1 }}>{t('plugins.stale')}</Text>
                <Text style={{ color: theme.colors.textLink }}>{t('plugins.retry')}</Text>
            </Pressable>}
            {loading && rows.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 32 }}><ActivityIndicator color={theme.colors.textSecondary} /></View>
            ) : rows.length === 0 ? (
                <Text style={{ color: theme.colors.textSecondary, paddingHorizontal: 18, paddingVertical: 18 }}>{failed ? t('plugins.treeUnavailable') : t('plugins.nothingToShow')}</Text>
            ) : rows.map(({ node, depth }, index) => {
                const disabled = node.action === undefined && (node.actions?.length ?? 0) === 0;
                return <Pressable
                    key={`${node.id}:${index}`}
                    disabled={disabled}
                    onPress={() => void runAction(node)}
                    onLongPress={() => {
                        if (node.actions === undefined || node.actions.length === 0) return;
                        openMenu({
                            title: node.title,
                            items: node.actions.map((entry) => ({
                                label: entry.label,
                                ...(entry.hint === undefined ? {} : { hint: entry.hint }),
                                onPress: () => void runAction(node, entry.action),
                            })),
                        });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${node.title}${node.subtitle === undefined ? '' : `: ${node.subtitle}`}`}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        paddingLeft: 18 + Math.min(depth, 3) * 18,
                        paddingRight: 18,
                        paddingVertical: 11,
                        backgroundColor: pressed ? theme.colors.surfaceHighest : 'transparent',
                        opacity: disabled ? 0.45 : 1,
                    })}
                >
                    {node.status !== undefined
                        ? <StatusDot color={toneColor(theme, node.status)} isPulsing={node.pulsing === true} size={7} />
                        : <Ionicons name={(node.icon ?? 'ellipse-outline') as never} size={12} color={theme.colors.textSecondary} />}
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={{ color: node.current === true ? theme.colors.accent : theme.colors.text, fontSize: depth === 0 ? 14 : 13, fontWeight: node.current === true ? '600' : '400' }}>
                            {node.title}
                        </Text>
                        {node.subtitle !== undefined && <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12 }}>{node.subtitle}</Text>}
                    </View>
                    {node.current === true && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.accent }} />}
                </Pressable>;
            })}
        </View>}
    />;
}
