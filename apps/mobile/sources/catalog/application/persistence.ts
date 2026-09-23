import { MMKV } from 'react-native-mmkv';
import { Settings, settingsDefaults, settingsParse, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Profile, profileDefaults, profileParse } from '../domain/profile';
import { AGENT_KINDS } from '../domain/agentKinds';
import type { Session } from '../domain/sessionTypes';
import type { HerdrTreeWorkspace } from '@muxr/contract';
import { agentLabels } from '@/herd/domain/agentPresentation';
type PermissionModeKey = string;

const mmkv = new MMKV();
const NEW_SESSION_DRAFT_KEY = 'new-session-draft-v1';
const REGISTERED_PUSH_TOKEN_KEY = 'registered-push-token-v1';
const HOME_SNAPSHOT_KEY = 'home-snapshot-v2';
const OLD_HOME_SNAPSHOT_KEY = 'home-snapshot-v1';

/**
 * Supported launch kinds passed through as session.start `kind`.
 * `shell` means a pane with no coding agent started in it.
 */
export const AGENT_TYPES = ['shell', ...AGENT_KINDS] as const;
export type NewSessionAgentType = (typeof AGENT_TYPES)[number];
export type NewSessionSessionType = 'simple' | 'worktree';

function settingsBlobHasUnknownKeys(raw: unknown): boolean {
    if (raw === null || typeof raw !== 'object') return false;
    const known = new Set(Object.keys(SettingsSchema.shape));
    for (const key of Object.keys(raw as Record<string, unknown>)) {
        if (!known.has(key)) return true;
    }
    return false;
}

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
    const settings = mmkv.getString('settings');
    if (!settings) {
        return { settings: { ...settingsDefaults }, version: null };
    }
    try {
        const parsed = JSON.parse(settings) as { settings?: unknown; version?: unknown };
        const parsedSettings = settingsParse(parsed.settings);
        const version = typeof parsed.version === 'number' ? parsed.version : null;
        if (settingsBlobHasUnknownKeys(parsed.settings)) {
            mmkv.set('settings', JSON.stringify({ settings: parsedSettings, version }));
        }
        return { settings: parsedSettings, version };
    } catch {
        mmkv.delete('settings');
        return { settings: { ...settingsDefaults }, version: null };
    }
}

export function saveSettings(settings: Settings, version: number) {
    mmkv.set('settings', JSON.stringify({ settings, version }));
}

export function loadPendingSettings(): Partial<Settings> {
    const pending = mmkv.getString('pending-settings');
    if (!pending) return {};
    try {
        const raw = JSON.parse(pending) as Record<string, unknown>;
        const knownKeys = new Set(Object.keys(SettingsSchema.shape));
        const knownFields: Record<string, unknown> = {};
        let hadUnknownFields = false;
        for (const [key, value] of Object.entries(raw)) {
            if (knownKeys.has(key)) {
                knownFields[key] = value;
            } else {
                hadUnknownFields = true;
            }
        }
        const parsed = SettingsSchema.partial().parse(knownFields);
        const overlay: Partial<Settings> = {};
        for (const key of Object.keys(knownFields) as Array<keyof Settings>) {
            if (key in parsed) (overlay as Record<string, unknown>)[key] = parsed[key];
        }
        if (hadUnknownFields) {
            mmkv.set('pending-settings', JSON.stringify(overlay));
        }
        return overlay;
    } catch (e) {
        console.error('Failed to parse pending settings', e);
        mmkv.delete('pending-settings');
        return {};
    }
}

export function savePendingSettings(settings: Partial<Settings>) {
    mmkv.set('pending-settings', JSON.stringify(settings));
}

export function loadLocalSettings(): LocalSettings {
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const raw = JSON.parse(localSettings);
            const parsed = localSettingsParse(raw);
            if (raw !== null && typeof raw === 'object' && 'terminalAutoShowKeyboard' in raw) {
                mmkv.set('local-settings', JSON.stringify(parsed));
            }
            return parsed;
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
    return loadLocalSettings().themePreference;
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

/**
 * The last Home the host confirmed for one machine. A cold start draws it,
 * marked stale, while the connection comes up; nothing else reads it.
 */
export type HomeSession = Pick<Session, 'id' | 'updatedAt'> & {
    metadata: Pick<NonNullable<Session['metadata']>, 'lifecycleStateSince'> | null;
};

type HomeWorkspace = Omit<HerdrTreeWorkspace, 'worktree'> & {
    worktree?: Omit<NonNullable<HerdrTreeWorkspace['worktree']>, 'repo'>;
};

export interface HomeSnapshot {
    machineId: string;
    workspaces: HomeWorkspace[];
    sessions: Record<string, HomeSession>;
}

export function loadHomeSnapshot(machineId: string): HomeSnapshot | null {
    mmkv.delete(OLD_HOME_SNAPSHOT_KEY);
    const raw = mmkv.getString(HOME_SNAPSHOT_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as HomeSnapshot;
        if (parsed.machineId !== machineId || !Array.isArray(parsed.workspaces)
            || parsed.sessions === null || typeof parsed.sessions !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveHomeSnapshot(machineId: string, workspaces: HerdrTreeWorkspace[], sessions: Session[]): void {
    mmkv.delete(OLD_HOME_SNAPSHOT_KEY);
    const snapshot: HomeSnapshot = {
        machineId,
        workspaces: workspaces.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            label: workspace.label,
            focused: workspace.focused,
            agentStatus: workspace.agentStatus,
            order: workspace.order,
            worktree: workspace.worktree && {
                branch: workspace.worktree.branch,
                path: workspace.worktree.path,
                repoKey: workspace.worktree.repoKey,
                linked: workspace.worktree.linked,
            },
            tokens: workspace.tokens && {
                parent: workspace.tokens.parent,
                kind: workspace.tokens.kind,
            },
            tabs: workspace.tabs.map((tab) => ({
                tabId: tab.tabId,
                label: tab.label,
                focused: tab.focused,
                agentStatus: tab.agentStatus,
                panes: tab.panes.map((pane) => ({
                    paneId: pane.paneId,
                    tabId: pane.tabId,
                    sessionId: pane.sessionId,
                    label: pane.label || (pane.cwd && !pane.agentName?.trim() && !pane.agentKind?.trim()
                        && !pane.terminalTitle?.trim() && !pane.taskTitle?.trim()
                        ? agentLabels(pane).taskTitle : undefined),
                    terminalTitle: pane.terminalTitle,
                    focused: pane.focused,
                    agentName: pane.agentName,
                    taskTitle: pane.taskTitle,
                    agentKind: pane.agentKind,
                    provider: pane.provider,
                    model: pane.model,
                    displayAgent: pane.displayAgent,
                    agentStatus: pane.agentStatus,
                    promptable: pane.promptable,
                })),
            })),
        })),
        sessions: Object.fromEntries(sessions.map((session) => [session.id, {
            id: session.id,
            updatedAt: session.updatedAt,
            metadata: session.metadata?.lifecycleStateSince === undefined
                ? null : { lifecycleStateSince: session.metadata.lifecycleStateSince },
        }])),
    };
    mmkv.set(HOME_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

/** Forgetting a machine forgets what its Home looked like. */
export function clearHomeSnapshot(machineId?: string): void {
    mmkv.delete(OLD_HOME_SNAPSHOT_KEY);
    if (machineId === undefined || loadHomeSnapshot(machineId) !== null) mmkv.delete(HOME_SNAPSHOT_KEY);
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
