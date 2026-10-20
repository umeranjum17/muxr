/**
 * OpenCode accounts run on the BYOKit accounts kit's Go plan-key route
 * (`@byokit/accounts/opencode-go`): the kit owns the account folder, the saved
 * key and its delivery to OpenCode. What stays here is muxr's own: the secrets
 * store the kit saves keys into, the `--standalone` flag a 2.x OpenCode needs,
 * and the config content every OpenCode pane starts with.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileStore, type Keystore } from '@byokit/secrets';
import { agentProbePath, resolveAgentBinary } from '@byokit/herdr';
import { plansDir } from './planStore.js';

/** Cached major version per resolved binary path plus file identity, so an
 *  in-place upgrade re-probes. Only successful probes are stored: a timeout,
 *  parse miss, or failed spawn must not pin "unknown" for the host lifetime
 *  (that would omit `--standalone` on every later 2.x launch). */
const opencodeMajorByBinary = new Map<string, number>();

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
    const binary = opencodeBinary(env);
    if (binary === undefined) return [];
    const major = opencodeMajor(binary);
    return major !== undefined && major >= 2 ? ['--standalone'] : [];
}

/** The OpenCode binary the kit launches and signs accounts in for, if one is installed. */
export function opencodeBinary(env: NodeJS.ProcessEnv): string | undefined {
    const probe = agentProbePath((env.PATH ?? '').split(delimiter), env.HOME?.trim() || homedir());
    const path = resolveAgentBinary('opencode', { path: probe }).path;
    return path === undefined ? undefined : resolve(path);
}

/**
 * The secrets store the kit saves OpenCode plan keys into: one sealed file in
 * the plans dir. Its passphrase is a random secret kept beside it, 0600, so a
 * key is as private as the delivery copy the kit writes for OpenCode itself.
 */
export function opencodeKeyStore(env: NodeJS.ProcessEnv): Keystore {
    const dir = plansDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const seal = join(dir, 'secrets.seal');
    try { writeFileSync(seal, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return fileStore({ path: join(dir, 'secrets.json'), passphrase: readFileSync(seal) });
}

/**
 * OpenCode Go agents start on Muse Spark 1.3 Contributor: without a model
 * OpenCode falls back to its own default (gpt-5.6-luna), which costs the first
 * reply a manual model switch.
 */
const OPENCODE_GO_DEFAULT_MODEL = 'opencode-go/muse-spark-1.3-contributor';

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
 * The config content an OpenCode pane starts with, as OPENCODE_CONFIG_CONTENT:
 * muxr never writes the user's own config, and the account folder's
 * opencode.json belongs to the kit, which rewrites it at every launch. It
 * pre-allows muxr's prompt-attachment folder, so an attachment path carried in
 * a prompt never trips the "Access external directory" prompt (OpenCode's
 * folder grant has no read/write split, and its edit globs match project-
 * relative paths only, so writes into the folder ride the same grant). With
 * `goModel` set — an account signed in to OpenCode Go — it also opens on the
 * Go default model, unless a config names one.
 *
 * OpenCode deep-merges that content last, and a plain string rule there would
 * be replaced by our rule map, so the user's own rules for that tool are read —
 * config files only, never auth — and carried in as `"*"`. Nothing is injected
 * (the prompt stays, never a guess) when the launch already sets
 * OPENCODE_CONFIG_CONTENT, a config cannot be read or parsed (JSONC comments),
 * or `permission` is one value for every tool.
 */
export function opencodeConfigEnv(env: NodeJS.ProcessEnv, dir: string, cwd: string, goModel = false): Record<string, string> {
    if (env.OPENCODE_CONFIG_CONTENT !== undefined || dir === '') return {};
    const permission: Record<string, unknown> = {};
    let modelNamed = false;
    for (const file of opencodeConfigFiles(env, cwd)) {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            return {};
        }
        if (!isRecord(parsed)) return {};
        if ('model' in parsed) modelNamed = true;
        if (parsed.permission === undefined) continue;
        if (!isRecord(parsed.permission)) return {};
        // OpenCode's merge: a later rule map joins an earlier one, anything else replaces it.
        for (const [key, value] of Object.entries(parsed.permission)) {
            const before = permission[key];
            permission[key] = isRecord(before) && isRecord(value) ? { ...before, ...value } : value;
        }
    }
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...(goModel && !modelNamed ? { model: OPENCODE_GO_DEFAULT_MODEL } : {}),
        permission: attachmentRules(permission, dir),
    }) };
}
