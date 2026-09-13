/**
 * The operator-intent resolver. The editable desired configuration now lives
 * at the top level of `~/.muxr/selfhost.json` (public JSON names); this module
 * resolves the effective value of each attribute with one precedence rule
 * everywhere: CLI flag > process env > persisted desired > probed/default.
 *
 * Persisted desired is read from selfhost.json's desired block (crypto-free,
 * via selfhostFile.mjs). Legacy `~/.muxr/config.env` is still honoured as a
 * higher-priority source until it is migrated in and retired; once selfhost.json
 * is version 2, a config.env beside it is a conflict, not a second source.
 * Secrets, keys and machine-owned state never appear here — they stay under
 * selfhost.json's `runtime`.
 */
import { parseEnv } from 'node:util';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BROWSER_CAPABLE_CONNECTIONS, CONFIG_ATTRIBUTES, CONFIG_KEYS, DESIRED_JSON_KEYS, attributeByKey, attributeByName, configSchema, formatAttribute, jsonNameOf, validateCrossAttributes } from './configSchema.mjs';
import { readDesiredConfig, readSelfhostFile, selfhostPath, selfhostStateUnreadable } from './selfhostFile.mjs';

// Dependency-free on purpose: operator intent must resolve without the
// crypto/QR stack (runtime.mjs) so `muxr config` and --apply-config stay light.
const env = (name) => process.env[name]?.trim() || undefined;
const stateDir = () => env('MUXR_HOME') || join(env('HOME') || homedir(), '.muxr');

function flagValue(args, name) {
    const inline = args.find((a) => a.startsWith(`${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function atomicWrite(path, text, mode = 0o600) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
        writeFileSync(temporary, text, { mode, flag: 'wx' });
        chmodSync(temporary, mode);
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

export const operatorConfigPath = () => join(stateDir(), 'config.env');

/** Intent keys, from the one schema. File keys ARE the MUXR_* env names: one namespace, no mapping table. */
export const OPERATOR_KEYS = CONFIG_KEYS;

function readConfigFile() {
    const path = operatorConfigPath();
    if (!existsSync(path)) return { values: {}, error: undefined };
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (cause) {
        return { values: {}, error: `cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    let parsed;
    try {
        // parseEnv silently drops lines without `=` (the classic typo), so
        // validate the shape first: a malformed file must fail, never default.
        // Never echo the line: a mistyped `MUXR_ADVERTISE_URL wss://u:p@…`
        // is still secret-bearing. Name the position and the rule only.
        raw.split('\n').forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) return;
            if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
                const key = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed)?.[1];
                throw new Error(`malformed ${path} line ${index + 1}${key === undefined ? '' : ` (${key})`}: expected KEY=value`);
            }
        });
        parsed = parseEnv(raw);
    } catch (cause) {
        return { values: {}, error: `malformed ${path}: ${cause instanceof Error ? cause.message : String(cause)} — fix or delete it (a missing file defaults)` };
    }
    const unknown = Object.keys(parsed).filter((key) => !OPERATOR_KEYS.includes(key));
    if (unknown.length > 0) {
        return { values: {}, error: `unsupported key(s) in ${path}: ${unknown.join(', ')} — supported: ${OPERATOR_KEYS.join(', ')}` };
    }
    return {
        values: Object.fromEntries(
            Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
        ),
        error: undefined,
    };
}

/**
 * The persisted-desired value for one attribute. Legacy config.env (MUXR_*
 * keys, strings) wins over the selfhost.json desired seed so an un-migrated
 * operator's explicit intent is preserved until migration retires config.env;
 * a v2 file has no config.env beside it. A desired value is typed and
 * re-validated through the schema (format→parse round-trip); null means
 * "auto/unset". Provenance is the tier 'config' for either file — never a
 * filename — so setupWizard's flag/env/config checks and the plan display keep
 * working unchanged.
 */
function configTier(attribute, desired, legacyValues) {
    const legacyRaw = legacyValues[attribute.key];
    if (legacyRaw !== undefined) return { value: attribute.parse(legacyRaw, 'config'), provenance: 'config' };
    const typed = desired[jsonNameOf(attribute)];
    if (typed === undefined || typed === null) return undefined;
    return { value: attribute.parse(formatAttribute(attribute, typed), 'config'), provenance: 'config' };
}

/**
 * External relay endpoint, one rule for config and wizard alike: a root
 * wss://host URL without credentials, query, or fragment. Errors never
 * repeat the value.
 */
