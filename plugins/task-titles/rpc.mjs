#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { rpc } from './runtime.mjs';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8') || 'null'); } catch { input = null; }
try {
    const result = await rpc(process.argv[2], input, process.env.MUXR_TASK_TITLES_CONFIG_DIR);
    process.stdout.write(JSON.stringify(result));
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Task titles unavailable'}\n`);
    process.exitCode = 1;
}
