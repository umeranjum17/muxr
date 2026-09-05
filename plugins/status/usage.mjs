#!/usr/bin/env node
import { scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, accessSync, chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';

const require = createRequire(import.meta.url);
const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
// The host injects this private stdin field only after checking this bundled
// script's canonical path. Keep Go auth content out of descendant environments.
const config = process.env.MUXR_PLUGIN_ID === 'muxr.status' ? input._usageConfig ?? {} : {};
for (const key of ['XDG_DATA_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OPENCODE_DB', 'OPENCODE_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TZ']) {
  if (typeof config[key] === 'string') process.env[key] = config[key];
}

/** Which provider tab the screen asked for; empty means most recently used. */
const requested = String(input.provider ?? '').slice(0, 32);
let ccusageFailure;
const AGENTS = {
  claude: 'Anthropic Claude', codex: 'OpenAI Codex', opencode: 'OpenCode', amp: 'Amp', droid: 'Droid', codebuff: 'Codebuff',
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
function windowPeriods() {
  const origin = nowDate();
  // Local midnight, then setDate — fixed 86_400_000 ms skips a DST spring-forward day.
  return Array.from({ length: RANGE_DAYS }, (_, index) => {
    const at = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate());
    at.setDate(at.getDate() - (RANGE_DAYS - 1 - index));
    return localDate(at);
  });
}


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
    const reset = relativeReset(resetAt);
    return [{ id, label, used: Math.round(utilization), reset }];
  });
}

function readJson(path, maxBytes) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return undefined;
    return { value: JSON.parse(readFileSync(path, 'utf8')), modified: stat.mtimeMs };
  } catch { return undefined; }
}

async function claudePlanLimits() {
  const config = process.env.CLAUDE_CONFIG_DIR?.trim() || join(process.env.HOME?.trim() || homedir(), '.claude');
  const snapshot = readJson(join(config, 'last-statusline-input.json'), 64 * 1024);
  const snapshotAge = snapshot === undefined ? undefined : Date.now() - snapshot.modified;
  if (snapshotAge !== undefined && snapshotAge >= 0 && snapshotAge < 5 * 60_000) {
    const limits = parseClaudeLimits(snapshot.value);
    if (limits.length > 0) return limits;
  }
  const credentials = readJson(join(config, '.credentials.json'), 64 * 1024)?.value?.claudeAiOauth;
  const token = typeof credentials?.accessToken === 'string' && credentials.accessToken.length <= 16 * 1024 ? credentials.accessToken : undefined;
  if (token === undefined || Number.isFinite(credentials?.expiresAt) && credentials.expiresAt <= Date.now()) return [];
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

async function goPlanLimits() {
  const { auth } = goAuthSelection();
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim() || auth.key.length > 16 * 1024) {
    return { series: [], label: 'OpenCode Go limits unavailable · connect your Go account in OpenCode' };
  }
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
      const used = Math.min(100, window.percent);
      const reset = relativeReset(Date.parse(window.resetsAt) / 1000);
      return [{ label, value: used, valueLabel: `${Math.round(used)}% used`, tone: limitTone(100 - used), ...(reset ? { detail: reset } : {}) }];
    });
    if (series.length !== 3) return { series: [], label: 'OpenCode Go limits unavailable · incomplete response' };
    return { series, label: 'OpenCode Go plan usage' };
  } catch { return { series: [], label: 'OpenCode Go limits unavailable · try again shortly' }; }
  finally { clearTimeout(timer); }
}

function money(value) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
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
  const periods = windowPeriods();
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
    const age = Date.now() - saved.at;
    const maxAge = saved.output?.provider === 'claude' ? 15_000 : 60_000;
    if (saved.identity === cacheIdentity && age >= 0 && age < maxAge && Array.isArray(saved.output?.items) && Buffer.byteLength(JSON.stringify(saved.output)) <= 65_536) return saved.output;
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
    writeFileSync(temporary, JSON.stringify({ at: Date.now(), identity: cacheIdentity, output }), { mode: 0o600 });
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

