/**
 * Host-owned default rows and read-only roster access for pane/account bookkeeping.
 * BYOKit owns all managed-folder mutations and the terms record.
 *
 * A record holds only `{id, provider, name, folder}`: never a password, key
 * or token. The store never persists identity or signed-in state; their source
 * is the tool's own status command (BYOKit for managed accounts, `planIdentity.ts` for the default row). muxr never opens a
 * credential file to learn who an account is.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PlanProvider = 'claude' | 'codex' | 'opencode';
export const PLAN_PROVIDERS: PlanProvider[] = ['claude', 'codex', 'opencode'];
export const PLAN_LABELS: Record<PlanProvider, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

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

function storePath(env: NodeJS.ProcessEnv): string {
    return join(plansDir(env), 'accounts-v1.json');
}

function validRecord(value: unknown): PlanAccountRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id === '' || row.id.length > 128) return undefined;
    if (row.provider !== 'claude' && row.provider !== 'codex' && row.provider !== 'opencode') return undefined;
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

function writeAtomically(path: string, body: string): void {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, path);
}

export function savePlanAccounts(env: NodeJS.ProcessEnv, accounts: PlanAccountRecord[]): void {
    const path = storePath(env);
    mkdirSync(plansDir(env), { recursive: true, mode: 0o700 });
    writeAtomically(path, JSON.stringify({ version: 1, accounts } satisfies StoreFile));
}
