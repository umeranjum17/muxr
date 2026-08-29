#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { backfillAgentNames } from './agent-name.mjs';

const herdr = process.env.HERDR_BIN_PATH?.trim() || 'herdr';
const path = [process.env.PATH ?? '', join(homedir(), '.local', 'bin'), join(homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(delimiter);
const run = (args) => execFileSync(herdr, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: path } });

backfillAgentNames(run);