export function parseExternalAdvertiseUrl(raw, from = 'operator config') {
    const entered = String(raw).trim();
    let parsed;
    try {
        parsed = new URL(entered);
    } catch {
        parsed = undefined;
    }
    if (
        parsed === undefined || parsed.protocol !== 'wss:' || !parsed.hostname
        || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    ) {
        throw new Error(`MUXR_ADVERTISE_URL (${from}) must be a root wss://host URL without credentials, query, or fragment for an external connection`);
    }
    return parsed.toString().replace(/\/$/, '');
}

/**
 * Resolve effective operator intent. `overrides.probed` carries values the
 * machine detected (recommended route, current state); anything unresolved
 * stays undefined with a 'default'/'probed' provenance note.
 */
export function resolveOperatorConfig({ args = [], probed = {} } = {}) {
    // Corruption is not a fresh install: never resolve (and never let a caller
    // reset) a selfhost.json that exists but does not parse.
    if (selfhostStateUnreadable()) {
        throw new Error(`${selfhostPath()} is present but not valid JSON — fix it; muxr will not reset it (that would destroy every pairing)`);
    }
    const desired = readDesiredConfig() ?? {};
    const unknown = Object.keys(desired).filter((key) => !DESIRED_JSON_KEYS.includes(key));
    if (unknown.length > 0) {
        throw new Error(`unsupported editable key(s) in ${selfhostPath()}: ${unknown.join(', ')} — supported: ${DESIRED_JSON_KEYS.join(', ')} (generated state lives under "runtime")`);
    }
    const legacy = readConfigFile();
    if (legacy.error !== undefined) throw new Error(legacy.error);
    // After migration to v2 the file is authoritative; a config.env beside it
    // is conflicting legacy input, never a silently-honoured second source.
    if (readSelfhostFile()?.version === 2 && existsSync(operatorConfigPath())) {
        throw new Error(`${operatorConfigPath()} exists beside a version-2 ${selfhostPath()} — config.env is no longer a config source. Remove it (its values are not auto-imported), then edit ${selfhostPath()} and run \`muxr setup --apply-config\``);
    }
    // Per-attribute flag spellings that are not `--<flag> value`.
    let webFlag;
    if (args.includes('--web')) webFlag = 'true';
    else if (args.includes('--no-web')) webFlag = 'false';
    const flagFor = (attribute) => {
        if (attribute.key === 'MUXR_WEB') return webFlag;
        if (attribute.key === 'MUXR_INTEGRATIONS_SYNC') return args.includes('--no-integrations') ? 'off' : undefined;
        if (attribute.flag === undefined) return undefined;
        // NOTE: `--mode` is intentionally not an alias for --connection-mode:
        // `muxr setup --mode selfhost` is setup operation mode, not a route.
        return flagValue(args, attribute.flag.split(' ')[0]);
    };
    const values = {};
    const provenance = {};
    for (const attribute of CONFIG_ATTRIBUTES) {
        const probedValue = probed[attribute.name];
        const fallback = probedValue !== undefined
            ? { value: probedValue, provenance: 'probed' }
            : { value: attribute.default, provenance: 'default' };
        // flag > env > persisted desired (config.env or selfhost.json) > probed/default.
        const flag = flagFor(attribute);
        const fromEnv = env(attribute.key);
        let picked;
        if (flag !== undefined) picked = { value: attribute.parse(flag, 'flag'), provenance: 'flag' };
        else if (fromEnv !== undefined) picked = { value: attribute.parse(fromEnv, 'env'), provenance: 'env' };
        else picked = configTier(attribute, desired, legacy.values) ?? fallback;
        if (picked.value !== undefined) values[attribute.name] = picked.value;
        // Defaults for optional attributes are recorded once they resolve to
        // something; an unset optional stays absent rather than "(default)".
        if (picked.value !== undefined || attribute.default !== undefined) provenance[attribute.name] = picked.provenance;
    }
    return { values, provenance };
}

const CONFIG_COMMENTS = [
    '# muxr desired state — human-editable, safe to keep in dotfiles.',
    '# One rule everywhere: CLI flag > MUXR_* env > this file > probed/default.',
    '# No secrets here: credentials and machine state live in selfhost.json.',
    '# Plan and apply it with: muxr setup --apply-config --dry-run --json',
    ...CONFIG_ATTRIBUTES.map((attribute) => `#   ${attribute.key}=${Array.isArray(attribute.values) ? attribute.values.join('|') : attribute.values}${attribute.default === undefined || typeof attribute.default === 'object' ? '' : ` (default ${formatAttribute(attribute, attribute.default)})`}`),
].join('\n');

