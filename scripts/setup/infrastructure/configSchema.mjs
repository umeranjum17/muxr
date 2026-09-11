/**
 * The one versioned definition of muxr's desired-state configuration.
 *
 * Every attribute of `~/.muxr/config.env` is declared here once: its env
 * name, type, allowed values, default, applicability, restart behaviour and
 * one-line description. Validation, defaults, provenance, `muxr config
 * --schema/--json`, the TUI Review preview, the JSON plan, the generated
 * configuration page and the agent skill all derive from this table, so
 * they cannot disagree.
 *
 * Rules that hold for every attribute:
 * - values are never echoed in errors; the key, its source and the rule are;
 * - ephemeral secrets and actions (provider keys, owner mint secrets, device
 *   keys, pairing codes, enrollment strings, one-use invitations) are not
 *   attributes and never appear here.
 */

export const CONFIG_SCHEMA_VERSION = 1;



const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
// Single addr-spec, no display name, no comments: what the relay can mail.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
const falsy = (value) => ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());

/** Root ws(s)://host[:port] only: userinfo, path, query and fragment are refused before the value can be reported anywhere. */
function parseRootWsUrl(raw, { requireWss }) {
    const url = raw.trim().replace(/\/$/, '');
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    const protocols = requireWss ? ['wss:'] : ['wss:', 'ws:'];
    if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        return undefined;
    }
    return url;
}

/**
 * `code=on,status=off` -> { code: true, status: false }. Only bundled plugin
 * short names; unknown names fail at plan time against the packaged set.
 */
function parseEnabledMap(raw) {
    const map = {};
    for (const part of raw.split(',')) {
        const entry = part.trim();
        if (entry === '') continue;
        const match = /^([a-z][a-z0-9-]{0,63})=(on|off)$/i.exec(entry);
        if (match === null) return undefined;
        map[match[1].toLowerCase()] = match[2].toLowerCase() === 'on';
    }
    return map;
}

/**
 * Exact add-on sources only: `owner/repo[/subdir]@<40-hex sha>` or
 * `npm:<name>@<exact version>`. Tags, branches and `latest` are refused so a
 * reapply installs the same bytes.
 */
function parseExtraPlugins(raw) {
    const list = [];
    for (const part of raw.split(',')) {
        const entry = part.trim();
        if (entry === '') continue;
        const github = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?)@([0-9a-f]{40}|[0-9a-f]{64})$/.exec(entry);
        const npm = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(entry);
        if (github !== null) list.push({ kind: 'github', source: github[1], ref: github[2] });
        else if (npm !== null) list.push({ kind: 'npm', name: npm[1], version: npm[2] });
        else return undefined;
    }
    return list;
}

export const CONNECTION_MODES = ['tailscale', 'tailscale-direct', 'private', 'lan', 'cloudflare', 'external'];
/** Routes a browser can reach: HTTPS/WSS origin the PWA can be served from. */
export const BROWSER_CAPABLE_CONNECTIONS = ['tailscale', 'cloudflare', 'external'];

/**
 * Attribute definition. `parse(raw, from)` returns the typed value or throws
 * an Error whose message names the key, source and rule only. `format(value)`
 * is the inverse for config.env and JSON.
 */
