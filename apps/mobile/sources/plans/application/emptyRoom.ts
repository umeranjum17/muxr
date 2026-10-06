import * as React from 'react';
import { isEmpty, providerEntry, providerForAgent, runningOn, type PlanAccount, type PlanProviderAccounts } from '../domain/planAccounts';
import { planConnection, refreshPlans, samePlanConnection, usePlansStore } from './plansStore';
import { agentAccount } from './plansApi';

/** A running agent whose account has no room left. Null while unknown. */
export interface EmptyRoom {
    entry: PlanProviderAccounts;
    account: PlanAccount;
}

// How often a mounted banner re-reads the room: often enough that an
// account emptying mid-run shows up without a navigation, seldom enough
// that a Home full of cards stays quiet.
const POLL_MS = 30_000;

/**
 * The empty account a running agent is on, when its provider has a choice
 * of accounts and the one it runs on is out of room. Reads the recorded
 * account once, then re-reads the room on this interval, so a banner
 * appears while the agent is still running, not only on arrival.
 */
export function useEmptyRoom(sessionId: string, agentKind: string | undefined): EmptyRoom | null {
    const provider = agentKind === undefined ? null : providerForAgent(agentKind);
    const entry = usePlansStore((state) => providerEntry(state.list, provider));
    const listed = entry !== undefined;
    const [recorded, setRecorded] = React.useState<{ sessionId: string; id?: string } | null>(null);
    const connection = planConnection();
    React.useEffect(() => {
        // Nothing else on this screen may have asked: without a list there
        // is no room to read, so ask first instead of staying dark forever.
        if (!listed) { void refreshPlans(connection); return; }
        let live = true;
        const check = () => {
            void agentAccount(sessionId, connection)
                .then(({ accountId }) => { if (live && samePlanConnection(connection)) setRecorded({ sessionId, id: accountId }); })
                // Unknown stays unknown: falling back to the computer's own
                // sign-in here could warn about the wrong account. The next
                // poll tries again.
                .catch(() => { if (live && samePlanConnection(connection)) setRecorded(null); });
        };
        setRecorded(null);
        void refreshPlans(connection);
        check();
        const timer = setInterval(() => { if (samePlanConnection(connection)) { void refreshPlans(connection); check(); } }, POLL_MS);
        return () => { live = false; clearInterval(timer); };
    }, [listed, sessionId, connection]);
    return React.useMemo(() => {
        if (entry === undefined || recorded?.sessionId !== sessionId) return null;
        const account = runningOn(entry, recorded.id);
        return account !== undefined && isEmpty(account) ? { entry, account } : null;
    }, [entry, recorded, sessionId]);
}
