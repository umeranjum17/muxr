/**
 * Inspect → plan → apply → verify for the desired state in config.env.
 *
 *   muxr setup --apply-config --dry-run [--json]   the plan, no mutation (exit 2 when it has changes)
 *   muxr setup --apply-config [--json]             apply exactly that plan, then verify (exit 0 verified, 1 failed)
 *
 * One plan object feeds the text output, the JSON receipt and the TUI
 * Review preview. Apply never mints or revokes grants and never emits
 * invitations: pairing is an action (`muxr pair`), not state. An unchanged
 * reapply is a no-op that reinstalls nothing.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BROWSER_CAPABLE_CONNECTIONS, CONFIG_ATTRIBUTES, attributeByName, formatAttribute } from '../infrastructure/configSchema.mjs';
import { daemonIsRunning, daemonMode } from '../infrastructure/daemon.mjs';
import { runLocalPrerequisites } from '../infrastructure/herdr.mjs';
import { operatorConfigPath, planToArgs, resolveSetupPlan } from '../infrastructure/operatorConfig.mjs';
import { pluginFolder, pluginsRoot } from '../infrastructure/paths.mjs';
import { print, run, stateDir } from '../infrastructure/runtime.mjs';
import { readSelfhostState } from '../infrastructure/selfhost.mjs';
import { selfhostPublicSummary } from '../infrastructure/selfhostRelay.mjs';
import { herdrPlugins, installPlugin } from '../../plugin/application/installPlugin.mjs';
import { startSelfHost } from './startSelfHost.mjs';

const BUNDLED_PREFIX = 'muxr.';

function bundledPluginNames() {
    const { readdirSync } = require('node:fs');
    return readdirSync(pluginsRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(pluginsRoot(), entry.name, 'herdr-plugin.toml')))
        .map((entry) => entry.name);
}
// ESM module: bring require in for the one sync directory read above.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function herdrPluginsSafe() {
    try {
        return herdrPlugins();
    } catch {
        return undefined;
    }
}

async function selectedVoiceProvider() {
    try {
        process.env.MUXR_PLUGIN_STATE_DIR = join(stateDir(), 'plugin-state', 'muxr.voice');
        const provider = await import(pathToFileURL(join(pluginFolder('voice'), 'provider.mjs')).href);
        return provider.selectedProvider().id;
    } catch {
        return undefined;
    }
}

/** What is on this computer now, in the schema's vocabulary. */
export async function currentDesiredState() {
    const state = readSelfhostState();
    const summary = state === undefined ? undefined : await selfhostPublicSummary();
    const installed = herdrPluginsSafe();
    const bundled = {};
    const extra = [];
    if (installed !== undefined) {
        for (const plugin of installed) {
            if (plugin.plugin_id.startsWith(BUNDLED_PREFIX)) {
                bundled[plugin.plugin_id.slice(BUNDLED_PREFIX.length)] = plugin.enabled === true;
            } else if (plugin.source?.kind === 'github' && typeof plugin.source.resolved_commit === 'string') {
                extra.push({ kind: 'github', source: [plugin.source.owner, plugin.source.repo, plugin.source.subdir].filter(Boolean).join('/'), ref: plugin.source.resolved_commit });
            } else if (plugin.source?.kind === 'npm') {
                extra.push({ kind: 'npm', name: plugin.source.name, version: plugin.source.version });
            }
        }
    }
    let setupRole;
    if (summary !== undefined) {
        if (summary.relayLocation === 'remote') setupRole = 'remote-host';
        else if (summary.relayRole === 'shared') setupRole = 'shared-relay';
        else setupRole = 'single-machine';
    }
    const unitMode = daemonMode();
    return {
        configured: state !== undefined,
        setupRole,
        connection: summary?.connectionMode,
        relayPort: summary?.relayPort,
        web: summary?.webEnabled,
        advertiseUrl: summary?.relayUrl,
        serviceMode: unitMode === undefined ? undefined : 'managed',
        serviceRunning: daemonIsRunning(),
        relayHealthy: summary?.relayHealthy,
        bundledPlugins: bundled,
        extraPlugins: extra,
        voiceProvider: await selectedVoiceProvider(),
        herdrReachable: installed !== undefined,
    };
}

