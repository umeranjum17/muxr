/** Host-local credential access for the published kit's opaque Claude source. */
import { claudeWindows, fingerprint, retryAfterMs, type EphemeralClaudeSource, type Source, type SourceAnswer } from '@byokit/usage';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function readJson(path: string, maxBytes: number): { value: unknown; modified: number } | undefined {
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return undefined;
        return { value: JSON.parse(readFileSync(path, 'utf8')) as unknown, modified: stat.mtimeMs };
    } catch { return undefined; }
}

function claudeConfigDir(env: NodeJS.ProcessEnv): string {
    return env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.claude');
}

/** The Claude account Claude Code is signed in to, re-read on every call so
 *  Claude Code's own renewal is picked up the next time it runs. muxr never
 *  renews these credentials itself: an expired token only means Claude is not
 *  read until Claude Code renews it, while its last good reading stands. */
const opaqueAccount = fingerprint('muxr/usage/account');
function claudeAuth(env: NodeJS.ProcessEnv): { token: string; expired: boolean; account: string } | undefined {
    const stored = readJson(join(claudeConfigDir(env), '.credentials.json'), 64 * 1024)?.value;
    const credentials = isRecord(stored) && isRecord(stored.claudeAiOauth) ? stored.claudeAiOauth : undefined;
    const token = credentials?.accessToken;
    if (credentials === undefined || typeof token !== 'string' || token === '' || token.length > 16 * 1024) return undefined;
    // Claude Code keeps the signed-in account beside its config: in the config
    // directory when one is set, otherwise in the home directory.
    const configFile = env.CLAUDE_CONFIG_DIR?.trim()
        ? join(env.CLAUDE_CONFIG_DIR.trim(), '.claude.json')
        : join(env.HOME?.trim() || homedir(), '.claude.json');
    const config = readJson(configFile, 4 * 1024 * 1024)?.value;
    const oauthAccount = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : undefined;
    let account: string;
    if (typeof credentials.accountUuid === 'string') account = credentials.accountUuid;
    else if (typeof oauthAccount?.accountUuid === 'string') account = oauthAccount.accountUuid;
    // Preserve the existing credential-derived cache identity for legacy
    // token-only sign-ins, without forwarding the credential as identity.
    else account = opaqueAccount('claude', token);
    const expiresAt = credentials.expiresAt;
    return { token, expired: typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= Date.now(), account };
}

/** Anthropic answers its usage endpoint for Claude Code's own client and
 *  rate-limits any other caller on sight, so the read identifies itself the
 *  way Claude Code does. */
const CLAUDE_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.202' };

function readSnapshot(env: NodeJS.ProcessEnv, nowMs: number): SourceAnswer | undefined {
    const snapshot = readJson(join(claudeConfigDir(env), 'last-statusline-input.json'), 64 * 1024);
    const age = snapshot === undefined ? undefined : nowMs - snapshot.modified;
    if (snapshot !== undefined && age !== undefined && age >= 0 && age < 5 * 60_000 && claudeWindows(snapshot.value).length > 0) {
        return { raw: snapshot.value, at: snapshot.modified };
    }
    return undefined;
}

/** Credential access and provider I/O remain inside this authorized host seam. */
async function readClaude(env: NodeJS.ProcessEnv, nowMs: number, signal: AbortSignal, expectedAccount: string): Promise<SourceAnswer> {
    const auth = claudeAuth(env);
    if (auth?.account !== expectedAccount) return { code: 'not-connected' };
    const snapshot = readSnapshot(env, nowMs);
    if (snapshot !== undefined) return snapshot;
    if (auth.expired) return { code: 'expired' };
    try {
        const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: { accept: 'application/json', authorization: `Bearer ${auth.token}`, ...CLAUDE_HEADERS },
            redirect: 'error', signal,
        });
        if (response.status !== 200) {
            await response.body?.cancel();
            if (response.status === 429) {
                const delay = retryAfterMs(response.headers.get('retry-after'), nowMs);
                return { code: 'rate-limited', ...(delay === undefined ? {} : { retryAfterMs: delay }) };
            }
            return { code: response.status === 401 ? 'auth' : response.status === 403 ? 'no-plan' : 'unavailable' };
        }
        if (response.body === null) return { code: 'incomplete' };
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 64 * 1024) { await reader.cancel(); return { code: 'incomplete' }; }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        return { raw: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, at: nowMs };
    } catch { return { code: 'unavailable' }; }
}

/** Only identity and an opaque callback cross into the kit; muxr owns sign-in. */
export function claudeSource(env: NodeJS.ProcessEnv): Extract<Source, { accountUuid: string; read: unknown }> | undefined {
    const account = claudeAuth(env)?.account;
    if (!account || account.length > 16 * 1024 || /[\0\r\n]/.test(account)) return undefined;
    return {
        provider: 'claude', accountUuid: account, origin: 'https://api.anthropic.com',
        connected: () => claudeAuth(env)?.account === account,
        read: ({ nowMs, signal }) => readClaude(env, nowMs, signal, account),
    };
}

const hintSources = new Map<string, EphemeralClaudeSource>();
export function claudeHintSource(env: NodeJS.ProcessEnv): EphemeralClaudeSource {
    const key = JSON.stringify([claudeConfigDir(env), env.HOME ?? '']);
    let source = hintSources.get(key);
    if (source === undefined) {
        source = { provider: 'claude', ephemeral: true, read: async ({ nowMs }) => readSnapshot(env, nowMs) ?? { code: 'not-connected' } };
        hintSources.set(key, source);
    }
    return source;
}
