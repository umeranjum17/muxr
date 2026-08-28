#!/usr/bin/env node
/**
 * Rename a pane after the work inside it. Runs on every agent status change,
 * so it must be cheap and quiet: preserve Herdr Agent Names, assign an animal
 * only when the real name is absent/internal, and update generated Task Titles.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ensureAgentName } from './agent-name.mjs';

const MODELS = [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/glm-5.1',
    'opencode-go/mimo-v2.5',
    'kimi-coding/k3-256k',
];
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

try {
    if (!paneId) process.exit(0);
    const pane = JSON.parse(run(['pane', 'get', paneId])).result.pane;
    ensureAgentName(run, paneId);
    const current = (pane.label ?? pane.title ?? '').trim();
    const tabId = typeof pane.tab_id === 'string' ? pane.tab_id : undefined;
    const tabLabel = tabId === undefined ? '' : (JSON.parse(run(['tab', 'get', tabId])).result.tab.label ?? '').trim();
    let context = {};
    try { context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? '{}'); } catch {}
    const provider = kindName(context.focused_pane_agent || pane.agent || pane.display_agent);

    const seen = join(STATE, 'named.json');
    let named = {};
    try { named = JSON.parse(readFileSync(seen, 'utf8')); } catch {}

    if (!untitled(current)) process.exit(0);

    const previous = named[paneId];
    if (typeof previous === 'string' && previous !== '' && !untitled(previous)) {
        run(['pane', 'rename', paneId, previous]);
        if (tabId !== undefined && untitled(tabLabel)) run(['tab', 'rename', tabId, previous]);
        log(`restored ${paneId} -> ${previous}`);
        process.exit(0);
    }

    const text = run(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '60']);
    if (text.trim().length < 80) process.exit(0);

    const title = ask(provider, `Below is terminal output from a coding agent. Reply with exactly 2 to 4 words in Title Case naming only the feature or task. Do not include the agent/provider name, quotes, punctuation, commands, paths, or explanation.\n\n${text.slice(-2500)}`)
        ?? formatTitle(provider, fallbackFeature(text));
    if (title === undefined) process.exit(0);

    run(['pane', 'rename', paneId, title]);
    if (tabId !== undefined && untitled(tabLabel)) run(['tab', 'rename', tabId, title]);
    mkdirSync(STATE, { recursive: true });
    writeFileSync(seen, JSON.stringify({ ...named, [paneId]: title }), { mode: 0o600 });
    log(`renamed ${paneId} -> ${title}`);
} catch (error) {
    log(`failed: ${String(error.message).slice(0, 200)}`);
    process.exit(0);
}
