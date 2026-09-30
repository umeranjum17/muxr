/**
 * Plan Account identity from the official tools' own status commands.
 *
 * Claude: `claude auth status` (JSON by default) with `CLAUDE_CONFIG_DIR`
 * pointed at the sign-in folder. Codex: app-server `account/read` with
 * `CODEX_HOME` pointed at the folder. muxr never opens `.credentials.json`
 * or `auth.json`: with those files unreadable the tools report signed out
 * and the list still works. Unavailable or unrecognised answers carry
 * `statusKnown: false`; `signedIn: false` alone is a confirmed sign-out.
 * Only identity (email, plan, signed-in) and that status marker leave these
 * functions; nothing secret is printed, stored or sent.
 */
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';

export interface PlanIdentity {
    signedIn: boolean;
    /** A failed or unrecognised status answer cannot establish sign-in state. */
    statusKnown?: false;
    email?: string;
    plan?: string;
}

export type PlanCommandRunner = (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string } | undefined>;

const RUN_TIMEOUT_MS = 15_000;

/** One bounded status call. Failures read as "no answer", never throw. */
export function runPlanCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
): Promise<{ stdout: string } | undefined> {
    return new Promise((resolve) => {
        execFile(command, args, { env, timeout: RUN_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
            if (error !== null && (error as { killed?: boolean }).killed !== true) {
                // A logged-out `auth status` may still print its JSON on the way out.
                if (stdout.trim() === '') { resolve(undefined); return; }
            }
            resolve({ stdout: stdout.slice(0, 64 * 1024) });
        });
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First short string under a key matching `match`, down a few levels. The
 *  tools' exact status shapes drift; the email and plan hide under obvious names. */
function findString(value: unknown, match: RegExp, depth = 0, skip?: RegExp): string | undefined {
    if (depth > 4) return undefined;
    if (typeof value === 'string') return undefined;
    if (Array.isArray(value)) {
        if (value.length > 32) return undefined;
        for (const entry of value) {
            const found = findString(entry, match, depth + 1, skip);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (!isRecord(value)) return undefined;
    const keys = Object.keys(value);
    if (keys.length > 64) return undefined;
    for (const key of keys) {
        if (skip?.test(key)) continue;
        const entry = value[key];
        if (match.test(key) && typeof entry === 'string' && entry !== '' && entry.length <= 320) return entry;
    }
    for (const key of keys) {
        const found = findString(value[key], match, depth + 1, skip);
        if (found !== undefined) return found;
    }
    return undefined;
}

function parsedJson(stdout: string): unknown {
    try {
        return JSON.parse(stdout) as unknown;
    } catch {
        return undefined;
    }
}

export async function claudeIdentity(
    folder: string,
    env: NodeJS.ProcessEnv,
    run: PlanCommandRunner = runPlanCommand,
): Promise<PlanIdentity> {
    const answer = await run('claude', ['auth', 'status'], { ...env, CLAUDE_CONFIG_DIR: folder });
    if (answer === undefined) return { signedIn: false, statusKnown: false };
    const status = parsedJson(answer.stdout);
    if (!isRecord(status)) return { signedIn: false, statusKnown: false };
    const loggedIn = status.loggedIn;
    if (loggedIn === false) return { signedIn: false };
    if (loggedIn !== true) return { signedIn: false, statusKnown: false };
    const identity: PlanIdentity = { signedIn: true };
    const email = findString(status, /email/i);
    if (email !== undefined) identity.email = email;
    const plan = findString(status, /^(plan|subscription|tier|subscriptionType|planName)$/i)
        ?? findString(status, /plan|subscription/i, 0, /id|status|at$/i);
    if (plan !== undefined) identity.plan = plan;
    return identity;
}

interface CodexAppServerResult {
    account?: unknown;
}

/** One app-server round: initialize, then a single method. Codex's limits use
 *  the same connection with `account/rateLimits/read` (see collectUsage). */
async function codexAppServer(
    folder: string,
    env: NodeJS.ProcessEnv,
    method: string,
): Promise<unknown> {
    return new Promise((resolve) => {
        const child = spawn('codex', ['app-server'], {
            env: { ...env, CODEX_HOME: folder },
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        let buffer = '';
        let settled = false;
        const finish = (value: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1_000).unref();
            }
            resolve(value);
        };
        const timer = setTimeout(() => finish(undefined), RUN_TIMEOUT_MS);
        child.once('error', () => finish(undefined));
        child.once('close', () => finish(undefined));
        child.stdin.on('error', () => finish(undefined));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 64 * 1024) { finish(undefined); return; }
            for (;;) {
                const newline = buffer.indexOf('\n');
                if (newline < 0) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                    const message = JSON.parse(line) as { id?: number; result?: unknown };
                    if (message.id === 1) {
                        child.stdin.write(`${JSON.stringify({ id: 2, method, params: {} })}\n`);
                    } else if (message.id === 2) {
                        finish(message.result);
                    }
                } catch { /* a non-JSON line is not an answer */ }
            }
        });
        child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'muxr', version: '1' } } })}\n`);
    });
}

export async function codexIdentity(
    folder: string,
    env: NodeJS.ProcessEnv,
    read: (folder: string, env: NodeJS.ProcessEnv) => Promise<unknown> = (dir, e) => codexAppServer(dir, e, 'account/read'),
): Promise<PlanIdentity> {
    const result = await read(folder, env) as CodexAppServerResult | undefined;
    const account = isRecord(result) && isRecord(result.account) ? result.account : undefined;
    if (isRecord(result) && result.account === null) return { signedIn: false };
    if (account === undefined) return { signedIn: false, statusKnown: false };
    const identity: PlanIdentity = { signedIn: true };
    const email = findString(account, /email/i);
    if (email !== undefined) identity.email = email;
    const plan = findString(account, /plan|subscription|tier/i, 0, /id|status|at$/i);
    if (plan !== undefined) identity.plan = plan;
    return identity;
}
