/** Compose the published managed-folder kit. muxr supplies paths, binaries and Herdr hooks. */
import { cliAccounts, type CliProvider, type CliAccount } from '@byokit/accounts/cli';
import { launchEnv } from '@byokit/accounts/isolate';
import { agentProbePath, resolveAgentBinary } from '@byokit/herdr';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { defaultPlanFolder, muxrHome, plansDir, loadPlanAccounts, type PlanAccountRecord } from './planStore.js';
import { opencodeBinary, opencodeKeyStore } from './opencodeAccounts.js';
import type { PlanAccount } from '@trymuxr/contract';
import { accountNameFrom } from '@trymuxr/contract';
import { claudeIdentity, codexIdentity, type DefaultLoginDeps, type PlanIdentity } from './planIdentity.js';

export type PlanPreparation = (folder: string, provider: CliProvider) => Promise<void>;

// Named by reference: the kit's nested @byokit/usage types are not portable to a declaration.
export function planAccounts(env: NodeJS.ProcessEnv, prepare?: PlanPreparation): ReturnType<typeof cliAccounts> {
    const home = env.HOME?.trim() || homedir();
    const path = agentProbePath((env.PATH ?? '').split(delimiter), home);
    const bins: Partial<Record<CliProvider, string>> = {};
    for (const provider of ['claude', 'codex'] as const) {
        const resolved = resolveAgentBinary(provider, { path });
        if (resolved.path !== undefined) bins[provider] = resolve(resolved.path);
    }
    const opencode = opencodeBinary(env);
    if (opencode !== undefined) bins.opencode = opencode;
    mkdirSync(muxrHome(env), { recursive: true, mode: 0o700 });
    const childEnv = launchEnv({ base: {
        HOME: home,
        PATH: path.join(delimiter),
        ...(env.TMPDIR === undefined ? {} : { TMPDIR: env.TMPDIR }),
        ...(env.USER === undefined ? {} : { USER: env.USER }),
        ...(env.LOGNAME === undefined ? {} : { LOGNAME: env.LOGNAME }),
    } }).env;
    return cliAccounts({
        stateDir: plansDir(env),
        bins,
        // OpenCode Go signs in with a plan key, which the kit saves here and delivers to the account's folder.
        keyStore: opencodeKeyStore(env),
        // The kit's CLI children receive this copy; isolate no longer changes the parent process.
        env: { ...childEnv, HOME: home, PATH: path.join(delimiter) },
        // The kit links history inside its own folders; it never creates or writes these targets.
        historyFrom: {
            claude: join(defaultPlanFolder('claude', env), 'projects'),
            codex: join(defaultPlanFolder('codex', env), 'sessions'),
        },
        ...(prepare === undefined ? {} : { prepare }),
    });
}

/** Translate kit errors at the existing plans wire boundary. */
export function planError(error: unknown): never {
    const codes: Record<string, string> = {
        'unknown-account': 'unknown-plan-account',
        'invalid-name': 'invalid-plan-name',
        'kind-mismatch': 'plan-kind-mismatch',
        'prepare-failed': 'plan-integration-failed',
        'bad-option': 'plan-account-unavailable',
    };
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && codes[code] !== undefined) {
        throw Object.assign(new Error(error instanceof Error ? error.message : 'The account is unavailable.'), { code: codes[code] });
    }
    throw error;
}

/** Names this provider's other accounts already carry: what a fresh
 *  suggestion must never duplicate. OpenCode rows have no email to tell them
 *  apart, so each takes the first default name no earlier row uses. */
function takenNames(env: NodeJS.ProcessEnv, record: PlanAccountRecord): string[] {
    const rows = loadPlanAccounts(env).filter((entry) => entry.provider === record.provider);
    if (record.provider !== 'opencode') {
        return rows.filter((entry) => entry.id !== record.id).map((entry) => entry.name.trim()).filter((name) => name !== '');
    }
    const taken: string[] = [];
    for (const entry of rows) {
        if (entry.id === record.id) break;
        taken.push(entry.name.trim() || accountNameFrom(undefined, 'opencode', taken));
    }
    return taken;
}

/** The person's own name for an account, or a suggestion from that account's
 *  OWN email when nobody has named it yet. */
export function accountName(record: PlanAccountRecord, env: NodeJS.ProcessEnv, email: string | undefined): string {
    return record.name.trim() || accountNameFrom(email, record.provider, takenNames(env, record));
}

export function fromCliAccount(account: CliAccount, record: PlanAccountRecord, env: NodeJS.ProcessEnv): PlanAccount {
    const { id, provider, email, plan } = account;
    return { id, provider, name: accountName(record, env, email), signedIn: account.state === 'ready',
        ...(email === undefined ? {} : { email }), ...(plan === undefined ? {} : { plan }) };
}

function describeDefault(record: PlanAccountRecord, identity: PlanIdentity, env: NodeJS.ProcessEnv): PlanAccount {
    return { id: record.id, provider: record.provider,
        name: accountName(record, env, identity.email),
        signedIn: identity.signedIn, foundOnComputer: true,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        ...(identity.plan === undefined ? {} : { plan: identity.plan }) };
}

export async function defaultAccount(record: PlanAccountRecord, env: NodeJS.ProcessEnv, deps: DefaultLoginDeps): Promise<PlanAccount> {
    const identity = record.provider === 'claude'
        ? await claudeIdentity(record.folder, env, deps.run)
        : await codexIdentity(record.folder, env, deps.codexRead);
    return describeDefault(record, identity, env);
}

/** Managed-folder validation remains in the kit, including old roster rows. */
export function resolvePlanRecord(env: NodeJS.ProcessEnv, accountId: string): PlanAccountRecord {
    const record = loadPlanAccounts(env).find((entry) => entry.id === accountId);
    if (record === undefined) {
        throw Object.assign(new Error('Unknown account. List accounts again and pick one shown there.'), { code: 'unknown-plan-account' });
    }
    if (!record.found) {
        try { planAccounts(env).launchEnv(accountId); } catch (error) { return planError(error); }
    }
    return record;
}
