#!/usr/bin/env node
import { scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, accessSync, chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { createRequire } from 'node:module';
import { headroomLabel, limitRow, paceVerdict, resetClock, WINDOW_MINUTES } from './rateLimits.mjs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';

const require = createRequire(import.meta.url);
const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
// The host injects this private stdin field only after checking this bundled
// script's canonical path. Keep Go auth content out of descendant environments.
const config = process.env.MUXR_PLUGIN_ID === 'muxr.status' ? input._usageConfig ?? {} : {};
for (const key of ['XDG_DATA_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OPENCODE_DB', 'OPENCODE_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TZ']) {
  if (typeof config[key] === 'string') process.env[key] = config[key];
}

/** Which provider tab the screen asked for; empty means most recently used. */
const requested = String(input.provider ?? '').slice(0, 32);
let ccusageFailure;
const AGENTS = {
  claude: 'Anthropic Claude', codex: 'OpenAI Codex', zai: 'Z.ai', opencode: 'OpenCode', amp: 'Amp', droid: 'Droid', codebuff: 'Codebuff',
  hermes: 'Hermes Agent', pi: 'Pi', goose: 'Goose', openclaw: 'OpenClaw', kilo: 'Kilo Code', kimi: 'Kimi Code', qwen: 'Qwen',
  copilot: 'GitHub Copilot CLI', gemini: 'Gemini CLI', grok: 'xAI Grok', cursor: 'Cursor', omp: 'OMP',
  devin: 'Devin', agy: 'Antigravity', cline: 'Cline', mastracode: 'Mastra Code', kiro: 'Kiro', qodercli: 'Qoder', maki: 'Maki',
};
const CCUSAGE_AGENTS = new Set(['claude', 'codex', 'opencode', 'amp', 'droid', 'codebuff', 'hermes', 'pi', 'goose', 'openclaw', 'kilo', 'kimi', 'qwen', 'copilot', 'gemini', 'grok']);
const selected = Object.hasOwn(AGENTS, requested) ? requested : '';
const AGENT_COMMANDS = { ...Object.fromEntries(Object.keys(AGENTS).map((agent) => [agent, agent])), cursor: 'cursor-agent' };
const COMMAND_ALIASES = {
  kilo: ['kilo', 'kilocode'], cursor: ['cursor-agent'], copilot: ['copilot', 'github-copilot'],
  kiro: ['kiro-cli'], agy: ['agy', 'antigravity'], mastracode: ['mastracode', 'mastra'], qodercli: ['qodercli', 'qoder'],
};

function installedAgent(agent, command) {
  return (COMMAND_ALIASES[agent] ?? [command]).some(available);
}

function available(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { const path = join(directory, command); accessSync(path, constants.X_OK); if (statSync(path).isFile()) return true; } catch {}
  }
  return false;
}

function ccusageBinary() {
  if (process.env.MUXR_CCUSAGE_BIN?.trim()) return process.env.MUXR_CCUSAGE_BIN.trim();
  const target = {
    'darwin-arm64': '@ccusage/ccusage-darwin-arm64', 'darwin-x64': '@ccusage/ccusage-darwin-x64',
    'linux-arm64': '@ccusage/ccusage-linux-arm64', 'linux-x64': '@ccusage/ccusage-linux-x64',
  }[`${process.platform}-${process.arch}`];
  if (!target) { ccusageFailure = 'Local activity backend unsupported on this platform'; return undefined; }
  try {
    const binary = require.resolve(`${target}/bin/ccusage`);
    try { accessSync(binary, constants.X_OK); }
    catch {
      try { chmodSync(binary, 0o755); }
      catch { ccusageFailure = 'ccusage backend is not executable · reinstall muxr without sudo'; return undefined; }
    }
    return binary;
  } catch { ccusageFailure = 'ccusage backend is missing · reinstall muxr'; return undefined; }
}

function runJson(command, args, timeout = 8_000) {
  if (!command) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    let escalation;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        escalation = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1_000);
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeout);
    child.once('error', () => finish(undefined));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) finish(undefined);
    });
    child.once('close', (code) => {
      if (escalation) clearTimeout(escalation);
      if (code !== 0) { finish(undefined); return; }
      try { finish(JSON.parse(buffer)); } catch { finish(undefined); }
    });
  });
}

