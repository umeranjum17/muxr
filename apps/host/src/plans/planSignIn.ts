/** muxr owns sign-in tabs and pane/account bookkeeping. Each sign-in attempt owns a kit instance. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { HerdrTreePane, HerdrTreeWorkspace, PlanAccount, PlanProviderAccounts } from '@trymuxr/contract';
import { planAccounts, planError, defaultAccount, fromCliAccount, resolvePlanRecord, accountName, type PlanPreparation } from './planAccounts.js';
import { addOpencodeAccount, opencodeLaunchEnv, opencodeSignedIn, removeOpencodeAccount } from './opencodeAccounts.js';
import { loadPlanAccounts, PLAN_LABELS, plansDir } from './planStore.js';

// A completed attempt releases its kit: a later re-sign-in must not inherit add's cancel ownership.
const attempts = new Map<string, { kit: ReturnType<typeof planAccounts>; adoptedId?: string }>();
const signInTabs = new Map<string, string>();
const signInOperations = new Map<string, Promise<unknown>>();
/** Each attempt's private script; it records how the login ended, which the kit's own marker only says on success. */
const signInScripts = new Map<string, string>();
/** OpenCode accounts this process created and never signed in: cancelling one removes it with its empty root. */
const freshOpencode = new Set<string>();

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * The tab runs one private script, so all it shows is the provider's own
 * sign-in: the script clears the screen, runs the kit's command (which sets
 * the account's folder itself), and records a login that failed.
 */
function signInScript(env: NodeJS.ProcessEnv, accountId: string, shell: string): Record<string, string> {
    forgetSignInScript(accountId);
    mkdirSync(plansDir(env), { recursive: true, mode: 0o700 });
    const script = join(plansDir(env), `signin-${randomBytes(12).toString('hex')}.sh`);
    writeFileSync(script, [
        "printf '\\033[H\\033[2J\\033[3J'",
        `if ${shell}; then :; else (umask 077; printf failed > ${quote(`${script}.result`)}); fi`,
        '',
    ].join('\n'), { mode: 0o700 });
    signInScripts.set(accountId, script);
    return { MUXR_PLAN_SIGNIN: script };
}

function forgetSignInScript(accountId: string): void {
    const script = signInScripts.get(accountId);
    if (script === undefined) return;
    rmSync(script, { force: true });
    rmSync(`${script}.result`, { force: true });
    signInScripts.delete(accountId);
}

function signInFailed(accountId: string): boolean {
    const script = signInScripts.get(accountId);
    try {
        return script !== undefined && readFileSync(`${script}.result`, 'utf8').trim() === 'failed';
    } catch {
        return false;
    }
}

