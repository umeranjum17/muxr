import * as React from 'react';
import { PRIMITIVE_SPECS, type PluginNativeSlot, type PluginPrimitiveSpec } from '@muxr/contract';
import type { PluginSlotContexts } from './slotTypes';
import { DeclarativeScreen } from './DeclarativeScreen';
import { renderPrimitive } from './primitiveRegistry';
import { useSlotContributions } from './useSlotContributions';

export function PluginSlot<S extends PluginNativeSlot>({ slot, context }: { slot: S; context: PluginSlotContexts[S] }) {
    const counts = new Map<string, number>();
    const contributions = useSlotContributions(slot)
        .filter((contribution) => {
            const contributionId = 'contributionId' in context ? context.contributionId : undefined;
            const pluginId = 'pluginId' in context ? context.pluginId : undefined;
            const hasPluginId = typeof pluginId === 'string' && pluginId.length > 0;
            const hasContributionId = typeof contributionId === 'string' && contributionId.length > 0;
            if (slot === 'navigation.content') {
                return hasPluginId && hasContributionId && contribution.id === contributionId && contribution.pluginId === pluginId;
            }
            if (!hasContributionId && !hasPluginId) return contribution.type === 'native';
            if (!hasContributionId || !hasPluginId) return false;
            return contribution.id === contributionId && contribution.pluginId === pluginId;
        })
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId) || left.id.localeCompare(right.id))
        .filter((contribution) => {
            if (contribution.type !== 'native') return true;
            const max = (PRIMITIVE_SPECS[contribution.primitive] as PluginPrimitiveSpec).maxContributions;
            if (max === undefined) return true;
            const count = counts.get(contribution.primitive) ?? 0;
            counts.set(contribution.primitive, count + 1);
            return count < max;
        });
    return <>{contributions.map((contribution) => {
        const stable = contribution.type === 'native'
            && (PRIMITIVE_SPECS[contribution.primitive] as PluginPrimitiveSpec).stableAcrossManifestRefresh === true;
        const key = stable
            ? `${contribution.pluginId}:${contribution.id}`
            : `${contribution.pluginId}:${contribution.manifestHash}:${contribution.id}`;
        if (contribution.type === 'screen') {
            return <DeclarativeScreen key={key} contribution={contribution} pluginId={contribution.pluginId} params={'params' in context ? context.params : undefined} />;
        }
        return <React.Fragment key={key}>{renderPrimitive({
            context,
            pluginId: contribution.pluginId,
            manifestHash: contribution.manifestHash,
            contribution,
        })}</React.Fragment>;
    })}</>;
}
