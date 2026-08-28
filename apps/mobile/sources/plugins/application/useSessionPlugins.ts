import * as React from 'react';
import type { PluginSummary, PluginToolbarButton } from '@muxr/contract';

import { useSocketStatus } from '@/sync/storage';
import { pluginSnapshot, refreshPlugins, subscribePlugins } from './pluginStore';

export type SessionPluginButton = PluginToolbarButton & Pick<PluginSummary, 'pluginId' | 'name'> & { manifestHash: string; capabilities: Record<string, string> };

export function invalidateSessionPlugins(): void {
    void refreshPlugins().catch(() => undefined);
}

function sessionPluginButtons(): SessionPluginButton[] {
    return pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions
        .filter((contribution): contribution is PluginToolbarButton => contribution.slot === 'session.toolbar')
        .map((contribution) => ({
            ...contribution,
            pluginId: summary.pluginId,
            manifestHash: summary.manifestHash,
            name: summary.name,
            capabilities: manifest.capabilities ?? {},
        })));
}

export function useSessionPlugins(): SessionPluginButton[] {
    const { status } = useSocketStatus();
    const [, render] = React.useReducer((value) => value + 1, 0);
    React.useEffect(() => {
        const unsubscribe = subscribePlugins(render);
        if (status === 'connected') void refreshPlugins().catch(() => undefined);
        return unsubscribe;
    }, [status]);
    return sessionPluginButtons();
}
