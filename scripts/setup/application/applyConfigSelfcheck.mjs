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
import { continueWithDirectTailscale, finalizeSetupPlan, selfhostArgsFromSetupPlan } from './finalizeSetupPlan.mjs';
import { resolveSetupPlan, writeOperatorConfig } from '../infrastructure/operatorConfig.mjs';

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

    // Beyond dry-run: the wizard's finalize → serialize → resolve → argv
    // chain. writeOperatorConfig(finalPlan) re-resolves to identical
    // values, the apply argv re-resolves to the same intent (review ==
    // apply == reapply), rewriting is byte-identical, and only config.env
    // changes — no state/grant files. Service reapplication itself
    // (ensureSelfhostRelay binds a real port and spawns a relay) cannot
    // run in this harness and is honestly skipped: no fake relay seam.
    cleanEnv();
    rmSync(configPath, { force: true });
    const lanFinal = finalizeSetupPlan({
        plan: { mode: 'lan', port: 8792, web: false, endpoint: undefined },
        found: { lan: '192.168.1.5' },
        syncIntegrations: true,
        notifyEmail: 'owner@example.com',
    });
    assert.deepEqual(lanFinal, {
        connection: 'lan',
        relayPort: 8792,
        web: false,
        advertiseUrl: 'ws://192.168.1.5:8792',
        integrationsSync: 'on',
        tunnel: false,
        tailscaleDirect: false,
        notifyEmail: 'owner@example.com',
    });
    const entriesOf = (snap) => new Map(snap === '' ? [] : snap.split('\n').map((line) => {
        const at = line.lastIndexOf(':');
        return [line.slice(0, at), line.slice(at + 1)];
    }));
    const preWrite = entriesOf(snapshotHome());
    writeOperatorConfig(lanFinal);
    assert.deepEqual(resolveSetupPlan({ args: [] }).values, lanFinal);
    const fileBytes = readFileSync(configPath, 'utf8');
    writeOperatorConfig(lanFinal);
    assert.equal(readFileSync(configPath, 'utf8'), fileBytes);
    const postWrite = entriesOf(snapshotHome());
    for (const [path, hash] of preWrite) assert.equal(postWrite.get(path), hash);
    assert.deepEqual(
        [...postWrite.keys()].filter((path) => postWrite.get(path) !== preWrite.get(path)),
        ['/config.env'],
    );
    // The apply argv over the written file re-resolves to the identical
    // intent: file and argv converge, so review == apply == reapply.
    const applyValues = resolveSetupPlan({
        args: selfhostArgsFromSetupPlan({ mode: 'lan', port: 8792, web: false, pairing: 'phone', found: { lan: '192.168.1.5' }, endpoint: undefined }),
    }).values;
    assert.deepEqual(applyValues, lanFinal);

    // Occupied Serve → direct recovery: the pure mapping is testable and
    // round-trips; the ownership probe needs Tailscale and stays out.
    const recovered = continueWithDirectTailscale({ mode: 'tailscale', port: 8792, web: true, endpoint: undefined, pairing: 'both' });
    assert.deepEqual(recovered, { mode: 'tailscale-direct', port: 8792, endpoint: undefined, web: false, pairing: 'phone' });
    const directFinal = finalizeSetupPlan({ plan: recovered, found: {}, syncIntegrations: false, notifyEmail: undefined });
    assert.equal(directFinal.connection, 'tailscale-direct');
    assert.equal(directFinal.web, false);
    assert.equal(directFinal.tailscaleDirect, true);
    assert.equal(directFinal.advertiseUrl, undefined);
    assert.equal(directFinal.integrationsSync, 'off');
    writeOperatorConfig(directFinal);
    const directFileValues = resolveSetupPlan({ args: [] }).values;
    assert.equal(directFileValues.connection, 'tailscale-direct');
    assert.equal(directFileValues.web, false);
    assert.equal(directFileValues.integrationsSync, 'off');
    // Flag reflections (tunnel/tailscaleDirect) ride the derived argv the
    // wizard always supplies: file + argv converge to the final plan.
    const directApplyValues = resolveSetupPlan({
        args: selfhostArgsFromSetupPlan({ mode: 'tailscale-direct', port: 8792, web: false, pairing: 'phone', found: {}, endpoint: undefined }),
    }).values;
    assert.deepEqual(directApplyValues, directFinal);
    // A non-root external endpoint fails at finalize: wizard and config agree.
    assert.throws(() => finalizeSetupPlan({
        plan: { mode: 'external', port: 8792, web: true, endpoint: 'ws://relay.example/hooks' },
        found: {},
        syncIntegrations: true,
        notifyEmail: undefined,
    }), /root wss:\/\/host/);

    process.stdout.write('PASS unit: self-host --apply-config executes current-source operator plan\n');
    } finally {
        restoreEnv();
        rmSync(HOME, { recursive: true, force: true });
    }
}

const invoked = process.argv[1] === undefined ? false : basename(process.argv[1]) === 'applyConfigSelfcheck.mjs';
if (invoked) await applyConfigSelfcheck();
