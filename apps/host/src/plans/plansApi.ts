/** Product wire projection and the read-only default-login row. BYOKit owns managed accounts and Auto. */
import { resolveSelection, roomOf, roomWords, type Room } from '@byokit/accounts';
import type { CliAccount } from '@byokit/accounts/cli';
import { launchEnv } from '@byokit/accounts/isolate';
import { existsSync } from 'node:fs';
import type { PlanAccount, PlanProviderAccounts } from '@trymuxr/contract';
import { planAccountWindows } from '../usage/index.js';
import { planAccounts, planError, fromCliAccount, defaultAccount, resolvePlanRecord } from './planAccounts.js';
import {
    defaultPlanFolder, loadPlanAccounts, PLAN_LABELS, PLAN_PROVIDERS, savePlanAccounts,
    type PlanAccountRecord, type PlanProvider,
} from './planStore.js';
import type { DefaultLoginDeps } from './planIdentity.js';

export interface PlansDeps extends DefaultLoginDeps {
    /** Usage owns source discovery/cache. It can supply the source's measurement time with the room. */
    room?: (record: PlanAccountRecord, env: NodeJS.ProcessEnv) => Promise<Room>;
}

/** Only muxr registers the computer's default row. No default folder is created or mutated. */
function providerRecords(provider: PlanProvider, env: NodeJS.ProcessEnv): PlanAccountRecord[] {
    const stored = loadPlanAccounts(env);
    const own = stored.filter((record) => record.provider === provider);
    // OpenCode sign-ins found on the computer are never adopted: a new account
    // honestly starts empty and signs in its own person.
    if (provider === 'opencode') return own;
    const folder = defaultPlanFolder(provider, env);
    if (!existsSync(folder) || own.some((record) => record.folder === folder)) return own;
    const found: PlanAccountRecord = { id: `found-${provider}`, provider, name: '', folder, found: true };
    savePlanAccounts(env, [found, ...stored]);
    return [found, ...own];
}

