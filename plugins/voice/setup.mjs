#!/usr/bin/env node
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const keyPath = join(process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr'), 'xai.key');
let restored = false;
const restore = () => {
    if (restored) return;
    restored = true;
    spawnSync('stty', ['echo'], { stdio: 'inherit' });
    process.stdout.write('\n');
};
const fail = (cause) => {
    restore();
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
};
process.once('SIGINT', () => fail(new Error('cancelled')));
process.once('SIGTERM', () => fail(new Error('cancelled')));
const hidden = spawnSync('stty', ['-echo'], { stdio: 'inherit' });
if (hidden.status !== 0) fail(new Error('Cannot disable terminal echo; key was not read.'));
else {
    process.stdout.write('xAI API key: ');
    const input = createInterface({ input: process.stdin, terminal: false });
    input.once('line', (line) => {
        try {
            const key = line.trim();
            if (!key) throw new Error('No key entered.');
            mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
            const directory = lstatSync(dirname(keyPath));
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('xAI key store must be a real directory');
            chmodSync(dirname(keyPath), 0o700);
            const temporary = `${keyPath}.tmp-${randomBytes(8).toString('hex')}`;
            try {
                writeFileSync(temporary, `${key}\n`, { mode: 0o600, flag: 'wx' });
                renameSync(temporary, keyPath);
            } finally { rmSync(temporary, { force: true }); }
            restore();
            process.stdout.write('muxr Voice is configured. Close this pane.\n');
        } catch (cause) { fail(cause); }
        finally { input.close(); }
    });
}
