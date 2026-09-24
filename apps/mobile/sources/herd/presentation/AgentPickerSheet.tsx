/**
 * What a new pane runs: the same agent list the home dock offers, Shell
 * first. Asks the host which agents it can start the first time it opens.
 */

import * as React from 'react';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { sync } from '@/catalog/sync';
import { resolveAgentCatalog } from '@/catalog';
import { DOCK_AGENTS, visibleDockAgents } from '@/spawn';

export function AgentPickerSheet(props: { visible: boolean; title: string; onSelect: (option: ModelMode) => void; onClose: () => void }): React.JSX.Element {
    const [agents, setAgents] = React.useState<ModelMode[] | null>(null);
    React.useEffect(() => {
        if (!props.visible || agents !== null) return;
        void sync.request('herdr.agentKinds', {}).then((result) => {
            const launchable = resolveAgentCatalog(result).options.filter((option) => option.availability !== 'unavailable').map((option) => option.kind);
            setAgents(visibleDockAgents([...new Set(['shell', ...launchable])], true, 'shell'));
        }).catch(() => setAgents(DOCK_AGENTS.filter((option) => option.key === 'shell')));
    }, [props.visible, agents]);
    return (
        <OptionSheet
            visible={props.visible}
            title={props.title}
            options={agents ?? []}
            emptyText="Checking which agents this computer can start…"
            onSelect={props.onSelect}
            onClose={props.onClose}
        />
    );
}