const RANGE_DAYS = 7;

function nowDate() {
  const raw = process.env.MUXR_USAGE_NOW;
  if (raw) {
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return new Date();
}

function localDate(at) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** The window we report, oldest first, always ending on today. */
function windowPeriods(origin) {
  // Local midnight, then setDate — fixed 86_400_000 ms skips a DST spring-forward day.
  return Array.from({ length: RANGE_DAYS }, (_, index) => {
    const at = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate());
    at.setDate(at.getDate() - (RANGE_DAYS - 1 - index));
    return localDate(at);
  });
}

// One captured instant for the whole response: two reads either side of local
// midnight would label one provider's day with another day's window.
const NOW = nowDate();
const TODAY = localDate(NOW);
const PERIODS = windowPeriods(NOW);


/**
 * One report covers every provider and every day on screen. Asking per tab
 * would re-read the same session logs once per provider.
 */
async function ccusageRange() {
  const binary = ccusageBinary();
  if (!binary) return undefined;
  const result = await runJson(binary, ['daily', '--by-agent', '--sections', 'daily,session', '--json', '--offline'], 10_000);
  if (!Array.isArray(result?.daily) && ccusageFailure === undefined) ccusageFailure = 'ccusage activity unavailable · reopen Usage in a minute';
  return ccusageFailure === undefined ? result : undefined;
}

function parseClaudeLimits(value) {
  const source = value?.rate_limits ?? value;
  return [
    ['five_hour', '5-hour limit'],
    ['seven_day', '7-day limit'],
  ].flatMap(([id, label]) => {
    const raw = source?.[id];
    const utilization = raw?.utilization ?? raw?.used_percentage;
    if (!Number.isFinite(utilization) || utilization < 0 || utilization > 100) return [];
    const resetAt = typeof raw?.resets_at === 'number' ? raw.resets_at : Date.parse(raw?.resets_at) / 1000;
    return [{ id, label, used: Math.round(utilization), resetAt }];
  });
}

function readJson(path, maxBytes) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return undefined;
    return { value: JSON.parse(readFileSync(path, 'utf8')), modified: stat.mtimeMs };
  } catch { return undefined; }
}

/** A connected Claude account: local OAuth credentials that have not expired. */
function claudeCredentials() {
  const config = process.env.CLAUDE_CONFIG_DIR?.trim() || join(process.env.HOME?.trim() || homedir(), '.claude');
  const credentials = readJson(join(config, '.credentials.json'), 64 * 1024)?.value?.claudeAiOauth;
  const token = typeof credentials?.accessToken === 'string' && credentials.accessToken.length <= 16 * 1024 ? credentials.accessToken : undefined;
  if (token === undefined || Number.isFinite(credentials?.expiresAt) && credentials.expiresAt <= Date.now()) return undefined;
  return token;
}

async function claudePlanLimits() {
  const config = process.env.CLAUDE_CONFIG_DIR?.trim() || join(process.env.HOME?.trim() || homedir(), '.claude');
  const snapshot = readJson(join(config, 'last-statusline-input.json'), 64 * 1024);
  const snapshotAge = snapshot === undefined ? undefined : Date.now() - snapshot.modified;
  if (snapshotAge !== undefined && snapshotAge >= 0 && snapshotAge < 5 * 60_000) {
    const limits = parseClaudeLimits(snapshot.value);
    if (limits.length > 0) return limits;
  }
  const token = claudeCredentials();
  if (token === undefined) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = await response.text();
    return body.length <= 64 * 1024 ? parseClaudeLimits(JSON.parse(body)) : [];
  } catch { return []; }
  finally { clearTimeout(timer); }
}