const OPENCODE_AMBIENT_AUTH_ENV = ['OPENCODE_AUTH', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_TEST_HOME'];

export const AUTO_TERMS_NOTE = 'Auto may use either of a provider\'s accounts.';

export async function planLaunchEnv(env: NodeJS.ProcessEnv, record: PlanAccountRecord): Promise<{ set: Record<string, string>; unset: string[] }> {
    if (record.found) return { set: {}, unset: [] };
    try {
        const kit = planAccounts(env);
        if (record.provider !== 'opencode') return kit.launchEnv(record.id);
        // OpenCode's key reaches it through files the kit writes at launch, so only `launch` gives its env.
        const launched = await kit.launch(record.id);
        if (!launched.ok) throw Object.assign(new Error(launched.message), { code: 'plan-account-unavailable' });
        // The kit sheds the rest of OpenCode's ambient auth; these inline and test redirects it does not.
        return { set: launched.set, unset: [...new Set([...launched.unset, ...OPENCODE_AMBIENT_AUTH_ENV])] };
    } catch (error) { return planError(error); }
}

async function accountEnvironment(env: NodeJS.ProcessEnv, record: PlanAccountRecord): Promise<NodeJS.ProcessEnv> {
    if (record.found) return { ...env, ...defaultFolderEnv(record) };
    try {
        const kit = planAccounts(env);
        const source = await kit.usageSource(record.id);
        // Explicit account unsets win over both inherited values and usage-source settings.
        // Consumers spawn with env as a replacement, so absent keys cannot be re-inherited.
        return launchEnv({ base: env, account: kit.launchEnv(record.id),
            ...(source?.provider === 'codex' ? { set: source.env } : {}),
        }).env;
    } catch (error) { return planError(error); }
}

function defaultFolderEnv(record: PlanAccountRecord): Record<string, string> {
    if (record.provider === 'claude') return { CLAUDE_CONFIG_DIR: record.folder };
    return { CODEX_HOME: record.folder };
}

async function providerRooms(provider: PlanProvider, env: NodeJS.ProcessEnv, deps: PlansDeps, managed: CliAccount[]) {
    // Once its adopted copy is signed in, the found row is that same sign-in: list it once.
    const adopted = new Set(managed.filter((account) => account.state === 'ready').map((account) => account.adoptedFrom));
    const records = providerRecords(provider, env).filter((record) => !(record.found && adopted.has(record.id)));
    const reads = await Promise.all(records.map(async (record) => {
        const cli = managed.find((account) => account.id === record.id);
        if (!record.found && cli === undefined) return undefined;
        const account = record.found ? await defaultAccount(record, env, deps) : fromCliAccount(cli!, record, env);
        let room: Room = { left: 'unknown' };
        let windowReadings: PlanAccount['windows'];
        // OpenCode Go's usage is not read per account: its room stays unknown.
        if (account.signedIn && provider !== 'opencode') {
            const scoped = await accountEnvironment(env, record);
            if (deps.room !== undefined) room = await deps.room(record, scoped);
            else {
                const windows = await planAccountWindows(provider, scoped, { refresh: true });
                windowReadings = windows.map((window) => ({ kind: window.windowKind, leftPercent: Math.round(100 - window.percentUsed),
                    ...(window.resetEpochSec === undefined ? {} : { resetsAtEpochSec: window.resetEpochSec }) }));
                room = roomOf(windows.map((window) => ({
                    usedPercent: window.percentUsed, kind: window.windowKind,
                    ...(window.resetEpochSec === undefined ? {} : { resetsAt: window.resetEpochSec }),
                })), undefined, 'seconds');
            }
        }
        return { account: { ...account, provider, ...(room.left === 'unknown' ? {} : {
            roomLeftPercent: Math.round(room.left), roomLabel: roomWords(room),
        }), ...(windowReadings === undefined || windowReadings.length === 0 ? {} : { windows: windowReadings }) }, room };
    }));
    return reads.filter((read): read is NonNullable<typeof read> => read !== undefined);
}

type ProviderRooms = Array<{ account: PlanAccount & { provider: PlanProvider; roomLeftPercent?: number; roomLabel?: string }; room: Room }>;

/** Every stored OpenCode account, and whether the kit reads it as signed in. A row the kit cannot status still counts, as signed out. */
export async function opencodeAccountStates(env: NodeJS.ProcessEnv): Promise<Array<{ id: string; signedIn: boolean }>> {
    const kit = planAccounts(env);
    return Promise.all(loadPlanAccounts(env).filter((record) => record.provider === 'opencode').map(
        (record) => kit.status(record.id).then((account) => ({ id: record.id, signedIn: account.state === 'ready' }), () => ({ id: record.id, signedIn: false }))));
}

/** Accounts a provider needs before its choice is listed or Auto picks: one OpenCode account already is one. */
function minimumRooms(provider: string): number {
    return provider === 'opencode' ? 1 : 2;
}

function selection(reads: Awaited<ReturnType<typeof providerRooms>>, account: string) {
    // Human provider labels also keep the kit's explanations suitable for the existing wire.
    const candidates = reads.map(({ account: wire, room }) => ({
        ...wire, provider: PLAN_LABELS[wire.provider], state: wire.signedIn ? 'ready' as const : 'signed_out' as const,
        billing: 'subscription' as const, room,
    }));
    return resolveSelection(candidates, {}, { account }, (candidate) => candidate.room, Date.now());
}

export async function listPlans(env: NodeJS.ProcessEnv = process.env, deps: PlansDeps = {}, options: { includeSingle?: boolean } = {}): Promise<{
    providers: PlanProviderAccounts[]; autoTermsAcknowledged: boolean; autoTermsNote: string;
}> {
    // Register default rows before any managed writes, retaining their original ordering.
    for (const provider of PLAN_PROVIDERS) providerRecords(provider, env);
    const kit = planAccounts(env);
    const managed = await kit.list();
    const reads = await Promise.all(PLAN_PROVIDERS.map(async (provider): Promise<PlanProviderAccounts | undefined> => {
        const rooms = await providerRooms(provider, env, deps, managed);
        if (rooms.length < (options.includeSingle ? 1 : minimumRooms(provider))) return undefined;
        const pick = selection(rooms, 'auto');
        return { provider, label: PLAN_LABELS[provider], accounts: rooms.map((read) => read.account),
            auto: pick.ok ? { accountId: pick.account.id, reason: pick.reason } : { reason: pick.reason } };
    }));
    return { providers: reads.filter((entry): entry is PlanProviderAccounts => entry !== undefined),
        autoTermsAcknowledged: kit.termsAcknowledged(), autoTermsNote: AUTO_TERMS_NOTE };
}

export function acknowledgeAutoTerms(env: NodeJS.ProcessEnv = process.env): { acknowledged: true } {
    planAccounts(env).acknowledgeTerms();
    return { acknowledged: true };
}

export async function resolvePlanLaunch(env: NodeJS.ProcessEnv, chosen: string, kind: string | undefined, deps: PlansDeps = {}): Promise<PlanAccountRecord | undefined> {
    const kit = planAccounts(env);
    let record: PlanAccountRecord;
    if (chosen === 'auto') {
        // Pi keeps its previous mapping onto the Claude accounts until the Pi account kind is a product decision.
        if (kind !== 'claude' && kind !== 'codex' && kind !== 'pi' && kind !== 'opencode') {
            throw Object.assign(new Error('Choose a provider agent for Auto.'), { code: 'plan-kind-mismatch' });
        }
        const reads = await providerRooms(kind === 'codex' || kind === 'opencode' ? kind : 'claude', env, deps, await kit.list());
        if (reads.length < minimumRooms(kind)) return undefined;
        const pick = selection(reads, chosen);
        if (!pick.ok) return undefined;
        record = resolvePlanRecord(env, pick.account.id);
    } else record = resolvePlanRecord(env, chosen);
    // The kit owns which kinds an account sign-in can launch; Pi keeps its old mapping above.
    const kinds = kind === 'pi' ? [...kit.kinds(record.provider), kind] : kit.kinds(record.provider);
    if (kind !== 'shell' && (record.provider === 'opencode' || kind !== undefined) && !kinds.includes(kind ?? '')) {
        throw Object.assign(new Error(`That account is a ${PLAN_LABELS[record.provider]} sign-in, not a ${kind ?? 'default'} one.`), { code: 'plan-kind-mismatch' });
    }
    let account: PlanAccount;
    if (record.found) account = await defaultAccount(record, env, deps);
    else {
        let status;
        try { status = await kit.status(record.id); } catch (error) { return planError(error); }
        account = fromCliAccount(status!, record, env);
    }
    return account.signedIn ? record : undefined;
}

export async function resolvePlanEnv(env: NodeJS.ProcessEnv, accountId: string): Promise<Record<string, string>> {
    return (await planLaunchEnv(env, resolvePlanRecord(env, accountId))).set;
}

export async function renamePlanAccount(env: NodeJS.ProcessEnv, accountId: string, name: string, deps: PlansDeps = {}): Promise<{ account: PlanAccount }> {
    const record = resolvePlanRecord(env, accountId);
    if (!record.found) {
        // Read the record again: the name just saved is the one to show.
        try {
            const renamed = fromCliAccount(await planAccounts(env).rename(accountId, name), resolvePlanRecord(env, accountId), env);
            return { account: renamed };
        } catch (error) { return planError(error); }
    }
    return { account: await renameStoredAccount(env, record, name, deps) };
}

/** A name the person chose, saved on the stored record: the row no kit owns
 *  (the computer's own sign-in). */
async function renameStoredAccount(env: NodeJS.ProcessEnv, record: PlanAccountRecord, name: string, deps: PlansDeps = {}): Promise<PlanAccount> {
    const clean = name.trim();
    if (clean === '' || clean.length > 64 || /[\x00-\x1f\x7f]/.test(clean)) {
        throw Object.assign(new Error('Give the account a name up to 64 characters.'), { code: 'invalid-plan-name' });
    }
    const named = { ...record, name: clean };
    savePlanAccounts(env, loadPlanAccounts(env).map((entry) => entry.id === record.id ? named : entry));
    return defaultAccount(named, env, deps);
}

export async function removePlanAccount(env: NodeJS.ProcessEnv, accountId: string): Promise<{ deletedFolder: boolean }> {
    const record = resolvePlanRecord(env, accountId);
    if (record.found) {
        savePlanAccounts(env, loadPlanAccounts(env).filter((entry) => entry.id !== accountId));
        return { deletedFolder: false };
    }
    try { await planAccounts(env).remove(accountId); } catch (error) { return planError(error); }
    return { deletedFolder: true };
}
