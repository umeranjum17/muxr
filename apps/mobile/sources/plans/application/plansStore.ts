import * as React from 'react';
import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';
import { storage, useSocketStatus } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { AUTO, effectiveChoice, launchAccount, providerEntry, providerForAgent, type PlanProviderAccounts, type PlansList } from '../domain/planAccounts';
import { sync } from '@/catalog/sync';

const saved = new MMKV();
// Account ids are per computer, so a pick made for another one is simply
// never pickable here and reads as Auto.
const CHOICE_KEY = 'plans-choice';
const AUTO_OFF_KEY = 'plans-auto-off';

export type PlanConnection = Pick<ReturnType<typeof getCachedConnectionSettings>, 'machineId' | 'relayUrl' | 'token'>;
const connectionNow = (): PlanConnection => {
    const { machineId, relayUrl, token } = getCachedConnectionSettings();
    return { machineId, relayUrl, token };
};
const choiceKey = () => `${CHOICE_KEY}:${JSON.stringify([getCachedConnectionSettings().relayUrl, getCachedConnectionSettings().machineId])}`;

function loadChoices(): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(saved.getString(choiceKey()) ?? '{}');
        return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
}

interface PlansState {
    connection: PlanConnection;
    /** Null until the host answers, and on a host without accounts. */
    list: PlansList | null;
    /** The person's pick per provider: an account id or Auto. */
    choices: Record<string, string>;
    /** Auto picks at launch; off, the dock keeps the account picked last. */
    autoOn: boolean;
    choose: (provider: string, choice: string) => void;
    setAutoOn: (on: boolean) => void;
}

export const usePlansStore = create<PlansState>()((set, get) => ({
    connection: connectionNow(),
    list: null,
    choices: loadChoices(),
    autoOn: saved.getBoolean(AUTO_OFF_KEY) !== true,
    choose: (provider, choice) => {
        if (choice === AUTO && !get().autoOn) get().setAutoOn(true);
        const choices = { ...get().choices, [provider]: choice };
        saved.set(choiceKey(), JSON.stringify(choices));
        set({ choices });
    },
    setAutoOn: (on) => {
        const { choices: previous, list } = get();
        const choices = { ...previous };
        if (on) {
            for (const provider of Object.keys(choices)) choices[provider] = AUTO;
        } else {
            for (const entry of list?.providers ?? []) {
                if (effectiveChoice(entry, choices[entry.provider], true) !== AUTO) continue;
                choices[entry.provider] = entry.auto.accountId ?? effectiveChoice(entry, undefined, false);
            }
        }
        saved.set(choiceKey(), JSON.stringify(choices));
        saved.set(AUTO_OFF_KEY, !on);
        set({ autoOn: on, choices });
    },
}));

let inflight: { connection: PlanConnection; promise: Promise<void> } | null = null;

export function planConnection(): PlanConnection {
    const previous = usePlansStore.getState().connection;
    const current = connectionNow();
    if (previous.machineId === current.machineId && previous.relayUrl === current.relayUrl && previous.token === current.token) return previous;
    usePlansStore.setState({ connection: current, list: null, choices: loadChoices() });
    return current;
}

export const samePlanConnection = (connection: PlanConnection): boolean => planConnection() === connection;
export function assertPlanConnection(connection: PlanConnection): void {
    if (!samePlanConnection(connection)) throw new Error('The computer changed. Open accounts again.');
}

storage.subscribe(() => { planConnection(); });

export function refreshPlans(connection = planConnection()): Promise<void> {
    if (!samePlanConnection(connection)) return Promise.resolve();
    if (inflight?.connection === connection) return inflight.promise;
    const promise = sync.request('plans.list', {}, 60_000)
        .then((list) => { if (samePlanConnection(connection)) usePlansStore.setState({ list: Array.isArray(list?.providers) ? list : null }); })
        .catch(() => { if (samePlanConnection(connection)) usePlansStore.setState({ list: null }); })
        .finally(() => { if (inflight?.promise === promise) inflight = null; });
    inflight = { connection, promise };
    return promise;
}

/** Keeps the accounts current while something that shows them is mounted. */
export function usePlans(): PlansList | null {
    const status = useSocketStatus().status;
    const connection = planConnection();
    React.useEffect(() => {
        if (status === 'connected') void refreshPlans(connection);
    }, [status, connection]);
    return usePlansStore((state) => state.list);
}

/** Settings shows Accounts only where the computer can list them. */
export function usePlanAccountsAvailable(): boolean {
    return usePlans() !== null;
}

/** What `session.start` carries for this agent: nothing unless there is a choice. */
export function planAccountForLaunch(agentKind: string): string | undefined {
    planConnection();
    const { list, choices, autoOn } = usePlansStore.getState();
    const provider = providerForAgent(agentKind);
    return launchAccount(providerEntry(list, provider), provider === null ? undefined : choices[provider], autoOn);
}

/** One agent's provider, its accounts and the current choice, from what the
 *  host last said; the surface that opens asks it again. */
export function useProviderChoice(agentKind: string): { entry: PlanProviderAccounts | undefined; choice: string } {
    planConnection();
    const provider = providerForAgent(agentKind);
    const entry = usePlansStore((state) => providerEntry(state.list, provider));
    const stored = usePlansStore((state) => (provider === null ? undefined : state.choices[provider]));
    const autoOn = usePlansStore((state) => state.autoOn);
    return { entry, choice: entry === undefined ? AUTO : effectiveChoice(entry, stored, autoOn) };
}