function goAuthSelection() {
  const home = process.env.HOME || homedir();
  let authContent;
  let hasOverride = false;
  if (Object.hasOwn(config, 'goAuthOverride')) {
    authContent = { 'opencode-go': config.goAuthOverride };
    hasOverride = true;
  } else {
    try { authContent = JSON.parse(process.env.OPENCODE_AUTH_CONTENT); hasOverride = true; } catch {}
  }
  if (!hasOverride) authContent = readJson(join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json'), 64 * 1024)?.value;
  return { source: hasOverride ? 'override' : 'disk', auth: authContent?.['opencode-go'] };
}

/** A connected Go account, from the same selection the cache identity uses. */
function goConnected() {
  const { auth } = goAuthSelection();
  return auth?.type === 'api' && typeof auth.key === 'string' && auth.key.trim() !== '' && auth.key.length <= 16 * 1024;
}

async function goPlanLimits() {
  if (!goConnected()) return { series: [], label: 'OpenCode Go limits unavailable · connect your Go account in OpenCode' };
  const { auth } = goAuthSelection();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
      headers: { accept: 'application/json', authorization: `Bearer ${auth.key}` },
      redirect: 'error', signal: controller.signal,
    });
    if (response.status === 401) return { series: [], label: 'OpenCode Go authentication unavailable · reconnect in OpenCode' };
    if (response.status === 403) return { series: [], label: 'OpenCode Go subscription unavailable for this account' };
    if (!response.ok) return { series: [], label: 'OpenCode Go limits unavailable · try again shortly' };
    let body = '';
    for await (const chunk of response.body) {
      body += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(body) > 64 * 1024) { controller.abort(); return { series: [], label: 'OpenCode Go limits unavailable' }; }
    }
    const usage = JSON.parse(body)?.usage;
    const series = [['rolling', 'Rolling'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].flatMap(([key, label]) => {
      const window = usage?.[key];
      if (!Number.isFinite(window?.percent) || window.percent < 0 || !['ok', 'rate-limited'].includes(window.status)) return [];
      // Rolling publishes no window length, so its row reports headroom and
      // the clock without claiming a burn projection.
      return [limitRow({
        label, used: Math.min(100, window.percent), windowMinutes: WINDOW_MINUTES[key],
        // Pace runs on the real clock: resets arrive as real-clock timestamps
        // while NOW may be pinned to a fixture date by MUXR_USAGE_NOW.
        resetEpochSec: Date.parse(window.resetsAt) / 1000, nowMs: Date.now(), limited: window.status === 'rate-limited',
      })];
    });
    if (series.length !== 3) return { series: [], label: 'OpenCode Go limits unavailable · incomplete response' };
    return { series, label: 'OpenCode Go plan usage' };
  } catch { return { series: [], label: 'OpenCode Go limits unavailable · try again shortly' }; }
  finally { clearTimeout(timer); }
}

/** The Z.ai credential Pi holds for its zai provider, from Pi's own auth store. */
function zaiToken() {
  const agentDir = process.env.PI_AGENT_DIR?.trim() || join(process.env.HOME?.trim() || homedir(), '.pi', 'agent');
  const auth = readJson(join(agentDir, 'auth.json'), 64 * 1024)?.value?.zai;
  const token = auth?.type === 'api_key' && typeof auth.key === 'string' ? auth.key.trim() : '';
  return token !== '' && token.length <= 16 * 1024 ? token : undefined;
}

// Monitor buckets arrive as unit/number pairs; unknown pairs are skipped
// rather than guessed at, so a schema change degrades to "unavailable".
const ZAI_WINDOWS = new Map([['3:5', { label: '5-hour limit', windowMinutes: 300 }], ['6:1', { label: 'Weekly limit', windowMinutes: 10080 }]]);

