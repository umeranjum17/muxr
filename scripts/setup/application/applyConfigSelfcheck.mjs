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
import { printOperatorConfig, resolveSetupPlan, writeOperatorConfig } from '../infrastructure/operatorConfig.mjs';
import { desiredState, planDesiredState } from './applyDesiredState.mjs';
import { CONFIG_ATTRIBUTES } from '../infrastructure/configSchema.mjs';
import { checkConfigDocs } from '../../release/index.mjs';

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

async function captureConfig(argv) {
    let out = '';
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk) => { out += String(chunk); return true; };
    process.stderr.write = (chunk) => { out += String(chunk); return true; };
    try {
        return { code: printOperatorConfig(argv), out };
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
        // A fresh computer: the dry-run plan has changes (exit 2), mutates
        // nothing, and is identical on a second run.
        const applied = await runApplyConfig(['--apply-config', '--dry-run']);
        assert.equal(applied.code, 2);
        assert.match(applied.out, /would apply/);
        assert.match(applied.out, /MUXR_CONNECTION=lan/);
        assert.equal(snapshotHome(), before);
        const reapplied = await runApplyConfig(['--apply-config', '--dry-run']);
        assert.equal(reapplied.code, 2);
        assert.equal(reapplied.out, applied.out);
        // The JSON plan carries the same attributes and steps as the text plan.
        const planJson = await runApplyConfig(['--apply-config', '--dry-run', '--json']);
        assert.equal(planJson.code, 2);
        const plan = JSON.parse(planJson.out.slice(planJson.out.indexOf('{')));
        assert.equal(plan.ok, true);
        assert.equal(plan.dryRun, true);
        assert.deepEqual(plan.attributes.filter((entry) => entry.changed).map((entry) => entry.key), ['MUXR_SETUP_ROLE', 'MUXR_CONNECTION', 'MUXR_RELAY_PORT', 'MUXR_WEB']);
        assert.ok(plan.steps.some((step) => step.id === 'relay-host'));
        assert.equal(snapshotHome(), before);
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

    // Secret canary: a credential/query/fragment-bearing advertise URL and a
    // mistyped secret-bearing line are refused before any output path, and
    // no text or JSON receipt (config, plan, apply) ever repeats the value.
    const CANARY = 'FAKE_SECRET_CANARY_7f3a';
    const canaryConfigs = [
        `MUXR_CONNECTION=external\nMUXR_ADVERTISE_URL=wss://audit:${CANARY}@example.invalid/?token=${CANARY}#${CANARY}\n`,
        `MUXR_CONNECTION=external\nMUXR_ADVERTISE_URL=wss://example.invalid/${CANARY}\n`,
        `MUXR_CONNECTION=lan\nMUXR_ADVERTISE_URL wss://audit:${CANARY}@example.invalid\n`,
        `MUXR_CONNECTION=${CANARY}\n`,
        `MUXR_CONNECTION=lan\nMUXR_RELAY_PORT=${CANARY}\n`,
        `MUXR_CONNECTION=lan\nMUXR_WEB=${CANARY}\n`,
        `MUXR_CONNECTION=lan\nMUXR_INTEGRATIONS_SYNC=${CANARY}\n`,
    ];
    for (const text of canaryConfigs) {
        writeConfig(text);
        before = snapshotHome();
        const receipts = [];
        for (const argv of [['--apply-config', '--dry-run'], ['--apply-config', '--dry-run', '--json'], ['--apply-config', '--json']]) {
            const run = await runApplyConfig(argv);
            assert.equal(run.code, 1, `canary config must be refused: ${argv.join(' ')}`);
            receipts.push(run.out);
        }
        const config = await captureConfig([]);
        assert.equal(config.code, 1);
        receipts.push(config.out);
        const configJson = await captureConfig(['--json']);
        assert.equal(configJson.code, 1);
        receipts.push(configJson.out);
        for (const receipt of receipts) assert.doesNotMatch(receipt, new RegExp(CANARY), 'secret canary echoed');
        assert.equal(snapshotHome(), before);
    }
    // The same canary is also refused when it arrives as env or flag.
    writeConfig('MUXR_CONNECTION=lan\n');
    process.env.MUXR_ADVERTISE_URL = `wss://audit:${CANARY}@example.invalid/`;
    const envCanary = await captureConfig([]);
    assert.equal(envCanary.code, 1);
    assert.doesNotMatch(envCanary.out, new RegExp(CANARY));
    delete process.env.MUXR_ADVERTISE_URL;
    const flagCanary = await captureConfig(['--advertise', `wss://example.invalid/?k=${CANARY}`]);
    assert.equal(flagCanary.code, 1);
    assert.doesNotMatch(flagCanary.out, new RegExp(CANARY));
    cleanEnv();

    // Desired-state matrix, planned against fixed machine snapshots: what a
    // fresh and an already-configured computer would do for each role and
    // option. The planner is the same object the TUI Review and --json print.
    const fresh = { configured: false, bundledPlugins: { code: true, status: true, voice: true }, extraPlugins: [], voiceProvider: 'codex', serviceRunning: false };
    const configuredLan = { ...fresh, configured: true, setupRole: 'single-machine', connection: 'lan', relayPort: 8792, web: false, advertiseUrl: 'ws://192.168.1.5:8792', serviceMode: 'managed', serviceRunning: true, relayHealthy: true };
    const stepIds = (text, current, extra = []) => { writeConfig(text); const plan = planDesiredState(desiredState(extra), current); return { ids: plan.steps.map((step) => step.id), missing: plan.missing, plan }; };
    cleanEnv();
    // single-machine HTTPS: browser app defaults on, service managed
    let row = stepIds('MUXR_CONNECTION=tailscale\n', fresh);
    assert.deepEqual(row.ids, ['relay-host', 'integrations']);
    assert.equal(row.plan.attributes.find((entry) => entry.key === 'MUXR_WEB').to, true);
    // explicit LAN/native, foreground
    row = stepIds('MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_SERVICE_MODE=foreground\n', fresh);
    assert.match(row.plan.steps[0].detail, /browser app off, service foreground/);
    // browser app on a native-only route is a named prerequisite, never a silent demotion
    writeConfig('MUXR_CONNECTION=lan\nMUXR_WEB=true\n');
    assert.throws(() => desiredState([]), /browser-capable MUXR_CONNECTION .* lan is a native-only route/);
    // shared relay and remote host roles
    row = stepIds('MUXR_SETUP_ROLE=shared-relay\nMUXR_CONNECTION=tailscale\nMUXR_WEB=false\n', fresh);
    assert.deepEqual(row.ids, ['relay-host', 'integrations']);
    row = stepIds('MUXR_SETUP_ROLE=remote-host\n', fresh);
    assert.ok(row.missing.some((item) => /enrollment/.test(item)), 'remote host without an enrollment must name the action');
    row = stepIds('MUXR_SETUP_ROLE=remote-host\n', { ...configuredLan, setupRole: 'remote-host', connection: undefined });
    assert.deepEqual(row.ids, ['integrations']);
    // integrations auto/on/off
    for (const [value, expected] of [['auto', ['integrations']], ['on', ['integrations']], ['off', []]]) {
        row = stepIds(`MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_INTEGRATIONS_SYNC=${value}\n`, configuredLan);
        assert.deepEqual(row.ids, expected, `integrations ${value}`);
    }
    // bundled plugin enable/disable, unknown name refused
    row = stepIds('MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_INTEGRATIONS_SYNC=off\nMUXR_BUNDLED_PLUGINS=status=off,code=on\n', configuredLan);
    assert.deepEqual(row.ids, ['plugin:status']);
    row = stepIds('MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_BUNDLED_PLUGINS=nosuch=off\n', configuredLan);
    assert.ok(row.missing.some((item) => /unknown bundled plugins: nosuch/.test(item)));
    // one pinned add-on (exact sha), tags refused at parse time
    const sha = '0123456789abcdef0123456789abcdef01234567';
    row = stepIds(`MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_INTEGRATIONS_SYNC=off\nMUXR_EXTRA_PLUGINS=owner/repo/plugins/thing@${sha}\n`, configuredLan);
    assert.deepEqual(row.ids, ['addon:owner/repo/plugins/thing']);
    row = stepIds(`MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_INTEGRATIONS_SYNC=off\nMUXR_EXTRA_PLUGINS=owner/repo/plugins/thing@${sha}\n`, { ...configuredLan, extraPlugins: [{ kind: 'github', source: 'owner/repo/plugins/thing', ref: sha }] });
    assert.deepEqual(row.ids, [], 'an installed add-on at the same commit is not reinstalled');
    writeConfig('MUXR_CONNECTION=lan\nMUXR_EXTRA_PLUGINS=owner/repo@main\n');
    assert.throws(() => desiredState([]), /MUXR_EXTRA_PLUGINS \(config\)/);
    // voice configured/unconfigured
    row = stepIds('MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_INTEGRATIONS_SYNC=off\nMUXR_VOICE_PROVIDER=xai\n', configuredLan);
    assert.deepEqual(row.ids, ['voice']);
    row = stepIds('MUXR_CONNECTION=lan\nMUXR_WEB=false\nMUXR_INTEGRATIONS_SYNC=off\n', configuredLan);
    assert.deepEqual(row.ids, [], 'an unchanged configured computer plans nothing');
    // The skill and the configuration page carry every attribute, from the schema.
    assert.deepEqual(await checkConfigDocs(), []);
    const skill = readFileSync(new URL('../../../skills/muxr/references/onboarding.md', import.meta.url), 'utf8');
    for (const attribute of CONFIG_ATTRIBUTES) assert.ok(skill.includes(`\`${attribute.key}\``), `skill lacks ${attribute.key}`);
    for (const phrase of ['--apply-config --dry-run', 'Secret boundary', 'Pairing handoff', '--allow-downgrade', 'herdr plugin install umeranjum17/muxr/plugins/control']) assert.ok(skill.includes(phrase), `skill lacks ${phrase}`);
    cleanEnv();

    // First-apply ordering (the wizard applies before writing config.env):
    // with no config file, finalize → apply argv → resolve must preserve a
    // CLI-provided notification address with flag precedence — and a flag
    // must override a filed address before anything is written.
    cleanEnv();
    rmSync(configPath, { force: true });
    const workingPlan = { mode: 'lan', port: 8792, web: false, endpoint: undefined };
    const workingFound = { lan: '192.168.1.5' };
    const firstFinal = finalizeSetupPlan({
        plan: workingPlan,
        found: workingFound,
        syncIntegrations: true,
        notifyEmail: 'owner@example.com',
    });
    const firstApplied = resolveSetupPlan({
        args: selfhostArgsFromSetupPlan({ ...workingPlan, pairing: 'phone', found: workingFound, notifyEmail: firstFinal.notifyEmail }),
    });
    assert.equal(firstApplied.values.notifyEmail, 'owner@example.com');
    assert.equal(firstApplied.provenance.notifyEmail, 'flag');
    assert.equal(firstApplied.values.connection, 'lan');
    assert.equal(firstApplied.values.advertiseUrl, 'ws://192.168.1.5:8792');
    writeConfig('MUXR_CONNECTION=lan\nMUXR_NOTIFY_EMAIL=file@example.com\n');
    const reviewedOverride = resolveSetupPlan({ args: ['--notify-email', 'flag@example.com'] });
    assert.equal(reviewedOverride.values.notifyEmail, 'flag@example.com');
    const overrideFinal = finalizeSetupPlan({
        plan: workingPlan,
        found: workingFound,
        syncIntegrations: true,
        notifyEmail: reviewedOverride.values.notifyEmail,
    });
    const overrideApplied = resolveSetupPlan({
        args: selfhostArgsFromSetupPlan({ ...workingPlan, pairing: 'phone', found: workingFound, notifyEmail: overrideFinal.notifyEmail }),
    });
    assert.equal(overrideApplied.values.notifyEmail, 'flag@example.com');
    assert.equal(overrideApplied.provenance.notifyEmail, 'flag');

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
        setupRole: 'single-machine',
        connection: 'lan',
        relayPort: 8792,
        web: false,
        advertiseUrl: 'ws://192.168.1.5:8792',
        integrationsSync: 'on',
        serviceMode: 'managed',
        pairingDefault: 'browser',
        bundledPlugins: {},
        extraPlugins: [],
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
