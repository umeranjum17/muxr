/** App-owned source discovery; the kit never discovers a sign-in or executable. */
import { usage, fingerprint, claudeWindows, fileUsageStore, memoryBackoffPolicy, type Usage, type Source, type Reading, type Code } from '@byokit/usage';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { PlanId } from '../domain/activity.js';
import { claudeSource } from './claudeSource.js';
import { piAgentDir } from './tokenLedger.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The kit refuses a whole source over one control character or oversized value. */
const sourceText = (value: string): boolean => value.length <= 16 * 1024 && !/[\0\r\n]/.test(value);
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
    if (token === '' || !sourceText(token)) return undefined;
    return token;
}

export function usageStateDir(env: NodeJS.ProcessEnv): string {
    const home = env.MUXR_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.muxr');
    return join(home, 'usage');
}

/** One-way adoption of prior host readings; ongoing storage belongs to the kit. */
function migratePlans(stateDir: string, env: NodeJS.ProcessEnv): void {
    const saved = readJson(join(stateDir, 'plans-v1.json'), 256 * 1024)?.value;
    if (!isRecord(saved) || !isRecord(saved.plans)) return;
    const entry = saved.plans.claude;
    if (!isRecord(entry)) return;
    const store = fileUsageStore(stateDir);
    const selected = claudeSource(env);
    const fp = fingerprint('muxr/usage/account');
    const entries = typeof entry.account === 'string' ? [[entry.account, entry]] : Object.entries(entry);
    for (const [account, value] of entries) {
        if (typeof account !== 'string' || !/^[a-f0-9]{64}$/.test(account) || !isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) continue;
        const windows = claudeWindows(value.raw);
        if (windows.length === 0) continue;
        // Never overwrite a kit reading, including its failed-poll metadata.
        if (store.get('claude', account) === undefined) store.put('claude', account, { at: value.at, windows });
        // Older token-only sign-ins used the credential fingerprint as their
        // key. Only that existing digest now crosses the opaque seam, and
        // the kit fingerprints it again; migrate the standing reading too.
        if (selected?.accountUuid === account) {
            const opaque = fp('claude', account);
            if (store.get('claude', opaque) === undefined) store.put('claude', opaque, { at: value.at, windows });
        }
    }
}

const readers = new Map<string, { standing: Usage; backoff: ReturnType<typeof memoryBackoffPolicy> }>();
function readersFor(env: NodeJS.ProcessEnv): { standing: Usage; backoff: ReturnType<typeof memoryBackoffPolicy> } {
    const stateDir = resolve(usageStateDir(env));
    let readersForState = readers.get(stateDir);
    if (readersForState === undefined) {
        migratePlans(stateDir, env);
        // The published policy shares account rests across standing/hint
        // readers. Keep the kit's outcome-specific default delay selection.
        const { delayMs: _delayMs, ...backoff } = memoryBackoffPolicy();
        readersForState = {
            standing: usage({ stateDir, salt: 'muxr/usage/account', backoff }),
            backoff,
        };
        readers.set(stateDir, readersForState);
    }
    return readersForState;
}
export function planReader(env: NodeJS.ProcessEnv): Usage {
    return readersFor(env).standing;
}

export function sourcesFor(env: NodeJS.ProcessEnv): Partial<Record<PlanId, Source>> {
    const sources: Partial<Record<PlanId, Source>> = {};
    const claude = claudeSource(env);
    if (claude !== undefined) sources.claude = claude;
    for (const directory of (env.PATH ?? '').split(delimiter)) {
        const bin = resolve(directory, 'codex');
        try {
            accessSync(bin, constants.X_OK);
            if (!statSync(bin).isFile()) continue;
            const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined
                && entry[0] !== '' && !entry[0].includes('=') && sourceText(entry[0]) && sourceText(entry[1])));
            const home = env.CODEX_HOME || join(env.HOME?.trim() || homedir(), '.codex');
            sources.codex = { provider: 'codex', bin, home: isAbsolute(home) ? home : resolve(home), env: childEnv };
            break;
        } catch { /* not in this PATH entry */ }
    }
    const { auth } = goAuthSelection(env);
    if (auth?.type === 'api' && typeof auth.key === 'string' && auth.key.trim() !== '' && sourceText(auth.key)) {
        // An API key is its own account: the kit keeps only its fingerprint, so a
        // reading persists and stays with the key it was read with.
        sources.opencode = { provider: 'opencode', key: auth.key, accountId: auth.key };
    }
    const zai = zaiToken(env);
    if (zai !== undefined) sources.zai = { provider: 'zai', key: zai, accountId: zai };
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

/** Account-selection hints never read/write the standing account cache. */
export async function readPlan(reader: Usage, source: Source | undefined, nowMs: number, { refresh = false, env }: { refresh?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Reading | undefined> {
    if (source === undefined) return undefined;
    if (!refresh) return reader.read(source, { nowMs });
    let stateDir: string;
    try { stateDir = mkdtempSync(join(tmpdir(), 'muxr-usage-refresh-')); }
    catch { return undefined; }
    try {
        return await usage({ stateDir, salt: 'muxr/usage/account', ...(env === undefined ? {} : { backoff: readersFor(env).backoff }) }).read(source, { nowMs });
    } finally {
        try { rmSync(stateDir, { recursive: true, force: true }); }
        catch { /* cleanup must not discard a successful quota hint */ }
    }
}
