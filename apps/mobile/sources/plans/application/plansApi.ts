import type { PlanAccount } from '@trymuxr/contract';
import { sync } from '@/catalog/sync';
import { humanError } from '@/utils/errors';
import { refreshPlans, usePlansStore } from './plansStore';

/** Opens the provider's own sign-in in a new tab, in a fresh private space
 *  (or the account's own, to sign in again). The tab is the returned session. */
export function startSignIn(provider: string, accountId?: string) {
    return sync.request('plans.add', { provider, ...(accountId === undefined ? {} : { accountId }) });
}

/** The one-time Auto note has been shown; the host never lists it as unseen again. */
export async function acknowledgeAutoTerms(): Promise<void> {
    usePlansStore.setState((state) => (state.list === null ? {} : { list: { ...state.list, autoTermsAcknowledged: true } }));
    await sync.request('plans.acknowledgeAutoTerms', {}).catch(() => {});
}

/** The account being signed in, as its tool reports it now. */
export function signInState(accountId: string): Promise<PlanAccount> {
    return sync.request('plans.status', { accountId }).then((answer) => answer.account);
}

/** Stop waiting: the host closes the sign-in tab, and drops a new account that never signed in. */
export async function cancelSignIn(accountId: string): Promise<void> {
    await sync.request('plans.cancel', { accountId }).catch(() => {});
    await refreshPlans();
}

export async function renameAccount(accountId: string, name: string): Promise<void> {
    await sync.request('plans.rename', { accountId, name });
    await refreshPlans();
}

export async function removeAccount(accountId: string): Promise<void> {
    await sync.request('plans.remove', { accountId });
    await refreshPlans();
}

/** The account a running agent is on, when muxr put it on one. */
export function agentAccount(sessionId: string): Promise<string | undefined> {
    return sync.request('plans.agent', { sessionId }).then((answer) => answer.accountId).catch(() => undefined);
}

/** How much the move re-reads: the conversation's size, when the host knows it. */
export function conversationTokens(sessionId: string): Promise<number | undefined> {
    return sync.request('session.status', { sessionId })
        .then((status) => status.contextUsage?.tokens ?? undefined)
        .catch(() => undefined);
}

export async function moveAgent(sessionId: string, accountId: string): Promise<{ sessionId: string }> {
    const result = await sync.request('plans.move', { sessionId, accountId });
    await refreshPlans();
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
