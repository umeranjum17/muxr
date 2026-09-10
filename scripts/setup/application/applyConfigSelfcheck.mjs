/**
 * --apply-config check: the current-source path executes complete, missing,
 * external-without-URL, and malformed operator configs. --dry-run exits
 * before any mutation, so failures must leave the state dir byte-identical
 * and reapply must be idempotent. Exits non-zero on the first failure.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startSelfHost } from './startSelfHost.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'muxr-apply-config-check-'));
const INTENT_KEYS = ['MUXR_CONNECTION', 'MUXR_RELAY_PORT', 'MUXR_WEB', 'MUXR_ADVERTISE_URL', 'MUXR_INTEGRATIONS_SYNC', 'MUXR_NOTIFY_EMAIL'];
const savedEnv = new Map(INTENT_KEYS.concat(['MUXR_HOME']).map((key) => [key, process.env[key]]));

function cleanEnv() {
    for (const key of INTENT_KEYS) delete process.env[key];
    process.env.MUXR_HOME = HOME;
}
function restoreEnv() {
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
const configPath = join(HOME, 'config.env');
const writeConfig = (text) => writeFileSync(configPath, text);

/** Content hash of everything under the temp HOME: proves no mutation. */
function snapshotHome() {
    const entries = [];
    const walk = (dir) => {
        let names;
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names.sort()) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else entries.push(`${full.slice(HOME.length)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
        }
    };
    walk(HOME);
    return entries.join('\n');
}

async function runApplyConfig(argv) {
    let out = '';
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const capture = (write) => (chunk, ...rest) => { out += String(chunk); return Reflect.apply(write, process.stdout, [chunk, ...rest]); };
    process.stdout.write = capture(stdoutWrite);
    process.stderr.write = capture(stderrWrite);
    try {
        return { code: await startSelfHost(argv), out };
    } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
    }
}

export async function applyConfigSelfcheck() {
    try {
        // Complete config applies (dry run) and reapply is idempotent.
        cleanEnv();
        writeConfig('MUXR_CONNECTION=lan\nMUXR_RELAY_PORT=8792\nMUXR_WEB=false\n');
        let before = snapshotHome();
        const applied = await runApplyConfig(['--apply-config', '--dry-run']);
        assert.equal(applied.code, 0);
        assert.match(applied.out, /applying operator config/);
        assert.equal(snapshotHome(), before);
        const reapplied = await runApplyConfig(['--apply-config', '--dry-run']);
        assert.equal(reapplied.code, 0);
        assert.equal(reapplied.out, applied.out);
        assert.equal(snapshotHome(), before);

        // Missing connection fails clearly before any mutation.
        cleanEnv();
        rmSync(configPath, { force: true });
        before = snapshotHome();
        const missing = await runApplyConfig(['--apply-config', '--dry-run']);
        assert.equal(missing.code, 1);
        assert.match(missing.out, /MUXR_CONNECTION/);
        assert.equal(snapshotHome(), before);

        // External without URL fails clearly (plan validation, before mutation).
        writeConfig('MUXR_CONNECTION=external\n');
        before = snapshotHome();
        const noUrl = await runApplyConfig(['--apply-config', '--dry-run']);
        assert.equal(noUrl.code, 1);
        assert.match(noUrl.out, /MUXR_ADVERTISE_URL/);
        assert.equal(snapshotHome(), before);

        // Malformed config fails closed, never defaults.
        writeConfig('MUXR_CONNECTION lan\n');
        before = snapshotHome();
        const malformed = await runApplyConfig(['--apply-config', '--dry-run']);
        assert.equal(malformed.code, 1);
        assert.equal(snapshotHome(), before);

        process.stdout.write('PASS unit: self-host --apply-config executes current-source operator plan\n');
    } finally {
        restoreEnv();
        rmSync(HOME, { recursive: true, force: true });
    }
}

const invoked = process.argv[1] === undefined ? false : basename(process.argv[1]) === 'applyConfigSelfcheck.mjs';
if (invoked) await applyConfigSelfcheck();
