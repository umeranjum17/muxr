import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import React from 'react';
import type { Session, Machine, SessionAgentModesPatch } from '../infrastructure/storageTypes';
import type { Settings } from './settings';
import { settingsDefaults } from './settings';
import type { LocalSettings } from './localSettings';
import type { Profile } from './profile';
import {
    loadSettings,
    loadLocalSettings,
    loadProfile,
    saveSettings,
    saveLocalSettings,
} from './persistence';
import {
    createAgentWatch,
    type PersistedVoiceReport,
    type VoiceAdmission,
    type WatchSnapshot,
} from '@/watch/store';
import { boundSessionFileCache } from './sessionFileCache';
import type { Message } from '../infrastructure/typesMessage';
import type { GitStatus } from '../infrastructure/storageTypes';
import type { GitStatusFiles } from '../infrastructure/gitStatusFiles';
import type { ProjectFilesList } from '../infrastructure/projectFiles';
import type { DecryptedArtifact } from '../infrastructure/artifactTypes';
import type { UserProfile, RelationshipUpdatedEvent } from '../infrastructure/friendTypes';
import type { FeedItem } from '../infrastructure/feedTypes';
import type { AttentionEntry, AttentionReason, HerdrTreeWorkspace, LifecycleCatalog, LifecycleEvent } from '@muxr/contract';
import { buildMessagesMap } from '../infrastructure/messageAdapter';
import { getRigActivityIndicators, getRigIdentity } from '../infrastructure/rig';
import { getSessionName, getSessionSubtitle, getSessionAvatarId, type SessionState } from '@/utils/sessionUtils';
import { agentRowAttention, mergeCatalogAgent } from '../domain/agent';
import { readAgentSession } from './readAgentSession';

function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): 'online' | number {
    return session.active ? 'online' : session.activeAt;
}

function isSessionActive(session: { active: boolean }): boolean {
    return session.active;
}

export interface SessionRowData {
    id: string;
    name: string;
    subtitle: string;
    avatarId: string;
    flavor: string | null;
    clientId: string | null;
    identityLine: string | null;
    providerKind: string | null;
    modelName: string | null;
    activitySummary: string | null;
    state: SessionState;
    activeAt?: number;
    createdAt?: number;
    hasDraft: boolean;
    active: boolean;
    machineId: string | null;
    path: string | null;
    homeDir: string | null;
    /** herdr workspace the session's pane lives in (label or cwd). */
    workspaceLabel: string | null;
    workspaceId: string | null;
    tabId: string | null;
    tabLabel: string | null;
    spawnedBy: string | null;
    /** Worktree provenance: 'repo ⎇ branch' for the group header. */
    worktreeRepo: string | null;
    worktreeBranch: string | null;
    hasUnread: boolean;
}

export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: SessionRowData[] }
    | { type: 'session'; session: SessionRowData };

function sessionRowState(session: Session): SessionState {
    return agentRowAttention(session);
}

function buildSessionRowData(session: Session): SessionRowData {
    const rigIdentity = getRigIdentity(session.metadata);
    const rigActivity = getRigActivityIndicators(session.metadata);
    return {
        id: session.id,
        name: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        avatarId: getSessionAvatarId(session),
        flavor: session.metadata?.flavor ?? null,
        clientId: session.metadata?.client?.id ?? null,
        identityLine: rigIdentity ? `${rigIdentity.clientName} · ${rigIdentity.providerName}` : null,
        providerKind: session.metadata?.provider?.kind ?? null,
        modelName: rigIdentity?.modelName ?? null,
        activitySummary: rigActivity.length > 0
            ? rigActivity.map((item) => `${item.count}${item.queued ? `+${item.queued}` : ''} ${item.key}`).join(' · ')
            : null,
        state: sessionRowState(session),
        ...(!session.active && { activeAt: session.activeAt, createdAt: session.createdAt }),
        hasDraft: !!session.draft,
        active: session.active,
        machineId: session.metadata?.machineId ?? null,
        path: session.metadata?.path ?? null,
        homeDir: session.metadata?.homeDir ?? null,
        workspaceLabel: session.metadata?.workspaceLabel ?? null,
        workspaceId: session.metadata?.workspaceId ?? null,
        tabId: session.metadata?.tabId ?? null,
        tabLabel: session.metadata?.tabLabel ?? null,
        spawnedBy: session.metadata?.spawnedBy ?? null,
        worktreeRepo: session.metadata?.worktree?.repo ?? null,
        worktreeBranch: session.metadata?.worktree?.branch ?? null,
        hasUnread: false,
    };
}

