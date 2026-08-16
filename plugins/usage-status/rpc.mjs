#!/usr/bin/env node
import { execFile } from 'node:child_process';
const child = execFile('pi', ['--print', '--mode', 'json', '--no-session', '--no-tools', '--no-skills', '-np', '--no-context-files', '/quota'], { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
  if (error) process.exit(1);
  for (const line of stdout.split('\n').reverse()) {
    try { const event = JSON.parse(line); if (event.message?.customType === 'subscription-usage') { process.stdout.write(JSON.stringify(event.message.content)); return; } } catch {}
  }
  process.stdout.write(JSON.stringify('Usage unavailable'));
});
child.stdin?.end();
