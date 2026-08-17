#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants, accessSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function available(command) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { accessSync(join(directory, command), constants.X_OK); return true; } catch {}
  }
  return false;
}

function codexUsage() {
  if (!available('codex')) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1_000).unref();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 8_000);
    child.once('error', () => finish(undefined));
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

function codexText(result) {
  const limits = Object.values(result?.rateLimitsByLimitId ?? {});
  if (!limits.length && result?.rateLimits) limits.push(result.rateLimits);
  if (!limits.length) return undefined;
  return ['OpenAI Codex', ...limits.slice(0, 16).map((limit) => {
    const window = limit.primary;
    const name = String(limit.limitName ?? limit.limitId ?? 'Codex').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Codex';
    const left = Number.isFinite(window?.usedPercent) ? `${Math.max(0, Math.min(100, 100 - window.usedPercent))}% left` : 'usage available';
    const reset = relativeReset(window?.resetsAt);
    return `  ${name}  ${left}${reset ? ` · resets in ${reset}` : ''}`;
  })].join('\n');
}

const sections = [];
const codexAvailable = available('codex');
const codex = codexText(await codexUsage());
if (codex) sections.push(codex);
else if (codexAvailable) sections.push('OpenAI Codex\n  CLI available · open /usage in that CLI for current limits');
const visible = [
  ['pi', 'Pi'],
  ['claude', 'Anthropic Claude'],
  ['kimi', 'Kimi Code'],
  ['cursor', 'Cursor'],
  ['grok', 'xAI Grok'],
  ['gemini', 'Gemini CLI'],
].filter(([command]) => available(command)).map(([, name]) => `${name}\n  CLI available · open /usage in that CLI for current limits`);
sections.push(...visible);
process.stdout.write(JSON.stringify(sections.join('\n') || 'Usage unavailable'));