/** Serialize intent only — never credentials or machine state. Defaults that were never chosen stay out. */
export function formatOperatorConfig(values) {
    const lines = [CONFIG_COMMENTS];
    for (const attribute of CONFIG_ATTRIBUTES) {
        const value = values[attribute.name];
        if (value === undefined) continue;
        if (attribute.key === 'MUXR_RELAY_PORT') { lines.push(`${attribute.key}=${value}`); continue; }
        if (attribute.type === 'map' && Object.keys(value).length === 0) continue;
        if (attribute.type === 'list' && value.length === 0) continue;
        if (attribute.default !== undefined && typeof attribute.default !== 'object' && value === attribute.default && !['MUXR_SETUP_ROLE', 'MUXR_SERVICE_MODE', 'MUXR_PAIRING_DEFAULT'].includes(attribute.key)) continue;
        lines.push(`${attribute.key}=${formatAttribute(attribute, value)}`);
    }
    if (!lines.some((line) => line.startsWith('MUXR_RELAY_PORT='))) lines.push('MUXR_RELAY_PORT=8792');
    return `${lines.join('\n')}\n`;
}

export function writeOperatorConfig(values) {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    chmodSync(stateDir(), 0o700);
    atomicWrite(operatorConfigPath(), formatOperatorConfig(values));
}

/** `KEY=value (provenance)` lines for `muxr config` and the Review screen. */
export function operatorReportLines(resolved) {
    return Object.keys(resolved.values).map((name) => {
        const attribute = attributeByName(name);
        return `${attribute?.key ?? name}=${attribute === undefined ? resolved.values[name] : formatAttribute(attribute, resolved.values[name])} (${resolved.provenance[name]})`;
    });
}

/** Cross-attribute completeness for an applicable plan (one rule set, in the schema). */
export function validateSetupPlan(values) {
    validateCrossAttributes(values);
}

/**
 * One normalized setup plan: precedence resolved once (flags > env > file >
 * probed/default), validated once, then reviewed, persisted, and applied
 * without re-deriving intent from raw args downstream. Pairing and other
 * per-invocation actions stay out: the plan is intent, not actions.
 */
export function resolveSetupPlan({ args = [], probed = {} } = {}) {
    const base = resolveOperatorConfig({ args, probed });
    const tunnel = args.includes('--tunnel');
    const tailscaleDirect = args.includes('--tailscale-direct');
    const values = {
        ...base.values,
        tunnel,
        tailscaleDirect,
    };
    const provenance = {
        ...base.provenance,
        tunnel: tunnel ? 'flag' : 'default',
        tailscaleDirect: tailscaleDirect ? 'flag' : 'default',
    };
    validateSetupPlan(values);
    return { values, provenance };
}

/** Canonical argv for a reviewed plan: the only flag derivation allowed. */
export function planToArgs(plan, { reconfigure = true } = {}) {
    const argv = ['--port', String(plan.relayPort ?? 8792)];
    if (plan.connection !== undefined) argv.push('--connection-mode', plan.connection);
    // An explicit bind choice is applied verbatim; 'auto' (or unset) is left to
    // the route-derived default, so it is never emitted or silently widened.
    if (plan.bindHost === '127.0.0.1' || plan.bindHost === '0.0.0.0') argv.push('--bind-host', plan.bindHost);
    if (plan.web === true) argv.push('--web');
    if (plan.web === false) argv.push('--no-web');
    if (plan.advertiseUrl !== undefined) argv.push('--advertise', plan.advertiseUrl);
    if (plan.tunnel === true) argv.push('--tunnel');
    if (plan.tailscaleDirect === true) argv.push('--tailscale-direct');
    if (plan.notifyEmail !== undefined) argv.push('--notify-email', plan.notifyEmail);
    if (reconfigure) argv.push('--reconfigure');
    return argv;
}

/** Deep value equality for schema-typed values (scalars, and same-source-ordered maps/lists). */
function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Where an effective desired value stands against what the machine last
 * applied: 'not configured', 'runtime unavailable' (no selfhost.json runtime
 * yet), 'applied' (matches the last applied config) or 'pending apply' (differs
 * — a service start/restart (`muxr restart`) or `muxr setup --apply-config` will make it live).
 */
