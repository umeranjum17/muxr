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

/**
 * The Agent sheet's quiet second line under each agent that has a choice of
 * account. Options come back untouched (the same array) when there is none,
 * so one account per provider renders exactly as before.
 */
export function useAccountHints<T extends { key: string; description?: string }>(options: T[]): T[] {
    const list = usePlans();
    const choices = usePlansStore((state) => state.choices);
    const autoOn = usePlansStore((state) => state.autoOn);
    return React.useMemo(() => {
        let changed = false;
        const next = options.map((option) => {
            const provider = providerForAgent(option.key);
            const entry = providerEntry(list, provider);
            if (entry === undefined || provider === null) return option;
            changed = true;
            const line = choiceLine(entry, effectiveChoice(entry, choices[provider], autoOn));
            // Pi runs on a Claude account only on a Claude model.
            const words = option.key === 'pi'
                ? `Claude models: ${line.value}`
                : [line.value, line.detail].filter(Boolean).join(' · ');
            return { ...option, description: words };
        });
        return changed ? next : options;
    }, [options, list, choices, autoOn]);
}
