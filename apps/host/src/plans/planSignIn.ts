/** muxr owns sign-in tabs and pane/account bookkeeping. Each sign-in attempt owns a kit instance. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanAccount } from '@trymuxr/contract';
import { planAccounts, planError, defaultAccount, fromCliAccount, resolvePlanRecord, type PlanPreparation } from './planAccounts.js';
import { loadPlanAccounts, PLAN_LABELS, plansDir } from './planStore.js';

// A completed attempt releases its kit: a later re-sign-in must not inherit add's cancel ownership.
const attempts = new Map<string, { kit: ReturnType<typeof planAccounts>; created: boolean; adoptedId?: string }>();
const signInTabs = new Map<string, string>();
const signInOperations = new Map<string, Promise<unknown>>();

export async function preparePlanSignIn(env: NodeJS.ProcessEnv, provider: string, accountId?: string, prepare?: PlanPreparation) {
    if (provider !== 'claude' && provider !== 'codex') {
        throw Object.assign(new Error('Only Claude and ChatGPT accounts can be added.'), { code: 'plan-provider-unsupported' });
    }
    const prior = accountId === undefined ? undefined : attempts.get(accountId);
    const kit = prior?.kit ?? planAccounts(env, prepare);
    try {
        let id = accountId;
        let signIn;
        if (id === undefined) {
            const added = await kit.add(provider);
            id = added.account.id;
            signIn = added.signIn;
        } else {
            const record = resolvePlanRecord(env, id);
            if (record.provider !== provider) {
                throw Object.assign(new Error('That account belongs to another provider.'), { code: 'plan-kind-mismatch' });
            }
            if (record.found) {
                // A found default row is read-only here: the kit adopts it into a managed folder it
                // creates, and never reads or copies the discovered one.
                const liveAdopted = prior?.adoptedId !== undefined && attempts.has(prior.adoptedId) ? prior.adoptedId : undefined;
                if (liveAdopted !== undefined) {
                    id = liveAdopted;
                    signIn = kit.signInAgain(id);
                } else {
                    const adopted = await kit.adopt(id);
                    id = adopted.account.id;
                    signIn = adopted.signIn;
                }
            } else signIn = kit.signInAgain(id);
        }
        const created = accountId === undefined || prior?.created === true;
        attempts.set(id, { kit, created });
        if (accountId !== undefined && accountId !== id) attempts.set(accountId, { kit, created, adoptedId: id });
        return { record: resolvePlanRecord(env, id), created, launch: {
            kind: 'shell', label: `Sign in · ${PLAN_LABELS[provider]}`, signIn: signIn.shell,
            planEnv: kit.launchEnv(id).set,
        } };
    } catch (error) { return planError(error); }
}

/** The lock owns the tab operation, beyond the kit's per-account mutations. */
export function withPlanSignIn<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    const result = (signInOperations.get(accountId) ?? Promise.resolve()).then(action, action);
    signInOperations.set(accountId, result);
    return result.finally(() => {
        if (signInOperations.get(accountId) === result) signInOperations.delete(accountId);
    });
}

export function rememberSignInTab(accountId: string, paneId: string): void {
    signInTabs.set(accountId, paneId);
}

export function signInTab(accountId: string) { return signInTabs.get(accountId); }

export function forgetSignInTab(accountId: string, paneId: string): void {
    if (signInTabs.get(accountId) === paneId) signInTabs.delete(accountId);
}

export function finishPlanSignIn(accountId: string): void {
    if (attempts.get(accountId)?.adoptedId !== undefined) return;
    attempts.delete(accountId);
    for (const [key, entry] of attempts) {
        if (entry.adoptedId === accountId) attempts.delete(key);
    }
}

export async function cancelPlanSignIn(env: NodeJS.ProcessEnv, accountId: string): Promise<{ removed: boolean }> {
    try { return await (attempts.get(accountId)?.kit ?? planAccounts(env)).cancel(accountId); }
    catch (error) { return planError(error); }
    finally { attempts.delete(accountId); }
}

export async function planAccountStatus(env: NodeJS.ProcessEnv, accountId: string): Promise<{ account: PlanAccount }> {
    const record = resolvePlanRecord(env, accountId);
    if (record.found) return { account: await defaultAccount(record, env, {}) };
    try { return { account: fromCliAccount(await (attempts.get(accountId)?.kit ?? planAccounts(env)).status(accountId)) }; }
    catch (error) { return planError(error); }
}

function panesPath(env: NodeJS.ProcessEnv): string {
    return join(plansDir(env), 'agent-panes-v1.json');
}

function loadPanes(env: NodeJS.ProcessEnv): Array<[string, string]> {
    try {
        const parsed: unknown = JSON.parse(readFileSync(panesPath(env), 'utf8'));
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
            : [];
    } catch {
        return [];
    }
}

/** Remember the account an agent was started or moved on, by its pane. */
export function rememberPlanPane(env: NodeJS.ProcessEnv, paneId: string, accountId: string, livePaneIds: readonly string[]): void {
    const kept = [...loadPanes(env).filter(([id]) => id !== paneId && livePaneIds.includes(id)), [paneId, accountId] as [string, string]];
    mkdirSync(plansDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(panesPath(env), JSON.stringify(kept), { mode: 0o600 });
}

/** The account an agent's pane runs on, when muxr started or moved it onto
 *  one. Absent means the computer's own sign-in, as before accounts existed. */
export function planPaneAccount(env: NodeJS.ProcessEnv, paneId: string): { accountId?: string } {
    const accountId = loadPanes(env).find(([id]) => id === paneId)?.[1];
    return accountId !== undefined && loadPlanAccounts(env).some((record) => record.id === accountId) ? { accountId } : {};
}
