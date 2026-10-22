import { AUTO, providerEntry, providerForAgent, providerName, runningOn, type PlanAccount } from '../domain/planAccounts';
import { samePlanConnection, usePlansStore, useUnknownAccounts, type PlanConnection } from './plansStore';
import { agentAccount, planFailure } from './plansApi';
import { showNotice } from './planNotices';

/** After Start, says which account the agent started on, as the host
 *  recorded it rather than as picked: Auto and a stale list can differ. */
export async function announceStartAccount(sessionId: string, agentKind: string, choice: string, connection: PlanConnection): Promise<void> {
    const entry = providerEntry(usePlansStore.getState().list, providerForAgent(agentKind));
    if (entry === undefined) return;
    let account: PlanAccount | undefined;
    try {
        account = runningOn(entry, (await agentAccount(sessionId, connection)).accountId, agentKind);
    } catch (error) {
        if (samePlanConnection(connection)) useUnknownAccounts.setState((state) => ({ reasons: { ...state.reasons, [sessionId]: planFailure(error) } }));
        return;
    }
    if (account === undefined || !samePlanConnection(connection)) return;
    showNotice(`Started on ${account.name}${choice === AUTO ? ' (Auto)' : ''}`, account.roomLabel ?? `${providerName(entry.provider)} account`);
}

