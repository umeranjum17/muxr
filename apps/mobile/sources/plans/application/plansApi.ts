import type { PlanAccount, RequestType, RequestParams, RequestResult } from '@trymuxr/contract';
import { sync } from '@/catalog/sync';
import { humanError } from '@/utils/errors';
import { assertPlanConnection, planConnection, refreshPlans, usePlansStore, type PlanConnection } from './plansStore';

async function requestPlan<T extends RequestType>(connection: PlanConnection, type: T, params: RequestParams<T>, timeoutMs?: number): Promise<RequestResult<T>> {
    assertPlanConnection(connection);
    try {
        const result = await sync.request(type, params, timeoutMs);
        assertPlanConnection(connection);
        return result;
    } catch (error) {
        assertPlanConnection(connection);
        throw error;
    }
}

/** Opens the provider's own sign-in in a new tab, in a fresh private space
 *  (or the account's own, to sign in again). The tab is the returned session. */
export function startSignIn(provider: string, accountId?: string, connection = planConnection()) {
    return requestPlan(connection, 'plans.add', { provider, ...(accountId === undefined ? {} : { accountId }) }, 60_000);
}

/** The one-time Auto note has been shown; the host never lists it as unseen again. */
export async function acknowledgeAutoTerms(connection = planConnection()): Promise<void> {
    await requestPlan(connection, 'plans.acknowledgeAutoTerms', {});
    usePlansStore.setState((state) => (state.list === null ? {} : { list: { ...state.list, autoTermsAcknowledged: true } }));
}

export function unseenAutoTerms(): string | undefined {
    planConnection();
    const list = usePlansStore.getState().list;
    return list?.autoTermsAcknowledged === false ? list.autoTermsNote : undefined;
}

/** The account being signed in, as its tool reports it now, and why its
 *  sign-in ended without signing in, once it has. */
export function signInState(accountId: string, connection = planConnection()): Promise<{ account: PlanAccount; failure?: string }> {
    return requestPlan(connection, 'plans.status', { accountId });
}

/** Cancel the tracked sign-in through `plans.cancel`, then refresh accounts. */
export async function cancelSignIn(accountId: string, connection = planConnection()): Promise<void> {
    await requestPlan(connection, 'plans.cancel', { accountId });
    await refreshPlans(connection);
    assertPlanConnection(connection);
}

export async function renameAccount(accountId: string, name: string, connection = planConnection()): Promise<void> {
    await requestPlan(connection, 'plans.rename', { accountId, name });
    await refreshPlans(connection);
    assertPlanConnection(connection);
}

export async function removeAccount(accountId: string, connection = planConnection()): Promise<void> {
    await requestPlan(connection, 'plans.remove', { accountId });
    await refreshPlans(connection);
    assertPlanConnection(connection);
}

/** The account a running agent is on, when muxr put it on one, and whether it has a conversation to move yet. */
export function agentAccount(sessionId: string, connection = planConnection()): Promise<{ accountId?: string; movable?: boolean }> {
    return requestPlan(connection, 'plans.agent', { sessionId });
}

export async function moveAgent(sessionId: string, accountId: string, connection = planConnection()): Promise<{ sessionId: string }> {
    const result = await requestPlan(connection, 'plans.move', { sessionId, accountId }, 240_000);
    await refreshPlans(connection);
    assertPlanConnection(connection);
    return result;
}

/** The host words its plan failures for people ("Wait for it to start, then
 *  try again."); keep those, and the app's own line for anything else. */
export function planFailure(cause: unknown): string {
    const human = humanError(cause);
    const raw = human.details ?? '';
    const sentence = raw.length > 0 && raw.length <= 200 && /[.!?]$/.test(raw) && !raw.includes('\n');
    return human.details !== undefined && human.title === 'Something went wrong' && sentence ? raw : human.message;
}
