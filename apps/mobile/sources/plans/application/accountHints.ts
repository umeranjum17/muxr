import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { choiceLine, providerEntry, providerForAgent } from '../domain/planAccounts';
import { planConnection, refreshPlans, usePlans, usePlansStore } from './plansStore';

export interface AccountLine {
    /** "Auto · Work", the picked account's name, or "Work is signed out". */
    value: string;
    /** "72% left", when the host has a reading; what to do about a signed-out pick. */
    detail?: string;
}

/** The dock's Account row for this agent, or null: most people never see it.
 *  Asks the host again whenever the dock comes back into view, so the room it
 *  shows is the room the sheet would show. */
export function useAccountLine(agentKind: string): AccountLine | null {
    const list = usePlans();
    const provider = providerForAgent(agentKind);
    const stored = usePlansStore((state) => (provider === null ? undefined : state.choices[provider]));
    const autoOn = usePlansStore((state) => state.autoOn);
    const shown = providerEntry(list, provider) !== undefined;
    useFocusEffect(React.useCallback(() => { if (shown) void refreshPlans(planConnection()); }, [shown]));
    return React.useMemo(() => {
        const entry = providerEntry(list, provider);
        return entry === undefined ? null : choiceLine(entry, stored, autoOn);
    }, [list, provider, stored, autoOn]);
}