export async function preparePlanSignIn(env: NodeJS.ProcessEnv, provider: string, accountId?: string, prepare?: PlanPreparation) {
    if (provider === 'opencode') {
        // muxr owns OpenCode accounts outright: one private HOME+XDG root per
        // id, no kit, no integration hooks. The same descriptor that starts
        // agents opens this tab, so the sign-in lands in that account's root.
        let record = accountId === undefined ? undefined : resolvePlanRecord(env, accountId);
        if (record !== undefined && record.provider !== 'opencode') {
            throw Object.assign(new Error('That account belongs to another provider.'), { code: 'plan-kind-mismatch' });
        }
        if (record === undefined) {
            record = addOpencodeAccount(env);
            freshOpencode.add(record.id);
        } else freshOpencode.delete(record.id);
        const descriptor = opencodeLaunchEnv(env, record);
        return {
            record,
            launch: {
                kind: 'shell',
                label: `Sign in · ${PLAN_LABELS.opencode}`,
                signIn: ' sh "$MUXR_PLAN_SIGNIN"',
                planEnv: { ...descriptor.set, ...signInScript(env, record.id, 'opencode auth login') },
                planUnset: descriptor.unset,
            },
        };
    }
    if (provider !== 'claude' && provider !== 'codex') {
        throw Object.assign(new Error('Only Claude, ChatGPT and OpenCode accounts can be added.'), { code: 'plan-provider-unsupported' });
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
        attempts.set(id, { kit });
        if (accountId !== undefined && accountId !== id) attempts.set(accountId, { kit, adoptedId: id });
        return { record: resolvePlanRecord(env, id), launch: {
            // A leading space keeps it out of the shell's history.
            kind: 'shell', label: `Sign in · ${PLAN_LABELS[provider]}`, signIn: ' sh "$MUXR_PLAN_SIGNIN"',
            planEnv: signInScript(env, id, signIn.shell),
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
    if (signInTabs.get(accountId) !== paneId) return;
    signInTabs.delete(accountId);
    forgetSignInScript(accountId);
}

export function finishPlanSignIn(accountId: string): void {
    if (attempts.get(accountId)?.adoptedId !== undefined) return;
    attempts.delete(accountId);
    for (const [key, entry] of attempts) {
        if (entry.adoptedId === accountId) attempts.delete(key);
    }
}

export async function cancelPlanSignIn(env: NodeJS.ProcessEnv, accountId: string): Promise<{ removed: boolean }> {
    if (freshOpencode.delete(accountId)) {
        removeOpencodeAccount(env, accountId);
        return { removed: true };
    }
    if (loadPlanAccounts(env).some((entry) => entry.id === accountId && entry.provider === 'opencode')) return { removed: false };
    try { return await (attempts.get(accountId)?.kit ?? planAccounts(env)).cancel(accountId); }
    catch (error) { return planError(error); }
    finally { attempts.delete(accountId); }
}

/** The account as its tool reports it now. `failure` says why a tracked sign-in ended without signing in. */
export async function planAccountStatus(env: NodeJS.ProcessEnv, accountId: string): Promise<{ account: PlanAccount; failure?: string }> {
    const record = resolvePlanRecord(env, accountId);
    if (record.provider === 'opencode') {
        const account: PlanAccount = { id: record.id, provider: 'opencode', name: accountName(record, env, undefined), signedIn: opencodeSignedIn(record) };
        return { account, ...(!account.signedIn && signInFailed(accountId)
            ? { failure: `${PLAN_LABELS.opencode} sign-in ended without signing in. Its tab shows why.` } : {}) };
    }
    let account: PlanAccount;
    if (record.found) account = await defaultAccount(record, env, {});
    else {
        try { account = fromCliAccount(await (attempts.get(accountId)?.kit ?? planAccounts(env)).status(accountId), record, env); }
        catch (error) { return planError(error); }
    }
    return { account, ...(!account.signedIn && signInFailed(accountId)
        ? { failure: `${PLAN_LABELS[record.provider]} sign-in ended without signing in. Its tab shows why.` } : {}) };
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

/**
 * Names the account each agent in the tree runs on, from the accounts the
 * host last listed: only for a provider with a choice of account (the list
 * holds no other), and never on a sign-in tab. Reading names from that list
 * keeps the tree's own cadence free of any provider tool call.
 */
export function withPlanAccounts<T extends { workspaces: HerdrTreeWorkspace[] }>(env: NodeJS.ProcessEnv, tree: T, listed: readonly PlanProviderAccounts[] | undefined): T {
    if (listed === undefined || listed.length === 0) return tree;
    const recorded = new Map(loadPanes(env));
    const signingIn = new Set(signInTabs.values());
    const accountOn = (pane: HerdrTreePane): string | undefined => {
        const kind = pane.agentKind;
        const provider = kind === 'claude' || kind === 'pi' ? 'claude' : kind === 'codex' ? 'codex' : kind === 'opencode' ? 'opencode' : undefined;
        const entry = listed.find((candidate) => candidate.provider === provider);
        if (entry === undefined || signingIn.has(pane.paneId)) return undefined;
        const id = recorded.get(pane.paneId);
        return (id === undefined ? entry.accounts.find((account) => account.foundOnComputer) : entry.accounts.find((account) => account.id === id))?.name;
    };
    return {
        ...tree,
        workspaces: tree.workspaces.map((workspace) => ({
            ...workspace,
            tabs: workspace.tabs.map((tab) => ({
                ...tab,
                panes: tab.panes.map((pane) => {
                    const planAccount = accountOn(pane);
                    return planAccount === undefined ? pane : { ...pane, planAccount };
                }),
            })),
        })),
    };
}

/** The account an agent's pane runs on, when muxr started or moved it onto
 *  one. Absent means the computer's own sign-in, as before accounts existed. */
export function planPaneAccount(env: NodeJS.ProcessEnv, paneId: string): { accountId?: string } {
    const accountId = loadPanes(env).find(([id]) => id === paneId)?.[1];
    return accountId !== undefined && loadPlanAccounts(env).some((record) => record.id === accountId) ? { accountId } : {};
}