/** Effective desired state, with the fresh single-machine web default resolved. */
export function desiredState(args) {
    const resolved = resolveSetupPlan({ args });
    const values = { ...resolved.values };
    const provenance = { ...resolved.provenance };
    if (values.web === undefined && values.setupRole === 'single-machine' && values.connection !== undefined) {
        values.web = BROWSER_CAPABLE_CONNECTIONS.includes(values.connection);
        provenance.web = 'default';
    }
    return { values, provenance };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The plan: every attribute compared with the machine, plus the apply steps it implies. */
export function planDesiredState(desired, current) {
    const attributes = [];
    for (const attribute of CONFIG_ATTRIBUTES) {
        const to = desired.values[attribute.name];
        if (to === undefined) continue;
        let from = current[attribute.name];
        let changed;
        if (attribute.name === 'bundledPlugins') {
            changed = Object.entries(to).some(([name, on]) => current.bundledPlugins[name] !== on);
            from = Object.fromEntries(Object.keys(to).map((name) => [name, current.bundledPlugins[name]]));
        } else if (attribute.name === 'extraPlugins') {
            changed = to.some((entry) => !current.extraPlugins.some((have) => same(have, entry)));
        } else if (attribute.name === 'integrationsSync') {
            // Integrations are reconciled on every apply (idempotent sync); never a reported change by itself.
            changed = false;
        } else if (attribute.name === 'pairingDefault') {
            changed = false;
        } else if (attribute.name === 'advertiseUrl' && (desired.values.connection === 'lan' || desired.values.connection === 'private')) {
            changed = !current.configured || (from !== undefined && from !== to);
        } else {
            changed = !same(from, to);
        }
        attributes.push({ key: attribute.key, from: from === undefined ? null : from, to, provenance: desired.provenance[attribute.name] ?? 'default', changed });
    }
    const missing = [];
    if (desired.values.setupRole !== 'remote-host' && desired.values.connection === undefined) missing.push('MUXR_CONNECTION');
    if (desired.values.web === true && desired.values.connection !== undefined && !BROWSER_CAPABLE_CONNECTIONS.includes(desired.values.connection)) {
        missing.push(`a browser-capable MUXR_CONNECTION for MUXR_WEB=true (${BROWSER_CAPABLE_CONNECTIONS.join(', ')})`);
    }
    if (desired.values.setupRole === 'remote-host' && !current.configured) {
        missing.push('an enrollment: run `muxr connect --enrollment <string>` once; the enrollment string is an action, not configuration');
    }
    const unknownBundled = Object.keys(desired.values.bundledPlugins ?? {}).filter((name) => !bundledPluginNames().includes(name));
    if (unknownBundled.length > 0) missing.push(`MUXR_BUNDLED_PLUGINS names unknown bundled plugins: ${unknownBundled.join(', ')} (known: ${bundledPluginNames().join(', ')})`);
    const steps = [];
    const runtimeChanged = attributes.some((entry) => entry.changed && ['MUXR_SETUP_ROLE', 'MUXR_CONNECTION', 'MUXR_RELAY_PORT', 'MUXR_WEB', 'MUXR_ADVERTISE_URL', 'MUXR_NOTIFY_EMAIL', 'MUXR_SERVICE_MODE'].includes(entry.key));
    if (desired.values.setupRole !== 'remote-host') {
        if (runtimeChanged || !current.configured) steps.push({ id: 'relay-host', detail: `configure relay+host: ${desired.values.connection} on :${desired.values.relayPort}, browser app ${desired.values.web ? 'on' : 'off'}, service ${desired.values.serviceMode}` });
        else if (!current.serviceRunning && desired.values.serviceMode === 'managed') steps.push({ id: 'relay-host', detail: 'start the configured relay+host service' });
    }
    if (desired.values.integrationsSync !== 'off') steps.push({ id: 'integrations', detail: `sync coding-agent integrations (${desired.values.integrationsSync})` });
    for (const [name, on] of Object.entries(desired.values.bundledPlugins ?? {})) {
        if (current.bundledPlugins[name] !== on) steps.push({ id: `plugin:${name}`, detail: `${on ? 'enable' : 'disable'} bundled plugin muxr.${name}` });
    }
    for (const entry of desired.values.extraPlugins ?? []) {
        if (!current.extraPlugins.some((have) => same(have, entry))) steps.push({ id: `addon:${entry.kind === 'npm' ? entry.name : entry.source}`, detail: `install add-on ${formatAttribute(attributeByName('extraPlugins'), [entry])}` });
    }
    if (desired.values.voiceProvider !== undefined && desired.values.voiceProvider !== current.voiceProvider) steps.push({ id: 'voice', detail: `select realtime voice provider ${desired.values.voiceProvider}` });
    return { attributes, steps, missing, changes: steps.length > 0 };
}

/** The plan as lines: the TUI Review screen and `--dry-run` print exactly these. */
export function planLines(plan, desired, { dryRun }) {
    const lines = [];
    for (const entry of plan.attributes) {
        const attribute = CONFIG_ATTRIBUTES.find((candidate) => candidate.key === entry.key);
        const shown = formatAttribute(attribute, entry.to);
        const was = entry.from === null ? 'unset' : formatAttribute(attribute, entry.from);
        lines.push(`  ${entry.changed ? '~' : '='} ${entry.key}=${shown} (${entry.provenance})${entry.changed ? ` ← ${was}` : ''}`);
    }
    if (plan.missing.length > 0) {
        lines.push('  prerequisites missing:');
        for (const item of plan.missing) lines.push(`    - ${item}`);
        return lines;
    }
    lines.push(plan.steps.length === 0 ? `  nothing to change${desired.values.setupRole === 'remote-host' ? ' (remote host follows its shared relay)' : ''}` : `  ${dryRun ? 'would apply' : 'applying'}:`);
    for (const step of plan.steps) lines.push(`    - ${step.detail}`);
    return lines;
}

function printPlan(plan, desired, options) {
    print(`desired state: ${operatorConfigPath()}${existsSync(operatorConfigPath()) ? '' : ' (missing — flags, env and defaults apply)'}`);
    for (const line of planLines(plan, desired, options)) print(line);
}

function receipt(phase, plan, desired, extra = {}) {
    return { ok: extra.ok ?? plan.missing.length === 0, phase, file: operatorConfigPath(), attributes: plan.attributes, steps: plan.steps, missing: plan.missing, changes: plan.changes, ...extra };
}

async function verifyDesiredState(desired) {
    const current = await currentDesiredState();
    const failures = [];
    if (desired.values.setupRole !== 'remote-host') {
        if (current.connection !== desired.values.connection) failures.push(`connection is ${current.connection ?? 'unset'}, wanted ${desired.values.connection}`);
        if (current.relayPort !== desired.values.relayPort) failures.push(`relay port is ${current.relayPort ?? 'unset'}, wanted ${desired.values.relayPort}`);
        if (current.web !== desired.values.web) failures.push(`browser app is ${current.web ? 'on' : 'off'}, wanted ${desired.values.web ? 'on' : 'off'}`);
        if (current.relayHealthy !== true) failures.push('relay is not answering /health');
        if (desired.values.serviceMode === 'managed' && !current.serviceRunning) failures.push('host service is not running');
    }
    for (const [name, on] of Object.entries(desired.values.bundledPlugins ?? {})) {
        if (current.bundledPlugins[name] !== on) failures.push(`bundled plugin muxr.${name} is ${current.bundledPlugins[name] === undefined ? 'missing' : current.bundledPlugins[name] ? 'enabled' : 'disabled'}, wanted ${on ? 'enabled' : 'disabled'}`);
    }
    for (const entry of desired.values.extraPlugins ?? []) {
        if (!current.extraPlugins.some((have) => same(have, entry))) failures.push(`add-on ${formatAttribute(attributeByName('extraPlugins'), [entry])} is not installed`);
    }
    if (desired.values.voiceProvider !== undefined && current.voiceProvider !== desired.values.voiceProvider) failures.push(`voice provider is ${current.voiceProvider ?? 'unset'}, wanted ${desired.values.voiceProvider}`);
    return { ok: failures.length === 0, failures, current };
}

export async function applyDesiredState(args = []) {
    const json = args.includes('--json');
    const dryRun = args.includes('--dry-run');
    const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    let desired;
    try {
        desired = desiredState(args.filter((arg) => arg !== '--json' && arg !== '--dry-run' && arg !== '--apply-config'));
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (json) out({ ok: false, phase: 'resolve', error: message });
        else process.stderr.write(`muxr setup --apply-config: ${message}\n`);
        return 1;
    }
    const current = await currentDesiredState();
    const plan = planDesiredState(desired, current);
    if (plan.missing.length > 0) {
        if (json) out(receipt('plan', plan, desired, { ok: false }));
        else { printPlan(plan, desired, { dryRun }); process.stderr.write('The plan is incomplete; nothing changed.\n'); }
        return 1;
    }
    if (dryRun) {
        if (json) out(receipt('plan', plan, desired, { ok: true, dryRun: true }));
        else printPlan(plan, desired, { dryRun: true });
        return plan.changes ? 2 : 0;
    }
    if (!json) printPlan(plan, desired, { dryRun: false });
    const done = [];
    const failed = (step, reason) => {
        const result = { ok: false, phase: 'apply', failedStep: step, reason, done };
        if (json) out(receipt('apply', plan, desired, result));
        else process.stderr.write(`apply failed at ${step}: ${reason}\nnothing after it ran; fix the cause and reapply.\n`);
        return 1;
    };
    for (const step of plan.steps) {
        if (step.id === 'relay-host') {
            const selfhostArgs = [...planToArgs(desired.values), '--yes', '--no-pair', '--from-desired-state'];
            if (desired.values.setupRole === 'shared-relay') selfhostArgs.push('--relay-only', '--managed-relay');
            if (desired.values.serviceMode === 'foreground') selfhostArgs.push('--foreground');
            const code = await startSelfHost(selfhostArgs);
            if (code !== 0) return failed(step.id, `self-host exited ${code}`);
        } else if (step.id === 'integrations') {
            const code = await runLocalPrerequisites(['--no-install-herdr', ...(desired.values.integrationsSync === 'on' ? ['--all'] : [])]);
            if (code !== 0) return failed(step.id, `integration sync exited ${code}`);
        } else if (step.id.startsWith('plugin:')) {
            const name = step.id.slice('plugin:'.length);
            const on = desired.values.bundledPlugins[name];
            const result = run(process.env.HERDR_BIN?.trim() || 'herdr', ['plugin', on ? 'enable' : 'disable', `${BUNDLED_PREFIX}${name}`]);
            if (!result.ok) return failed(step.id, (result.stderr || result.stdout || 'herdr failed').trim());
        } else if (step.id.startsWith('addon:')) {
            const entry = desired.values.extraPlugins.find((candidate) => step.id === `addon:${candidate.kind === 'npm' ? candidate.name : candidate.source}`);
            const spec = entry.kind === 'npm' ? `npm:${entry.name}@${entry.version}` : `${entry.source}@${entry.ref}`;
            try {
                const code = await installPlugin([spec, '--yes']);
                if (code !== 0) return failed(step.id, `plugin install exited ${code}`);
            } catch (cause) {
                return failed(step.id, cause instanceof Error ? cause.message : String(cause));
            }
        } else if (step.id === 'voice') {
            const { configureVoice } = await import('./voiceHost.mjs');
            const code = await configureVoice(['select', desired.values.voiceProvider]);
            if (code !== 0) return failed(step.id, 'voice provider selection failed');
        }
        done.push(step.id);
    }
    const verified = await verifyDesiredState(desired);
    if (json) out(receipt('verify', plan, desired, { ok: verified.ok, done, verification: verified.failures }));
    else if (verified.ok) print(plan.steps.length === 0 ? 'Verified: this computer already matches the desired state.' : 'Verified: the desired state is applied and healthy.');
    else process.stderr.write(`Applied, but verification failed:\n${verified.failures.map((line) => `  - ${line}`).join('\n')}\n`);
    return verified.ok ? 0 : 1;
}