function buildSessionListViewData(sessions: Record<string, Session>): SessionListViewItem[] {
    const activeSessions: Session[] = [];
    const inactiveSessions: Session[] = [];
    for (const session of Object.values(sessions)) {
        if (session.metadata?.isSideChat) continue;
        if (isSessionActive(session)) activeSessions.push(session);
        else inactiveSessions.push(session);
    }
    const sortKey = storage.getState().settings.sortSessionsByActivity
        ? (s: Session) => s.lastMessageSentAt ?? s.createdAt
        : (s: Session) => s.createdAt;
    activeSessions.sort((a, b) => sortKey(b) - sortKey(a));
    inactiveSessions.sort((a, b) => sortKey(b) - sortKey(a));

    const listData: SessionListViewItem[] = [];
    if (activeSessions.length > 0) {
        listData.push({
            type: 'active-sessions',
            sessions: activeSessions.map((s) => buildSessionRowData(s)),
        });
    }
    for (const session of inactiveSessions) {
        listData.push({ type: 'session', session: buildSessionRowData(session) });
    }
    return listData;
}

interface SessionMessagesState {
    messages: Message[];
    messagesMap: Record<string, Message>;
    isLoaded: boolean;
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
}

interface StorageState extends WatchSnapshot {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    profile: Profile;
    sessions: Record<string, Session>;
    herdrWorkspaces: HerdrTreeWorkspace[];
    herdrTreeLoaded: boolean;
    sessionListViewData: SessionListViewItem[] | null;
    sessionMessages: Record<string, SessionMessagesState>;
    pathGitStatus: Record<string, GitStatus | null>;
    pathGitStatusFiles: Record<string, GitStatusFiles | null>;
    pathProjectFiles: Record<string, ProjectFilesList | null>;
    sessionFileCache: Record<string, Record<string, { content: string | null; diff: string | null; isBinary: boolean; cachedAt: number }>>;
    machines: Record<string, Machine>;
    artifacts: Record<string, DecryptedArtifact>;
    friends: Record<string, UserProfile>;
    users: Record<string, UserProfile | null>;
    feedItems: FeedItem[];
    feedHead: string | null;
    feedTail: string | null;
    feedHasMore: boolean;
    feedLoaded: boolean;
    friendsLoaded: boolean;
    isDataReady: boolean;
    // False until refreshCatalog has delivered the session list at least once.
    // Without it a disconnected refresh renders "session deleted" for a session
    // that simply has not loaded yet.
    sessionsLoaded: boolean;
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketError: string | null;
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    nativeUpdateStatus: { available: boolean; updateUrl?: string } | null;
    currentViewingSessionId: string | null;
    unreadSessionIds: Set<string>;
    attentionEntries: AttentionEntry[];
    admitVoiceReport: (report: PersistedVoiceReport) => VoiceAdmission;
    updateVoiceReportRetry: (identity: string, attempts: number, readyAt: number) => void;
    deliverVoiceReport: (identity: string) => void;
    discardVoiceReport: (identity: string) => void;
    applySessions: (sessions: (Omit<Session, 'presence'> & { presence?: 'online' | number })[], replace?: boolean) => void;
    applyHerdrTree: (workspaces: HerdrTreeWorkspace[]) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    deleteMachine: (machineId: string) => void;
    applyReady: () => void;
    markSessionsLoaded: () => void;
    setSessionMessages: (sessionId: string, messages: Message[], loaded?: boolean, hasMoreOlder?: boolean) => void;
    updateSession: (sessionId: string, patch: Partial<Session>) => void;
    setSocketStatus: (status: StorageState['socketStatus']) => void;
    setSocketError: (message: string | null) => void;
    applyLocalSettings: (patch: Partial<LocalSettings>) => void;
    applySettingsLocal: (patch: Partial<Settings>) => void;
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    setCurrentViewingSession: (sessionId: string | null) => void;
    getSessionPathKey: (sessionId: string) => string | null;
    applyFileCache: (sessionId: string, filePath: string, content: string | null, diff: string | null, isBinary: boolean) => void;
    applyGitStatus: (pathKey: string, status: GitStatus | null) => void;
    applyGitStatusFiles: (pathKey: string, files: GitStatusFiles | null) => void;
    applyProjectFiles: (pathKey: string, files: ProjectFilesList | null) => void;
    applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => void;
    getActiveSessions: () => Session[];
    updateSessionAgentModes: (sessionId: string, patch: SessionAgentModesPatch) => void;
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
    deleteSession: (sessionId: string) => void;
    applyFriends: (friends: UserProfile[]) => void;
    applyRelationshipUpdate: (event: RelationshipUpdatedEvent) => void;
    getFriend: (userId: string) => UserProfile | undefined;
    getAcceptedFriends: () => UserProfile[];
    applyUsers: (users: Record<string, UserProfile | null>) => void;
    getUser: (userId: string) => UserProfile | null | undefined;
    assumeUsers: (userIds: string[]) => Promise<void>;
    applyFeedItems: (items: FeedItem[]) => void;
    clearFeed: () => void;
    markSessionRead: (sessionId: string) => void;
    markSessionUnread: (sessionId: string) => void;
    applyAttentionCatalog: (entries: AttentionEntry[]) => void;
    applyLifecycleCatalog: (catalog: LifecycleCatalog) => LifecycleEvent[];
    applyLifecycleEvent: (event: LifecycleEvent) => LifecycleEvent[];
    markLifecyclePresented: (eventId: string, at?: string) => void;
    acknowledgeLifecyclePush: (eventId: string, machineId: string) => void;
    setLifecycleAuthority: (authority: string) => void;
    setLifecycleScope: (scope: string) => void;
    resetLifecycleCatalog: () => void;
}

