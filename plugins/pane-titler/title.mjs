#!/usr/bin/env node
/**
 * Preserve Herdr Agent Names, assign an animal only when the real name is
 * absent/internal, and write a Task Title through pane report-metadata.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ensureAgentName } from './agent-name.mjs';

const MODELS = [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/glm-5.1',
    'opencode-go/mimo-v2.5',
    'kimi-coding/k3-256k',
];
const PLUGIN_SOURCE = 'muxr.pane-titler';
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
    const line = text.split('\n').map((entry) => entry.trim()).find((entry) =>
        entry.length > 12 && entry.length < 80
        && /[a-zA-Z]/.test(entry)
        && !/^(\$ |tip:|ctrl|import |---|===|desc:)/i.test(entry));
    if (line === undefined) return 'Session';
    return line.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
}
function ask(agent, prompt) {
    for (const model of MODELS) {
        try {
            const out = execFileSync('pi', ['--print', '--model', model, '--no-session', '--no-tools', '--no-skills', '-np', '--no-context-files', prompt], { encoding: 'utf8', timeout: 30000, maxBuffer: 256 * 1024, env: { ...process.env, PATH: TOOL_PATH } });
            const raw = out.trim().split('\n').filter(Boolean).pop() ?? '';
            const title = formatTitle(agent, raw);
            if (title) { log(`model=${model} title=${title}`); return title; }
        } catch (error) {
            log(`model=${model} unavailable: ${String(error.message).slice(0, 80)}`);
        }
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
    const origin = sessionFence(agent);
    if (origin === undefined) process.exit(0);

    const text = run(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '60']);
    if (text.trim().length < 80) process.exit(0);

    const provider = kindName(agent.agent);
    const title = ask(provider, `Below is terminal output from a coding agent. Reply with exactly 2 to 4 words in Title Case naming only the feature or task. Do not include the agent/provider name, quotes, punctuation, commands, paths, or explanation.\n\n${text.slice(-2500)}`)
        ?? formatTitle(provider, fallbackFeature(text));
    if (title === undefined) process.exit(0);

    const current = readAgent(paneId);
    const fence = sessionFence(current);
    if (current === undefined || fence === undefined || fence.key !== origin.key) process.exit(0);
    if (!needsTaskTitle(current)) process.exit(0);

    const args = [
        'pane', 'report-metadata', paneId,
        '--source', PLUGIN_SOURCE,
        '--applies-to-source', fence.source,
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
