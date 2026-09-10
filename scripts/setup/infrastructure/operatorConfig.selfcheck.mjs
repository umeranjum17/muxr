/**
 * Operator-config self-check: precedence, malformed file, unknown key, and
 * the `--mode` collision (`muxr setup --mode selfhost` is operation mode,
 * never a connection route). Exits non-zero on the first failure.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    formatOperatorConfig,
    planToArgs,
    printOperatorConfig,
    resolveOperatorConfig,
    resolveSetupPlan,
    validateSetupPlan,
    writeOperatorConfig,
} from './operatorConfig.mjs';
import { readRelayEnv, writeRelayEnv } from './selfhostRelay.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'muxr-opcfg-check-'));
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

try {
    // Default: missing file defaults.
    cleanEnv();
    rmSync(configPath, { force: true });
    let resolved = resolveOperatorConfig({ args: [] });
    assert.equal(resolved.values.relayPort, 8792);
    assert.equal(resolved.provenance.relayPort, 'default');
    assert.equal(resolved.values.connection, undefined);

    // File: values load with config provenance.
    writeConfig('MUXR_CONNECTION=lan\nMUXR_RELAY_PORT=6666\nMUXR_WEB=false\n');
    resolved = resolveOperatorConfig({ args: [] });
    assert.equal(resolved.values.connection, 'lan');
    assert.equal(resolved.values.relayPort, 6666);
    assert.equal(resolved.values.web, false);
    assert.equal(resolved.provenance.connection, 'config');

    // Env beats file; flag beats env.
    process.env.MUXR_RELAY_PORT = '7777';
    resolved = resolveOperatorConfig({ args: [] });
    assert.equal(resolved.values.relayPort, 7777);
    assert.equal(resolved.provenance.relayPort, 'env');
    resolved = resolveOperatorConfig({ args: ['--port', '9999'] });
    assert.equal(resolved.values.relayPort, 9999);
    assert.equal(resolved.provenance.relayPort, 'flag');
    delete process.env.MUXR_RELAY_PORT;

    // `--mode` collision: setup operation mode is never a connection route.
    rmSync(configPath, { force: true });
    resolved = resolveOperatorConfig({ args: ['--mode', 'selfhost'] });
    assert.equal(resolved.values.connection, undefined);
    resolved = resolveOperatorConfig({ args: ['--connection-mode', 'tailscale'] });
    assert.equal(resolved.values.connection, 'tailscale');
    assert.equal(resolved.provenance.connection, 'flag');

    // Malformed file fails clearly instead of defaulting.
    writeConfig('MUXR_CONNECTION lan\n');
    assert.throws(() => resolveOperatorConfig({ args: [] }), /malformed .* line 1.*KEY=value/);

    // Unknown key / typo fails clearly.
    writeConfig('MUXR_CONNECTION=lan\nMUXR_CONECTION=tailscale\n');
    assert.throws(() => resolveOperatorConfig({ args: [] }), /unsupported key.*MUXR_CONECTION/);

    // printOperatorConfig reports the failure with exit 1, not a crash.
    assert.equal(printOperatorConfig([]), 1);

    // Round-trip: write then resolve.
    cleanEnv();
    writeOperatorConfig({ connection: 'tailscale', relayPort: 8792, web: true, integrationsSync: 'auto' });
    resolved = resolveOperatorConfig({ args: [] });
    assert.equal(resolved.values.connection, 'tailscale');
    assert.equal(resolved.values.web, true);
    assert.equal(resolved.provenance.connection, 'config');
    assert.ok(formatOperatorConfig({ connection: 'x' }).includes('MUXR_CONNECTION=x'));
    assert.equal(printOperatorConfig([]), 0);

    // Normalized plan: intent resolved once, validated once, derived once.
    cleanEnv();
    rmSync(configPath, { force: true });
    let plan = resolveSetupPlan({ args: ['--connection-mode', 'tailscale', '--port', '8792', '--web', '--yes'] });
    assert.equal(plan.values.connection, 'tailscale');
    assert.equal(plan.values.tunnel, false);
    assert.equal(plan.values.tailscaleDirect, false);
    assert.deepEqual(
        planToArgs(plan.values),
        ['--port', '8792', '--connection-mode', 'tailscale', '--web', '--reconfigure'],
    );
    plan = resolveSetupPlan({ args: ['--connection-mode', 'cloudflare', '--tailscale-direct'] });
    assert.equal(plan.values.tunnel, false);
    assert.equal(plan.values.tailscaleDirect, true);
    assert.ok(planToArgs(plan.values).includes('--tailscale-direct'));
    assert.throws(() => resolveSetupPlan({ args: ['--connection-mode', 'external'] }), /MUXR_ADVERTISE_URL/);
    plan = resolveSetupPlan({ args: ['--connection-mode', 'external', '--advertise', 'wss://relay.example'] });
    assert.equal(plan.values.advertiseUrl, 'wss://relay.example');
    assert.throws(() => validateSetupPlan({ connection: 'external' }), /MUXR_ADVERTISE_URL/);
    // A reviewed plan persists exactly and re-resolves identically (review == apply).
    writeOperatorConfig({ ...plan.values, integrationsSync: 'auto' });
    const reread = resolveSetupPlan({ args: [] });
    assert.equal(reread.values.connection, 'external');
    assert.equal(reread.values.advertiseUrl, 'wss://relay.example');
    assert.equal(reread.provenance.connection, 'config');

    // Relay process env round-trips through the owner-only record (never secrets).
    cleanEnv();
    writeRelayEnv({ notifyEmail: 'owner@example.com' });
    assert.deepEqual(readRelayEnv(), { MUXR_NOTIFY_EMAIL: 'owner@example.com' });
    writeRelayEnv({});
    assert.deepEqual(readRelayEnv(), {});

    process.stdout.write('PASS unit: operator config precedence, malformed/unknown rejection, --mode collision\n');
    process.stdout.write('PASS unit: normalized setup plan round-trip and relay env record\n');
} finally {
    restoreEnv();
    rmSync(HOME, { recursive: true, force: true });
}
