#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reportAgentOutcome } from '../voice/coordinatorPolicy.mjs';

const method = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8') || 'null');
const codex = process.env.MUXR_CODEX_BIN?.trim() || 'codex';
const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');

function credentialFileIsPrivate() {
    try {
        const root = lstatSync(codexHome);
        const file = lstatSync(join(codexHome, 'auth.json'));
        const owner = typeof process.getuid === 'function' ? process.getuid() : file.uid;
        return root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o022) === 0 && root.uid === owner
            && file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 && file.uid === owner;
    } catch { return false; }
}

let output;
if (method === 'status') {
    const login = spawnSync(codex, ['login', 'status'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
    const authenticated = login.status === 0 && /logged in using chatgpt/i.test(`${login.stdout}${login.stderr}`);
    const privateStore = credentialFileIsPrivate();
    let statusLabel = 'Experimental subscription access ready';
    if (!authenticated) statusLabel = 'Run codex login with ChatGPT';
    else if (!privateStore) statusLabel = 'Codex credential file is not owner-only';
    output = { configured: authenticated && privateStore, statusLabel };
} else if (method === 'report') {
    output = { say: reportAgentOutcome(input) };
} else {
    throw new Error(`unknown Codex Voice method: ${method ?? ''}`);
}
process.stdout.write(JSON.stringify(output));
