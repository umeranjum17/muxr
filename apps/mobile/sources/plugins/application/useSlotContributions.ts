import * as React from 'react';
import type { PluginNativeContribution, PluginNativeSlot, PluginScreenContribution } from '@muxr/contract';
import { useSocketStatus } from '@/sync/storage';
import { pluginSnapshot, refreshPlugins, subscribePlugins } from './pluginStore';

export type SlotContribution = (PluginNativeContribution | PluginScreenContribution) & { pluginId: string; pluginName: string; manifestHash: string };

export function invalidatePlugins(): void {
    void refreshPlugins().catch(() => undefined);
}

export function useSlotContributions(slot: PluginNativeSlot): SlotContribution[] {
    const { status } = useSocketStatus();
    const [, render] = React.useReducer((value) => value + 1, 0);
    React.useEffect(() => {
        const unsubscribe = subscribePlugins(render);
        if (status === 'connected') void refreshPlugins().catch(() => undefined);
        return unsubscribe;
    }, [status]);
    return pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) => {
        const matches = 'type' in contribution
            && (contribution.type === 'native' && contribution.slot === slot
                || contribution.type === 'screen' && contribution.slot === 'navigation.content' && slot === 'navigation.content');
        return matches ? [{ ...contribution, pluginId: summary.pluginId, pluginName: summary.name, manifestHash: summary.manifestHash }] : [];
    }));
}