function relativeReset(seconds) {
  if (!Number.isFinite(seconds) || seconds * 1000 < Date.now() - 86_400_000 || seconds * 1000 > Date.now() + 366 * 86_400_000) return '';
  let minutes = Math.max(0, Math.ceil((seconds * 1000 - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1440); minutes -= days * 1440;
  const hours = Math.floor(minutes / 60); minutes = Math.floor(minutes - hours * 60);
  return [days && `${days}d`, hours && `${hours}h`, !days && minutes && `${minutes}m`].filter(Boolean).join(' ');
}

function limitTone(remaining) {
  if (remaining <= 10) return 'danger';
  if (remaining <= 25) return 'warning';
  return 'positive';
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
      const minutes = window.windowDurationMins;
      let duration = key;
      if (Number.isFinite(minutes) && minutes > 0) duration = `${minutes / 60}h`;
      const windowName = `${name} · ${duration}`;
      const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
      const reset = relativeReset(window?.resetsAt);
      return [{ index: index * 2 + Number(key === 'secondary'), name: windowName, remaining, reset }];
    });
  });
  // Critical windows first: the limit you are about to hit leads the list.
  parsed.sort((a, b) => (a.remaining ?? 101) - (b.remaining ?? 101) || a.index - b.index);
  const details = parsed.slice(0, 8);
  const items = parsed.map(({ index, name, remaining, reset }) => ({
    id: `limit-codex-${index}`, title: name, subtitle: 'OpenAI Codex current limit', icon: 'speedometer-outline',
    group: 'Rate limits',
    ...(remaining === undefined ? {} : { progress: { value: remaining / 100, tone: limitTone(remaining) } }),
    metadata: [
      { value: remaining === undefined ? 'Available' : `${remaining}% left`, ...(remaining === undefined ? {} : { tone: limitTone(remaining) }) },
      ...(reset ? [{ value: `resets in ${reset}` }] : []),
    ],
  }));
  const first = details.length === 0 ? undefined : details.reduce((lowest, limit) => (limit.remaining < lowest.remaining ? limit : lowest));
  return {
    items,
    // detail carries the reset clock, so a limit row reads "75% · 1h 53m".
    series: details.map((limit) => ({
      label: limit.name, value: limit.remaining, valueLabel: `${limit.remaining}%`, tone: limitTone(limit.remaining),
      ...(limit.reset ? { detail: limit.reset } : {}),
    })),
    ring: first === undefined ? [] : [
      { label: 'Remaining', value: first.remaining, valueLabel: `${first.remaining}%`, tone: limitTone(first.remaining), ...(first.reset ? { detail: first.reset } : {}) },
      { label: 'Used', value: 100 - first.remaining, valueLabel: `${100 - first.remaining}%`, tone: 'secondary' },
    ],
    remaining: first?.remaining ?? 0,
    remainingLabel: first === undefined ? 'Unavailable' : `${first.remaining}% left${first.reset ? ` · resets in ${first.reset}` : ''}`,
  };
}

function idleLabel(agent, local, failure) {
  if (agent === 'omp') return local?.omp?.rows ? 'No measured activity today' : local?.omp?.reason ?? 'Local usage database unavailable';
  if (!CCUSAGE_AGENTS.has(agent)) return 'Local activity unsupported by ccusage';
  return failure ?? 'No measured activity today';
}

function providerLimits(provider, codex) {
  return provider === 'codex' ? codex.series : [];
}

function limitLabel(provider, claudeLimits, codex) {
  if (provider === 'claude') return claudeLimits.length ? 'Claude plan usage' : 'Claude plan limits unavailable';
  if (provider === 'codex') return codex.series.length ? codex.remainingLabel : 'Codex plan limits unavailable';
  return 'Plan limits unsupported for this provider';
}

