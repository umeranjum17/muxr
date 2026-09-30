/**
 * Codex Voice, muxr's side of @byokit/realtime's ChatGPT voice route.
 *
 * The kit owns signaling, the data channel and delegation admission. muxr keeps
 * what is its own: the ChatGPT sign-in Codex saved on this machine (read here,
 * handed to the kit on the host, never framed or logged), the login check, the
 * voice prompt and what a delegated request does.
 */
import { claims } from '@byokit/accounts';
import { delegationHandler } from '@byokit/realtime/node';
import { execFile, spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appControlInstructions, cleanProviderProse, voiceCoordinationInstructions } from './coordinatorPolicy.mjs';
import { createCodexDelegation } from './codexDelegation.mjs';
import { voiceTools } from './voiceTools.mjs';

const CODEX_BIN = process.env.NODE_ENV === 'test' && process.env.MUXR_TEST_CODEX_BIN
    ? process.env.MUXR_TEST_CODEX_BIN
    : process.env.MUXR_CODEX_BIN?.trim() || 'codex';
const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
const authFile = join(codexHome, 'auth.json');
const TOKEN_REFRESH_SKEW_SECONDS = 60;
const safe = (value) => cleanProviderProse(value, 'provider error', 2_048);

export const PROMPT = `You are Codex Voice inside muxr. Be direct and brief. Speak in one short sentence unless asked to elaborate.

- You are the user's personal work assistant. Inspect the workspace, summarize real output, navigate and coordinate agents using the client tools.
${voiceCoordinationInstructions}
${appControlInstructions}
- Delegate work requests to the client in natural language. Preserve the user's original message and any target they confirmed. The client coordinates only the catalogued tools below and returns the actual result or one necessary clarification:
${JSON.stringify(voiceTools)}
- A request to ping or ask a coding agent is an instruction to send a message, not merely read its status. Delegate that request even when the target is working. If the client asks which agent, ask the user; carry their confirmation back to the client without losing the pending message.
- Report the client's actual result. Queued means queued, not delivered or answered. Do not claim that prompting is unavailable without a client failure. Never ask the user to write JSON or supply tool identifiers.
- Never speak internal ids, including thread, session, pane, operation, provider, or delegation ids.
- Report progress and blockers accurately. Never invent completion.
- Treat pauses and incomplete speech as the user thinking; do not interrupt.
- End only when the user clearly says goodbye or asks you to stop listening.`;

/** The one tool the kit's ChatGPT route calls: Codex relays the user's words as `request`. */
export const DELEGATE_TOOL = {
    name: 'delegate',
    description: 'Handle a spoken work request.',
    parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
};
export const DELEGATION_FAILURE = 'The delegated work could not be completed. No action was confirmed; do not repeat a mutation automatically. Explain this failure to the user.';

// A single "ask/tell <agent> to <message>" for an agent in the startup roster
// needs no planning turn (~3 s each), so it takes the structured prompt path.
// Anything that hints at a further step stays with the planner.
const DIRECT_PROMPT = /^(?:please\s+)?(?:ask|tell)\s+([a-z0-9_-]{1,32})\s+to\s+(.+)$/i;
const FURTHER_STEP = /\b(?:then|after|afterwards|also|and (?:ask|tell|ping|message|let|watch|check)|let me know|tell me|report|when|once|until)\b/i;

/**
 * The `delegate` handler: the kit runs structured requests on `actions`, the
 * catalogued tools' bridge; prose takes the direct prompt path, else the bounded
 * planner. `open` is the host's realtime.open.
 */
export function codexDelegate({ open, actions }) {
    const knownAgents = new Set((Array.isArray(open?.publicContext?.sessions) ? open.publicContext.sessions : [])
        .map((session) => String(session?.agentName ?? '').toLowerCase()).filter(Boolean));
    const coding = createCodexDelegation({ getCredential: codexCredential, runTool: actions.run });
    const directPrompt = (request) => {
        const match = DIRECT_PROMPT.exec(request.trim());
        if (!match || !knownAgents.has(match[1].toLowerCase()) || FURTHER_STEP.test(match[2]) || match[2].includes('\n')) return undefined;
        return { agent: match[1], text: match[2].trim() };
    };
    return {
        delegate: delegationHandler({
            bridge: actions,
            async plan(request, { id, signal }) {
                const direct = directPrompt(request);
                if (direct) {
                    const receipt = await actions.run('prompt_agent', direct, id, signal);
                    // Only an unresolved target sent nothing; every other receipt is final
                    // so an uncertain prompt is never sent twice.
                    if (!/^(?:I could not find an agent|More than one agent)/.test(receipt)) return receipt;
                }
                return coding.run(request, id, signal);
            },
        }),
        close: () => { coding.close(); actions.close(); },
    };
}

// Codex owns refresh and credential writes in the passed CODEX_HOME.
// See README.md for the accounts integration and remaining kit gaps.
let authRefresh;