function mergeCatalogSession(
    storePrevious: Session | undefined,
    mergedPrevious: Session | undefined,
    session: Omit<Session, 'presence'> & { presence?: 'online' | number },
    replace: boolean,
): Session {
    return mergeCatalogAgent(storePrevious, mergedPrevious, session, replace, resolveSessionOnlineState);
}

const { settings } = loadSettings();
const localSettings = loadLocalSettings();
const profile = loadProfile();
const watch = createAgentWatch();

export const storage = create<StorageState>()((set, get) => ({
    settings,
    settingsVersion: null,
    localSettings,
    profile,
    sessions: {},
    herdrWorkspaces: [],
    herdrTreeLoaded: false,
    machines: {},
    sessionListViewData: null,
    sessionMessages: {},
    pathGitStatus: {},
    pathGitStatusFiles: {},
    pathProjectFiles: {},
    sessionFileCache: {},
    artifacts: {},
    friends: {},
    users: {},
    feedItems: [],
    feedHead: null,
    feedTail: null,
    feedHasMore: false,
    // muxr has no social feed or friends service, so these are permanently
    // "loaded and empty". Leaving them false spins the Inbox tab forever.
    feedLoaded: true,
    friendsLoaded: true,
    isDataReady: false,
    sessionsLoaded: false,
    socketStatus: 'disconnected',
    socketError: null,
    socketLastConnectedAt: null,
    socketLastDisconnectedAt: null,
    nativeUpdateStatus: null,
    currentViewingSessionId: null,
    unreadSessionIds: new Set<string>(),
    attentionEntries: [],
    ...watch.snapshot(),
    admitVoiceReport: (report) => {
        const admission = watch.admitVoice(report);
        set(watch.snapshot());
        return admission;
    },
    updateVoiceReportRetry: (identity, attempts, readyAt) => {
        set(watch.updateVoiceRetry(identity, attempts, readyAt));
    },
    deliverVoiceReport: (identity) => {
        set(watch.deliverVoice(identity));
    },
    discardVoiceReport: (identity) => {
        set(watch.discardVoice(identity));
    },
    applySessions: (sessions, replace = false) => set((state) => {
        const merged = replace ? {} as Record<string, Session> : { ...state.sessions };
        for (const session of sessions) {
            merged[session.id] = mergeCatalogSession(state.sessions[session.id], merged[session.id], session, replace);
        }
        return { sessions: merged, sessionListViewData: buildSessionListViewData(merged) };
    }),
    applyHerdrTree: (herdrWorkspaces) => set({ herdrWorkspaces, herdrTreeLoaded: true }),
    applyMachines: (machines, replace = false) => set((state) => {
        const next = replace ? {} as Record<string, Machine> : { ...state.machines };
        for (const machine of machines) next[machine.id] = machine;
        return { machines: next };
    }),
    deleteMachine: (machineId) => set((state) => {
        const machines = { ...state.machines };
        delete machines[machineId];
        return { machines };
    }),
    // sessionListViewData stays null until applySessions runs, which needs a
    // reachable relay. Without seeding an empty list here, a first launch with
    // no relay cannot express "ready, nothing to show" and the list spins
    // forever instead of rendering the not-connected empty state.
    applyReady: () => set((state) => ({
        isDataReady: true,
        sessionListViewData: state.sessionListViewData ?? [],
    })),
    markSessionsLoaded: () => set({ sessionsLoaded: true }),
    setSessionMessages: (sessionId, messages, loaded = true, hasMoreOlder = false) => set((state) => ({
        sessionMessages: {
            ...state.sessionMessages,
            [sessionId]: {
                messages: [...messages],
                messagesMap: buildMessagesMap(messages),
                isLoaded: loaded,
                hasMoreOlder,
                isLoadingOlder: false,
            },
        },
    })),
    updateSession: (sessionId, patch) => set((state) => {
        const existing = state.sessions[sessionId];
        if (existing === undefined) return state;
        const sessions = { ...state.sessions, [sessionId]: { ...existing, ...patch } };
        return { sessions, sessionListViewData: buildSessionListViewData(sessions) };
    }),
    setSocketStatus: (socketStatus) => set({ socketStatus }),
    setSocketError: (socketError) => set({ socketError }),
    // Settings are device-local in muxr -- there is no settings sync request --
    // so writing the store was the whole change and every toggle reset on reload.
    applyLocalSettings: (patch) => set((state) => {
        const localSettings = { ...state.localSettings, ...patch };
        saveLocalSettings(localSettings);
        return { localSettings };
    }),
    applySettingsLocal: (patch) => set((state) => {
        const settings = { ...state.settings, ...patch };
        saveSettings(settings, state.settingsVersion ?? 0);
        return { settings };
    }),
    updateSessionDraft: (sessionId, draft) => set((state) => {
        const existing = state.sessions[sessionId];
        if (existing === undefined) return state;
        const sessions = { ...state.sessions, [sessionId]: { ...existing, draft } };
        return { sessions, sessionListViewData: buildSessionListViewData(sessions) };
    }),
    setCurrentViewingSession: (sessionId) => set({ currentViewingSessionId: sessionId }),
    getSessionPathKey: (sessionId) => {
        const session = get().sessions[sessionId];
        if (!session?.metadata?.machineId || !session.metadata.path) return null;
        return `${session.metadata.machineId}:${session.metadata.path}`;
    },
    applyFileCache: (sessionId, filePath, content, diff, isBinary) => set((state) => {
        const entry = { content, diff, isBinary, cachedAt: Date.now() };
        return {
            sessionFileCache: {
                ...state.sessionFileCache,
                [sessionId]: boundSessionFileCache(state.sessionFileCache[sessionId] ?? {}, filePath, entry),
            },
        };
    }),
    applyGitStatus: (pathKey, status) => set((state) => ({
        pathGitStatus: { ...state.pathGitStatus, [pathKey]: status },
    })),
    applyGitStatusFiles: (pathKey, files) => set((state) => ({
        pathGitStatusFiles: { ...state.pathGitStatusFiles, [pathKey]: files },
    })),
    applyProjectFiles: (pathKey, files) => set((state) => ({
        pathProjectFiles: { ...state.pathProjectFiles, [pathKey]: files },
    })),
    applyNativeUpdateStatus: (nativeUpdateStatus) => set({ nativeUpdateStatus }),
    getActiveSessions: () => Object.values(get().sessions).filter((session) => session.active),
    updateSessionAgentModes: (_sessionId, _patch) => {},
    applyArtifacts: (artifacts) => set((state) => {
        const next = { ...state.artifacts };
        for (const artifact of artifacts) next[artifact.id] = artifact;
        return { artifacts: next };
    }),
    addArtifact: (artifact) => set((state) => ({
        artifacts: { ...state.artifacts, [artifact.id]: artifact },
    })),
    updateArtifact: (artifact) => set((state) => ({
        artifacts: { ...state.artifacts, [artifact.id]: artifact },
    })),
    deleteArtifact: (artifactId) => set((state) => {
        const artifacts = { ...state.artifacts };
        delete artifacts[artifactId];
        return { artifacts };
    }),
    deleteSession: (sessionId) => set((state) => {
        const sessions = { ...state.sessions };
        const sessionFileCache = { ...state.sessionFileCache };
        delete sessions[sessionId];
        delete sessionFileCache[sessionId];
        return { sessions, sessionFileCache, sessionListViewData: buildSessionListViewData(sessions) };
    }),
    applyFriends: (friends) => set((state) => {
        const next = { ...state.friends };
        for (const friend of friends) next[friend.id] = friend;
        return { friends: next, friendsLoaded: true };
    }),
    applyRelationshipUpdate: (_event) => {},
    getFriend: (userId) => get().friends[userId],
    getAcceptedFriends: () => Object.values(get().friends).filter((friend) => friend.status === 'friend'),
    applyUsers: (users) => set((state) => ({ users: { ...state.users, ...users } })),
    getUser: (userId) => get().users[userId],
    assumeUsers: async (_userIds) => {},
    applyFeedItems: (items) => set({ feedItems: items, feedLoaded: true }),
    clearFeed: () => set({ feedItems: [], feedHead: null, feedTail: null, feedHasMore: false }),
    markSessionRead: (sessionId) => set((state) => {
        const unreadSessionIds = new Set(state.unreadSessionIds);
        unreadSessionIds.delete(sessionId);
        return { unreadSessionIds };
    }),
    markSessionUnread: (sessionId) => set((state) => {
        const unreadSessionIds = new Set(state.unreadSessionIds);
        unreadSessionIds.add(sessionId);
        return { unreadSessionIds };
    }),
    // Whole-catalog replace: the host publishes the full set every time, and
    // there is no local seen/dismissed state to merge -- a row leaves because
    // its condition resolved, never because this client hid it.
    applyAttentionCatalog: (entries) => set(() => ({ attentionEntries: entries })),
    applyLifecycleCatalog: (catalog) => {
        const newAlerts = watch.applyCatalog(catalog);
        set(watch.snapshot());
        return newAlerts;
    },
    applyLifecycleEvent: (event) => {
        const newAlerts = watch.applyEvent(event);
        set(watch.snapshot());
        return newAlerts;
    },
    markLifecyclePresented: (eventId, at) => {
        set(watch.markPresented(eventId, at));
    },
    acknowledgeLifecyclePush: (eventId, machineId) => {
        set(watch.acknowledgePush(eventId, machineId));
    },
    setLifecycleAuthority: (authority) => {
        watch.setAuthority(authority);
    },
    setLifecycleScope: (scope) => {
        set(watch.setScope(scope));
    },
    resetLifecycleCatalog: () => {
        set(watch.resetCatalog());
    },
}));