// The identity includes the selected Go credential. Use a bounded KDF rather
// than a fast hash; the stable domain salt keeps cache comparisons deterministic.
const cacheIdentity = scryptSync(JSON.stringify({
  config: Object.fromEntries(['HOME', 'PATH', 'XDG_DATA_HOME', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OPENCODE_DB', 'OPENCODE_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TZ'].map((key) => [key, process.env[key] ?? null])),
  go: goAuthSelection(),
}), 'muxr.status/usage/cache-identity/v3', 32, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }).toString('hex');
const cached = cachedOutput();
if (cached !== undefined) {
  process.stdout.write(JSON.stringify(cached));
} else {
  // Codex limits load every time: the home card lists them whatever tab the
  // details screen last showed.
  const [range, codex, local] = await Promise.all([
    ccusageRange(), codexUsage().then(codexItems),
    runJson(process.execPath, [fileURLToPath(new URL('./localUsage.mjs', import.meta.url)), JSON.stringify(windowPeriods()), String(nowDate().getTime())], 5_000),
  ]);
  const agents = byAgent(range);
  const latest = new Map();
  for (const row of range?.session ?? []) {
    if (!CCUSAGE_AGENTS.has(row?.agent) || !(row.totalTokens > 0)) continue;
    const at = Date.parse(row.metadata?.lastActivity);
    if (Number.isFinite(at) && at <= nowDate().getTime()) latest.set(row.agent, Math.max(latest.get(row.agent) ?? 0, at));
  }
  for (const [agent, report] of Object.entries(local ?? {})) {
    if (Number.isFinite(report.latest) && report.latest <= nowDate().getTime()) latest.set(agent, report.latest);
    if (!report.rows) continue;
    const days = windowPeriods().map((period) => ({ period, row: undefined }));
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
  // A provider earns a tab by having measured usage this week or a CLI on the
  // host; an installed-but-idle agent still deserves a tab that says so.
  const providerIds = [...new Set([...agents.keys(), ...latest.keys(), ...installed.map(([agent]) => agent), ...(selected ? [selected] : []), ...(codex.items.length ? ['codex'] : [])])]
    .sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0) || AGENTS[a].localeCompare(AGENTS[b]));
  const provider = providerIds.includes(selected) ? selected : providerIds[0] ?? '';
  const activitySupported = CCUSAGE_AGENTS.has(provider) || provider === 'omp';
  const localReport = local?.[provider];
  let activityFailure = ccusageFailure;
  if (localReport?.rows) activityFailure = undefined;
  if (provider === 'omp' && !localReport?.rows) activityFailure = localReport?.reason ?? 'Local usage database unavailable';
  const activityAvailable = activitySupported && activityFailure === undefined;
  let activityLabel = 'Local activity from ccusage; costs are estimates, not plan usage';
  if (!agents.get(provider)?.some(({ row }) => row?.totalTokens > 0)) activityLabel = 'No local activity found in the last 7 days';
  if (localReport?.rows) activityLabel = 'Recorded local activity; costs are separate from plan limits';
  if (activityFailure) activityLabel = activityFailure;
  if (!activitySupported) activityLabel = 'Local activity unsupported by ccusage for this provider';
  if (!provider) activityLabel = ccusageFailure ?? 'No supported providers detected';
  const days = agents.get(provider) ?? windowPeriods().map((period) => ({ period, row: undefined }));
  const today = days[days.length - 1]?.row;
  const weekTokens = days.reduce((sum, day) => sum + (day.row?.totalTokens ?? 0), 0);
  const weekCost = days.reduce((sum, day) => sum + (day.row?.totalCost ?? 0), 0);
  const [claudeLimits, go] = await Promise.all([
    provider === 'claude' ? claudePlanLimits() : [],
    provider === 'opencode' ? goPlanLimits() : { series: [], label: '' },
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
      subtitle: idleLabel(agent, local, ccusageFailure),
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
    todayCost: activityAvailable ? money(today?.totalCost) ?? '—' : '—',
    modelSeries: modelSeries(today),
    weekTokens: activityAvailable ? tokens(weekTokens) ?? '—' : '—',
    weekCost: activityAvailable && days.every(({ row }) => row === undefined || Number.isFinite(row.totalCost)) ? money(weekCost) ?? '—' : '—',
    weekSeries: (activityAvailable ? days : []).map(({ period, row }) => ({
      label: dayLabel(period), value: row?.totalTokens ?? 0, valueLabel: tokens(row?.totalTokens ?? 0) ?? '0',
    })),
    limitSeries: provider === 'opencode' ? go.series : providerLimits(provider, codex),
    limitRing: provider === 'codex' ? codex.ring : [],
    ...(fiveHour === undefined ? {} : {
      fiveHourUsed: fiveHour.used,
      fiveHourLabel: `${fiveHour.used}% used${fiveHour.reset ? ` · resets in ${fiveHour.reset}` : ''}`,
    }),
    ...(sevenDay === undefined ? {} : {
      sevenDayUsed: sevenDay.used,
      sevenDayLabel: `${sevenDay.used}% used${sevenDay.reset ? ` · resets in ${sevenDay.reset}` : ''}`,
    }),
    limitLabel: provider === 'opencode' ? go.label : limitLabel(provider, claudeLimits, codex),
    codexRemaining: codex.remaining,
    codexRemainingLabel: codex.remainingLabel,
  };
  if (output.items.length === 0) output.items.push({ id: 'usage-unavailable', title: 'Usage unavailable', icon: 'warning-outline', metadata: [] });
  // Never pin a failure or a fallback provider under the requested key: one
  // blocked ccusage read would otherwise own the screen for the whole TTL.
  const goUnavailable = provider === 'opencode' && go.series.length === 0;
  const claudeUnavailable = provider === 'claude' && claudeLimits.length === 0;
  const codexUnavailable = installed.some(([agent]) => agent === 'codex') && codex.series.length === 0;
  const limitsUnavailable = goUnavailable || claudeUnavailable || codexUnavailable;
  const localUnavailable = local === undefined || Object.values(local).some((report) => report.unavailable);
  if (ccusageFailure === undefined && activityFailure === undefined && !localUnavailable && !limitsUnavailable && (selected === '' || selected === output.provider)) saveOutput(output);
  process.stdout.write(JSON.stringify(output));
}
