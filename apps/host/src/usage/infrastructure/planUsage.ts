/** App-owned source discovery; the kit never discovers a sign-in or executable. */
import { usage, type Usage, type Source, type Reading, type Code } from '@byokit/usage';
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { PlanId } from '../domain/activity.js';
import { piAgentDir } from './tokenLedger.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function readJson(path: string, maxBytes: number): { value: unknown; modified: number } | undefined {
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return undefined;
        return { value: JSON.parse(readFileSync(path, 'utf8')) as unknown, modified: stat.mtimeMs };
    } catch { return undefined; }
}

/** The Go account selection, from the same source the cache identity uses.
 *  A defined OPENCODE_AUTH_CONTENT pins the account (an unusable value pins
 *  to "none" rather than falling back to another account's disk config). */
function goAuthSelection(env: NodeJS.ProcessEnv): { source: 'override' | 'disk'; auth: { type?: unknown; key?: unknown } | null | undefined } {
    if (env.OPENCODE_AUTH_CONTENT !== undefined) {
        return { source: 'override', auth: goAuthOverride(env) };
    }
    const stored = readJson(join(env.XDG_DATA_HOME || join(env.HOME?.trim() || homedir(), '.local', 'share'), 'opencode', 'auth.json'), 64 * 1024)?.value;
    const auth = isRecord(stored) ? stored['opencode-go'] : undefined;
    return { source: 'disk', auth: isRecord(auth) ? { type: auth.type, key: auth.key } : undefined };
}

/** Same shape the private projection used to hand the plugin: an unusable or
 *  absent member reads as null so the disk account is never borrowed. */
function goAuthOverride(env: NodeJS.ProcessEnv): { type?: unknown; key?: unknown } | null {
    try {
        const parsed: unknown = JSON.parse(env.OPENCODE_AUTH_CONTENT ?? '');
        const member = isRecord(parsed) ? parsed['opencode-go'] : undefined;
        if (!isRecord(member) || member.type !== 'api') return null;
        const selected: Record<string, string> = Object.create(null);
        for (const field of ['type', 'key']) {
            const value = member[field];
            if (typeof value === 'string' && value.length <= 16 * 1024) selected[field] = value;
        }
        if (Object.keys(selected).length !== 2) return null;
        return { type: selected.type, key: selected.key };
    } catch { return null; }
}

/** The Z.ai credential Pi holds for its zai provider, from Pi's own auth store. */
function zaiToken(env: NodeJS.ProcessEnv): string | undefined {
    const stored = readJson(join(piAgentDir(env), 'auth.json'), 64 * 1024)?.value;
    const auth = isRecord(stored) && isRecord(stored.zai) ? stored.zai : undefined;
    const token = auth?.type === 'api_key' && typeof auth.key === 'string' ? auth.key.trim() : '';
    if (token === '' || token.length > 16 * 1024) return undefined;
    return token;
}

export function usageStateDir(env: NodeJS.ProcessEnv): string {
    const home = env.MUXR_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.muxr');
    return join(home, 'usage');
}

const PLAN_IDS: PlanId[] = ['claude', 'codex', 'opencode', 'zai'];

export interface StoredPlanReading { at: number; raw: unknown }
/** The last good reading of every plan, keyed per account fingerprint: two
 *  sign-ins of one provider keep separate readings, and one account's
 *  failure never costs the other its standing. */
export type PlanReadings = Partial<Record<PlanId, Record<string, StoredPlanReading>>>;

/** Retained for Claude only. Preserve the kit-owned provider entries when
 *  merging a Claude update into the shared file. The kit owns every other
 *  provider's last-good lookup and persistence. */
export function readPlans(env: NodeJS.ProcessEnv, migrateLegacy = false): PlanReadings {
    const saved = readJson(join(usageStateDir(env), 'plans-v1.json'), 256 * 1024)?.value;
    if (!isRecord(saved) || !isRecord(saved.plans)) return {};
    const plans: PlanReadings = {};
    let legacy = false;
    for (const id of PLAN_IDS) {
        const entry = saved.plans[id];
        if (!isRecord(entry)) continue;
        const byAccount: Record<string, StoredPlanReading> = {};
        if (typeof entry.account === 'string' && Number.isFinite(entry.at)) {
            legacy = true;
            byAccount[entry.account] = { at: entry.at as number, raw: entry.raw };
        }
        for (const [fingerprint, reading] of Object.entries(entry)) {
            if (fingerprint.length > 128 || !isRecord(reading) || !Number.isFinite(reading.at)) continue;
            byAccount[fingerprint] = { at: reading.at as number, raw: reading.raw };
        }
        if (Object.keys(byAccount).length > 0) plans[id] = byAccount;
    }
    if (migrateLegacy && legacy) savePlans(env, plans);
    return plans;
}