const emptyMessages: Message[] = [];
const emptySessions: Session[] = [];

function pathLookup<T>(state: { getSessionPathKey: (sessionId: string) => string | null }, sessionId: string, table: Record<string, T | null>): T | null {
    const pathKey = state.getSessionPathKey(sessionId);
    if (!pathKey) return null;
    return table[pathKey] ?? null;
}

export function useSessions(): Session[] {
    return storage(useShallow((state) => Object.values(state.sessions)));
}

export function useHerdrTree(): { workspaces: HerdrTreeWorkspace[]; loaded: boolean } {
    return storage(useShallow((state) => ({ workspaces: state.herdrWorkspaces, loaded: state.herdrTreeLoaded })));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => {
        const result = readAgentSession({ agentRoute: id }, { listed: (route) => state.sessions[route] });
        return result.ok ? result.agent : null;
    }));
}

export function useSessionMessages(sessionId: string): {
    messages: Message[];
    isLoaded: boolean;
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
} {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyMessages,
            isLoaded: session?.isLoaded ?? false,
            hasMoreOlder: session?.hasMoreOlder ?? false,
            isLoadingOlder: session?.isLoadingOlder ?? false,
        };
    }));
}

export function useMessage(sessionId: string, messageId: string): Message | null {
    return storage(useShallow((state) => state.sessionMessages[sessionId]?.messagesMap[messageId] ?? null));
}