export const CONFIG_ATTRIBUTES = [
    {
        key: 'MUXR_SETUP_ROLE', name: 'setupRole', type: 'enum', values: ['single-machine', 'shared-relay', 'remote-host'], default: 'single-machine',
        description: 'What this computer is: the usual relay+host on one machine, an always-on shared relay for other machines, or an agent host enrolled with a shared relay.',
        appliesTo: 'always', restart: 'relay and host',
        parse(raw, from) { const v = raw.trim(); if (!this.values.includes(v)) throw ruleError(this, from, `must be one of ${this.values.join(', ')}`); return v; },
    },
    {
        key: 'MUXR_CONNECTION', name: 'connection', type: 'enum', values: CONNECTION_MODES, default: undefined,
        description: 'How devices reach the relay. tailscale (Serve, HTTPS), cloudflare (quick tunnel, HTTPS) and external (your own wss:// origin) serve the browser app; tailscale-direct, private and lan are native-only routes.',
        appliesTo: 'single-machine, shared-relay', restart: 'relay and host', flag: '--connection-mode',
        parse(raw, from) { const v = raw.trim(); if (!this.values.includes(v)) throw ruleError(this, from, `must be one of ${this.values.join(', ')}`); return v; },
    },
    {
        key: 'MUXR_RELAY_PORT', name: 'relayPort', type: 'integer', values: '1024..65535', default: 8792,
        description: 'Local relay port.',
        appliesTo: 'single-machine, shared-relay', restart: 'relay and host', flag: '--port',
        parse(raw, from) { const port = Number(raw); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw ruleError(this, from, 'must be an integer from 1024 to 65535'); return port; },
        format: (value) => String(value),
    },
    {
        key: 'MUXR_WEB', name: 'web', type: 'boolean', values: ['true', 'false'], default: undefined,
        description: 'Serve the browser app from this host. Requires a browser-capable connection. A fresh single-machine setup defaults to true; automation must say false explicitly to opt out.',
        appliesTo: 'single-machine', restart: 'relay', flag: '--web / --no-web',
        parse(raw, from) { if (truthy(raw)) return true; if (falsy(raw)) return false; throw ruleError(this, from, 'must be true or false'); },
        format: (value) => (value ? 'true' : 'false'),
    },
    {
        key: 'MUXR_ADVERTISE_URL', name: 'advertiseUrl', type: 'url', values: 'root ws(s)://host[:port]', default: undefined,
        description: 'Relay URL devices connect to. Required for external (root wss://host, nothing else in it); derived for the other routes.',
        appliesTo: 'connection=external (required), private/lan (optional override)', restart: 'relay and host', flag: '--advertise',
        parse(raw, from) { const url = raw.trim() === '' ? undefined : parseRootWsUrl(raw, { requireWss: false }); if (raw.trim() !== '' && url === undefined) throw ruleError(this, from, 'must be a root ws(s)://host[:port] URL without credentials, path, query, or fragment'); return url; },
    },
    {
        key: 'MUXR_INTEGRATIONS_SYNC', name: 'integrationsSync', type: 'enum', values: ['auto', 'on', 'off'], default: 'auto',
        description: 'Coding-agent lifecycle integrations: auto syncs detected agents, on syncs every supported agent, off leaves them alone.',
        appliesTo: 'single-machine, remote-host', restart: 'none', flag: '--no-integrations (=off)',
        parse(raw, from) { const v = raw.trim().toLowerCase(); if (!this.values.includes(v)) throw ruleError(this, from, 'must be auto, on, or off'); return v; },
    },
    {
        key: 'MUXR_NOTIFY_EMAIL', name: 'notifyEmail', type: 'email', values: 'one address', default: undefined,
        description: 'Optional address the relay notifies about attention events.',
        appliesTo: 'always', restart: 'relay', flag: '--notify-email',
        parse(raw, from) { const v = raw.trim(); if (v === '') return undefined; if (v.length > 254 || !EMAIL.test(v)) throw ruleError(this, from, 'must be one valid email address'); return v; },
    },
    {
        key: 'MUXR_SERVICE_MODE', name: 'serviceMode', type: 'enum', values: ['managed', 'foreground'], default: 'managed',
        description: 'managed registers systemd/launchd user services that survive logout; foreground runs relay and host only while `muxr up` is running.',
        appliesTo: 'always', restart: 'relay and host',
        parse(raw, from) { const v = raw.trim().toLowerCase(); if (!this.values.includes(v)) throw ruleError(this, from, 'must be managed or foreground'); return v; },
    },
    {
        key: 'MUXR_PAIRING_DEFAULT', name: 'pairingDefault', type: 'enum', values: ['browser', 'browser-view', 'browser-personal', 'native', 'none'], default: 'browser',
        description: 'Which grant `muxr pair` and the Herdr Pair pane offer first: browser Control (8 hours), View-only (8 hours), personal Control (30 days), the native QR, or nothing.',
        appliesTo: 'single-machine, remote-host', restart: 'none',
        parse(raw, from) { const v = raw.trim().toLowerCase(); if (!this.values.includes(v)) throw ruleError(this, from, `must be one of ${this.values.join(', ')}`); return v; },
    },
    {
        key: 'MUXR_BUNDLED_PLUGINS', name: 'bundledPlugins', type: 'map', values: '<name>=on|off[,...]', default: {},
        description: 'Enable or disable bundled muxr plugins by short name (for example code=on,status=off). Unlisted plugins keep their packaged default (enabled).',
        appliesTo: 'single-machine, remote-host', restart: 'none',
        parse(raw, from) { const map = parseEnabledMap(raw); if (map === undefined) throw ruleError(this, from, 'must be a comma-separated list of <name>=on|off'); return map; },
        format: (value) => Object.entries(value).map(([name, on]) => `${name}=${on ? 'on' : 'off'}`).join(','),
    },
    {
        key: 'MUXR_EXTRA_PLUGINS', name: 'extraPlugins', type: 'list', values: 'owner/repo[/subdir]@<sha>[,...] | npm:<name>@<version>', default: [],
        description: 'Add-on muxr plugins pinned to an exact GitHub commit or exact npm version. Tags, branches and latest are refused so a reapply installs the same bytes.',
        appliesTo: 'single-machine, remote-host', restart: 'none',
        parse(raw, from) { const list = parseExtraPlugins(raw); if (list === undefined) throw ruleError(this, from, 'entries must be owner/repo[/subdir]@<40-hex sha> or npm:<name>@<exact version>'); return list; },
        format: (value) => value.map((entry) => (entry.kind === 'npm' ? `npm:${entry.name}@${entry.version}` : `${entry.source}@${entry.ref}`)).join(','),
    },
    {
        key: 'MUXR_VOICE_PROVIDER', name: 'voiceProvider', type: 'string', values: 'installed host voice provider id', default: undefined,
        description: 'Realtime voice provider selected on this host (see `muxr voice status`). Unset leaves the host choice unchanged. Credentials are never configuration.',
        appliesTo: 'single-machine, remote-host', restart: 'none',
        parse(raw, from) { const v = raw.trim().toLowerCase(); if (v === '') return undefined; if (!PLUGIN_ID.test(v)) throw ruleError(this, from, 'must be a provider id (lowercase letters, digits, dashes)'); return v; },
    },
];