async function refreshCodexAuthOnce() {
    const { promise, resolve, reject } = Promise.withResolvers();
    const child = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let initialized = false;
    let settled = false;
    let shuttingDown = false;
    let killTimer;
    const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
            child.kill();
            reject(error);
            return;
        }
        // Codex writes refreshed auth as the account request completes. Let it
        // flush and exit before the credential file is read below.
        shuttingDown = true;
        child.stdin.end();
        killTimer = setTimeout(() => child.kill(), 1_000);
        child.once('exit', () => {
            clearTimeout(killTimer);
            resolve();
        });
    };
    const timer = setTimeout(() => finish(new Error('Codex credential refresh timed out.')), 15_000);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
        if (!settled) finish(new Error(`Codex credential refresh exited (${code ?? 'signal'}).`));
        else if (!shuttingDown) clearTimeout(killTimer);
    });
    child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 256 * 1024) return finish(new Error('Codex app-server returned oversized refresh output.'));
        while (output.includes('\n')) {
            const index = output.indexOf('\n');
            const line = output.slice(0, index); output = output.slice(index + 1);
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (message.id === 1 && !initialized) {
                if (message.error) return finish(new Error(`Codex initialization failed: ${safe(message.error.message)}`));
                initialized = true;
                child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
                child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: true } })}\n`);
            } else if (message.id === 2) {
                if (message.error) return finish(new Error(`Codex credential refresh failed: ${safe(message.error.message)}`));
                if (message.result?.account?.type !== 'chatgpt') {
                    return finish(new Error('Codex ChatGPT login could not be refreshed. Run codex login again.'));
                }
                return finish();
            }
        }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'muxr', title: 'muxr', version: '0.1.0' } } })}\n`);
    await promise;
}

async function refreshCodexAuth() {
    if (authRefresh !== undefined) return authRefresh;
    authRefresh = refreshCodexAuthOnce().finally(() => { authRefresh = undefined; });
    return authRefresh;
}

function tokenAccountId(token) {
    try {
        const payload = claims(token);
        return payload['https://api.openai.com/auth']?.chatgpt_account_id;
    } catch { return undefined; }
}

function bindCredential(token, account) {
    if (typeof token !== 'string' || !token) throw new Error('Codex ChatGPT sign-in is unavailable. Run codex login.');
    const boundAccount = tokenAccountId(token);
    if (typeof account === 'string' && typeof boundAccount === 'string' && account !== boundAccount) {
        throw new Error('Codex credential account binding is inconsistent.');
    }
    const resolvedAccount = typeof account === 'string' && account ? account : boundAccount;
    if (typeof resolvedAccount !== 'string' || !resolvedAccount) throw new Error('Codex credential has no ChatGPT account binding.');
    return { token, account: resolvedAccount };
}

function tokenExpiry(token) {
    try {
        const payload = claims(token);
        return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
    } catch { return undefined; }
}

function needsTokenRefresh(token) {
    const expiry = tokenExpiry(token);
    return expiry === undefined || expiry <= Math.floor(Date.now() / 1_000) + TOKEN_REFRESH_SKEW_SECONDS;
}

async function readCodexCredential() {
    let root;
    let file;
    try {
        [root, file] = await Promise.all([lstat(codexHome), lstat(authFile)]);
    } catch {
        throw new Error('Codex ChatGPT login is unavailable. Run codex login.');
    }
    const owner = typeof process.getuid === 'function' ? process.getuid() : file.uid;
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o022) !== 0
        || root.uid !== owner || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.uid !== owner) {
        throw new Error('Codex credential file must be owner-only in a non-writable store.');
    }
    try {
        const auth = JSON.parse(await readFile(authFile, 'utf8'));
        return bindCredential(auth.tokens?.access_token, auth.tokens?.account_id);
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error('Codex ChatGPT login is unreadable. Run codex login.');
        throw error;
    }
}

export async function codexCredential() {
    let credential = await readCodexCredential();
    if (needsTokenRefresh(credential.token)) {
        await refreshCodexAuth();
        credential = await readCodexCredential();
        if (needsTokenRefresh(credential.token)) throw new Error('Codex ChatGPT access token is expired. Run codex login again.');
    }
    return credential;
}

/** The kit's `plan` auth: the sign-in Codex saved, refreshed through Codex when stale. */
export async function codexAccess() {
    const credential = await codexCredential();
    return { access: credential.token, accountId: credential.account };
}

/**
 * Codex authenticates through an existing ChatGPT CLI login, so there is no key
 * to store; the settings screen reports the login instead.
 */
export async function status() {
    // Async: this runs in the host process, where a sync spawn stalls every
    // link request for the length of `codex login status` (~40 ms, up to 10 s).
    const login = await new Promise((resolve) => execFile(CODEX_BIN, ['login', 'status'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` })));
    const authenticated = login.ok && /logged in using chatgpt/i.test(login.output);
    let privateStore = false;
    try {
        const root = lstatSync(codexHome);
        const file = lstatSync(authFile);
        const owner = typeof process.getuid === 'function' ? process.getuid() : file.uid;
        privateStore = root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o022) === 0 && root.uid === owner
            && file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 && file.uid === owner;
    } catch { privateStore = false; }
    let tokenReady = false;
    if (authenticated && privateStore) {
        try {
            const auth = JSON.parse(readFileSync(authFile, 'utf8'));
            const token = auth.tokens?.access_token;
            tokenReady = typeof token === 'string' && token.length > 0 && !needsTokenRefresh(token);
        } catch { tokenReady = false; }
    }
    let statusLabel = 'Experimental subscription access ready';
    if (!authenticated) statusLabel = 'Run codex login with ChatGPT';
    else if (!privateStore) statusLabel = 'Codex credential file is not owner-only';
    else if (!tokenReady) statusLabel = 'Codex ChatGPT login expired; run codex login again';
    return { configured: authenticated && privateStore && tokenReady, statusLabel };
}
