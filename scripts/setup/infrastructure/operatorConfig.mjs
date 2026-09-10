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

/** Intent keys. File keys ARE the MUXR_* env names: one namespace, no mapping table. */
export const OPERATOR_KEYS = [
    'MUXR_CONNECTION',
    'MUXR_RELAY_PORT',
    'MUXR_WEB',
    'MUXR_ADVERTISE_URL',
    'MUXR_INTEGRATIONS_SYNC',
    'MUXR_NOTIFY_EMAIL',
];

const CONNECTION_MODES = ['tailscale', 'tailscale-direct', 'private', 'lan', 'cloudflare', 'external'];

function readConfigFile() {
    try {
        if (!existsSync(operatorConfigPath())) return {};
        const parsed = parseEnv(readFileSync(operatorConfigPath(), 'utf8'));
        return Object.fromEntries(
            Object.entries(parsed).filter(([key, value]) => OPERATOR_KEYS.includes(key) && typeof value === 'string' && value.trim() !== ''),
        );
    } catch {
        return {};
    }
}

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
const falsy = (value) => ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());

function pick({ flag, envName, file, fallback, parse }) {
    if (flag !== undefined) return { value: parse(flag, 'flag'), provenance: 'flag' };
    const fromEnv = env(envName);
    if (fromEnv !== undefined) return { value: parse(fromEnv, 'env'), provenance: 'env' };
    if (file !== undefined) return { value: parse(file, 'config'), provenance: 'config' };
    return { value: fallback.value, provenance: fallback.provenance };
}

function parsePort(raw, _from) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`relay port must be an integer from 1024 to 65535 (got ${raw})`);
    return port;
}

function parseConnection(raw, from) {
    const mode = raw.trim();
    if (!CONNECTION_MODES.includes(mode)) throw new Error(`unknown connection ${mode} from ${from}; choose ${CONNECTION_MODES.join(', ')}`);
    return mode;
}

function parseWeb(raw, from) {
    if (truthy(raw)) return true;
    if (falsy(raw)) return false;
    throw new Error(`MUXR_WEB must be true/false (got ${raw} from ${from})`);
}