async function zaiPlanLimits() {
  const token = zaiToken();
  if (token === undefined) return { series: [], label: 'Z.ai limits unavailable · connect Z.ai in Pi' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error', signal: controller.signal,
    });
    if (response.status === 401) return { series: [], label: 'Z.ai authentication unavailable · reconnect in Pi' };
    if (response.status === 403) return { series: [], label: 'Z.ai coding plan unavailable for this account' };
    if (!response.ok) return { series: [], label: 'Z.ai limits unavailable · try again shortly' };
    let body = '';
    for await (const chunk of response.body) {
      body += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(body) > 64 * 1024) { controller.abort(); return { series: [], label: 'Z.ai limits unavailable' }; }
    }
    const parsed = JSON.parse(body);
    if (parsed?.success === false) return { series: [], label: 'Z.ai coding plan unavailable for this account' };
    const series = (Array.isArray(parsed?.data?.limits) ? parsed.data.limits : []).flatMap((limit) => {
      const window = ZAI_WINDOWS.get(`${limit?.unit}:${limit?.number}`);
      const used = limit?.percentage;
      if (window === undefined || !Number.isFinite(used) || used < 0 || used > 100) return [];
      return [limitRow({
        label: window.label, used: Math.min(100, used), windowMinutes: window.windowMinutes,
        resetEpochSec: Number(limit?.nextResetTime) / 1000, nowMs: Date.now(),
      })];
    });
    if (series.length === 0) return { series: [], label: 'Z.ai limits unavailable · incomplete response' };
    return { series, label: 'Z.ai plan usage' };
  } catch { return { series: [], label: 'Z.ai limits unavailable · try again shortly' }; }
  finally { clearTimeout(timer); }
}

function money(value) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dayLabel(period) {
  const parsed = new Date(`${String(period ?? '')}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? String(period ?? '')
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parsed.getUTCDay()];
}

/**
 * agent -> one entry per day of the window, so every tab reads from one report.
 * Days are placed by date rather than by position: ccusage omits days with no
 * activity, so trusting its order would slide an older day into today's slot
 * and report stale totals as current.
 */
function byAgent(result) {
  const periods = PERIODS;
  const slots = new Map(periods.map((period, index) => [period, index]));
  const agents = new Map();
  for (const day of Array.isArray(result?.daily) ? result.daily : []) {
    const index = slots.get(String(day?.period ?? ''));
    if (index === undefined) continue;
    for (const row of Array.isArray(day?.agents) ? day.agents.slice(0, 32) : []) {
      if (!CCUSAGE_AGENTS.has(row?.agent) || !Number.isSafeInteger(row.totalTokens) || row.totalTokens < 0) continue;
      const entry = agents.get(row.agent) ?? periods.map((period) => ({ period, row: undefined }));
      entry[index] = { period: periods[index], row };
      agents.set(row.agent, entry);
    }
  }
  return agents;
}

function modelSeries(row) {
  const breakdowns = Array.isArray(row?.modelBreakdowns) ? row.modelBreakdowns.slice(0, 8) : [];
  return breakdowns.flatMap((model) => {
    const total = (model.inputTokens ?? 0) + (model.outputTokens ?? 0) + (model.cacheCreationTokens ?? 0) + (model.cacheReadTokens ?? 0);
    const label = String(model.modelName ?? '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 40);
    const valueLabel = tokens(total);
    return label === '' || valueLabel === undefined ? [] : [{ label, value: total, valueLabel }];
  }).sort((a, b) => b.value - a.value);
}

function tokens(value) {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function ccusageItems(agents) {
  const totals = new Map();
  for (const [agent, days] of agents) {
    const today = days[days.length - 1]?.row;
    if (today !== undefined) totals.set(agent, today.totalTokens);
  }
  const sorted = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 16);
  const max = sorted.length === 0 ? 0 : sorted[0][1];
  const items = sorted.flatMap(([agent, total]) => {
    const value = tokens(total);
    return value === undefined ? [] : [{
      id: `activity-${agent}`, title: AGENTS[agent], subtitle: 'Local activity today', icon: 'analytics-outline',
      group: 'Active today',
      ...(max > 0 ? { progress: { value: total / max } } : {}),
      metadata: [{ value: `${value} tokens`, tone: 'primary' }],
      // The card is a summary; the detail lives on one screen, wherever it opened from.
      action: { type: 'screen', contributionId: 'usage.details', params: { provider: agent } },
    }];
  });
  const series = sorted.slice(0, 8).flatMap(([agent, total]) => {
    const valueLabel = tokens(total);
    return valueLabel === undefined ? [] : [{ label: AGENTS[agent], value: total, valueLabel }];
  });
  const totalTokens = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return { items, series, agents: new Set(totals.keys()), totalTokens, totals };
}

function cacheName() {
  return `usage-v2-${selected === '' ? 'all' : selected}.json`;
}

function cachedOutput() {
  const state = process.env.MUXR_PLUGIN_STATE_DIR?.trim();
  if (!state) return undefined;
  try {
    const saved = JSON.parse(readFileSync(join(state, cacheName()), 'utf8'));
    const age = NOW.getTime() - saved.at;
    const maxAge = saved.output?.provider === 'claude' ? 15_000 : 60_000;
    // A payload captured yesterday would keep labelling its last day "Today".
    if (saved.identity === cacheIdentity && saved.date === TODAY && age >= 0 && age < maxAge && Array.isArray(saved.output?.items) && Buffer.byteLength(JSON.stringify(saved.output)) <= 65_536) return saved.output;
  } catch {}
  return undefined;
}

function saveOutput(output) {
  const state = process.env.MUXR_PLUGIN_STATE_DIR?.trim();
  if (!state) return;
  if (Buffer.byteLength(JSON.stringify(output)) > 65_536) return;
  const cache = join(state, cacheName());
  const temporary = `${cache}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ at: NOW.getTime(), date: TODAY, identity: cacheIdentity, output }), { mode: 0o600 });
    renameSync(temporary, cache);
  } catch {}
}