export function useSessionUsage(_sessionId: string) {
    return null;
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
    return storage(useShallow((state) => state.settings[name]));
}

export function useSettingMutable<K extends keyof Settings>(name: K): [Settings[K], (value: Settings[K]) => void] {
    const setValue = React.useCallback((value: Settings[K]) => {
        storage.getState().applySettingsLocal({ [name]: value });
    }, [name]);
    return [useSetting(name), setValue];
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(name: K): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const setValue = React.useCallback((value: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: value });
    }, [name]);
    return [useLocalSetting(name), setValue];
}

export function useAllMachines(options?: { includeOffline?: boolean }): Machine[] {
    const includeOffline = options?.includeOffline ?? false;
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        const machines = Object.values(state.machines).sort((a, b) => b.createdAt - a.createdAt);
        return includeOffline ? machines : machines.filter((v) => v.active);
    }));
}

export function useMachine(machineId: string): Machine | null {
    return storage(useShallow((state) => state.machines[machineId] ?? null));
}

export function useSessionListViewData(): SessionListViewItem[] | null {
    return storage(useShallow((state) => (state.isDataReady ? state.sessionListViewData : null)));
}

export function useAllSessions(): Session[] {
    return useSessions();
}

/**
 * Sessions waiting on the user, most urgent first, as the host ordered them.
 *
 * This is state, not mail: the host publishes exactly the set that currently
 * needs a human, one row per session. Nothing accumulates and nothing is
 * dismissed by hand -- a row disappears when its condition resolves.
 */