function parseAdvertise(raw) {
    const url = raw.trim().replace(/\/$/, '');
    if (url === '') return undefined;
    const parsed = new URL(url);
    if ((parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') || !parsed.hostname) throw new Error(`advertise URL must be a ws(s):// URL (got ${raw})`);
    return url;
}

/**
 * Resolve effective operator intent. `overrides.probed` carries values the
 * machine detected (recommended route, current state); anything unresolved
 * stays undefined with a 'default'/'probed' provenance note.
 */
export function resolveOperatorConfig({ args = [], probed = {} } = {}) {
    const file = readConfigFile();
    let webFlag;
    if (args.includes('--web')) webFlag = 'true';
    else if (args.includes('--no-web')) webFlag = 'false';
    const integrationsFlag = args.includes('--no-integrations') ? 'off' : undefined;

    const connection = pick({
        flag: flagValue(args, '--connection-mode') ?? flagValue(args, '--mode'),
        envName: 'MUXR_CONNECTION', file: file.MUXR_CONNECTION,
        fallback: { value: probed.connection, provenance: probed.connection === undefined ? 'default' : 'probed' },
        parse: parseConnection,
    });
    const relayPort = pick({
        flag: flagValue(args, '--port'),
        envName: 'MUXR_RELAY_PORT', file: file.MUXR_RELAY_PORT,
        fallback: { value: probed.relayPort ?? 8792, provenance: probed.relayPort === undefined ? 'default' : 'probed' },
        parse: parsePort,
    });
    const web = pick({
        flag: webFlag,
        envName: 'MUXR_WEB', file: file.MUXR_WEB,
        fallback: { value: probed.web, provenance: probed.web === undefined ? 'default' : 'probed' },
        parse: parseWeb,
    });
    const advertiseUrl = pick({
        flag: flagValue(args, '--advertise'),
        envName: 'MUXR_ADVERTISE_URL', file: file.MUXR_ADVERTISE_URL,
        fallback: { value: probed.advertiseUrl, provenance: probed.advertiseUrl === undefined ? 'default' : 'probed' },
        parse: parseAdvertise,
    });
    const integrationsSync = pick({
        flag: integrationsFlag,
        envName: 'MUXR_INTEGRATIONS_SYNC', file: file.MUXR_INTEGRATIONS_SYNC,
        fallback: { value: probed.integrationsSync ?? 'auto', provenance: 'default' },
        parse: (raw, from) => {
            const value = raw.trim().toLowerCase();
            if (!['auto', 'on', 'off'].includes(value)) throw new Error(`integrations sync must be auto/on/off (got ${raw} from ${from})`);
            return value;
        },
    });
    const notifyEmail = pick({
        flag: flagValue(args, '--notify-email'),
        envName: 'MUXR_NOTIFY_EMAIL', file: file.MUXR_NOTIFY_EMAIL,
        fallback: { value: undefined, provenance: 'default' },
        parse: (raw) => raw.trim(),
    });

    const values = {
        ...(connection.value === undefined ? {} : { connection: connection.value }),
        relayPort: relayPort.value,
        ...(web.value === undefined ? {} : { web: web.value }),
        ...(advertiseUrl.value === undefined ? {} : { advertiseUrl: advertiseUrl.value }),
        integrationsSync: integrationsSync.value,
        ...(notifyEmail.value === undefined ? {} : { notifyEmail: notifyEmail.value }),
    };
    const provenance = {
        connection: connection.provenance,
        relayPort: relayPort.provenance,
        web: web.provenance,
        ...(advertiseUrl.value === undefined ? {} : { advertiseUrl: advertiseUrl.provenance }),
        integrationsSync: integrationsSync.provenance,
        ...(notifyEmail.value === undefined ? {} : { notifyEmail: notifyEmail.provenance }),
    };
    return { values, provenance };
}

const CONFIG_COMMENTS = `# muxr operator intent — human-editable, safe to keep in dotfiles.
# One rule everywhere: CLI flag > MUXR_* env > this file > probed/default.
# No secrets here: credentials and machine state live in selfhost.json.
# Values: MUXR_CONNECTION=tailscale|tailscale-direct|private|lan|cloudflare|external
#         MUXR_RELAY_PORT=8792  MUXR_WEB=true|false
#         MUXR_ADVERTISE_URL=wss://... (external only)
#         MUXR_INTEGRATIONS_SYNC=auto|on|off  MUXR_NOTIFY_EMAIL=you@example.com
`;

/** Serialize intent only — never credentials or machine state. */
export function formatOperatorConfig(values) {
    const lines = [CONFIG_COMMENTS.trimEnd()];
    if (values.connection !== undefined) lines.push(`MUXR_CONNECTION=${values.connection}`);
    lines.push(`MUXR_RELAY_PORT=${values.relayPort ?? 8792}`);
    if (values.web !== undefined) lines.push(`MUXR_WEB=${values.web ? 'true' : 'false'}`);
    if (values.advertiseUrl !== undefined) lines.push(`MUXR_ADVERTISE_URL=${values.advertiseUrl}`);
    if (values.integrationsSync !== undefined && values.integrationsSync !== 'auto') lines.push(`MUXR_INTEGRATIONS_SYNC=${values.integrationsSync}`);
    if (values.notifyEmail !== undefined) lines.push(`MUXR_NOTIFY_EMAIL=${values.notifyEmail}`);
    return `${lines.join('\n')}\n`;
}

export function writeOperatorConfig(values) {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    chmodSync(stateDir(), 0o700);
    atomicWrite(operatorConfigPath(), formatOperatorConfig(values));
}

/** `key=value (provenance)` lines for `muxr config` and the Review screen. */
export function operatorReportLines(resolved) {
    return Object.keys(resolved.values).map((key) => `${key}=${resolved.values[key]} (${resolved.provenance[key]})`);
}

function snakeToEnv(key) {
    return { connection: 'MUXR_CONNECTION', relayPort: 'MUXR_RELAY_PORT', web: 'MUXR_WEB', advertiseUrl: 'MUXR_ADVERTISE_URL', integrationsSync: 'MUXR_INTEGRATIONS_SYNC', notifyEmail: 'MUXR_NOTIFY_EMAIL' }[key] ?? key;
}

/** `muxr config`: effective operator intent with provenance. Read-only. */
export function printOperatorConfig(args = []) {
    const { print } = { print: (text = '') => process.stdout.write(`${text}\n`) };
    const resolved = resolveOperatorConfig({ args });
    print(`operator intent: ${operatorConfigPath()}${existsSync(operatorConfigPath()) ? '' : ' (missing — defaults and probes apply)'}`);
    for (const key of Object.keys(resolved.values)) {
        print(`  ${snakeToEnv(key)}=${resolved.values[key]} (${resolved.provenance[key]})`);
    }
    print('precedence: CLI flag > MUXR_* env > config.env > probed/default · secrets live in selfhost.json, never here');
    return 0;
}
