/** App-owned source discovery; the kit never discovers a sign-in or executable. */
import { usage, type Usage, type Source, type Reading, type Code } from '@byokit/usage';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
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

/** A connected Go account, from the same selection the cache identity uses. */
function goConnected(env: NodeJS.ProcessEnv): boolean {
    const { auth } = goAuthSelection(env);
    return auth?.type === 'api' && typeof auth.key === 'string' && auth.key.trim() !== '' && auth.key.length <= 16 * 1024;
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

const readers = new Map<string, Usage>();
export function planReader(env: NodeJS.ProcessEnv): Usage {
    const stateDir = resolve(usageStateDir(env));
    let reader = readers.get(stateDir);
    if (reader === undefined) {
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
    if (goConnected(env)) sources.opencode = { provider: 'opencode', key: goAuthSelection(env).auth!.key as string };
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