function ruleError(attribute, from, rule) {
    return new Error(`${attribute.key} (${from}) ${rule}`);
}

/** Schema defaults for a fresh plan, keyed by attribute name (unset optionals stay absent). */
export function configDefaults() {
    const values = {};
    for (const attribute of CONFIG_ATTRIBUTES) {
        if (attribute.default === undefined) continue;
        values[attribute.name] = typeof attribute.default === 'object' ? structuredClone(attribute.default) : attribute.default;
    }
    return values;
}

export const attributeByKey = (key) => CONFIG_ATTRIBUTES.find((attribute) => attribute.key === key);
export const attributeByName = (name) => CONFIG_ATTRIBUTES.find((attribute) => attribute.name === name);
export const CONFIG_KEYS = CONFIG_ATTRIBUTES.map((attribute) => attribute.key);

export function formatAttribute(attribute, value) {
    if (value === undefined) return undefined;
    return attribute.format === undefined ? String(value) : attribute.format(value);
}

/** Cross-attribute rules: the only validation that needs more than one key. */
export const CONFIG_CONFLICTS = [
    { keys: ['MUXR_CONNECTION', 'MUXR_ADVERTISE_URL'], rule: 'MUXR_CONNECTION=external needs MUXR_ADVERTISE_URL (root wss://host)' },
    { keys: ['MUXR_WEB', 'MUXR_CONNECTION'], rule: `MUXR_WEB=true needs a browser-capable MUXR_CONNECTION (${BROWSER_CAPABLE_CONNECTIONS.join(', ')})` },
    { keys: ['MUXR_SETUP_ROLE', 'MUXR_CONNECTION'], rule: 'MUXR_SETUP_ROLE=remote-host takes no MUXR_CONNECTION; the shared relay decides' },
];

export function validateCrossAttributes(values) {
    if (values.connection === 'external') {
        if (values.advertiseUrl === undefined) throw new Error('MUXR_CONNECTION=external needs MUXR_ADVERTISE_URL (or --advertise <wss://host>)');
        if (parseRootWsUrl(values.advertiseUrl, { requireWss: true }) === undefined) {
            throw new Error('MUXR_ADVERTISE_URL must be a root wss://host URL without credentials, query, or fragment for an external connection');
        }
    }
    if (values.web === true && values.connection !== undefined && !BROWSER_CAPABLE_CONNECTIONS.includes(values.connection)) {
        throw new Error(`MUXR_WEB=true needs a browser-capable MUXR_CONNECTION (${BROWSER_CAPABLE_CONNECTIONS.join(', ')}); ${values.connection} is a native-only route`);
    }
    if (values.setupRole === 'remote-host' && values.connection !== undefined) {
        throw new Error('MUXR_SETUP_ROLE=remote-host takes no MUXR_CONNECTION; the shared relay decides the route');
    }
}

/** `muxr config --schema` and the generated docs read exactly this. */
export function configSchema() {
    return {
        version: CONFIG_SCHEMA_VERSION,
        file: '~/.muxr/config.env',
        precedence: ['flag', 'env', 'config', 'probed', 'default'],
        attributes: CONFIG_ATTRIBUTES.map((attribute) => ({
            key: attribute.key,
            type: attribute.type,
            values: attribute.values,
            default: attribute.default === undefined ? null : attribute.default,
            description: attribute.description,
            appliesTo: attribute.appliesTo,
            restart: attribute.restart,
            ...(attribute.flag === undefined ? {} : { flag: attribute.flag }),
        })),
        conflicts: CONFIG_CONFLICTS,
        notConfiguration: ['provider API keys and OAuth logins', 'the relay owner mint secret', 'device keys', 'pairing codes', 'enrollment strings', 'one-use invitations'],
        exitCodes: { 0: 'verified, no unresolved failure', 1: 'invalid configuration or unavailable prerequisite', 2: 'dry run: valid plan with changes to apply' },
    };
}
