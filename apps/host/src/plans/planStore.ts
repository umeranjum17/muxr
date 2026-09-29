/**
 * Plan Account store: which provider sign-ins muxr knows, and where they live.
 *
 * A record holds only `{id, provider, name, folder}`: never a password, key
 * or token. Identity and signed-in state always come fresh from the tool's
 * own status command (see `planIdentity.ts`); muxr never opens a credential
 * file to learn who an account is.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type PlanProvider = 'claude' | 'codex';
export const PLAN_PROVIDERS: PlanProvider[] = ['claude', 'codex'];
export const PLAN_LABELS: Record<PlanProvider, string> = { claude: 'Claude', codex: 'Codex' };

export interface PlanAccountRecord {
    /** Opaque handle; `found-<provider>` for the found sign-in, random otherwise. */
    id: string;
    provider: PlanProvider;
    /** The person's own name; empty until they give one. */
    name: string;
    /** The sign-in folder: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at launch. */
    folder: string;
    /** False when muxr created the folder; a found sign-in is only ever forgotten, never deleted. */
    found: boolean;
}

interface StoreFile {
    version: 1;
    accounts: PlanAccountRecord[];
}

export function muxrHome(env: NodeJS.ProcessEnv): string {
    return env.MUXR_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.muxr');
}

export function plansDir(env: NodeJS.ProcessEnv): string {
    return join(muxrHome(env), 'plans');
}

/** Where the provider's own tool signs in when muxr points it nowhere else. */
export function defaultPlanFolder(provider: PlanProvider, env: NodeJS.ProcessEnv): string {
    const home = env.HOME?.trim() || homedir();
    if (provider === 'claude') return env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
    return env.CODEX_HOME?.trim() || join(home, '.codex');
}

/** The launch env that runs an agent on this sign-in: one folder, nothing copied. */
export function planLaunchEnv(record: PlanAccountRecord): Record<string, string> {
    if (record.provider === 'claude') return { CLAUDE_CONFIG_DIR: record.folder };
    return { CODEX_HOME: record.folder };
}

function storePath(env: NodeJS.ProcessEnv): string {
    return join(plansDir(env), 'accounts-v1.json');
}

function validRecord(value: unknown): PlanAccountRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id === '' || row.id.length > 128) return undefined;
    if (row.provider !== 'claude' && row.provider !== 'codex') return undefined;
    if (typeof row.name !== 'string' || row.name.length > 64) return undefined;
    if (typeof row.folder !== 'string' || row.folder === '' || row.folder.length > 8_192) return undefined;
    if (typeof row.found !== 'boolean') return undefined;
    return { id: row.id, provider: row.provider, name: row.name, folder: row.folder, found: row.found };
}

export function loadPlanAccounts(env: NodeJS.ProcessEnv): PlanAccountRecord[] {
    try {
        const parsed: unknown = JSON.parse(readFileSync(storePath(env), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
        const file = parsed as { accounts?: unknown };
        if (!Array.isArray(file.accounts)) return [];
        const seen = new Set<string>();
        const out: PlanAccountRecord[] = [];
        for (const candidate of file.accounts) {
            const record = validRecord(candidate);
            if (record === undefined || seen.has(record.id)) continue;
            seen.add(record.id);
            out.push(record);
        }
        return out;
    } catch {
        return [];
    }
}

export function savePlanAccounts(env: NodeJS.ProcessEnv, accounts: PlanAccountRecord[]): void {
    const path = storePath(env);
    mkdirSync(plansDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ version: 1, accounts } satisfies StoreFile), { mode: 0o600 });
}

export function newPlanAccountId(): string {
    return `pa_${randomBytes(9).toString('hex')}`;
}

function autoTermsPath(env: NodeJS.ProcessEnv): string {
    return join(plansDir(env), 'auto-terms-v1.json');
}

export function autoTermsAcknowledged(env: NodeJS.ProcessEnv): boolean {
    try {
        const parsed: unknown = JSON.parse(readFileSync(autoTermsPath(env), 'utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            && (parsed as { acknowledged?: unknown }).acknowledged === true;
    } catch {
        return false;
    }
}

export function acknowledgeAutoTerms(env: NodeJS.ProcessEnv): void {
    const path = autoTermsPath(env);
    mkdirSync(plansDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ acknowledged: true }), { mode: 0o600 });
}

/** Folders muxr itself created live under its own plans dir; only those may ever be deleted. */
export function isMuxrPlanFolder(folder: string, env: NodeJS.ProcessEnv): boolean {
    const root = resolve(plansDir(env));
    const candidate = resolve(folder);
    return candidate === root || candidate.startsWith(`${root}/`);
}

/** Delete a muxr-created sign-in folder. Found folders are never passed here. */
export function deletePlanFolder(folder: string): void {
    rmSync(folder, { recursive: true, force: true });
}
