import { MMKV } from 'react-native-mmkv';
import type { SessionAttachment } from '@muxr/contract';
import { Settings, settingsDefaults, settingsParse, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Profile, profileDefaults, profileParse } from './profile';
import { AGENT_KINDS } from './agentKinds';
type PermissionModeKey = string;

const mmkv = new MMKV();
const NEW_SESSION_DRAFT_KEY = 'new-session-draft-v1';
const REGISTERED_PUSH_TOKEN_KEY = 'registered-push-token-v1';
const LIFECYCLE_NOTIFICATIONS_KEY = 'lifecycle-notifications-v1';
const VOICE_REPORTS_KEY = 'lifecycle-voice-reports-v1';

export interface PersistedVoiceReport {
    identity: string;
    sessionId: string;
    from: string;
    status: string;
    displayName: string;
    taskTitle: string;
    attempts: number;
    readyAt: number;
}

export interface VoiceReportScope {
    pending: PersistedVoiceReport[];
    delivered: string[];
    updatedAt: number;
}

export interface VoiceReportPersistence { scopes: Record<string, VoiceReportScope> }

const VOICE_STATUSES = new Set(['idle', 'done', 'blocked', 'failed']);
const VOICE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const VOICE_CREDENTIAL_PATTERN = /(?:authorization\s*[:=]|bearer\s+[a-z0-9._-]{8,}|(?:api[ _-]?key|apikey|token|secret|password|credential)\s*[:=]\s*\S+|\bkey\s*[:=]\s*[a-z0-9._-]{8,}|\bsk-[a-z0-9_-]{8,}|\bacctok[a-z0-9_-]*|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const VOICE_INTERNAL_REFERENCE_PATTERN = /\b(?:pph?_[a-z0-9]+|(?:w\d+[A-Za-z]?):(?:p|t)\d+|(?:machine|device|session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i;
const VOICE_SCOPE_INTERNAL_REFERENCE_PATTERN = /\b(?:pph?_[a-z0-9]+|(?:w\d+[A-Za-z]?):(?:p|t)\d+|(?:session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b/i;
const VOICE_PATH_PATTERN = /\bfile:\/\/\/|(?:^|[^a-z0-9_/])(?:~\/|\/(?!\/)[^\s<>"'`]+|[a-z]:[\\/][^\s<>"'`]*|\\\\[^\s\\]+\\[^\s<>"'`]*)/i;
const VOICE_INSTRUCTION_PATTERN = /(?:\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the)\s+)?(?:previous|prior|earlier|above|system|developer)\s+(?:instructions?|directions?|messages?|rules?)\b|\b(?:system|developer)\s+prompt\b|\b(?:reveal|repeat|print|show)\s+(?:the\s+)?(?:system|developer)\s+prompt\b|\byou\s+are\s+(?:now|chatgpt|an?\s+assistant)\b|\bact\s+as\b|(?:^|[\s<])(?:system|assistant|developer)\s*:|<(?:system|assistant|developer)\b)/i;

export function sanitizePersistedVoiceReport(value: unknown): PersistedVoiceReport | null {
    if (typeof value !== 'object' || value === null) return null;
    const entry = value as Partial<PersistedVoiceReport>;
    const rawDisplayName = typeof entry.displayName === 'string' ? entry.displayName : '';
    const rawTaskTitle = typeof entry.taskTitle === 'string' ? entry.taskTitle : '';
    const displayName = rawDisplayName.trim().slice(0, 80);
    const taskTitle = rawTaskTitle.trim().slice(0, 200);
    const trustedText = `${displayName} ${taskTitle}`;
    if (typeof entry.identity !== 'string' || entry.identity === '' || entry.identity.length > 200
        || typeof entry.sessionId !== 'string' || entry.sessionId === '' || entry.sessionId.length > 200
        || entry.from !== 'working' || typeof entry.status !== 'string' || !VOICE_STATUSES.has(entry.status)
        || displayName === '' || taskTitle === '' || !isTrustedVoiceName(displayName)
        || VOICE_PATH_PATTERN.test(taskTitle)
        || VOICE_CONTROL_PATTERN.test(`${rawDisplayName}${rawTaskTitle}`)
        || VOICE_CREDENTIAL_PATTERN.test(trustedText)
        || VOICE_INTERNAL_REFERENCE_PATTERN.test(trustedText)
        || VOICE_INSTRUCTION_PATTERN.test(trustedText)) return null;
    const attempts = typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) && entry.attempts >= 0
        ? Math.min(Math.floor(entry.attempts), 1_000) : 0;
    const readyAt = typeof entry.readyAt === 'number' && Number.isFinite(entry.readyAt) && entry.readyAt >= 0
        ? Math.min(entry.readyAt, Date.now() + 30_000) : 0;
    return {
        identity: entry.identity, sessionId: entry.sessionId, from: 'working', status: entry.status,
        displayName, taskTitle, attempts, readyAt,
    };
}

function isTrustedVoiceName(name: string): boolean {
    return !/^(?:pp_|pane[_-]|session[_-])/i.test(name)
        && !/^[\w-]+:[\w-]+$/.test(name)
        && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(name)
        && !/[\\/]/.test(name);
}

function isTrustedVoiceScopeKey(value: string): boolean {
    if (value.length === 0 || value.length > 200 || value !== value.trim()
        || !/^[a-z0-9._:-]+$/i.test(value) || VOICE_CONTROL_PATTERN.test(value)
        || VOICE_CREDENTIAL_PATTERN.test(value) || VOICE_SCOPE_INTERNAL_REFERENCE_PATTERN.test(value)
        || VOICE_INSTRUCTION_PATTERN.test(value.replace(/[_-]+/g, ' '))) return false;
    return true;
}

export interface LifecycleNotificationScope {
    initialized: boolean;
    presented: Array<{ eventId: string; at: string }>;
    updatedAt: number;
}

export interface LifecycleNotificationPersistence {
    scopes: Record<string, LifecycleNotificationScope>;
}

/**
 * Legacy MMKV copy of the OpenAI key, captured once at load and purged from
 * storage immediately. Voice may offer it for a one-time transfer to the
 * muxr Voice plugin; after that the phone's copy is gone for good.
 */
let legacyRealtimeApiKey: string | null = null;

/** Take (and forget) any legacy key captured during load, for a one-time transfer. */
export function takeLegacyRealtimeApiKey(): string | null {
    const value = legacyRealtimeApiKey;
    legacyRealtimeApiKey = null;
    return value;
}

/**
 * Supported launch kinds passed through as session.start `kind`.
 * `shell` means a pane with no coding agent started in it.
 */
export const AGENT_TYPES = ['shell', ...AGENT_KINDS] as const;
export type NewSessionAgentType = (typeof AGENT_TYPES)[number];
export type NewSessionSessionType = 'simple' | 'worktree';

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey | null;
    modelMode: string | null;
    effortLevel: string | null;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;
    updatedAt: number;
}

export function loadSettings(): { settings: Settings, version: number | null } {
    const pending = mmkv.getString('pending-settings');
    if (pending) {
        try {
            const parsed = JSON.parse(pending) as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(parsed, 'realtimeApiKey')) {
                delete parsed.realtimeApiKey;
                mmkv.set('pending-settings', JSON.stringify(parsed));
            }
        } catch {
            mmkv.delete('pending-settings');
        }
    }
    const settings = mmkv.getString('settings');
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            const raw = parsed.settings as unknown;
            const hasLegacy = typeof raw === 'object' && raw !== null
                && Object.prototype.hasOwnProperty.call(raw, 'realtimeApiKey');
            const legacy = hasLegacy && typeof (raw as Record<string, unknown>).realtimeApiKey === 'string'
                ? String((raw as Record<string, unknown>).realtimeApiKey)
                : null;
            const parsedSettings = settingsParse(parsed.settings);
            if (hasLegacy) {
                // Delete the legacy field before any network attempt. A reachable
                // authenticated host may receive this in-memory value once; a
                // failed/offline transfer must never leave the phone copy behind.
                legacyRealtimeApiKey = legacy;
                mmkv.set('settings', JSON.stringify({ settings: parsedSettings, version: parsed.version }));
            }
            return { settings: parsedSettings, version: parsed.version };
        } catch {
            // Corrupt settings cannot be safely rewritten field-by-field. Drop
            // the blob so a hidden legacy key can never survive the migration.
            mmkv.delete('settings');
            return { settings: { ...settingsDefaults }, version: null };
        }
    }
    return { settings: { ...settingsDefaults }, version: null };
}

export function saveSettings(settings: Settings, version: number) {
    mmkv.set('settings', JSON.stringify({ settings, version }));
}

export function loadPendingSettings(): Partial<Settings> {
    const pending = mmkv.getString('pending-settings');
    if (pending) {
        try {
            const parsed = JSON.parse(pending);
            return SettingsSchema.partial().parse(parsed);
        } catch (e) {
            console.error('Failed to parse pending settings', e);
            return {};
        }
    }
    return {};
}

export function savePendingSettings(settings: Partial<Settings>) {
    mmkv.set('pending-settings', JSON.stringify(settings));
}

export function loadLocalSettings(): LocalSettings {
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            return localSettingsParse(parsed);
        } catch (e) {
            console.error('Failed to parse local settings', e);
            return { ...localSettingsDefaults };
        }
    }
    return { ...localSettingsDefaults };
}

export function saveLocalSettings(settings: LocalSettings) {
    mmkv.set('local-settings', JSON.stringify(settings));
}

export function loadThemePreference(): 'light' | 'dark' | 'adaptive' {
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            const settings = localSettingsParse(parsed);
            return settings.themePreference;
        } catch (e) {
            console.error('Failed to parse local settings for theme preference', e);
            return localSettingsDefaults.themePreference;
        }
    }
    return localSettingsDefaults.themePreference;
}

export function loadSessionDrafts(): Record<string, string> {
    const drafts = mmkv.getString('session-drafts');
    if (drafts) {
        try {
            return JSON.parse(drafts);
        } catch (e) {
            console.error('Failed to parse session drafts', e);
            return {};
        }
    }
    return {};
}

export function saveSessionDrafts(drafts: Record<string, string>) {
    mmkv.set('session-drafts', JSON.stringify(drafts));
}

/** Host metadata plus an optional local blob ref. Bytes never persist here. */
export type StoredSessionAttachment = SessionAttachment & { localUri?: string };

export function loadNewSessionDraft(): NewSessionDraft | null {
    const raw = mmkv.getString(NEW_SESSION_DRAFT_KEY);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const input = typeof parsed.input === 'string' ? parsed.input : '';
        const selectedMachineId = typeof parsed.selectedMachineId === 'string' ? parsed.selectedMachineId : null;
        const selectedPath = typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null;
        const agentType: NewSessionAgentType = AGENT_TYPES.includes(parsed.agentType as NewSessionAgentType)
            ? parsed.agentType as NewSessionAgentType
            : 'pi';
        const permissionMode: PermissionModeKey | null = typeof parsed.permissionMode === 'string'
            ? parsed.permissionMode
            : null;
        const modelMode: string | null = typeof parsed.modelMode === 'string' ? parsed.modelMode : null;
        const effortLevel: string | null = typeof parsed.effortLevel === 'string' ? parsed.effortLevel : null;
        const sessionType: NewSessionSessionType = parsed.sessionType === 'worktree' ? 'worktree' : 'simple';
        const worktreeKey = typeof parsed.worktreeKey === 'string' ? parsed.worktreeKey : null;
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

        return {
            input,
            selectedMachineId,
            selectedPath,
            agentType,
            permissionMode,
            modelMode,
            effortLevel,
            sessionType,
            worktreeKey,
            updatedAt,
        };
    } catch (e) {
        console.error('Failed to parse new session draft', e);
        return null;
    }
}

export function saveNewSessionDraft(draft: NewSessionDraft) {
    mmkv.set(NEW_SESSION_DRAFT_KEY, JSON.stringify(draft));
}

export function clearNewSessionDraft() {
    mmkv.delete(NEW_SESSION_DRAFT_KEY);
}

export function loadRegisteredPushToken(): string | null {
    return mmkv.getString(REGISTERED_PUSH_TOKEN_KEY) ?? null;
}

export function saveRegisteredPushToken(token: string) {
    mmkv.set(REGISTERED_PUSH_TOKEN_KEY, token);
}

export function clearRegisteredPushToken() {
    mmkv.delete(REGISTERED_PUSH_TOKEN_KEY);
}

export function loadLifecycleNotificationPersistence(): LifecycleNotificationPersistence {
    const raw = mmkv.getString(LIFECYCLE_NOTIFICATIONS_KEY);
    if (!raw) return { scopes: {} };
    try {
        const value = JSON.parse(raw) as Partial<LifecycleNotificationPersistence>;
        if (typeof value.scopes !== 'object' || value.scopes === null) return { scopes: {} };
        const scopes: LifecycleNotificationPersistence['scopes'] = {};
        for (const [key, scope] of Object.entries(value.scopes)) {
            if (typeof scope !== 'object' || scope === null) continue;
            scopes[key] = {
                initialized: scope.initialized === true,
                presented: Array.isArray(scope.presented)
                    ? scope.presented.filter((entry): entry is { eventId: string; at: string } =>
                        typeof entry?.eventId === 'string' && typeof entry.at === 'string')
                    : [],
                updatedAt: typeof scope.updatedAt === 'number' ? scope.updatedAt : 0,
            };
        }
        return { scopes };
    } catch {
        return { scopes: {} };
    }
}

export function saveLifecycleNotificationPersistence(value: LifecycleNotificationPersistence): void {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const scopes = Object.fromEntries(Object.entries(value.scopes)
        .filter(([, scope]) => scope.updatedAt >= cutoff)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, 8));
    value.scopes = scopes;
    mmkv.set(LIFECYCLE_NOTIFICATIONS_KEY, JSON.stringify({ scopes }));
}

export function loadVoiceReportPersistence(): VoiceReportPersistence {
    const raw = mmkv.getString(VOICE_REPORTS_KEY);
    if (!raw) return { scopes: {} };
    try {
        const value = JSON.parse(raw) as Partial<VoiceReportPersistence>;
        if (typeof value.scopes !== 'object' || value.scopes === null) return { scopes: {} };
        const scopes: Record<string, VoiceReportScope> = {};
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
        const entries = Object.entries(value.scopes)
            .filter(([key, scope]) => isTrustedVoiceScopeKey(key)
                && typeof scope === 'object' && scope !== null
                && typeof scope.updatedAt === 'number' && Number.isFinite(scope.updatedAt)
                && scope.updatedAt >= cutoff)
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, 8);
        for (const [key, scope] of entries) {
            if (typeof scope !== 'object' || scope === null) continue;
            const allDelivered = Array.isArray(scope.delivered)
                ? [...new Set(scope.delivered.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))]
                : [];
            const deliveredIds = new Set(allDelivered);
            const delivered = allDelivered.slice(-512);
            const pending = Array.isArray(scope.pending)
                ? scope.pending.map(sanitizePersistedVoiceReport).filter((entry): entry is PersistedVoiceReport => entry !== null)
                : [];
            const pendingById = new Map<string, PersistedVoiceReport>();
            for (const entry of pending) if (!deliveredIds.has(entry.identity) && !pendingById.has(entry.identity)) pendingById.set(entry.identity, entry);
            scopes[key] = {
                pending: [...pendingById.values()].slice(0, 128),
                delivered,
                updatedAt: typeof scope.updatedAt === 'number' ? scope.updatedAt : 0,
            };
        }
        return { scopes };
    } catch {
        return { scopes: {} };
    }
}

export function saveVoiceReportPersistence(value: VoiceReportPersistence): void {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    value.scopes = Object.fromEntries(Object.entries(value.scopes)
        .filter(([key, scope]) => isTrustedVoiceScopeKey(key) && scope.updatedAt >= cutoff)
        .map(([key, scope]) => [key, {
            pending: scope.pending.map(sanitizePersistedVoiceReport)
                .filter((entry): entry is PersistedVoiceReport => entry !== null).slice(0, 128),
            delivered: [...new Set(scope.delivered.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(-512),
            updatedAt: scope.updatedAt,
        }] as const)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, 8));
    mmkv.set(VOICE_REPORTS_KEY, JSON.stringify({ scopes: value.scopes }));
}

export function loadSessionLastMessageSentAt(): Record<string, number> {
    const timestamps = mmkv.getString('session-last-message-sent-at');
    if (timestamps) {
        try {
            return JSON.parse(timestamps);
        } catch (e) {
            console.error('Failed to parse session last message sent timestamps', e);
            return {};
        }
    }
    return {};
}

export function saveSessionLastMessageSentAt(timestamps: Record<string, number>) {
    mmkv.set('session-last-message-sent-at', JSON.stringify(timestamps));
}

export function loadProfile(): Profile {
    const profile = mmkv.getString('profile');
    if (profile) {
        try {
            const parsed = JSON.parse(profile);
            return profileParse(parsed);
        } catch (e) {
            console.error('Failed to parse profile', e);
            return { ...profileDefaults };
        }
    }
    return { ...profileDefaults };
}

export function saveProfile(profile: Profile) {
    mmkv.set('profile', JSON.stringify(profile));
}

// Simple temporary text storage for passing large strings between screens
export function storeTempText(content: string): string {
    const id = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    mmkv.set(`temp_text_${id}`, content);
    return id;
}

export function retrieveTempText(id: string): string | null {
    const content = mmkv.getString(`temp_text_${id}`);
    if (content) {
        // Auto-delete after retrieval
        mmkv.delete(`temp_text_${id}`);
        return content;
    }
    return null;
}


export function clearPersistence() {
    mmkv.clearAll();
}