export interface AttentionRowData {
    sessionId: string;
    name: string;
    reason: AttentionReason;
    detail: string;
    at: number;
}

export function useAttentionEntries(): AttentionEntry[] {
    return storage(useShallow((state) => state.attentionEntries));
}

export function useLifecycleEvents(): LifecycleEvent[] {
    return storage(useShallow((state) => state.lifecycleEvents));
}

export function usePendingLifecycleEvent(): LifecycleEvent | undefined {
    return storage(useShallow((state) =>
        state.pendingLifecycleEvents.find((event) => event.state !== 'done') ?? state.pendingLifecycleEvents[0]));
}

export function useLifecycleCatalogAvailable(): boolean {
    return storage(useShallow((state) => state.lifecycleCatalogAvailable));
}

export function useAttentionRows(): AttentionRowData[] {
    const sessions = useSessions();
    const attentionEntries = useAttentionEntries();
    return React.useMemo(
        () =>
            attentionEntries.map((entry) => {
                const session = sessions.find((candidate) => candidate.id === entry.sessionId);
                return {
                    sessionId: entry.sessionId,
                    name: session !== undefined ? getSessionName(session) : 'Agent',
                    reason: entry.reason,
                    detail: entry.detail,
                    at: Date.parse(entry.at) || 0,
                };
            }),
        [sessions, attentionEntries],
    );
}

