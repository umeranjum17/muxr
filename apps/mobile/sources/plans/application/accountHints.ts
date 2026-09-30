import * as React from 'react';
import { choiceLine, effectiveChoice, providerEntry, providerForAgent } from '../domain/planAccounts';
import { usePlans, usePlansStore } from './plansStore';

export interface AccountLine {
    /** "Auto · Work", or the picked account's name. */
    value: string;
    /** "72% left", when the host has a reading. */
    detail?: string;
}

/** The dock's Account row for this agent, or null: most people never see it. */
export function useAccountLine(agentKind: string): AccountLine | null {
    const list = usePlans();
    const provider = providerForAgent(agentKind);
    const stored = usePlansStore((state) => (provider === null ? undefined : state.choices[provider]));
    const autoOn = usePlansStore((state) => state.autoOn);
    return React.useMemo(() => {
        const entry = providerEntry(list, provider);
        return entry === undefined ? null : choiceLine(entry, effectiveChoice(entry, stored, autoOn));
    }, [list, provider, stored, autoOn]);
}

