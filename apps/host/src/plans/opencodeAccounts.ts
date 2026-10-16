/**
 * OpenCode accounts: muxr-owned private HOME+XDG roots, one per account id.
 *
 * OpenCode keeps its sign-in in the XDG data root (`OPENCODE_CONFIG_DIR` only
 * selects settings), so an account here is a whole private root, and the same
 * launch descriptor opens its sign-in tab and starts its agents. No kit: no
 * folderVar, no move, no readiness probe, billing unknown.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { INHERITED, launchEnv } from '@byokit/accounts/isolate';
import { agentProbePath, resolveAgentBinary } from '@byokit/herdr';
import { loadPlanAccounts, plansDir, savePlanAccounts, type PlanAccountRecord } from './planStore.js';

/** Source-backed OpenCode redirects: none may reach a launch, inherited or set. */
const BLOCKED = ['OPENCODE_AUTH', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_TEST_HOME', 'OPENCODE_DB'];

/** Cached major version per resolved binary path plus file identity, so an
 *  in-place upgrade re-probes. Only successful probes are stored: a timeout,
 *  parse miss, or failed spawn must not pin "unknown" for the host lifetime
 *  (that would omit `--standalone` on every later 2.x launch). */
const opencodeMajorByBinary = new Map<string, number>();

function unavailable(): never {
    throw Object.assign(new Error("That account's private folder is missing or unsafe. Remove the account and add it again."), { code: 'plan-account-unavailable' });
}

/** Major from `opencode --version` (1.x and 2.x both print it). Unknown → undefined. */
function opencodeMajor(binary: string): number | undefined {
    const stat = existsSync(binary) ? statSync(binary) : undefined;
    const key = stat === undefined ? binary : `${binary}:${stat.mtimeMs}:${stat.size}`;
    const cached = opencodeMajorByBinary.get(key);
    if (cached !== undefined) return cached;
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const match = /\b(\d+)\.\d+\.\d+\b/.exec(text) ?? /\bv?(\d+)\.\d+\b/.exec(text);
    const major = match === null ? undefined : Number(match[1]);
    if (major === undefined || !Number.isFinite(major)) return undefined;
    opencodeMajorByBinary.set(key, major);
    return major;
}

/**
 * OpenCode 2.x starts one shared background server on a fixed port; a second
 * account hangs waiting for it. `--standalone` gives each process a private
 * server. 1.x rejects that flag, so only 2.x launches carry it.
 */
export function opencodeLaunchArgs(env: NodeJS.ProcessEnv = process.env): string[] {
    const probe = agentProbePath((env.PATH ?? '').split(delimiter), env.HOME?.trim() || homedir());
    const binary = resolveAgentBinary('opencode', { path: probe }).path;
    if (binary === undefined) return [];
    const major = opencodeMajor(binary);
    return major !== undefined && major >= 2 ? ['--standalone'] : [];
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

/** Whether an account's launch env points at an OpenCode store with a Go
 *  credential. Same store and key the usage reader uses. */
export function opencodeGoSignedIn(env: Record<string, string | undefined>): boolean {
    if (env.XDG_DATA_HOME === undefined) return false;
    try {
        const auth: unknown = JSON.parse(readFileSync(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'));
        return typeof auth === 'object' && auth !== null && 'opencode-go' in auth;
    } catch {
        return false;
    }
}

const OPENCODE_GO_DEFAULT_MODEL = 'opencode-go/muse-spark-1.3-contributor';

/**
 * OpenCode Go agents start on Muse Spark 1.3 Contributor: without a model
 * OpenCode falls back to its own default (gpt-5.6-luna), which costs the first
 * reply a manual model switch. It goes in the account's own OpenCode config,
 * which 1.x and 2.x both read (2.x has no `--model`), and only when no config
 * there names a model, so a model the user set stands. Written at launch, so
 * an account signed in before this existed gets it too.
 */
export function defaultOpencodeGoModel(env: Record<string, string | undefined>): void {
    if (env.XDG_CONFIG_HOME === undefined || !opencodeGoSignedIn(env)) return;
    const dir = join(env.XDG_CONFIG_HOME, 'opencode');
    let target = join(dir, 'opencode.json');
    let config: Record<string, unknown> = {};
    // OpenCode's global config files, merged in this order; it seeds opencode.jsonc itself.
    for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            // ponytail: a file with JSONC comments is left alone (OpenCode's default then), parse JSONC if users hit it.
            return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || 'model' in parsed) return;
        target = join(dir, name);
        config = parsed as Record<string, unknown>;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Temp file then rename: a failed write leaves the user's config intact, not truncated.
    const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        writeFileSync(temp, `${JSON.stringify({ ...config, model: OPENCODE_GO_DEFAULT_MODEL }, null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, target);
    } catch (error) { rmSync(temp, { force: true }); throw error; }
}

/** A permission entry as its rule map: a plain string is the catch-all rule. */
function permissionRules(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') return { '*': value };
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

/** Object order is rule order (last match wins): the permission's own rules
 *  stand, ours comes last, so the one folder reads without a prompt. */
function attachmentRules(permission: Record<string, unknown>, dir: string): Record<string, Record<string, unknown>> {
    return {
        external_directory: { ...permissionRules(permission.external_directory), [`${dir}/**`]: 'allow' },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The config files OpenCode merges before OPENCODE_CONFIG_CONTENT, in its
 *  order: global, then OPENCODE_CONFIG, then project files from the worktree
 *  root down to `cwd`. */
function opencodeConfigFiles(env: NodeJS.ProcessEnv, cwd: string): string[] {
    const global = join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config'), 'opencode');
    const project: string[] = [];
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
        project.unshift(...['opencode.json', 'opencode.jsonc', join('.opencode', 'opencode.json'), join('.opencode', 'opencode.jsonc')].map((name) => join(dir, name)));
        if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
    }
    return [
        ...['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => join(global, name)),
        ...(env.OPENCODE_CONFIG?.trim() ? [env.OPENCODE_CONFIG.trim()] : []),
        ...project,
    ];
}

/**
 * The same attachment pre-allow for an OpenCode started without a muxr
 * account, as OPENCODE_CONFIG_CONTENT for its pane: muxr never writes the
 * user's own config. OpenCode deep-merges that content last, and a plain
 * string rule there would be replaced by our rule map, so the user's own
 * rules for that tool are read — config files only, never auth — and carried
 * in as `"*"`. Nothing is injected (the prompt stays, never a guess) when the
 * host already sets OPENCODE_CONFIG_CONTENT, a config cannot be read or parsed
 * (JSONC comments), or `permission` is one value for every tool.
 */
export function opencodeAttachmentEnv(env: NodeJS.ProcessEnv, dir: string, cwd: string): Record<string, string> {
    if (env.OPENCODE_CONFIG_CONTENT !== undefined || dir === '') return {};
    const permission: Record<string, unknown> = {};
    for (const file of opencodeConfigFiles(env, cwd)) {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            return {};
        }
        if (!isRecord(parsed)) return {};
        if (parsed.permission === undefined) continue;
        if (!isRecord(parsed.permission)) return {};
        // OpenCode's merge: a later rule map joins an earlier one, anything else replaces it.
        for (const [key, value] of Object.entries(parsed.permission)) {
            const before = permission[key];
            permission[key] = isRecord(before) && isRecord(value) ? { ...before, ...value } : value;
        }
    }
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: attachmentRules(permission, dir) }) };
}

/**
 * Pre-allows muxr's own prompt-attachment folder in the account's OpenCode
 * config, so an attachment path carried in a prompt never trips the "Access
 * external directory" prompt. The grant is exactly that one folder: OpenCode's
 * folder grant has no read/write split, and its edit globs match project-
 * relative paths only — a deny rule for this external folder never matches —
 * so writes into the folder ride the same grant. Muxr owns the account root,
 * so the
 * config there is ours to keep current; written at launch, so an account
 * from before this existed gets it too. Runs only when the launch carries a
 * muxr-owned XDG root (a plan account); an ambient launch keeps the user's
 * own config untouched. A config OpenCode would merge but we cannot parse
 * (JSONC comments) is left alone — the prompt is the old behavior, not a
 * broken launch.
 */
export function allowOpencodeAttachments(env: Record<string, string | undefined>, dir: string): void {
    if (env.XDG_CONFIG_HOME === undefined || dir === '') return;
    const configDir = join(env.XDG_CONFIG_HOME, 'opencode');
    let target = join(configDir, 'opencode.json');
    let config: Record<string, unknown> = {};
    // Same global files OpenCode merges, last one wins; ours must land there.
    for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(join(configDir, name), 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        target = join(configDir, name);
        config = parsed as Record<string, unknown>;
    }
    const permission = permissionRules(config.permission);
    config.permission = { ...permission, ...attachmentRules(permission, dir) };
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Temp file then rename: a failed write leaves the config intact, not truncated.
    const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, target);
    } catch (error) { rmSync(temp, { force: true }); throw error; }
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

/** Delete the private root muxr created for the account, then forget it. A root
 *  outside the plans dir or a symlink is never deleted, only forgotten; returns
 *  whether the root was deleted. A failed delete keeps the record for a retry. */
export function removeOpencodeAccount(env: NodeJS.ProcessEnv, accountId: string): boolean {
    const record = loadPlanAccounts(env).find((entry) => entry.id === accountId);
    if (record === undefined) unavailable();
    const owned = insidePlansDir(env, record.folder) && !(existsSync(record.folder) && lstatSync(record.folder).isSymbolicLink());
    if (owned) rmSync(record.folder, { recursive: true, force: true });
    savePlanAccounts(env, loadPlanAccounts(env).filter((entry) => entry.id !== accountId));
    return owned;
}
