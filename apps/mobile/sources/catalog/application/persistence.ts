import { MMKV } from 'react-native-mmkv';
import { Settings, settingsDefaults, settingsParse, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Profile, profileDefaults, profileParse } from '../domain/profile';
import { AGENT_KINDS } from '../domain/agentKinds';
import type { Session } from '../domain/sessionTypes';
import type { HerdrTreePane, HerdrTreeWorkspace } from '@trymuxr/contract';
import { agentLabels, isShellLabels } from '@/herd/labels';
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
    agentTypeExplicit?: boolean;
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

const OLD_SPACES_PINS_KEY = 'spaces-pins-v1';
const SPACES_PINS_KEY = 'spaces-pins-v2';

/** Like Spaces layouts: paired machine id -> Herdr workspace ids. */
function spacePinsByMachine(): Record<string, string[]> {
    const raw = mmkv.getString(SPACES_PINS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Invalid saved space pins');
    }
    return Object.fromEntries(Object.entries(parsed).map(([machineId, pins]) => [machineId, ids(pins)]));
}

export function loadSpacePins(machineId: string): string[] {
    return spacePinsByMachine()[machineId] ?? [];
}

export function saveSpacePins(machineId: string, pins: string[], workspaceId: string) {
    if (!machineId) throw new Error('Pair a computer before pinning a space');
    const legacy = legacySpacePins();
    mmkv.set(SPACES_PINS_KEY, JSON.stringify({ ...spacePinsByMachine(), [machineId]: pins }));
    if (legacy === undefined) return;
    const remaining = legacy.filter((id) => id !== workspaceId);
    if (remaining.length === 0) mmkv.delete(OLD_SPACES_PINS_KEY);
    else mmkv.set(OLD_SPACES_PINS_KEY, JSON.stringify(remaining));
}

function legacySpacePins(): string[] | undefined {
    const raw = mmkv.getString(OLD_SPACES_PINS_KEY);
    if (raw === undefined) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
        throw new Error('Invalid saved legacy space pins');
    }
    if (parsed.length === 0) {
        mmkv.delete(OLD_SPACES_PINS_KEY);
        return;
    }
    return parsed as string[];
}

export function hasLegacySpacePins(): boolean {
    return legacySpacePins() !== undefined;
}

export function migrateSpacePins(machineId: string, workspaces: readonly HerdrTreeWorkspace[]): void {
    const legacy = legacySpacePins();
    if (legacy === undefined || !machineId) return;
    const matched = legacy.filter((id) => workspaces.some((ws) => ws.workspaceId === id));
    if (matched.length === 0) return;
    const pins = spacePinsByMachine();
    pins[machineId] = [...new Set([...(pins[machineId] ?? []), ...matched])];
    mmkv.set(SPACES_PINS_KEY, JSON.stringify(pins));
    const remaining = legacy.filter((id) => !matched.includes(id));
    if (remaining.length === 0) mmkv.delete(OLD_SPACES_PINS_KEY);
    else mmkv.set(OLD_SPACES_PINS_KEY, JSON.stringify(remaining));
}

const SPACES_LAYOUT_KEY = 'spaces-layout-v1';

/**
 * Per machine: the top-level Spaces order from Move up/down (Herdr workspace
 * ids), and favourite agents by Agent Route, which the host keeps for the
 * agent's life and never hands to another, unlike a Herdr pane id. Both are
 * only unique on their own machine, so each machine keeps its own; absent ids
 * wait for their workspace or agent.
 */
export interface SpacesLayout {
    order: string[];
    favourites: string[];
}

const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

export function loadSpacesLayouts(): Record<string, SpacesLayout> {
    const raw = mmkv.getString(SPACES_LAYOUT_KEY);
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).map(([machineId, layout]) => {
            const entry = typeof layout === 'object' && layout !== null ? layout as Record<string, unknown> : {};
            return [machineId, { order: ids(entry.order), favourites: ids(entry.favourites) }];
        }));
    } catch {
        mmkv.delete(SPACES_LAYOUT_KEY);
        return {};
    }
}

export function saveSpacesLayouts(layouts: Record<string, SpacesLayout>) {
    mmkv.set(SPACES_LAYOUT_KEY, JSON.stringify(layouts));
}

export function loadThemePreference(): 'light' | 'dark' | 'adaptive' {
    return loadLocalSettings().themePreference;
}

export function loadDarkSurfaces(): 'seamless' | 'raised' {
    return loadLocalSettings().darkSurfaces;
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
            agentTypeExplicit: parsed.agentTypeExplicit === true,
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

type HomeWorkspace = Omit<HerdrTreeWorkspace, 'worktree' | 'tabs'> & {
    worktree?: Pick<NonNullable<HerdrTreeWorkspace['worktree']>, 'branch'>;
    tabs: Array<Omit<HerdrTreeWorkspace['tabs'][number], 'label'>>;
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

/** What the pane leads with, kept so a cold launch draws the same row: an agent's task, a shell's title. */
function snapshotTitle(pane: HerdrTreePane): { taskTitle?: string } {
    const labels = agentLabels(pane);
    const title = isShellLabels(labels) ? labels.title : labels.task;
    return title === undefined ? {} : { taskTitle: title };
}

export function saveHomeSnapshot(machineId: string, workspaces: HerdrTreeWorkspace[], sessions: Session[], names: ReadonlyMap<string, string>, parents: ReadonlyMap<string, string>): void {
    mmkv.delete(OLD_HOME_SNAPSHOT_KEY);
    const snapshot: HomeSnapshot = {
        machineId,
        workspaces: workspaces.map((workspace) => ({
            workspaceId: workspace.workspaceId,
            label: names.get(workspace.workspaceId),
            focused: workspace.focused,
            agentStatus: workspace.agentStatus,
            order: workspace.order,
            worktree: workspace.worktree && { branch: workspace.worktree.branch },
            tokens: workspace.tokens || parents.has(workspace.workspaceId) ? {
                ...(parents.has(workspace.workspaceId) ? { parent: parents.get(workspace.workspaceId)! } : {}),
                ...(workspace.tokens?.kind === undefined ? {} : { kind: workspace.tokens.kind }),
            } : undefined,
            tabs: workspace.tabs.map((tab) => ({
                tabId: tab.tabId,
                focused: tab.focused,
                agentStatus: tab.agentStatus,
                panes: tab.panes.map((pane) => ({
                    paneId: pane.paneId,
                    tabId: pane.tabId,
                    sessionId: pane.sessionId,
                    ...snapshotTitle(pane),
                    focused: pane.focused,
                    agentName: pane.agentName,
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