function codexUsage() {
  if (!available('codex')) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    let escalation;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        escalation = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1_000);
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 8_000);
    child.once('error', () => finish(undefined));
    child.once('close', () => { if (escalation) clearTimeout(escalation); finish(undefined); });
    child.stdin.on('error', () => finish(undefined));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) { finish(undefined); return; }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
          if (message.id === 2) finish(message.result);
        } catch {}
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'muxr', version: '1' } } })}\n`);
  });
}

function codexItems(result) {
  const limits = Object.values(result?.rateLimitsByLimitId ?? {});
  if (!limits.length && result?.rateLimits) limits.push(result.rateLimits);
  const parsed = limits.slice(0, 8).flatMap((limit, index) => {
    if (!limit || typeof limit !== 'object') return [];
    const rawName = String(limit.limitName ?? limit.limitId ?? 'Codex').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Codex';
    const name = rawName.toLowerCase() === 'codex' ? AGENTS.codex : rawName;
    return ['primary', 'secondary'].flatMap((key) => {
      const window = limit[key];
      if (!Number.isFinite(window?.usedPercent)) return [];
      const rawMinutes = window.windowDurationMins;
      const windowMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : undefined;
      let duration = key;
      if (windowMinutes !== undefined) duration = `${windowMinutes / 60}h`;
      const windowName = `${name} · ${duration}`;
      const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
      return [{
        index: index * 2 + Number(key === 'secondary'), name: windowName, remaining,
        used: 100 - remaining, windowMinutes, resetAt: window?.resetsAt,
      }];
    });
  });
  // Critical windows first: the limit you are about to hit leads the list.
  parsed.sort((a, b) => (a.remaining ?? 101) - (b.remaining ?? 101) || a.index - b.index);
  const details = parsed.slice(0, 8);
  // Real clock for pace: provider resets are real-clock timestamps.
  const at = Date.now();
  const items = parsed.map(({ index, name, remaining, used, windowMinutes, resetAt }) => {
    const { verdict, tone } = paceVerdict({ used, windowMinutes, resetEpochSec: resetAt, nowMs: at });
    const clock = resetClock(resetAt, at);
    return {
      id: `limit-codex-${index}`, title: name, subtitle: 'OpenAI Codex current limit', icon: 'speedometer-outline',
      group: 'Rate limits',
      ...(remaining === undefined ? {} : { progress: { value: remaining / 100, tone } }),
      metadata: [
        { value: remaining === undefined ? 'Available' : `${remaining}% left`, ...(remaining === undefined ? {} : { tone }) },
        { value: clock === '' ? verdict : `${clock} · ${verdict}` },
      ],
    };
  });
  const first = details.length === 0 ? undefined : details.reduce((lowest, limit) => (limit.remaining < lowest.remaining ? limit : lowest));
  return {
    items,
    // detail carries the reset clock and the pace word, so a limit row reads
    // "60% left · 2:30 PM · on pace" with red reserved for a projected hit.
    series: details.map((limit) => limitRow({
      label: limit.name, used: limit.used, windowMinutes: limit.windowMinutes,
      resetEpochSec: limit.resetAt, nowMs: at,
    })),
    ring: first === undefined ? [] : [
      limitRow({
        label: 'Remaining', used: first.used, windowMinutes: first.windowMinutes,
        resetEpochSec: first.resetAt, nowMs: at,
      }),
      { label: 'Used', value: 100 - first.remaining, valueLabel: `${100 - first.remaining}%`, tone: 'secondary' },
    ],
    remaining: first?.remaining ?? 0,
    remainingLabel: first === undefined ? 'Unavailable' : headroomLabel({
      used: first.used, windowMinutes: first.windowMinutes, resetEpochSec: first.resetAt, nowMs: at,
    }),
  };
}

function idleLabel(agent, local, failure) {
  // OMP and Pi are both accounted from their own transcripts, so a collection
  // that failed is what the row has to report -- ccusage's Pi row is the
  // duplicated one this plugin replaces, and silence is not "nothing today".
  const report = local?.[agent];
  if (agent === 'omp' || agent === 'pi') return report?.rows ? 'No measured activity today' : report?.reason ?? 'Local activity unavailable';
  if (!CCUSAGE_AGENTS.has(agent)) return 'Local activity unsupported by ccusage';
  return failure ?? 'No measured activity today';
}

function providerLimits(provider, codex) {
  return provider === 'codex' ? codex.series : [];
}

function limitLabel(provider, claudeLimits, codex) {
  if (provider === 'claude') return claudeLimits.length ? 'Claude plan usage' : 'Claude plan limits unavailable';
  if (provider === 'codex') return codex.series.length ? codex.remainingLabel : 'Codex plan limits unavailable';
  // The plan may well exist; muxr just has no integration that can read it.
  return 'Plan limits aren\u2019t connected in muxr';
}

// The identity includes the selected Go credential. Use a bounded KDF rather
// than a fast hash; the stable domain salt keeps cache comparisons deterministic.
const cacheIdentity = scryptSync(JSON.stringify({
  config: Object.fromEntries(['HOME', 'PATH', 'XDG_DATA_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OPENCODE_DB', 'OPENCODE_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TZ'].map((key) => [key, process.env[key] ?? null])),
  go: goAuthSelection(),
}), 'muxr.status/usage/cache-identity/v4', 32, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex');
const cached = cachedOutput();
if (cached !== undefined) {
  process.stdout.write(JSON.stringify(cached));
} else {
  // Codex limits load every time: the home card lists them whatever tab the
  // details screen last showed.
  const [range, codex, local] = await Promise.all([
    ccusageRange(), codexUsage().then(codexItems),
    runJson(process.execPath, [fileURLToPath(new URL('./localUsage.mjs', import.meta.url)), JSON.stringify(PERIODS), String(NOW.getTime())], 5_000),
  ]);
  const agents = byAgent(range);
  const latest = new Map();
  for (const row of range?.session ?? []) {
    if (!CCUSAGE_AGENTS.has(row?.agent) || !(row.totalTokens > 0)) continue;
    const at = Date.parse(row.metadata?.lastActivity);
    if (Number.isFinite(at) && at <= NOW.getTime()) latest.set(row.agent, Math.max(latest.get(row.agent) ?? 0, at));
  }
  // OMP and Pi are accounted from their own transcripts, so ccusage's rows for
  // them are the duplicated ones this collector replaces. A child that timed
  // out, crashed or answered with nothing leaves no total to fall back to.
  const reports = local !== null && typeof local === 'object' ? { ...local } : {};
  for (const agent of ['omp', 'pi']) {
    const report = reports[agent];
    if (report === null || typeof report !== 'object' || !Array.isArray(report.rows) && report.unavailable !== true) {
      reports[agent] = { unavailable: true, reason: 'Local activity could not be measured · reopen Usage in a minute' };
    }
  }
  for (const [agent, report] of Object.entries(reports)) {
    if (Number.isFinite(report.latest) && report.latest <= NOW.getTime()) latest.set(agent, report.latest);
    if (report.unavailable) { agents.delete(agent); continue; }
    if (!report.rows) continue;
    const days = PERIODS.map((period) => ({ period, row: undefined }));
    for (const aggregate of report.rows) {
      if (!Number.isSafeInteger(aggregate.totalTokens) || aggregate.totalTokens < 0) continue;
      const day = days.find((day) => day.period === aggregate.period);
      if (!day) continue;
      day.row ??= { totalTokens: 0, totalCost: 0, modelBreakdowns: [] };
      day.row.totalTokens += aggregate.totalTokens;
      day.row.totalCost = Number.isFinite(day.row.totalCost) && Number.isFinite(aggregate.totalCost) ? day.row.totalCost + aggregate.totalCost : undefined;
      day.row.modelBreakdowns.push(aggregate);
    }
    agents.set(agent, days);
  }
  const activity = ccusageItems(agents);
  const installed = Object.entries(AGENT_COMMANDS).filter(([agent, command]) => installedAgent(agent, command));
  // A tab means real integration: measured activity this week, or a connected
  // plan/account. Installed-but-idle CLIs are neither, so they earn no tab;
  // a deep link to one falls back to the default tab. OMP and Pi are measured
  // by muxr's own collector, so their tabs (and a failed collection's honest
  // message) always stay.
  const planConnected = [
    ['claude', claudeCredentials() !== undefined], ['opencode', goConnected()], ['zai', zaiToken() !== undefined],
  ].flatMap(([agent, connected]) => (connected ? [agent] : []));
  const providerIds = [...new Set([...agents.keys(), ...latest.keys(), ...Object.keys(reports), ...planConnected, ...(codex.items.length ? ['codex'] : [])])]
    .sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0) || AGENTS[a].localeCompare(AGENTS[b]));
  const provider = providerIds.includes(selected) ? selected : providerIds[0] ?? '';
  const activitySupported = CCUSAGE_AGENTS.has(provider) || provider === 'omp';
  const localReport = reports[provider];
  let activityFailure = ccusageFailure;
  if (localReport?.rows) activityFailure = undefined;
  if (localReport?.unavailable) activityFailure = localReport.reason ?? 'Local activity unavailable';
  const activityAvailable = activitySupported && activityFailure === undefined;
  let activityLabel = 'Local activity from ccusage; costs are estimates, not plan usage';
  if (!agents.get(provider)?.some(({ row }) => row?.totalTokens > 0)) activityLabel = 'No local activity found in the last 7 days';
  if (localReport?.rows) activityLabel = 'Recorded local activity; costs are separate from plan limits';
  if (activityFailure) activityLabel = activityFailure;
  if (!activitySupported) activityLabel = 'Local activity unsupported by ccusage for this provider';
  if (!provider) activityLabel = ccusageFailure ?? 'No supported providers detected';
  const days = agents.get(provider) ?? PERIODS.map((period) => ({ period, row: undefined }));
  const today = days[days.length - 1]?.row;
  const weekTokens = days.reduce((sum, day) => sum + (day.row?.totalTokens ?? 0), 0);
  const weekCost = days.reduce((sum, day) => sum + (day.row?.totalCost ?? 0), 0);
  const [claudeLimits, go, zaiPlan] = await Promise.all([
    provider === 'claude' ? claudePlanLimits() : [],
    provider === 'opencode' ? goPlanLimits() : { series: [], label: '' },
    provider === 'zai' ? zaiPlanLimits() : { series: [], label: '' },
  ]);
  const fiveHour = claudeLimits.find((limit) => limit.id === 'five_hour');
  const sevenDay = claudeLimits.find((limit) => limit.id === 'seven_day');
  const items = [];
  if (ccusageFailure) items.push({
    id: 'ccusage-unavailable', title: 'Local activity unavailable', subtitle: ccusageFailure, icon: 'warning-outline', metadata: [],
  });
  const reported = new Set(activity.agents);
  if (codex.items.length) reported.add('codex');
  for (const [agent] of installed) {
    if (reported.has(agent)) continue;
    items.push({
      id: `available-${agent}`, title: AGENTS[agent], icon: 'terminal-outline', metadata: [],
      group: 'Local activity',
      subtitle: idleLabel(agent, reports, ccusageFailure),
      action: { type: 'screen', contributionId: 'usage.details', params: { provider: agent } },
    });
  }
  // Rate limits lead (they need attention), then today's activity, then idle.
  const ordered = [...codex.items, ...activity.items, ...items];
  const totalTokens = tokens(activity.totalTokens);
  const output = {
    items: ordered.slice(0, 50),
    actions: [{ id: 'details', label: 'Open full usage', icon: 'stats-chart-outline', action: { type: 'screen', contributionId: 'usage.details' } }],
    ...(activity.totalTokens > 0 && totalTokens !== undefined
      ? { badge: { value: `${totalTokens} tokens today` } }
      : {}),
    summary: {
      measured: String(activity.series.length),
      installed: String(installed.length),
      totalTokens: totalTokens ?? '0',
    },
    activitySeries: activity.series,
    providers: providerIds.map((agent) => ({ id: agent, label: AGENTS[agent] })),
    provider,
    providerName: AGENTS[provider] ?? 'Usage',
    activityLabel,
    todayTokens: activityAvailable ? tokens(today?.totalTokens ?? 0) ?? '—' : '—',
    // A measured day with no activity cost nothing; a measured row whose cost
    // was never recorded is unknown, and a dash is the only honest figure.
    todayCost: activityAvailable ? (today === undefined ? '$0.00' : money(today.totalCost) ?? '—') : '—',
    modelSeries: modelSeries(today),
    weekTokens: activityAvailable ? tokens(weekTokens) ?? '—' : '—',
    weekCost: activityAvailable && days.every(({ row }) => row === undefined || Number.isFinite(row.totalCost)) ? money(weekCost) ?? '—' : '—',
    weekSeries: (activityAvailable ? days : []).map(({ period, row }) => ({
      label: dayLabel(period), value: row?.totalTokens ?? 0, valueLabel: tokens(row?.totalTokens ?? 0) ?? '0', detail: period,
    })),
    capturedAt: NOW.toISOString(),
    windowPeriods: PERIODS,
    limitSeries: provider === 'opencode' ? go.series : provider === 'zai' ? zaiPlan.series : providerLimits(provider, codex),
    limitRing: provider === 'codex' ? codex.ring : [],
    ...(fiveHour === undefined ? {} : {
      fiveHourUsed: fiveHour.used,
      fiveHourLabel: headroomLabel({
        used: fiveHour.used, windowMinutes: WINDOW_MINUTES.five_hour,
        resetEpochSec: fiveHour.resetAt, nowMs: Date.now(),
      }),
    }),
    ...(sevenDay === undefined ? {} : {
      sevenDayUsed: sevenDay.used,
      sevenDayLabel: headroomLabel({
        used: sevenDay.used, windowMinutes: WINDOW_MINUTES.seven_day,
        resetEpochSec: sevenDay.resetAt, nowMs: Date.now(),
      }),
    }),
    limitLabel: provider === 'opencode' ? go.label : provider === 'zai' ? zaiPlan.label : limitLabel(provider, claudeLimits, codex),
    codexRemaining: codex.remaining,
    codexRemainingLabel: codex.remainingLabel,
  };
  if (output.items.length === 0) output.items.push({ id: 'usage-unavailable', title: 'Usage unavailable', icon: 'warning-outline', metadata: [] });
  // Never pin a failure or a fallback provider under the requested key: one
  // blocked ccusage read would otherwise own the screen for the whole TTL.
  const goUnavailable = provider === 'opencode' && go.series.length === 0;
  const claudeUnavailable = provider === 'claude' && claudeLimits.length === 0;
  const zaiUnavailable = provider === 'zai' && zaiPlan.series.length === 0;
  const codexUnavailable = installed.some(([agent]) => agent === 'codex') && codex.series.length === 0;
  const limitsUnavailable = goUnavailable || claudeUnavailable || zaiUnavailable || codexUnavailable;
  const localUnavailable = Object.values(reports).some((report) => report.unavailable);
  if (ccusageFailure === undefined && activityFailure === undefined && !localUnavailable && !limitsUnavailable && (selected === '' || selected === output.provider)) saveOutput(output);
  process.stdout.write(JSON.stringify(output));
}
