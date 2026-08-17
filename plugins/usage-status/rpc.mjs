#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants, accessSync, chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';

const require = createRequire(import.meta.url);
let ccusageFailure;
const AGENTS = {
  claude: 'Anthropic Claude', codex: 'OpenAI Codex', opencode: 'OpenCode', amp: 'Amp', droid: 'Droid', codebuff: 'Codebuff',
  hermes: 'Hermes Agent', pi: 'Pi', goose: 'Goose', openclaw: 'OpenClaw', kilo: 'Kilo Code', kimi: 'Kimi Code', qwen: 'Qwen',
  copilot: 'GitHub Copilot CLI', gemini: 'Gemini CLI', grok: 'xAI Grok', cursor: 'Cursor', omp: 'OMP',
};
const CCUSAGE_AGENTS = new Set(Object.keys(AGENTS).filter((agent) => agent !== 'cursor' && agent !== 'omp'));
const AGENT_COMMANDS = { ...Object.fromEntries(Object.keys(AGENTS).map((agent) => [agent, agent])), cursor: 'cursor-agent' };

function available(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { accessSync(join(directory, command), constants.X_OK); return true; } catch {}
  }
  return false;
}

function ccusageBinary() {
  if (process.env.MUXR_CCUSAGE_BIN?.trim()) return process.env.MUXR_CCUSAGE_BIN.trim();
  const target = {
    'darwin-arm64': '@ccusage/ccusage-darwin-arm64', 'darwin-x64': '@ccusage/ccusage-darwin-x64',
    'linux-arm64': '@ccusage/ccusage-linux-arm64', 'linux-x64': '@ccusage/ccusage-linux-x64',
  }[`${process.platform}-${process.arch}`];
  if (!target) return undefined;
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
      if (buffer.length > 64 * 1024) finish(undefined);
    });
    child.once('close', (code) => {
      if (escalation) clearTimeout(escalation);
      if (code !== 0) { finish(undefined); return; }
      try { finish(JSON.parse(buffer)); } catch { finish(undefined); }
    });
  });
}

async function ccusageDaily() {
  const binary = ccusageBinary();
  if (!binary) return undefined;
  const result = await runJson(binary, ['daily', '--last', '1', '--by-agent', '--json', '--no-cost', '--offline'], 15_000);
  if (result === undefined && ccusageFailure === undefined) ccusageFailure = 'ccusage activity unavailable · reopen Usage in a minute';
  return result;
}

function tokens(value) {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function ccusageItems(result) {
  const totals = new Map();
  for (const day of Array.isArray(result?.daily) ? result.daily.slice(0, 1) : []) {
    for (const row of Array.isArray(day?.agents) ? day.agents.slice(0, 32) : []) {
      if (!CCUSAGE_AGENTS.has(row?.agent) || !Number.isSafeInteger(row.totalTokens) || row.totalTokens < 0) continue;
      totals.set(row.agent, (totals.get(row.agent) ?? 0) + row.totalTokens);
    }
  }
  const sorted = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 16);
  const items = sorted.flatMap(([agent, total]) => {
    const value = tokens(total);
    return value === undefined ? [] : [{
      id: `activity-${agent}`, title: AGENTS[agent], subtitle: 'Local activity today · ccusage', icon: 'analytics-outline',
      metadata: [{ value: `${value} tokens`, tone: 'primary' }],
    }];
  });
  const series = sorted.slice(0, 8).flatMap(([agent, total]) => {
    const valueLabel = tokens(total);
    return valueLabel === undefined ? [] : [{ label: AGENTS[agent], value: total, valueLabel }];
  });
  return { items, series, agents: new Set(totals.keys()) };
}

function cachedOutput() {
  const state = process.env.MUXR_PLUGIN_STATE_DIR?.trim();
  if (!state) return undefined;
  try {
    const saved = JSON.parse(readFileSync(join(state, 'usage.json'), 'utf8'));
    const age = Date.now() - saved.at;
    if (age >= 0 && age < 60_000 && Array.isArray(saved.output?.items) && JSON.stringify(saved.output).length <= 16_384) return saved.output;
  } catch {}
  return undefined;
}

