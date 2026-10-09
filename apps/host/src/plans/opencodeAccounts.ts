/**
 * OpenCode accounts: muxr-owned private HOME+XDG roots, one per account id.
 *
 * OpenCode keeps its sign-in in the XDG data root (`OPENCODE_CONFIG_DIR` only
 * selects settings), so an account here is a whole private root, and the same
 * launch descriptor opens its sign-in tab and starts its agents. No kit: no
 * folderVar, no move, no readiness probe, billing unknown.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { INHERITED, launchEnv } from '@byokit/accounts/isolate';
import { agentProbePath, resolveAgentBinary } from '@byokit/herdr';
import { loadPlanAccounts, plansDir, savePlanAccounts, type PlanAccountRecord } from './planStore.js';

/** Source-backed OpenCode redirects: none may reach a launch, inherited or set. */
const BLOCKED = ['OPENCODE_AUTH', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_TEST_HOME', 'OPENCODE_DB'];

function unavailable(): never {
    throw Object.assign(new Error("That account's private folder is missing or unsafe. Remove the account and add it again."), { code: 'plan-account-unavailable' });
}

/** Absolute, beneath the app-managed plans dir, and not that dir itself. */
function insidePlansDir(env: NodeJS.ProcessEnv, folder: string): boolean {
    if (!isAbsolute(folder)) return false;
    const base = resolve(plansDir(env));
    const root = resolve(folder);
    const up = relative(base, root);
    return root !== base && up !== '' && !up.startsWith('..') && !isAbsolute(up);
}

/** The account root: created private and empty if absent. A new account never
 *  inherits another tool's credentials; a symlinked or relocated root is refused. */
function openRoot(env: NodeJS.ProcessEnv, folder: string): string {
    if (!insidePlansDir(env, folder)) unavailable();
    if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) unavailable();
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    for (const dir of ['.config', join('.local', 'share'), join('.local', 'state'), '.cache', '.tmp']) {
        mkdirSync(join(folder, dir), { recursive: true, mode: 0o700 });
    }
    const up = relative(realpathSync(plansDir(env)), realpathSync(folder));
    const first = up.split(sep)[0];
    if (first !== 'opencode') unavailable();
    return folder;
}

/** The one launch descriptor for this account: private HOME + XDG roots and
 *  TMPDIR, an explicit minimal base (never ambient env), and every blocked
 *  OpenCode or provider-credential name carried out. */
export function opencodeLaunchEnv(env: NodeJS.ProcessEnv, record: PlanAccountRecord): { set: Record<string, string>; unset: string[] } {
    const root = openRoot(env, record.folder);
    const probe = agentProbePath((env.PATH ?? '').split(delimiter), env.HOME?.trim() || homedir());
    const binary = resolveAgentBinary('opencode', { path: probe }).path;
    const shellName = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const descriptor = launchEnv({
        base: {},
        set: {
            HOME: root,
            XDG_CONFIG_HOME: join(root, '.config'),
            XDG_DATA_HOME: join(root, '.local', 'share'),
            XDG_STATE_HOME: join(root, '.local', 'state'),
            XDG_CACHE_HOME: join(root, '.cache'),
            TMPDIR: join(root, '.tmp'),
            PATH: [...new Set([...(binary === undefined ? [] : [dirname(binary)]), ...probe])].join(delimiter),
        },
        unset: [...BLOCKED, ...Object.keys(env).filter((name) => shellName.test(name) && INHERITED.test(name))],
    });
    return { set: descriptor.env, unset: descriptor.unset };
}

/** The tool's own store inside this account's private root: entries in its
 *  auth.json mean a sign-in lives there. Only the count is read; key values
 *  never leave this function. */
export function opencodeSignedIn(record: PlanAccountRecord): boolean {
    try {
        const auth: unknown = JSON.parse(readFileSync(join(record.folder, '.local', 'share', 'opencode', 'auth.json'), 'utf8'));
        return typeof auth === 'object' && auth !== null && !Array.isArray(auth) && Object.keys(auth).length > 0;
    } catch {
        return false;
    }
}

/** A fresh account id with its own private root. */
export function addOpencodeAccount(env: NodeJS.ProcessEnv): PlanAccountRecord {
    mkdirSync(plansDir(env), { recursive: true, mode: 0o700 });
    const stored = loadPlanAccounts(env);
    let id = '';
    do { id = `oc_${randomBytes(8).toString('hex')}`; } while (stored.some((record) => record.id === id));
    const record: PlanAccountRecord = { id, provider: 'opencode', name: '', folder: join(plansDir(env), 'opencode', id), found: false };
    savePlanAccounts(env, [...stored, record]);
    return record;
}

/** Forget the account and delete the private root muxr created for it. */
export function removeOpencodeAccount(env: NodeJS.ProcessEnv, accountId: string): void {
    const record = loadPlanAccounts(env).find((entry) => entry.id === accountId);
    if (record === undefined) unavailable();
    if (!insidePlansDir(env, record.folder) || existsSync(record.folder) && lstatSync(record.folder).isSymbolicLink()) unavailable();
    savePlanAccounts(env, loadPlanAccounts(env).filter((entry) => entry.id !== accountId));
    rmSync(record.folder, { recursive: true, force: true });
}
