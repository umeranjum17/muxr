/**
 * Operator-intent config: the human-editable `~/.muxr/config.env`.
 *
 * Holds only stable intent (connection, port, web, integrations) — never
 * credentials, keys, or machine-owned state, which stay in selfhost.json
 * (owner-only, machine-written). One precedence rule everywhere:
 * CLI flag > process env > operator config > probed/default value.
 */
import { parseEnv } from 'node:util';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BROWSER_CAPABLE_CONNECTIONS, CONFIG_ATTRIBUTES, CONFIG_KEYS, attributeByKey, attributeByName, configSchema, formatAttribute, validateCrossAttributes } from './configSchema.mjs';

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

function pick({ flag, envName, file, fallback, parse }) {
    if (flag !== undefined) return { value: parse(flag, 'flag'), provenance: 'flag' };
    const fromEnv = env(envName);
    if (fromEnv !== undefined) return { value: parse(fromEnv, 'env'), provenance: 'env' };
    if (file !== undefined) return { value: parse(file, 'config'), provenance: 'config' };
    return { value: fallback.value, provenance: fallback.provenance };
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
    const file = readConfigFile();
    if (file.error !== undefined) throw new Error(file.error);
    const fileValues = file.values;
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
        const picked = pick({
            flag: flagFor(attribute),
            envName: attribute.key,
            file: fileValues[attribute.key],
            fallback,
            parse: (raw, from) => attribute.parse(raw, from),
        });
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
    if (plan.web === true) argv.push('--web');
    if (plan.web === false) argv.push('--no-web');
    if (plan.advertiseUrl !== undefined) argv.push('--advertise', plan.advertiseUrl);
    if (plan.tunnel === true) argv.push('--tunnel');
    if (plan.tailscaleDirect === true) argv.push('--tailscale-direct');
    if (plan.notifyEmail !== undefined) argv.push('--notify-email', plan.notifyEmail);
    if (reconfigure) argv.push('--reconfigure');
    return argv;
}

/** Non-secret effective values with provenance, as `muxr config --json` prints them. */
export function operatorConfigJson(resolved) {
    const values = {};
    const provenance = {};
    for (const attribute of CONFIG_ATTRIBUTES) {
        const value = resolved.values[attribute.name];
        values[attribute.key] = value === undefined ? null : value;
        if (resolved.provenance[attribute.name] !== undefined) provenance[attribute.key] = resolved.provenance[attribute.name];
    }
    return { schemaVersion: configSchema().version, file: operatorConfigPath(), present: existsSync(operatorConfigPath()), values, provenance };
}

/** `muxr config [--json|--schema]`: effective desired state with provenance. Read-only. */
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
    print(`desired state: ${operatorConfigPath()}${existsSync(operatorConfigPath()) ? '' : ' (missing — defaults and probes apply)'}`);
    for (const attribute of CONFIG_ATTRIBUTES) {
        const value = resolved.values[attribute.name];
        if (value === undefined) continue;
        print(`  ${attribute.key}=${formatAttribute(attribute, value)} (${resolved.provenance[attribute.name]})`);
    }
    print('precedence: CLI flag > MUXR_* env > config.env > probed/default · secrets live in selfhost.json, never here');
    print('plan it: muxr setup --apply-config --dry-run --json · schema: muxr config --schema');
    return 0;
}

export { BROWSER_CAPABLE_CONNECTIONS, attributeByKey };