function appliedStatus(attribute, value) {
    if (value === undefined) return 'not configured';
    const runtime = readSelfhostFile()?.runtime;
    if (runtime === undefined) return 'runtime unavailable';
    const appliedValue = (runtime.appliedConfig ?? {})[jsonNameOf(attribute)];
    if (appliedValue === undefined || appliedValue === null) return 'pending apply';
    return sameValue(appliedValue, value) ? 'applied' : 'pending apply';
}

/** Non-secret effective values with provenance and applied status, as `muxr config --json` prints them. */
export function operatorConfigJson(resolved) {
    const values = {};
    const provenance = {};
    const status = {};
    for (const attribute of CONFIG_ATTRIBUTES) {
        const value = resolved.values[attribute.name];
        values[attribute.key] = value === undefined ? null : value;
        if (resolved.provenance[attribute.name] !== undefined) provenance[attribute.key] = resolved.provenance[attribute.name];
        status[attribute.key] = appliedStatus(attribute, value);
    }
    return { schemaVersion: configSchema().version, file: selfhostPath(), present: existsSync(selfhostPath()), values, provenance, status };
}

/**
 * The portable, versioned desired document — editable JSON names only, never
 * runtime identity/observations. Replay it on another machine by copying it into
 * that machine's selfhost.json desired block and running `muxr setup
 * --apply-config` (omitted keys fall back to schema defaults).
 */
export function exportDesiredConfig() {
    const desired = readDesiredConfig() ?? {};
    const doc = { version: 2 };
    for (const attribute of CONFIG_ATTRIBUTES) {
        const jsonName = jsonNameOf(attribute);
        if (desired[jsonName] !== undefined) doc[jsonName] = desired[jsonName];
    }
    return doc;
}

/** `muxr config [show] [--json|--schema]`: effective desired state, provenance and applied status. Read-only. */
export function printOperatorConfig(args = []) {
    const print = (text = '') => process.stdout.write(`${text}\n`);
    if (args.includes('--schema')) {
        print(JSON.stringify(configSchema(), null, 2));
        return 0;
    }
    let resolved;
    try {
        resolved = resolveOperatorConfig({ args });
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (args.includes('--json')) print(JSON.stringify({ ok: false, error: message }, null, 2));
        else process.stderr.write(`muxr config: ${message}\n`);
        return 1;
    }
    if (args.includes('--json')) {
        print(JSON.stringify({ ok: true, ...operatorConfigJson(resolved) }, null, 2));
        return 0;
    }
    print(`desired config: ${selfhostPath()}${existsSync(selfhostPath()) ? '' : ' (missing — defaults and probes apply until setup)'}`);
    for (const attribute of CONFIG_ATTRIBUTES) {
        const value = resolved.values[attribute.name];
        if (value === undefined) continue;
        const state = appliedStatus(attribute, value);
        print(`  ${jsonNameOf(attribute)}=${formatAttribute(attribute, value)} (${resolved.provenance[attribute.name]}${state === 'applied' ? '' : `, ${state}`})`);
    }
    if (existsSync(operatorConfigPath())) {
        print(`legacy: ${operatorConfigPath()} still present — its explicit values override selfhost.json desired while it exists; remove it to stop that (a one-time import is not yet available)`);
    }
    print('precedence: CLI flag > MUXR_* env > selfhost.json desired > probed/default · identity and observations live under "runtime", never edited by hand');
    print('edit selfhost.json then `muxr setup --apply-config` · export: muxr config export · schema: muxr config --schema');
    return 0;
}

/** `muxr config [show|export]` (set/apply arrive with the lifecycle parcel). Read-only here. */
export function runConfig(args = []) {
    const sub = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : undefined;
    if (sub === 'export') {
        process.stdout.write(`${JSON.stringify(exportDesiredConfig(), null, 2)}\n`);
        return 0;
    }
    if (sub === 'set' || sub === 'apply') {
        process.stderr.write(`muxr config ${sub}: not in this build yet — edit ${selfhostPath()} (or set MUXR_* env / flags) and run \`muxr setup --apply-config\` to validate, apply and verify.\n`);
        return 1;
    }
    return printOperatorConfig(sub === 'show' ? args.slice(1) : args);
}

export { BROWSER_CAPABLE_CONNECTIONS, attributeByKey };
