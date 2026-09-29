/**
 * Adding a Plan Account, or signing one in again: a private folder muxr owns,
 * and the provider's own tool opened on it in a new tab, where the person
 * signs in themselves. muxr never sees a password or key: it only asks the
 * tool whether the folder is signed in now (`planIdentity.ts`).
 *
 * Which account each running agent is on is remembered here too, so the
 * phone can say "On Personal" and offer a move to the others.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { PlanAccount } from '@trymuxr/contract';
import { claudeIdentity, codexIdentity } from './planIdentity.js';
import { suggestPlanName, resolvePlanRecord } from './plansApi.js';
import {
    defaultPlanFolder,
    loadPlanAccounts,
    newPlanAccountId,
    PLAN_LABELS,
    plansDir,
    savePlanAccounts,
    type PlanAccountRecord,
    type PlanProvider,
} from './planStore.js';

/** What a new folder shares with the main sign-in, never its credentials.
 *  History, so a move can resume what another account started; settings, so
 *  the person's hooks come along: Herdr learns which conversation an agent
 *  runs only from its hook there, and without it every launch on the account
 *  fails its start check. */
const SHARED_WITH_MAIN: Record<PlanProvider, string[]> = {
    claude: ['projects', 'settings.json'],
    codex: ['sessions', 'config.toml', 'hooks.json'],
};

/** A fresh sign-in space, or the account's own to sign in again. */
export function preparePlanSignIn(
    env: NodeJS.ProcessEnv,
    provider: string,
    accountId?: string,
): { record: PlanAccountRecord; created: boolean } {
    if (provider !== 'claude' && provider !== 'codex') {
        throw Object.assign(new Error('Only Claude and ChatGPT accounts can be added.'), { code: 'plan-provider-unsupported' });
    }
    if (accountId !== undefined) {
        const record = resolvePlanRecord(env, accountId);
        if (record.provider !== provider) throw Object.assign(new Error('That account belongs to another provider.'), { code: 'plan-kind-mismatch' });
        return { record, created: false };
    }
    const folder = join(plansDir(env), provider, randomBytes(8).toString('hex'));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Only ever links inside muxr's own folder; muxr never writes the main sign-in.
    for (const entry of SHARED_WITH_MAIN[provider]) {
        const main = join(defaultPlanFolder(provider, env), entry);
        if (existsSync(main)) symlinkSync(main, join(folder, entry));
    }
    const record: PlanAccountRecord = { id: newPlanAccountId(), provider, name: '', folder, found: false };
    savePlanAccounts(env, [...loadPlanAccounts(env), record]);
    return { record, created: true };
}

/** The open sign-in tab per account, and whether its folder is new: a new
 *  one that never signed in goes when the person cancels. In memory only; a
 *  restarted host leaves the tab to the person. */
const signInTabs = new Map<string, { paneId: string; created: boolean }>();

export function rememberSignInTab(accountId: string, paneId: string, created: boolean): void {
    signInTabs.set(accountId, { paneId, created });
}

/** Take the account's sign-in tab off the books; the caller closes the pane. */
export function takeSignInTab(accountId: string): { paneId: string; created: boolean } | undefined {
    const tab = signInTabs.get(accountId);
    signInTabs.delete(accountId);
    return tab;
}

/** What the sign-in tab runs: the provider's own tool, pointed at the folder.
 *  A fresh folder opens straight onto the tool's own sign-in screen. */
export function planSignInLaunch(record: PlanAccountRecord): { kind: string; label: string; planEnv: Record<string, string>; signIn: true } {
    return {
        kind: record.provider,
        label: `Sign in · ${PLAN_LABELS[record.provider]}`,
        signIn: true,
        planEnv: record.provider === 'claude' ? { CLAUDE_CONFIG_DIR: record.folder } : { CODEX_HOME: record.folder },
    };
}

/** The account as its tool reports it right now: the phone polls this while
 *  the person signs in, and moves on once it reads signed in. */
export async function planAccountStatus(env: NodeJS.ProcessEnv, accountId: string): Promise<{ account: PlanAccount }> {
    const record = resolvePlanRecord(env, accountId);
    const identity = record.provider === 'claude'
        ? await claudeIdentity(record.folder, env)
        : await codexIdentity(record.folder, env);
    return {
        account: {
            id: record.id,
            provider: record.provider,
            name: record.name.trim() === '' ? suggestPlanName(identity.email, record.provider) : record.name,
            ...(identity.email === undefined ? {} : { email: identity.email }),
            ...(identity.plan === undefined ? {} : { plan: identity.plan }),
            ...(record.found ? { foundOnComputer: true as const } : {}),
            signedIn: identity.signedIn,
        },
    };
}

const PANES_KEPT = 256;

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
export function rememberPlanPane(env: NodeJS.ProcessEnv, paneId: string, accountId: string): void {
    const kept = [...loadPanes(env).filter(([id]) => id !== paneId), [paneId, accountId] as [string, string]].slice(-PANES_KEPT);
    mkdirSync(plansDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(panesPath(env), JSON.stringify(kept), { mode: 0o600 });
}

/** The account an agent's pane runs on, when muxr started or moved it onto
 *  one. Absent means the computer's own sign-in, as before accounts existed. */
export function planPaneAccount(env: NodeJS.ProcessEnv, paneId: string): { accountId?: string } {
    const accountId = loadPanes(env).find(([id]) => id === paneId)?.[1];
    return accountId !== undefined && loadPlanAccounts(env).some((record) => record.id === accountId) ? { accountId } : {};
}
