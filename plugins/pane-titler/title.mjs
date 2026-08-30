#!/usr/bin/env node
/**
 * Preserve Herdr Agent Names, assign an animal only when the real name is
 * absent/internal, and write a Task Title through pane report-metadata.
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ensureAgentName } from './agent-name.mjs';

const providerBridge = join(import.meta.dirname, 'provider-acp.mjs');
const ACP_BY_AGENT = {
    claude: {
        command: process.execPath,
        args: [providerBridge, 'claude'],
        model: 'haiku',
        env: { ANTHROPIC_MODEL: 'haiku', CLAUDE_CODE_EXECUTABLE: 'claude' },
    },
    codex: {
        command: process.execPath,
        args: [providerBridge, 'codex'],
        model: 'gpt-5.4-mini',
        env: { CODEX_PATH: 'codex' },
    },
    cursor: { command: 'cursor-agent', args: ['--model', 'auto', 'acp'], model: 'auto', env: {} },
    opencode: {
        command: 'opencode',
        args: ['acp', '--pure', '--cwd', process.cwd()],
        model: 'opencode-go/deepseek-v4-flash',
        sessionConfig: { configId: 'model', value: 'opencode-go/deepseek-v4-flash' },
        env: {},
    },
};
const MODEL_TIMEOUT_MS = 12_000;
const PLUGIN_SOURCE = 'muxr.pane-titler.v3';
const STATE = process.env.HERDR_PLUGIN_STATE_DIR || process.env.MUXR_PLUGIN_STATE_DIR || join(homedir(), '.muxr', 'plugin-state', 'muxr.pane-titler');
const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';
const paneId = process.env.HERDR_PANE_ID?.trim();

const TOOL_PATH = [
    process.env.PATH ?? '',
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
].filter(Boolean).join(delimiter);

const log = (line) => { try { mkdirSync(STATE, { recursive: true }); appendFileSync(join(STATE, 'titler.log'), `${new Date().toISOString()} ${line}\n`); } catch {} };
const run = (args, timeout = 20000) => execFileSync(herdr, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: TOOL_PATH } });

const GENERATED = /^\d+$|^(pi|claude|codex|gemini|cursor|opencode|amp|droid|grok|omp)(\s+\d+)?$|^pp_|^pph_/i;
const GREETING = /^(hi|hey|hello|yo|sup|test|ok|hmm|thanks|help)(\s|$)/i;
const FIRST_PROMPT = /^[a-z0-9]+(?:\s+[a-z0-9]+){2,5}$/;

function untitled(name) {
    const value = (name ?? '').trim();
    if (value === '') return true;
    if (GENERATED.test(value)) return true;
    if (GREETING.test(value)) return true;
    return FIRST_PROMPT.test(value);
}

function kindName(kind) {
    const value = (kind ?? '').trim();
    if (value === '') return 'Agent';
    if (value.toLowerCase() === 'opencode') return 'OpenCode';
    if (value.toLowerCase() === 'pi') return 'Pi';
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTitle(agent, raw) {
    let feature = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
    feature = feature.replace(new RegExp(`^${agent}\\s*[-–—:]\\s*`, 'i'), '');
    feature = feature.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (feature === '') return undefined;
    const titled = feature.split(' ').slice(0, 4).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    return titled.length <= 40 ? titled : titled.slice(0, 40).replace(/\s+\S*$/, '');
}

function fallbackFeature(text) {
    const line = text.split('\n').map((entry) => entry.trim()).reverse().find((entry) =>
        entry.length > 12 && entry.length < 80
        && /[a-zA-Z]/.test(entry)
        && !/^(\$ |tip:|ctrl|import |---|===|desc:)/i.test(entry));
    if (line === undefined) return 'Session';
    return line.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
}

function terminalFeature(agent) {
    const raw = typeof agent?.terminal_title_stripped === 'string'
        ? agent.terminal_title_stripped.trim()
        : '';
    if (raw === '' || /(?:\.\.\.|…)$/.test(raw)) return undefined;
    const task = raw
        .replace(/^(?:fix|feat|feature|chore|refactor|review)[/:_-]+/i, '')
        .replace(/[\\/_-]+/g, ' ');
    const title = formatTitle(kindName(agent.agent), task);
    return title !== undefined && title.split(/\s+/).length >= 2 ? title : undefined;
}
function agentEnvironment(overrides) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')));
    return { ...inherited, PATH: TOOL_PATH, ...overrides };
}

async function stopProcessGroup(child) {
    if (child.pid === undefined || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGTERM');
    } catch { return; }
    if (child.exitCode !== null) return;
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 250))]);
    if (child.exitCode !== null) return;
    try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
    } catch {}
}

async function askAcp(config, prompt) {
    const child = spawn(config.command, config.args, {
        cwd: process.cwd(),
        env: agentEnvironment(config.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error('ACP title timeout')), MODEL_TIMEOUT_MS);
    let nextId = 1;
    let output = '';
    let buffer = '';
    const pending = new Map();
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const failPending = (error) => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };
    const request = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        const onAbort = () => {
            pending.delete(id);
            reject(abort.signal.reason ?? new Error('ACP title cancelled'));
        };
        if (abort.signal.aborted) return onAbort();
        abort.signal.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
            resolve: (value) => { abort.signal.removeEventListener('abort', onAbort); resolve(value); },
            reject: (error) => { abort.signal.removeEventListener('abort', onAbort); reject(error); },
        });
        send({ jsonrpc: '2.0', id, method, params });
    });
    const handleMessage = (message) => {
        if (message?.method === 'session/update') {
            const update = message.params?.update;
            if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
                output += update.content.text;
            }
            return;
        }
        if (message?.method !== undefined && message.id !== undefined) {
            if (message.method === 'session/request_permission') {
                send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
            } else {
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } });
            }
            return;
        }
        if (message?.id === undefined) return;
        const active = pending.get(message.id);
        if (active === undefined) return;
        pending.delete(message.id);
        if (message.error !== undefined) active.reject(new Error(message.error.message ?? 'ACP request failed'));
        else active.resolve(message.result);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line === '') continue;
            try { handleMessage(JSON.parse(line)); } catch (error) { failPending(error); }
        }
    });
    child.once('error', failPending);
    child.once('exit', (code, signal) => failPending(new Error(`ACP exited (${signal ?? code ?? 'unknown'})`)));
    try {
        await request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'muxr-pane-titler', version: '1' },
        });
        const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
        if (config.sessionConfig !== undefined) {
            await request('session/set_config_option', { sessionId: session.sessionId, ...config.sessionConfig });
        }
        await request('session/prompt', {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: prompt }],
        });
        return output;
    } catch (error) {
        const detail = stderr.trim() || String(error?.message ?? error);
        throw new Error(detail.slice(0, 160));
    } finally {
        clearTimeout(timeout);
        abort.abort(new Error('ACP title complete'));
        child.stdin.end();
        await stopProcessGroup(child);
    }
}

async function ask(agentKind, agentLabel, prompt) {
    const kind = agentKind?.trim().toLowerCase();
    try {
        let raw;
        let model;
        if (kind === 'pi') {
            model = 'opencode-go/deepseek-v4-flash';
            raw = execFileSync('pi', [
                '--print', '--model', model, '--thinking', 'off', '--no-session',
                '--no-tools', '--no-skills', '-np', '--no-context-files', prompt,
            ], { encoding: 'utf8', timeout: MODEL_TIMEOUT_MS, maxBuffer: 256 * 1024, env: agentEnvironment({}) });
        } else {
            const config = ACP_BY_AGENT[kind];
            if (config === undefined) return undefined;
            model = config.model;
            raw = await askAcp(config, prompt);
        }
        const title = formatTitle(agentLabel, raw.trim().split('\n').filter(Boolean).pop() ?? '');
        if (title !== undefined) {
            log(`agent=${kind} transport=${kind === 'pi' ? 'cli' : 'acp'} model=${model} title=${title}`);
            return title;
        }
        log(`agent=${kind} transport=${kind === 'pi' ? 'cli' : 'acp'} model=${model} returned no title`);
    } catch (error) {
        log(`agent=${kind} transport=${kind === 'pi' ? 'cli' : 'acp'} unavailable: ${String(error.message).slice(0, 120)}`);
    }
    return undefined;
}

function readAgent(id) {
    const parsed = JSON.parse(run(['agent', 'list']));
    const rows = Array.isArray(parsed?.result?.agents) ? parsed.result.agents : [];
    return rows.find((candidate) => candidate?.pane_id === id);
}

function fold(value) {
    return typeof value === 'string'
        ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('und')
        : '';
}

function needsTaskTitle(agent) {
    const title = typeof agent?.title === 'string' ? agent.title.trim() : '';
    if (title === '' || untitled(title)) return true;
    const name = fold(agent?.name);
    return name !== '' && fold(title) === name;
}

function sessionFence(agent) {
    const session = agent?.agent_session;
    if (session === null || typeof session !== 'object') return undefined;
    const source = typeof session.source === 'string' ? session.source.trim() : '';
    const value = typeof session.value === 'string' ? session.value.trim() : '';
    if (source === '' || value === '') return undefined;
    const kind = typeof session.kind === 'string' ? session.kind : '';
    return { source, key: `${source}\0${kind}\0${value}` };
}

function generationFence(agent) {
    const session = sessionFence(agent);
    if (session !== undefined) return session.key;
    const seq = seqOf(agent);
    return seq !== undefined ? `seq:${seq}` : 'none';
}

function seqOf(agent) {
    if (Number.isInteger(agent?.state_change_seq)) return agent.state_change_seq;
    if (Number.isInteger(agent?.revision)) return agent.revision;
    return undefined;
}

try {
    if (!paneId) process.exit(0);
    ensureAgentName(run, paneId);
    const agent = readAgent(paneId);
    if (agent === undefined || !needsTaskTitle(agent)) process.exit(0);
    const origin = generationFence(agent);

    const text = run(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '60']);
    const provider = kindName(agent.agent);
    const title = terminalFeature(agent)
        ?? await ask(agent.agent, provider, `Below is terminal output from a coding agent. Reply with exactly 2 to 4 words in Title Case naming only the feature or task. Do not use tools. Do not include the agent/provider name, quotes, punctuation, commands, paths, or explanation.\n\n${text.slice(-2500)}`)
        ?? formatTitle(provider, fallbackFeature(text));
    if (title === undefined) process.exit(0);

    const current = readAgent(paneId);
    if (current === undefined || generationFence(current) !== origin) process.exit(0);
    if (typeof current.agent !== 'string' || current.agent.trim() === '') process.exit(0);
    if (!needsTaskTitle(current)) process.exit(0);

    const args = [
        'pane', 'report-metadata', paneId,
        '--source', PLUGIN_SOURCE,
        '--agent', current.agent,
        '--title', title,
    ];
    const seq = seqOf(current);
    if (seq !== undefined) args.push('--seq', String(seq));
    run(args);
    log(`titled ${paneId} -> ${title}`);
} catch (error) {
    log(`failed: ${String(error.message).slice(0, 200)}`);
    process.exit(0);
}
