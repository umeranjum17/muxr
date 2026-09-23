import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getWebSecret, setWebSecret } from '@/pairing/secrets';

const STORAGE_KEY = 'muxr.connection.v1';
const MAX_RECENT_CWDS = 5;

function isTailscaleHost(hostname: string): boolean {
    return hostname.endsWith('.ts.net')
        || /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./.test(hostname);
}

function isPrivateLanHost(hostname: string): boolean {
    return /^(localhost|127\.)/.test(hostname)
        || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

export function pairingTransport(relayUrl: string | undefined): string | undefined {
    if (relayUrl === undefined) return undefined;
    try {
        const { hostname, protocol } = new URL(relayUrl);
        if (isTailscaleHost(hostname)) return 'Tailscale';
        if (hostname.endsWith('.trycloudflare.com')) return 'Cloudflare tunnel';
        if ((protocol === 'ws:' || protocol === 'wss:') && isPrivateLanHost(hostname)) return 'Local or private network';
        return 'Hosted VPS / custom relay';
    } catch {
        return undefined;
    }
}

export interface SshTarget {
    /** Host running sshd; never a muxr machine name or display label. */
    host: string;
    port: number;
    username: string;
    /** The muxr relay port as seen from the SSH host's loopback. */
    relayPort: number;
    /** SHA256:... fingerprint learned on first connect and then pinned. */
    hostKey?: string;
}

export interface ConnectionSettings {
    /** Hosted is fail-closed and grant-backed. Local is the explicit development fixture. */
    mode: 'hosted' | 'local';
    relayUrl: string;
    machineId: string;
    /** Account token from POST /v1/accounts. Required by a strict relay. */
    token: string;
    /** True when the active machine is a self-host pairing (no account surface). */
    selfhost?: boolean;
    /** Android-only route override; the relay and E2EE grant stay unchanged. */
    ssh?: SshTarget;
    lastSessionCwd: string;
    recentSessionCwds: string[];
}

/*
 * Build-time overrides so one local build can point at a remote relay without a
 * settings screen. Stored settings still win once the user edits them.
 * Static process.env.EXPO_PUBLIC_* references only: Expo inlines them at
 * bundle time, so a dynamic template lookup silently bakes undefined.
 *
 * A browser export bakes none of them. It is served by the host it pairs with
 * and takes its connection from that pairing, so a published web bundle must
 * never carry a machine id, a relay URL, or an account token that was merely
 * set in the build environment. Metro folds `Platform.OS` per platform, so the
 * `web` branch is dropped before the literals can be baked.
 */
const BUILD_ENV_APPLIES = Platform.OS !== 'web';

function buildEnv(suffix: 'MODE' | 'RELAY_URL' | 'MACHINE_ID' | 'TOKEN'): string | undefined {
    if (!BUILD_ENV_APPLIES) return undefined;
    switch (suffix) {
        case 'MODE': return process.env.EXPO_PUBLIC_MUXR_MODE;
        case 'RELAY_URL': return process.env.EXPO_PUBLIC_MUXR_RELAY_URL;
        case 'MACHINE_ID': return process.env.EXPO_PUBLIC_MUXR_MACHINE_ID;
        case 'TOKEN': return process.env.EXPO_PUBLIC_MUXR_TOKEN;
    }
}

const DEFAULT_MODE: ConnectionSettings['mode'] = buildEnv('MODE') === 'local' ? 'local' : 'hosted';

export const DEFAULT_CONNECTION: ConnectionSettings = {
    mode: DEFAULT_MODE,
    relayUrl: buildEnv('RELAY_URL') ?? 'ws://127.0.0.1:8792',
    machineId: buildEnv('MACHINE_ID') ?? (DEFAULT_MODE === 'local' ? 'devbox' : ''),
    token: DEFAULT_MODE === 'local' ? (buildEnv('TOKEN') ?? '') : '',
    lastSessionCwd: '',
    recentSessionCwds: [],
};

let memoryCache: ConnectionSettings | undefined;
let hydrated = false;

export function isConnectionSettingsHydrated(): boolean {
    return hydrated;
}

function parseMachineId(mode: ConnectionSettings['mode'], parsed: Partial<ConnectionSettings>): string {
    const raw = typeof parsed.machineId === 'string' ? parsed.machineId.trim() : '';
    if (mode === 'hosted') return raw;
    if (raw.length > 0) return raw;
    return DEFAULT_CONNECTION.machineId;
}

function parseLocalToken(storedToken: string): string {
    if (storedToken.length > 0) return storedToken;
    return DEFAULT_CONNECTION.token;
}

function parsePort(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fallback;
}

function parseSshTarget(value: unknown): SshTarget | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const parsed = value as Partial<SshTarget>;
    const host = typeof parsed.host === 'string' ? parsed.host.trim() : '';
    const username = typeof parsed.username === 'string' ? parsed.username.trim() : '';
    if (host.length === 0 || username.length === 0) return undefined;
    const hostKey = typeof parsed.hostKey === 'string' && /^SHA256:[A-Za-z0-9+/]+$/.test(parsed.hostKey)
        ? parsed.hostKey
        : undefined;
    return {
        host,
        username,
        port: parsePort(parsed.port, 22),
        relayPort: parsePort(parsed.relayPort, 8792),
        ...(hostKey === undefined ? {} : { hostKey }),
    };
}

