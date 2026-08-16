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