function saveOutput(output) {
  const state = process.env.MUXR_PLUGIN_STATE_DIR?.trim();
  if (!state) return;
  const cache = join(state, 'usage.json');
  const temporary = `${cache}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ at: Date.now(), output }), { mode: 0o600 });
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

function codexItems(result) {
  const limits = Object.values(result?.rateLimitsByLimitId ?? {});
  if (!limits.length && result?.rateLimits) limits.push(result.rateLimits);
  const details = [];
  const items = limits.slice(0, 16).map((limit, index) => {
    const window = limit.primary;
    const rawName = String(limit.limitName ?? limit.limitId ?? 'Codex').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Codex';
    const name = rawName.toLowerCase() === 'codex' ? AGENTS.codex : rawName;
    const remaining = Number.isFinite(window?.usedPercent) ? Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))) : undefined;
    const reset = relativeReset(window?.resetsAt);
    if (remaining !== undefined && details.length < 8) details.push({ name, remaining, reset });
    return {
      id: `limit-codex-${index}`, title: name, subtitle: 'OpenAI Codex current limit', icon: 'speedometer-outline',
      metadata: [
        { value: remaining === undefined ? 'Available' : `${remaining}% left`, ...(remaining === undefined ? {} : { tone: remaining <= 10 ? 'danger' : remaining <= 25 ? 'warning' : 'positive' }) },
        ...(reset ? [{ label: 'Resets', value: `in ${reset}` }] : []),
      ],
    };
  });
  const first = details.length === 0 ? undefined : details.reduce((lowest, limit) => (limit.remaining < lowest.remaining ? limit : lowest));
  return {
    items,
    series: details.map((limit) => ({ label: limit.name, value: limit.remaining, valueLabel: `${limit.remaining}%` })),
    ring: first === undefined ? [] : [
      { label: 'Remaining', value: first.remaining, valueLabel: `${first.remaining}%`, tone: first.remaining <= 10 ? 'danger' : first.remaining <= 25 ? 'warning' : 'positive' },
      { label: 'Used', value: 100 - first.remaining, valueLabel: `${100 - first.remaining}%`, tone: 'secondary' },
    ],
    remaining: first?.remaining ?? 0,
    remainingLabel: first === undefined ? 'Unavailable' : `${first.remaining}% left${first.reset ? ` · resets in ${first.reset}` : ''}`,
  };
}

const cached = cachedOutput();
if (cached !== undefined) {
  process.stdout.write(JSON.stringify(cached));
} else {
  const [activity, codex] = await Promise.all([
    ccusageDaily().then(ccusageItems),
    codexUsage().then(codexItems),
  ]);
  const items = [...activity.items, ...codex.items];
  if (ccusageFailure && activity.items.length === 0) items.push({
    id: 'ccusage-unavailable', title: 'Local activity unavailable', subtitle: ccusageFailure, icon: 'warning-outline', metadata: [],
  });
  const reported = new Set(activity.agents);
  if (codex.items.length) reported.add('codex');
  const installedAgents = Object.entries(AGENT_COMMANDS).filter(([, command]) => available(command));
  for (const [agent] of installedAgents) {
    if (reported.has(agent)) continue;
    items.push({
      id: `available-${agent}`, title: AGENTS[agent], icon: 'terminal-outline', metadata: [{ value: 'Installed' }],
      subtitle: CCUSAGE_AGENTS.has(agent) ? 'No activity reported by ccusage today' : 'Local totals unsupported by ccusage',
    });
  }
  const output = {
    items: items.slice(0, 50), actions: [],
    summary: { measured: String(activity.series.length), installed: String(installedAgents.length) },
    activitySeries: activity.series,
    codexSeries: codex.series,
    codexRing: codex.ring,
    codexRemaining: codex.remaining,
    codexRemainingLabel: codex.remainingLabel,
  };
  if (output.items.length === 0) output.items.push({ id: 'usage-unavailable', title: 'Usage unavailable', icon: 'warning-outline', metadata: [] });
  saveOutput(output);
  process.stdout.write(JSON.stringify(output));
}
