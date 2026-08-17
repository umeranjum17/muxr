#!/usr/bin/env node
// Example RPC backend for the declarative screen example. Runs on the host as
// the machine user; keep it read-only and side-effect free.
import { readFileSync } from 'node:fs';

const [method] = process.argv.slice(2);
const input = (() => {
    try { return JSON.parse(readFileSync(0, 'utf8') || 'null'); }
    catch { return null; }
})();

const reply = (value) => { process.stdout.write(JSON.stringify(value)); };
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };

if (method === 'list') {
    reply({
        title: 'Example plugin',
        status: 'Approved',
        progress: 60,
        agents: [
            { label: 'Working', value: 3, tone: 'positive' },
            { label: 'Waiting', value: 1, tone: 'warning' },
            { label: 'Idle', value: 2, tone: 'secondary' },
        ],
        sessions: [
            { title: 'landing page', cwd: '/work/site', status: 'idle' },
            { title: 'api server', cwd: '/work/api', status: 'working' },
            { title: 'cli tool', cwd: '/work/cli', status: 'done' },
        ],
    });
} else if (method === 'save') {
    // Echo the bounded form payload back; write nothing. A real plugin would
    // persist under MUXR_PLUGIN_STATE_DIR. Herdr actions (not RPCs) receive
    // HERDR_PLUGIN_STATE_DIR / HERDR_PLUGIN_CONTEXT_JSON.
    const name = typeof input?.name === 'string' ? input.name.slice(0, 80) : '';
    const enabled = input?.enabled === true;
    const tier = ['free', 'pro'].includes(input?.tier) ? input.tier : 'free';
    reply({ saved: true, name, enabled, tier });
} else {
    fail(`unknown method: ${method}`);
}
