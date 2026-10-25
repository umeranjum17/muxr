import * as React from 'react';
import { useHomeHerd } from '@/catalog/store';
import { herdPanes } from '../domain/herd';
import { selectLiveTerminalCards } from './liveTerminalOrder';
import { agentSummary, agentSummaryLine } from '../domain/agentSummary';

/** What the herd on Home is doing, as the one plain sentence the Right now card
 *  says about it. Undefined while the host's herd is still on its way: a herd
 *  that has not arrived is not an empty one, and "nothing is running" before the
 *  answer lands would be a guess. */
export function useHomeAgentLine(): string | undefined {
    const { sessions, workspaces, loaded } = useHomeHerd();
    return React.useMemo(() => {
        if (!loaded) return undefined;
        return agentSummaryLine(agentSummary(selectLiveTerminalCards(sessions, herdPanes(sessions, workspaces))));
    }, [loaded, sessions, workspaces]);
}
