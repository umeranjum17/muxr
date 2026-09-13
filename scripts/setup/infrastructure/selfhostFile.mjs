/**
 * The `~/.muxr/selfhost.json` file model, dependency-free on purpose.
 *
 * selfhost.json version 2 has two roles in one file: editable **desired**
 * config at the top level (the public JSON names — webEnabled, bindHost,
 * relayPort, connectionMode, relayUrl, …) and generated/observed **runtime**
 * (machine identity, credentials, actual endpoint, ingress ownership, the last
 * successfully applied config) under `runtime`. Runtime can never overwrite a
 * desired value: health/ingress/auth writers merge into `runtime` only.
 *
 * This module imports no crypto/QR/domain code so the operator resolver
 * (`operatorConfig.mjs`) can read desired state while staying light. The
 * live-relay helpers that DO need that stack live in `selfhost.mjs`, which
 * re-exports everything here so existing importers are unaffected.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const env = (name) => process.env[name]?.trim() || undefined;
const stateDir = () => env('MUXR_HOME') || join(env('HOME') || homedir(), '.muxr');

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

export const selfhostPath = () => join(stateDir(), 'selfhost.json');

/** Raw parse of selfhost.json — a v1 (flat) or v2 (desired + runtime) record, or undefined. */
export function readSelfhostFile() {
    try {
        if (!existsSync(selfhostPath())) return undefined;
        const parsed = JSON.parse(readFileSync(selfhostPath(), 'utf8'));
        return parsed?.version === 1 || parsed?.version === 2 ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** connectionMode values whose relayUrl the operator sets explicitly; the rest are derived. */
const EXPLICIT_RELAY_URL_MODES = ['external', 'private', 'lan'];

/**
 * Split a v1 flat record into v2: editable desired at the top, generated
 * identity and observed state under `runtime`. Identity, grants, ingress
 * ownership and device records move verbatim — no key is regenerated. An
 * explicit legacy bind choice is retained; a derived route's relayUrl becomes
 * desired null (its actual URL lives in runtime). Pure: never writes.
 */
export function migrateSelfhostToV2(v1) {
    const desired = {
        setupRole: v1.setupRole ?? (v1.relayLocation === 'remote' ? 'remote-host' : 'single-machine'),
        ...(v1.connectionMode !== undefined ? { connectionMode: v1.connectionMode } : {}),
        relayPort: Number.isInteger(v1.relayPort) ? v1.relayPort : 8792,
        bindHost: v1.bindHost === '127.0.0.1' || v1.bindHost === '0.0.0.0' ? v1.bindHost : 'auto',
        ...(typeof v1.webEnabled === 'boolean' ? { webEnabled: v1.webEnabled } : {}),
        relayUrl: EXPLICIT_RELAY_URL_MODES.includes(v1.connectionMode) ? (v1.relayUrl ?? null) : null,
        serviceMode: v1.serviceMode ?? 'managed',
        ...(v1.notifyEmail ? { notifyEmail: v1.notifyEmail } : {}),
        integrationsSync: v1.integrationsSync ?? 'auto',
        pairingDefault: v1.pairingDefault ?? 'browser',
        bundledPlugins: v1.bundledPlugins ?? {},
        extraPlugins: v1.extraPlugins ?? [],
        ...(v1.voiceProvider ? { voiceProvider: v1.voiceProvider } : {}),
    };
    const runtime = {
        ...(v1.machine ? { machine: v1.machine } : {}),
        ...(v1.machineCredential ? { machineCredential: v1.machineCredential } : {}),
        ...(v1.credentialExpiresAt ? { credentialExpiresAt: v1.credentialExpiresAt } : {}),
        ...(v1.mintSecret ? { mintSecret: v1.mintSecret } : {}),
        ...(v1.relayLocation ? { relayLocation: v1.relayLocation } : {}),
        ...(v1.ingress ? { ingress: v1.ingress } : {}),
        ...(v1.relayPort !== undefined ? { relayPort: v1.relayPort } : {}),
        ...(v1.relayUrl !== undefined ? { relayUrl: v1.relayUrl } : {}),
        ...(v1.bindHost !== undefined ? { bindHost: v1.bindHost } : {}),
        ...(typeof v1.webEnabled === 'boolean' ? { webEnabled: v1.webEnabled } : {}),
        ...(v1.webRoot ? { webRoot: v1.webRoot } : {}),
        ...(v1.webOrigin ? { webOrigin: v1.webOrigin } : {}),
        appliedConfig: { ...desired },
    };
    return { version: 2, ...desired, runtime };
}

/** The flat applied-effective view v1 callers expect: runtime (actual/identity) over desired. */
function appliedView(v2) {
    const { runtime = {}, ...desired } = v2;
    return { ...desired, ...runtime, version: 2 };
}

/**
 * The applied-effective state for operational callers (auth, control base,
 * status): identity and actual endpoint from runtime, editable values from the
 * top level. A v1 file is already this flat shape; a v2 file is flattened with
 * runtime winning. Editable desired is read with `readDesiredConfig`.
 */
export function readSelfhostState() {
    const file = readSelfhostFile();
    if (file === undefined) return undefined;
    return file.version === 2 ? appliedView(file) : file;
}

/** The editable desired configuration (public JSON names), migrating a v1 file's view. */
export function readDesiredConfig() {
    const file = readSelfhostFile();
    if (file === undefined) return undefined;
    const v2 = file.version === 2 ? file : migrateSelfhostToV2(file);
    const { runtime: _runtime, version: _version, ...desired } = v2;
    return desired;
}

/**
 * Merge generated/observed fields into `runtime` only, never touching desired.
 * Migrates a v1 file to v2 in place. This is the single path health/ingress/
 * auth writers use so an observation can never overwrite an editable value.
 */
export function mergeSelfhostRuntime(partial) {
    const file = readSelfhostFile();
    if (file === undefined) return;
    const v2 = file.version === 2 ? file : migrateSelfhostToV2(file);
    v2.runtime = { ...(v2.runtime ?? {}), ...partial };
    writeSelfhostState(v2);
}

/** Merge validated editable values into the desired top level, preserving runtime. */
export function writeDesiredConfig(partialDesired) {
    const file = readSelfhostFile();
    const v2 = file === undefined
        ? { version: 2, runtime: {} }
        : (file.version === 2 ? file : migrateSelfhostToV2(file));
    for (const [key, value] of Object.entries(partialDesired)) {
        if (value === undefined) delete v2[key];
        else v2[key] = value;
    }
    v2.version = 2;
    writeSelfhostState(v2);
    return v2;
}

/**
 * True when selfhost.json exists but does not parse. Corrupt is not "not
 * configured": setup must never mint a new machine identity over it (that
 * destroys every pairing), so callers distinguish the two.
 */
export function selfhostStateUnreadable() {
    if (!existsSync(selfhostPath())) return false;
    try {
        JSON.parse(readFileSync(selfhostPath(), 'utf8'));
        return false;
    } catch {
        return true;
    }
}

export function selfhostConfigured() { return readSelfhostState() !== undefined; }

export function writeSelfhostState(state) {
    atomicWrite(selfhostPath(), `${JSON.stringify(state, null, 2)}\n`);
}

export { EXPLICIT_RELAY_URL_MODES };