function parseSettings(raw: string): ConnectionSettings {
    const parsed = JSON.parse(raw) as Partial<ConnectionSettings>;
    const mode = parsed.mode === 'local' || parsed.mode === 'hosted' ? parsed.mode : DEFAULT_CONNECTION.mode;
    const recent = Array.isArray(parsed.recentSessionCwds)
        ? parsed.recentSessionCwds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
    const storedToken = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    const ssh = parsed.selfhost === true ? parseSshTarget(parsed.ssh) : undefined;
    return {
        mode,
        relayUrl: typeof parsed.relayUrl === 'string' && parsed.relayUrl.trim().length > 0
            ? parsed.relayUrl.trim()
            : DEFAULT_CONNECTION.relayUrl,
        // Hosted account-only sessions deliberately persist an empty machine id.
        // Falling back to the build default turns account auth into a fake machine connection.
        machineId: parseMachineId(mode, parsed),
        ...(ssh === undefined ? {} : { ssh }),
        // An empty stored token is never usable against a strict relay, so it
        // falls back to the build default rather than pinning the app to a
        // permanent unauthorized retry loop.
        token: mode === 'local' ? parseLocalToken(storedToken) : '',
        lastSessionCwd: typeof parsed.lastSessionCwd === 'string' ? parsed.lastSessionCwd.trim() : '',
        ...(parsed.selfhost === true ? { selfhost: true } : {}),
        recentSessionCwds: recent.slice(0, MAX_RECENT_CWDS),
    };
}

async function readRaw(): Promise<string | null> {
    if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
        return getWebSecret(STORAGE_KEY);
    }
    return AsyncStorage.getItem(STORAGE_KEY);
}

async function writeRaw(json: string): Promise<void> {
    if (Platform.OS === 'web') return setWebSecret(STORAGE_KEY, json);
    await AsyncStorage.setItem(STORAGE_KEY, json);
}

/** Sync read of cached settings; defaults until async hydration completes. */
export function getCachedConnectionSettings(): ConnectionSettings {
    return memoryCache ?? { ...DEFAULT_CONNECTION };
}

export async function loadConnectionSettingsAsync(): Promise<ConnectionSettings> {
    if (memoryCache !== undefined) {
        hydrated = true;
        return memoryCache;
    }
    try {
        const raw = await readRaw();
        if (raw !== null) {
            memoryCache = parseSettings(raw);
            if (memoryCache.mode === 'hosted') await writeRaw(JSON.stringify(memoryCache));
            hydrated = true;
            return memoryCache;
        }
    } catch {
        // ponytail: corrupt storage falls back to defaults
    }
    memoryCache = { ...DEFAULT_CONNECTION };
    hydrated = true;
    return memoryCache;
}

export async function saveConnectionSettings(settings: ConnectionSettings): Promise<void> {
    const previous = await loadConnectionSettingsAsync();
    if (previous.machineId !== settings.machineId || previous.mode !== settings.mode) {
        const { clearArtifactDownloads } = await import('@/utils/artifactTransfer');
        await clearArtifactDownloads();
    }
    await writeRaw(JSON.stringify(settings));
    memoryCache = settings;
}

export function rememberSessionCwd(settings: ConnectionSettings, cwd: string): ConnectionSettings {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) return settings;
    const recent = [trimmed, ...settings.recentSessionCwds.filter((entry) => entry !== trimmed)].slice(0, MAX_RECENT_CWDS);
    return { ...settings, lastSessionCwd: trimmed, recentSessionCwds: recent };
}
