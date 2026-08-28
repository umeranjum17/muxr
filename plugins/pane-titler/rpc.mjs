#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { readAgentName, renameAgent } from './agent-name.mjs';

const [method] = process.argv.slice(2);
const input = (() => {
    try { return JSON.parse(readFileSync(0, 'utf8') || 'null'); }
    catch { return null; }
})();
const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';
const path = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), join(homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(delimiter);
const run = (args) => execFileSync(herdr, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: path } });
const paneId = typeof input?.paneId === 'string' ? input.paneId : undefined;
if (paneId === undefined) throw new Error('Agent session is unavailable.');

if (method === 'read') {
    process.stdout.write(JSON.stringify({ agentName: readAgentName(run, paneId) ?? 'Agent' }));
} else if (method === 'rename') {
    process.stdout.write(JSON.stringify({ agentName: renameAgent(run, paneId, input?.name) }));
} else {
    throw new Error(`unknown method: ${method}`);
}