export function useIsDataReady(): boolean {
    return storage(useShallow((state) => state.isDataReady));
}

export function useSessionsLoaded(): boolean {
    return storage(useShallow((state) => state.sessionsLoaded));
}

export function useSocketStatus() {
    // Date.now() in here made the selector return a fresh value on every render,
    // so useShallow never matched and the component re-rendered forever. The
    // timestamps were read by nobody, and a clock sampled during selection would
    // not record the transition anyway.
    return storage(useShallow((state) => ({ status: state.socketStatus, error: state.socketError })));
}

export function useSideChatSessions(_parentSessionId: string | null): Session[] {
    return emptySessions;
}

export function useSessionGitStatus(_sessionId: string): GitStatus | null {
    return storage(useShallow((state) => pathLookup(state, _sessionId, state.pathGitStatus)));
}

export function useSessionGitStatusFiles(_sessionId: string): GitStatusFiles | null {
    return storage(useShallow((state) => pathLookup(state, _sessionId, state.pathGitStatusFiles)));
}

export function useSessionProjectFiles(_sessionId: string): ProjectFilesList | null {
    return storage(useShallow((state) => pathLookup(state, _sessionId, state.pathProjectFiles)));
}

export function useSessionFileCache(sessionId: string, filePath: string) {
    return storage(useShallow((state) => state.sessionFileCache[sessionId]?.[filePath] ?? null));
}

export function useEntitlement(_id: 'pro'): boolean {
    return false;
}

export function useProfile() {
    return storage(useShallow((state) => state.profile));
}

export function useFriendRequests(): UserProfile[] {
    return storage(useShallow((state) =>
        Object.values(state.friends).filter((friend) => friend.status === 'pending')));
}

export function useRequestedFriends(): UserProfile[] {
    return storage(useShallow((state) =>
        Object.values(state.friends).filter((friend) => friend.status === 'requested')));
}

export function useAcceptedFriends(): UserProfile[] {
    return storage(useShallow((state) =>
        Object.values(state.friends).filter((friend) => friend.status === 'friend')));
}

export function useFeedItems(): FeedItem[] {
    return storage(useShallow((state) => state.feedItems));
}

export function useFeedLoaded(): boolean {
    return storage(useShallow((state) => state.feedLoaded));
}

export function useFriendsLoaded(): boolean {
    return storage(useShallow((state) => state.friendsLoaded));
}

export function useUser(_userId: string | undefined): UserProfile | null {
    return storage(useShallow((state) => (_userId ? state.users[_userId] ?? null : null)));
}

export function useFriend(_userId: string | undefined): UserProfile | undefined {
    return storage(useShallow((state) => (_userId ? state.friends[_userId] : undefined)));
}

export function useArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) =>
        Object.values(state.artifacts).filter((artifact) => !artifact.draft)));
}

export function useAllArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => Object.values(state.artifacts)));
}

export function useDraftArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) =>
        Object.values(state.artifacts).filter((artifact) => artifact.draft === true)));
}

export function useArtifact(_artifactId: string): DecryptedArtifact | null {
    return storage(useShallow((state) => state.artifacts[_artifactId] ?? null));
}

export function useArtifactsCount() {
    return 0;
}

export function useIsSessionUnread(_sessionId: string) {
    return false;
}

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useLocalSettings(): LocalSettings {
    return storage(useShallow((state) => state.localSettings));
}

export type KnownEntitlements = 'pro';

export function useFriends(): Record<string, UserProfile> {
    return storage(useShallow((state) => state.friends));
}

export function updateSessionAgentModes(sessionId: string, patch: SessionAgentModesPatch): void {
    storage.getState().updateSessionAgentModes(sessionId, patch);
}

// ponytail: default settings if loadSettings returned empty
if (Object.keys(storage.getState().settings).length === 0) {
    storage.getState().applySettingsLocal(settingsDefaults);
}
