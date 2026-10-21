import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `muxr accounts`: the signed-in Claude accounts, which one each agent runs
 * on, and starting or moving an agent onto one by name. Everything here is a
 * request the person (or an agent they told) makes by hand; nothing picks an
 * account for them. The running host answers over its owner-only
 * `accounts.sock`, so a move here is the same move the phone makes.
 */

const REQUEST_TIMEOUT_MS = 120_000;
const WINDOW_NAMES = { session: '5-hour', weekly: '7-day' };

const USAGE = `usage: muxr accounts [list] [--json]
       muxr accounts panes [--json]
       muxr accounts start <account> [--cwd <dir>] [--label <text>]
       muxr accounts move <agent> <account>`;

function socketPath() {
    return join(process.env.MUXR_HOME?.trim() || join(process.env.HOME?.trim() || homedir(), '.muxr'), 'host', 'accounts.sock');
}

function ask(type, params = {}) {
    return new Promise((resolveAnswer, reject) => {
        const socket = createConnection(socketPath());
        let reply = '';
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => { socket.destroy(); reject(new Error('the muxr host did not answer in time')); });
        socket.on('connect', () => socket.write(`${JSON.stringify({ type, params })}\n`));
        socket.on('data', (chunk) => { reply += chunk.toString('utf8'); });
        socket.on('error', (error) => reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
            ? new Error('the muxr host is not running; start muxr first')
            : error));
        socket.on('close', () => {
            let answer;
            try { answer = JSON.parse(reply); } catch { reject(new Error('the muxr host gave an unreadable answer')); return; }
            if (answer.ok === true) resolveAnswer(answer.data);
            else reject(new Error(String(answer.error ?? 'the muxr host refused the request')));
        });
    });
}

async function claudeAccounts() {
    const { providers } = await ask('plans.list');
    const claude = providers.find((provider) => provider.provider === 'claude');
    if (claude === undefined) {
        throw new Error('fewer than two Claude accounts are signed in; sign in a second one in the muxr app first');
    }
    return claude.accounts;
}

function accountLabel(account) {
    return account.email === undefined ? account.name : `${account.name} <${account.email}>`;
}

/** An account by its name or email, exactly as `muxr accounts` prints them. Never "auto". */
function pickAccount(accounts, wanted) {
    const key = wanted.trim().toLowerCase();
    const matches = accounts.filter((account) => account.name.toLowerCase() === key || account.email?.toLowerCase() === key);
    if (matches.length === 1) return matches[0];
    const names = accounts.map(accountLabel).join(', ');
    throw new Error(matches.length === 0 ? `no Claude account named "${wanted}"; signed in: ${names}` : `"${wanted}" matches more than one account; use the email: ${names}`);
}

function reset(epochSec) {
    if (epochSec === undefined) return '';
    const minutes = Math.max(0, Math.round((epochSec * 1000 - Date.now()) / 60_000));
    const left = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
        : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
    const at = new Date(epochSec * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return ` · resets ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} (in ${left})`;
}

function accountLines(account) {
    const head = `${accountLabel(account)}${account.plan === undefined ? '' : ` · ${account.plan}`}${account.signedIn ? '' : ' · signed out'}`;
    if (!account.signedIn) return [head];
    const windows = account.windows ?? [];
    if (windows.length === 0) return [head, '    quota: not readable right now'];
    return [head, ...windows.map((window) => `    ${(WINDOW_NAMES[window.kind] ?? window.kind).padEnd(7)} ${window.leftPercent}% left${reset(window.resetsAtEpochSec)}`)];
}

async function list(args) {
    const accounts = await claudeAccounts();
    if (args.json) { process.stdout.write(`${JSON.stringify({ accounts: accounts.map(({ id: _id, ...rest }) => rest) })}\n`); return 0; }
    process.stdout.write(`Claude accounts (${accounts.length})\n${accounts.flatMap((account) => accountLines(account).map((line) => `  ${line}`)).join('\n')}\n`);
    return 0;
}

async function agentRows() {
    const [sessions, accounts] = await Promise.all([ask('session.list', {}), claudeAccounts().catch(() => [])]);
    return Promise.all(sessions.map(async (session) => {
        const { accountId } = await ask('plans.agent', { sessionId: session.id }).catch(() => ({}));
        return { session, account: accounts.find((account) => account.id === accountId) };
    }));
}

async function panes(args) {
    const rows = await agentRows();
    const shown = rows.map(({ session, account }) => ({
        agent: session.agentName ?? session.paneId ?? session.id,
        pane: session.paneId,
        kind: session.agentKind,
        task: session.taskTitle,
        account: account === undefined ? null : { name: account.name, email: account.email ?? null },
    }));
    if (args.json) { process.stdout.write(`${JSON.stringify({ agents: shown })}\n`); return 0; }
    if (shown.length === 0) { process.stdout.write('No agents are running.\n'); return 0; }
    process.stdout.write(`${shown.map((row) => `${row.agent}${row.kind === undefined ? '' : ` (${row.kind})`}  ${row.account === null ? 'no Claude account' : `${row.account.name}${row.account.email === null ? '' : ` <${row.account.email}>`}`}`).join('\n')}\n`);
    return 0;
}

function findAgent(rows, wanted) {
    const key = wanted.trim().toLowerCase();
    const matches = rows.map((row) => row.session).filter((session) => session.agentName?.toLowerCase() === key || session.paneId?.toLowerCase() === key);
    if (matches.length === 1) return matches[0];
    throw new Error(matches.length === 0 ? `no agent named "${wanted}"; see \`muxr accounts panes\`` : `"${wanted}" matches more than one agent; use its pane`);
}

async function start(args) {
    const accounts = await claudeAccounts();
    const account = pickAccount(accounts, args.positional[0] ?? (() => { throw new Error(USAGE); })());
    const result = await ask('session.start', {
        cwd: resolve(args.cwd ?? process.cwd()), kind: 'claude', planAccount: account.id, ...(args.label === undefined ? {} : { label: args.label }),
    });
    const info = result.info ?? {};
    process.stdout.write(`Started ${info.agentName ?? 'a Claude agent'} on ${accountLabel(account)}.\n`);
    return 0;
}

async function move(args) {
    const [agentName, accountName] = args.positional;
    if (agentName === undefined || accountName === undefined) throw new Error(USAGE);
    const account = pickAccount(await claudeAccounts(), accountName);
    const agent = findAgent(await agentRows(), agentName);
    await ask('plans.move', { sessionId: agent.id, accountId: account.id });
    process.stdout.write(`Moved ${agent.agentName ?? agentName} to ${accountLabel(account)}. Its conversation continues in a new pane.\n`);
    return 0;
}

function parse(argv) {
    const args = { positional: [], json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') args.json = true;
        else if (arg === '--cwd' || arg === '--label') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
            args[arg.slice(2)] = value;
            i += 1;
        } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}\n${USAGE}`);
        else args.positional.push(arg);
    }
    return args;
}

export async function accounts(argv) {
    const sub = argv[0] === undefined || argv[0].startsWith('--') ? 'list' : argv[0];
    const args = parse(sub === 'list' && argv[0] !== 'list' ? argv : argv.slice(1));
    if (sub === 'list') return list(args);
    if (sub === 'panes') return panes(args);
    if (sub === 'start') return start(args);
    if (sub === 'move') return move(args);
    throw new Error(USAGE);
}
