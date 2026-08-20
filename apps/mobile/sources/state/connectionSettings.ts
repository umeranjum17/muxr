import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getWebSecret, setWebSecret } from './webSecureStore';

const STORAGE_KEY = 'muxr.connection.v1';
const MAX_RECENT_CWDS = 5;

export function pairingTransport(relayUrl: string | undefined): string | undefined {
    if (relayUrl === undefined) return undefined;
    try {
        const { hostname, protocol } = new URL(relayUrl);
        if (hostname.endsWith('.ts.net') || /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./.test(hostname)) return 'Tailscale';
        if (hostname.endsWith('.trycloudflare.com')) return 'Cloudflare tunnel';
        if (protocol === 'ws:' && (/^(localhost|127\.)/.test(hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname))) return 'Local network';
        return 'Hosted VPS / custom relay';
    } catch {
        return undefined;
    }
}

export interface ConnectionSettings {
    /** Hosted is fail-closed and grant-backed. Local is the explicit development fixture. */
    mode: 'hosted' | 'local';
    relayUrl: string;
    machineId: string;
    /** base64 shared key; empty string means cleartext (explicit opt-out). */
    encryptionKey: string;
    /** Account token from POST /v1/accounts. Required by a strict relay. */
    token: string;
    /** True when the active machine is a self-host pairing (no account surface). */
    selfhost?: boolean;
    lastSessionCwd: string;
    recentSessionCwds: string[];
}

/*
 * Build-time overrides so one export can point at a remote relay without a
 * settings screen. Stored settings still win once the user edits them.
 * Static process.env.EXPO_PUBLIC_* references only: Expo inlines them at
 * bundle time, so a dynamic template lookup silently bakes undefined.
 */
function buildEnv(suffix: 'MODE' | 'RELAY_URL' | 'MACHINE_ID' | 'E2EE_KEY' | 'TOKEN'): string | undefined {
    switch (suffix) {
        case 'MODE': return process.env.EXPO_PUBLIC_MUXR_MODE;
        case 'RELAY_URL': return process.env.EXPO_PUBLIC_MUXR_RELAY_URL;
        case 'MACHINE_ID': return process.env.EXPO_PUBLIC_MUXR_MACHINE_ID;
        case 'E2EE_KEY': return process.env.EXPO_PUBLIC_MUXR_E2EE_KEY;
        case 'TOKEN': return process.env.EXPO_PUBLIC_MUXR_TOKEN;
    }
}

const DEFAULT_MODE: ConnectionSettings['mode'] = buildEnv('MODE') === 'local' ? 'local' : 'hosted';

export const DEFAULT_CONNECTION: ConnectionSettings = {
    mode: DEFAULT_MODE,
    relayUrl: buildEnv('RELAY_URL') ?? 'ws://127.0.0.1:8792',
    machineId: buildEnv('MACHINE_ID') ?? 'devbox',
    encryptionKey: DEFAULT_MODE === 'local' ? (buildEnv('E2EE_KEY') ?? '') : '',
    token: DEFAULT_MODE === 'local' ? (buildEnv('TOKEN') ?? '') : '',
    lastSessionCwd: '',
    recentSessionCwds: [],
};

let memoryCache: ConnectionSettings | undefined;
let hydrated = false;

export function isConnectionSettingsHydrated(): boolean {
    return hydrated;
}

function parseSettings(raw: string): ConnectionSettings {
    const parsed = JSON.parse(raw) as Partial<ConnectionSettings>;
    const mode = parsed.mode === 'local' || parsed.mode === 'hosted' ? parsed.mode : DEFAULT_CONNECTION.mode;
    const recent = Array.isArray(parsed.recentSessionCwds)
        ? parsed.recentSessionCwds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
    return {
        mode,
        relayUrl: typeof parsed.relayUrl === 'string' && parsed.relayUrl.trim().length > 0
            ? parsed.relayUrl.trim()
            : DEFAULT_CONNECTION.relayUrl,
        // Hosted account-only sessions deliberately persist an empty machine id.
        // Falling back to the build default turns account auth into a fake machine connection.
        machineId: mode === 'hosted'
            ? typeof parsed.machineId === 'string' ? parsed.machineId.trim() : ''
            : typeof parsed.machineId === 'string' && parsed.machineId.trim().length > 0
                ? parsed.machineId.trim()
                : DEFAULT_CONNECTION.machineId,
        encryptionKey: mode === 'local' && typeof parsed.encryptionKey === 'string' ? parsed.encryptionKey.trim() : '',
        // An empty stored token is never usable against a strict relay, so it
        // falls back to the build default rather than pinning the app to a
        // permanent unauthorized retry loop.
        token: mode === 'local' && typeof parsed.token === 'string' && parsed.token.trim().length > 0
            ? parsed.token.trim()
            : mode === 'local' ? DEFAULT_CONNECTION.token : '',
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
    memoryCache = settings;
    try {
        await writeRaw(JSON.stringify(settings));
    } catch {
        // ponytail: in-memory cache still holds latest edits if disk write fails
    }
}

export function rememberSessionCwd(settings: ConnectionSettings, cwd: string): ConnectionSettings {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) return settings;
    const recent = [trimmed, ...settings.recentSessionCwds.filter((entry) => entry !== trimmed)].slice(0, MAX_RECENT_CWDS);
    return { ...settings, lastSessionCwd: trimmed, recentSessionCwds: recent };
}
