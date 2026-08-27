#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reportInstruction } from './coordinatorPolicy.mjs';

const root = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
const keyFile = join(root, 'openai.key');
const method = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8') || 'null');

function assertKeyRoot(info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('OpenAI key store must be a real directory');
}

async function readKey() {
    let directory;
    let info;
    try { directory = await lstat(root); info = await lstat(keyFile); }
    catch (cause) {
        if (cause?.code === 'ENOENT') throw new Error('No OpenAI key. Configure the provider from muxr Settings.');
        throw cause;
    }
    assertKeyRoot(directory);
    if ((directory.mode & 0o077) !== 0 || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error('OpenAI key store must be owner-only');
    }
    const value = (await readFile(keyFile, 'utf8')).trim();
    if (!value) throw new Error('No OpenAI key. Configure the provider from muxr Settings.');
    return value;
}

async function writeKey(value) {
    const key = String(value ?? '').trim();
    if (!key) throw new Error('OpenAI key must not be empty');
    await mkdir(root, { recursive: true, mode: 0o700 });
    assertKeyRoot(await lstat(root));
    await chmod(root, 0o700);
    const temporary = `${keyFile}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await writeFile(temporary, `${key}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, keyFile);
    } finally { await rm(temporary, { force: true }); }
}

let output;
if (method === 'status') {
    output = await readKey().then(() => ({ configured: true, statusLabel: 'Key set' }), () => ({ configured: false, statusLabel: 'No key set' }));
} else if (method === 'key.set') {
    await writeKey(input?.key); output = null;
} else if (method === 'key.clear') {
    try {
        assertKeyRoot(await lstat(root));
        const info = await lstat(keyFile);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing to remove non-regular key file');
        await rm(keyFile);
    } catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
    output = null;
} else if (method === 'report') {
    output = { say: reportInstruction(input) };
} else {
    throw new Error(`unknown OpenAI Realtime method: ${method ?? ''}`);
}
process.stdout.write(JSON.stringify(output));
