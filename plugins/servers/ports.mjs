#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8') || 'null') ?? {};
const method = process.argv[2];

function listening() {
  const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return out.split('\n').slice(1).filter(Boolean).flatMap((line) => {
    const address = line.trim().split(/\s+/)[3] ?? '';
    const port = address.split(':').pop() ?? '';
    const pid = /pid=(\d+)/.exec(line)?.[1] ?? '';
    const name = /"([^"]+)"/.exec(line)?.[1] ?? 'unknown';
    return port && pid ? [{ port, pid, name, title: `:${port}`, subtitle: `${name} · pid ${pid}` }] : [];
  }).slice(0, 32);
}

if (method === 'list') {
  const ports = listening();
  process.stdout.write(JSON.stringify({ title: `${ports.length} listening`, ports }));
} else if (method === 'detail') {
  const found = listening().find((entry) => entry.pid === String(input.pid ?? ''));
  process.stdout.write(JSON.stringify(found ?? { title: 'gone', subtitle: 'no longer listening', pid: '', port: '', name: '' }));
} else {
  const pid = Number.parseInt(String(input.pid ?? ''), 10);
  // Only ever signal a pid this machine is currently listening on.
  if (!listening().some((entry) => entry.pid === String(pid))) throw new Error('not a listening process');
  process.kill(pid, 'SIGTERM');
  process.stdout.write(JSON.stringify(`sent SIGTERM to ${pid}`));
}