/** Merge this collection's new readings into the file: another collection
 *  running beside it may have landed a reading this one did not. */
export function savePlans(env: NodeJS.ProcessEnv, updates: PlanReadings): void {
    const path = join(usageStateDir(env), 'plans-v1.json');
    const temporary = `${path}.${process.pid}.tmp`;
    try {
        const plans = readPlans(env);
        for (const id of PLAN_IDS) {
            const next = updates[id];
            if (next === undefined) continue;
            const current = plans[id] ?? {};
            for (const [fingerprint, reading] of Object.entries(next)) {
                if (reading.at >= (current[fingerprint]?.at ?? -Infinity)) current[fingerprint] = reading;
            }
            plans[id] = current;
        }
        const body = JSON.stringify({ plans });
        if (Buffer.byteLength(body) > 256 * 1024) return;
        mkdirSync(usageStateDir(env), { recursive: true, mode: 0o700 });
        writeFileSync(temporary, body, { mode: 0o600 });
        renameSync(temporary, path);
    } catch { /* an unwritten reading only means the next failure has nothing to stand on */ }
}

const readers = new Map<string, Usage>();
export function planReader(env: NodeJS.ProcessEnv): Usage {
    const stateDir = resolve(usageStateDir(env));
    let reader = readers.get(stateDir);
    if (reader === undefined) {
        readPlans(env, true);
        reader = usage({ stateDir, salt: 'muxr/usage/account' });
        readers.set(stateDir, reader);
    }
    return reader;
}

export function sourcesFor(env: NodeJS.ProcessEnv): Partial<Record<Source['provider'], Source>> {
    const sources: Partial<Record<Source['provider'], Source>> = {};
    for (const directory of (env.PATH ?? '').split(delimiter)) {
        const bin = resolve(directory, 'codex');
        try {
            accessSync(bin, constants.X_OK);
            if (!statSync(bin).isFile()) continue;
            const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
            const home = env.CODEX_HOME || join(env.HOME?.trim() || homedir(), '.codex');
            sources.codex = { provider: 'codex', bin, home: isAbsolute(home) ? home : resolve(home), env: childEnv };
            break;
        } catch { /* not in this PATH entry */ }
    }
    const { auth } = goAuthSelection(env);
    if (auth?.type === 'api' && typeof auth.key === 'string' && auth.key.trim() !== '' && auth.key.length <= 16 * 1024) {
        sources.opencode = { provider: 'opencode', key: auth.key };
    }
    const zai = zaiToken(env);
    if (zai !== undefined) sources.zai = { provider: 'zai', key: zai };
    return sources;
}

export function planLabel(provider: 'opencode' | 'zai', code: Code | undefined): string {
    const labels: Record<typeof provider, Partial<Record<Code | 'good', string>>> = {
        opencode: {
            good: 'OpenCode Go plan usage',
            'not-connected': 'OpenCode Go limits unavailable · connect your Go account in OpenCode',
            auth: 'OpenCode Go authentication unavailable · reconnect in OpenCode',
            'no-plan': 'OpenCode Go subscription unavailable for this account',
            incomplete: 'OpenCode Go limits unavailable · incomplete response',
        },
        zai: {
            good: 'Z.ai plan usage',
            'not-connected': 'Z.ai limits unavailable · connect Z.ai in Pi',
            auth: 'Z.ai authentication unavailable · reconnect in Pi',
            'no-plan': 'Z.ai coding plan unavailable for this account',
            incomplete: 'Z.ai limits unavailable · incomplete response',
        },
    };
    return labels[provider][code ?? 'good'] ?? `${provider === 'opencode' ? 'OpenCode Go' : 'Z.ai'} limits unavailable · try again shortly`;
}

export function readPlan(reader: Usage, source: Source | undefined, nowMs: number): Promise<Reading | undefined> {
    return source === undefined ? Promise.resolve(undefined) : reader.read(source, { nowMs });
}
