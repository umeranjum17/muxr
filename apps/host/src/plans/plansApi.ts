/**
 * Plan Accounts: the host surface behind `plans.*`.
 *
 * The feature is invisible below two accounts per provider: a provider with
 * fewer known sign-ins is omitted from `plans.list`, so a one-account
 * machine sees nothing new. `session.start` carries nothing then either.
 */
import { existsSync } from 'node:fs';
import type { PlanAccount, PlanProviderAccounts } from '@trymuxr/contract';
import { planAccountWindows, type UsageWindowVM } from '../usage/index.js';
import { choosePlanAccount, roomLabelFor, tightestRoomWindow } from './planAuto.js';
import {
    acknowledgeAutoTerms as recordAutoTermsAcknowledged,
    autoTermsAcknowledged,
    defaultPlanFolder,
    deletePlanFolder,
    isMuxrPlanFolder,
    loadPlanAccounts,
    newPlanAccountId,
    PLAN_LABELS,
    PLAN_PROVIDERS,
    planLaunchEnv,
    savePlanAccounts,
    type PlanAccountRecord,
    type PlanProvider,
} from './planStore.js';
import { claudeIdentity, codexIdentity, type PlanCommandRunner, type PlanIdentity } from './planIdentity.js';

export interface PlansDeps {
    run?: PlanCommandRunner;
    codexRead?: (folder: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
}

const MAX_NAME = 64;

/** A name the person would recognize: the email's first token, else the provider's own label. */
export function suggestPlanName(email: string | undefined, provider: PlanProvider): string {
    if (email !== undefined) {
        const local = email.split('@')[0] ?? '';
        const first = local.split(/[._-]+/).filter((part) => part !== '')[0] ?? '';
        if (first !== '') return (first.slice(0, 1).toUpperCase() + first.slice(1).toLowerCase()).slice(0, MAX_NAME);
    }
    return PLAN_LABELS[provider];
}

function identify(
    provider: PlanProvider,
    folder: string,
    env: NodeJS.ProcessEnv,
    deps: PlansDeps,
): Promise<PlanIdentity> {
    if (provider === 'claude') return claudeIdentity(folder, env, deps.run);
    return codexIdentity(folder, env, deps.codexRead);
}

/** Every known sign-in for one provider: stored records plus the found one,
 *  whose entry is created on first sight so a rename has somewhere to land. */
async function providerRooms(
    provider: PlanProvider,
    records: PlanAccountRecord[],
    env: NodeJS.ProcessEnv,
    deps: PlansDeps,
): Promise<{ accounts: PlanAccount[]; rooms: { id: string; name: string; signedIn: boolean; windows: UsageWindowVM[] }[] }> {
    const folderVar = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const reads = await Promise.all(records.map(async (record) => {
        const identity = await identify(provider, record.folder, env, deps);
        const name = record.name.trim() === '' ? suggestPlanName(identity.email, provider) : record.name;
        // Room left from the same reader Usage uses, pointed at this sign-in.
        const windows = identity.signedIn
            ? await planAccountWindows(provider, { ...env, [folderVar]: record.folder })
            : [];
        const tight = tightestRoomWindow(windows);
        return {
            account: {
                id: record.id,
                provider,
                name,
                ...(identity.email === undefined ? {} : { email: identity.email }),
                ...(identity.plan === undefined ? {} : { plan: identity.plan }),
                ...(record.found ? { foundOnComputer: true as const } : {}),
                signedIn: identity.signedIn,
                ...(tight === undefined ? {} : {
                    roomLeftPercent: Math.round(tight.percentRemaining),
                    roomLabel: roomLabelFor(tight),
                }),
            } as PlanAccount,
            room: { id: record.id, name, signedIn: identity.signedIn, windows },
        };
    }));
    return { accounts: reads.map((read) => read.account), rooms: reads.map((read) => read.room) };
}

export const AUTO_TERMS_NOTE = 'Auto may use either of a provider\'s accounts.';

export async function listPlans(
    env: NodeJS.ProcessEnv = process.env,
    deps: PlansDeps = {},
): Promise<{ providers: PlanProviderAccounts[]; autoTermsAcknowledged: boolean; autoTermsNote: string }> {
    const stored = loadPlanAccounts(env);
    const perProvider = new Map(PLAN_PROVIDERS.map((provider) => {
        const own = stored.filter((record) => record.provider === provider);
        const found = defaultPlanFolder(provider, env);
        const records = existsSync(found) && !own.some((record) => record.folder === found)
            ? [{ id: `found-${provider}`, provider, name: '', folder: found, found: true }, ...own]
            : own;
        return [provider, records] as const;
    }));
    const merged = PLAN_PROVIDERS.flatMap((provider) => perProvider.get(provider) ?? []);
    if (merged.length !== stored.length) savePlanAccounts(env, merged);
    const reads = await Promise.all(PLAN_PROVIDERS.map(async (provider): Promise<PlanProviderAccounts | undefined> => {
        const { accounts, rooms } = await providerRooms(provider, perProvider.get(provider) ?? [], env, deps);
        if (accounts.length < 2) return undefined;
        const auto = choosePlanAccount(rooms, PLAN_LABELS[provider]);
        return {
            provider,
            label: PLAN_LABELS[provider],
            accounts,
            auto: auto.accountId === undefined ? { reason: auto.reason } : { accountId: auto.accountId, reason: auto.reason },
        };
    }));
    const providers = reads.filter((entry): entry is PlanProviderAccounts => entry !== undefined);
    return { providers, autoTermsAcknowledged: autoTermsAcknowledged(env), autoTermsNote: AUTO_TERMS_NOTE };
}

export function acknowledgeAutoTerms(env: NodeJS.ProcessEnv = process.env): { acknowledged: true } {
    recordAutoTermsAcknowledged(env);
    return { acknowledged: true };
}

function describe(record: PlanAccountRecord, identity: PlanIdentity): PlanAccount {
    const name = record.name.trim() === '' ? suggestPlanName(identity.email, record.provider) : record.name;
    return {
        id: record.id,
        provider: record.provider,
        name,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        ...(identity.plan === undefined ? {} : { plan: identity.plan }),
        ...(record.found ? { foundOnComputer: true as const } : {}),
        signedIn: identity.signedIn,
    };
}

/** The stored record behind an id, or an `unknown-plan-account` throw the wire reports plainly. */
export function resolvePlanRecord(env: NodeJS.ProcessEnv, accountId: string): PlanAccountRecord {
    const record = loadPlanAccounts(env).find((entry) => entry.id === accountId);
    if (record === undefined) {
        throw Object.assign(new Error('Unknown account. List accounts again and pick one shown there.'), {
            code: 'unknown-plan-account',
        });
    }
    return record;
}

/** Launch env for a `session.start.planAccount` id. P3 merges it into the new pane. */
export function resolvePlanEnv(env: NodeJS.ProcessEnv, accountId: string): Record<string, string> {
    return planLaunchEnv(resolvePlanRecord(env, accountId));
}

export async function renamePlanAccount(
    env: NodeJS.ProcessEnv,
    accountId: string,
    name: string,
    deps: PlansDeps = {},
): Promise<{ account: PlanAccount }> {
    const clean = name.trim();
    if (clean === '' || clean.length > MAX_NAME) {
        throw Object.assign(new Error('Give the account a name up to 64 characters.'), { code: 'invalid-plan-name' });
    }
    const accounts = loadPlanAccounts(env);
    const record = accounts.find((entry) => entry.id === accountId) ?? resolvePlanRecord(env, accountId);
    record.name = clean;
    savePlanAccounts(env, accounts);
    const identity = await identify(record.provider, record.folder, env, deps);
    return { account: describe(record, identity) };
}

export function removePlanAccount(
    env: NodeJS.ProcessEnv,
    accountId: string,
): { deletedFolder: boolean } {
    const record = resolvePlanRecord(env, accountId);
    savePlanAccounts(env, loadPlanAccounts(env).filter((entry) => entry.id !== accountId));
    // A found sign-in is only forgotten. A muxr-created folder goes with its
    // record, which signs that account out on this computer.
    if (record.found || !isMuxrPlanFolder(record.folder, env)) return { deletedFolder: false };
    deletePlanFolder(record.folder);
    return { deletedFolder: true };
}
