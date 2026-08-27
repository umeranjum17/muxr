import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import React from 'react';
import type { Session, Machine, SessionAgentModesPatch } from './storageTypes';
import type { Settings } from './settings';
import { settingsDefaults } from './settings';
import type { LocalSettings } from './localSettings';
import { localSettingsDefaults } from './localSettings';
import type { Profile } from './profile';
import { profileDefaults } from './profile';
import {
    loadLifecycleNotificationPersistence,
    loadSettings,
    loadLocalSettings,
    loadProfile,
    saveLifecycleNotificationPersistence,
    saveSettings,
    saveLocalSettings,
} from './persistence';
import { boundSessionFileCache } from './sessionFileCache';
import type { Message } from './typesMessage';
import type { GitStatus } from './storageTypes';
import type { GitStatusFiles } from './gitStatusFiles';
import type { ProjectFilesList } from './projectFiles';
import type { DecryptedArtifact } from './artifactTypes';
import type { UserProfile, RelationshipUpdatedEvent } from './friendTypes';
import type { FeedItem } from './feedTypes';
import type { AttentionEntry, AttentionReason, HerdrTreeWorkspace, LifecycleCatalog, LifecycleEvent } from '@muxr/contract';
import { buildMessagesMap } from './messageAdapter';
import { ACTIVE_SESSION_MS } from './sessionMapping';
import { getRigActivityIndicators, getRigIdentity } from './rig';
import { getSessionName, getSessionSubtitle, getSessionAvatarId, type SessionState } from '@/utils/sessionUtils';

function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): 'online' | number {
    return session.active ? 'online' : session.activeAt;
}

function isSessionActive(session: { active: boolean }): boolean {
    return session.active;
}

const MAX_LIFECYCLE_EVENTS = 50;
const LIFECYCLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function lifecycleTime(event: LifecycleEvent): number {
    return Date.parse(event.at) || 0;
}

function boundLifecycleEvents(events: readonly LifecycleEvent[]): LifecycleEvent[] {
    const cutoff = Date.now() - LIFECYCLE_RETENTION_MS;
    const byId = new Map<string, LifecycleEvent>();
    for (const event of events) {
        if (lifecycleTime(event) >= cutoff && !byId.has(event.eventId)) byId.set(event.eventId, event);
    }
    return [...byId.values()]
        .sort((left, right) => lifecycleTime(right) - lifecycleTime(left))
        .slice(0, MAX_LIFECYCLE_EVENTS);
}

function presentsLifecycle(event: LifecycleEvent): boolean {
    return event.state === 'blocked' || event.state === 'failed' || event.state === 'done';
}

function boundPresented(records: Array<{ eventId: string; at: string }>): Array<{ eventId: string; at: string }> {
    const cutoff = Date.now() - LIFECYCLE_RETENTION_MS;
    return [...new Map(records
        .filter((record) => (Date.parse(record.at) || 0) >= cutoff)
        .map((record) => [record.eventId, record])).values()]
        .sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0))
        .slice(0, MAX_LIFECYCLE_EVENTS);
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
    completedTodosCount: number;
    totalTodosCount: number;
    hasUnread: boolean;
}

export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: SessionRowData[] }
    | { type: 'session'; session: SessionRowData };

function buildSessionRowData(session: Session): SessionRowData {
    const isOnline = session.presence === 'online';
    const hasPermissions = !!(session.agentState?.requests && Object.keys(session.agentState.requests).length > 0);
    let state: SessionState;
    if (!isOnline) state = 'disconnected';
    else if (hasPermissions) state = 'permission_required';
    else if (session.thinking) state = 'thinking';
    else state = 'waiting';

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
        state,
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
        completedTodosCount: session.todos?.filter((todo) => todo.status === 'completed').length ?? 0,
        totalTodosCount: session.todos?.length ?? 0,
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

interface StorageState {
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
    lifecycleRevision: number;
    lifecycleEvents: LifecycleEvent[];
    pendingLifecycleEvents: LifecycleEvent[];
    prebaselineLifecycleEvents: LifecycleEvent[];
    lifecycleCatalogInitialized: boolean;
    lifecycleCatalogAvailable: boolean;
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

const { settings } = loadSettings();
const localSettings = loadLocalSettings();
const profile = loadProfile();
const lifecyclePersistence = loadLifecycleNotificationPersistence();
let lifecycleScope = '';
let lifecycleAuthority = '';
let lifecycleScopeState = { initialized: false, presented: [] as Array<{ eventId: string; at: string }>, updatedAt: 0 };
const persistedLifecycleIds = new Set<string>();
const preAuthorityPushes: Array<{ eventId: string; machineId: string }> = [];

function saveLifecycleScope(): void {
    if (lifecycleScope === '') return;
    lifecycleScopeState.updatedAt = Date.now();
    lifecyclePersistence.scopes[lifecycleScope] = lifecycleScopeState;
    saveLifecycleNotificationPersistence(lifecyclePersistence);
}

function acknowledgePushInScope(scope: string, eventId: string): void {
    const current = lifecyclePersistence.scopes[scope]
        ?? { initialized: false, presented: [], updatedAt: 0 };
    const updated = {
        ...current,
        presented: boundPresented([...current.presented, { eventId, at: new Date().toISOString() }]),
        updatedAt: Date.now(),
    };
    lifecyclePersistence.scopes[scope] = updated;
    saveLifecycleNotificationPersistence(lifecyclePersistence);
    if (scope !== lifecycleScope) return;
    lifecycleScopeState = updated;
    persistedLifecycleIds.add(eventId);
}

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
    lifecycleRevision: 0,
    lifecycleEvents: [],
    pendingLifecycleEvents: [],
    prebaselineLifecycleEvents: [],
    lifecycleCatalogInitialized: false,
    lifecycleCatalogAvailable: false,
    applySessions: (sessions, replace = false) => set((state) => {
        const merged = replace ? {} as Record<string, Session> : { ...state.sessions };
        for (const session of sessions) {
            // metadata is replaced wholesale, and session.list carries neither a
            // title nor live model/lifecycle state. Carry those over or a catalog
            // refresh briefly turns working/blocked panes into done panes, fires
            // false completion notifications and re-arms the recent-agent buffer.
            const previous = replace ? state.sessions[session.id] : merged[session.id];
            const known = previous?.metadata;
            const metadata = session.metadata === null
                ? session.metadata
                : {
                    ...(known?.summary === undefined ? {} : { summary: known.summary }),
                    ...(known?.currentModelCode === undefined ? {} : {
                        currentModelCode: known.currentModelCode,
                        currentModelProviderId: known.currentModelProviderId,
                    }),
                    ...(known?.currentThoughtLevelCode === undefined
                        ? {}
                        : { currentThoughtLevelCode: known.currentThoughtLevelCode }),
                    ...(known?.agentStatus === undefined
                        ? {}
                        : {
                              agentStatus: known.agentStatus,
                              lifecycleStateSince: known.lifecycleStateSince,
                          }),
                    ...session.metadata,
                };
            const existing = previous;
            const catalogHasLifecycle = session.metadata?.agentStatus !== undefined;
            merged[session.id] = {
                ...existing,
                ...session,
                ...(!catalogHasLifecycle && existing !== undefined
                    ? {
                          thinking: existing.thinking,
                          thinkingAt: existing.thinkingAt,
                          agentState: existing.agentState,
                          agentStateVersion: existing.agentStateVersion,
                      }
                    : {}),
                metadata,
                presence: session.presence ?? resolveSessionOnlineState(session),
            };
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
        if (catalog.revision < get().lifecycleRevision) return [];
        const buffered = get().prebaselineLifecycleEvents;
        const lifecycleEvents = boundLifecycleEvents([...buffered, ...catalog.events]);
        if (!get().lifecycleCatalogInitialized) {
            const bufferedIds = new Set(buffered.map((event) => event.eventId));
            const presented = boundPresented([
                ...lifecycleScopeState.presented,
                ...lifecycleEvents
                .filter((event) => !bufferedIds.has(event.eventId))
                .map((event) => ({ eventId: event.eventId, at: event.at })),
            ]);
            for (const event of presented) persistedLifecycleIds.add(event.eventId);
            const fresh = buffered.filter((event) => presentsLifecycle(event));
            lifecycleScopeState.initialized = true;
            lifecycleScopeState.presented = presented;
            saveLifecycleScope();
            set({
                lifecycleRevision: catalog.revision,
                lifecycleEvents,
                pendingLifecycleEvents: boundLifecycleEvents(fresh),
                prebaselineLifecycleEvents: [],
                lifecycleCatalogInitialized: true,
                lifecycleCatalogAvailable: true,
            });
            return fresh;
        }
        const pendingIds = new Set(get().pendingLifecycleEvents.map((event) => event.eventId));
        const fresh = lifecycleEvents.filter((event) =>
            presentsLifecycle(event) && !persistedLifecycleIds.has(event.eventId) && !pendingIds.has(event.eventId));
        const pendingLifecycleEvents = boundLifecycleEvents([...fresh, ...get().pendingLifecycleEvents]);
        set({ lifecycleRevision: catalog.revision, lifecycleEvents, pendingLifecycleEvents, lifecycleCatalogAvailable: true });
        return fresh;
    },
    applyLifecycleEvent: (event) => {
        const lifecycleEvents = boundLifecycleEvents([event, ...get().lifecycleEvents]);
        const pendingIds = new Set(get().pendingLifecycleEvents.map((entry) => entry.eventId));
        const fresh = get().lifecycleCatalogInitialized
            && presentsLifecycle(event)
            && !persistedLifecycleIds.has(event.eventId)
            && !pendingIds.has(event.eventId)
            ? [event]
            : [];
        set({
            lifecycleEvents,
            prebaselineLifecycleEvents: get().lifecycleCatalogInitialized
                ? get().prebaselineLifecycleEvents
                : boundLifecycleEvents([event, ...get().prebaselineLifecycleEvents]),
            pendingLifecycleEvents: fresh.length === 0
                ? get().pendingLifecycleEvents
                : boundLifecycleEvents([...fresh, ...get().pendingLifecycleEvents]),
        });
        return fresh;
    },
    markLifecyclePresented: (eventId, at) => set((state) => {
        const event = state.pendingLifecycleEvents.find((entry) => entry.eventId === eventId)
            ?? state.lifecycleEvents.find((entry) => entry.eventId === eventId);
        persistedLifecycleIds.add(eventId);
        const presented = boundPresented([
            ...lifecycleScopeState.presented,
            { eventId, at: event?.at ?? at ?? new Date().toISOString() },
        ]);
        lifecycleScopeState.initialized = true;
        lifecycleScopeState.presented = presented;
        saveLifecycleScope();
        return { pendingLifecycleEvents: state.pendingLifecycleEvents.filter((entry) => entry.eventId !== eventId) };
    }),
    acknowledgeLifecyclePush: (eventId, machineId) => set((state) => {
        if (lifecycleAuthority === '') {
            if (!preAuthorityPushes.some((entry) => entry.eventId === eventId && entry.machineId === machineId)) {
                preAuthorityPushes.push({ eventId, machineId });
            }
            return state;
        }
        const scope = `${lifecycleAuthority}:${machineId}`;
        acknowledgePushInScope(scope, eventId);
        return scope === lifecycleScope
            ? { pendingLifecycleEvents: state.pendingLifecycleEvents.filter((entry) => entry.eventId !== eventId) }
            : state;
    }),
    setLifecycleAuthority: (authority) => {
        lifecycleAuthority = authority;
        for (const push of preAuthorityPushes.splice(0)) {
            acknowledgePushInScope(`${authority}:${push.machineId}`, push.eventId);
        }
    },
    setLifecycleScope: (scope) => {
        if (scope === lifecycleScope) return;
        lifecycleScope = scope;
        const loaded = lifecyclePersistence.scopes[scope];
        lifecycleScopeState = loaded === undefined
            ? { initialized: false, presented: [], updatedAt: Date.now() }
            : { ...loaded, presented: boundPresented(loaded.presented) };
        persistedLifecycleIds.clear();
        for (const entry of lifecycleScopeState.presented) persistedLifecycleIds.add(entry.eventId);
        set({
            lifecycleRevision: 0,
            lifecycleEvents: [],
            pendingLifecycleEvents: [],
            prebaselineLifecycleEvents: [],
            lifecycleCatalogInitialized: lifecycleScopeState.initialized,
            lifecycleCatalogAvailable: false,
        });
    },
    resetLifecycleCatalog: () => {
        persistedLifecycleIds.clear();
        lifecycleScopeState.initialized = false;
        lifecycleScopeState.presented = [];
        saveLifecycleScope();
        set({
            lifecycleRevision: 0,
            lifecycleEvents: [],
            pendingLifecycleEvents: [],
            prebaselineLifecycleEvents: [],
            lifecycleCatalogInitialized: false,
            lifecycleCatalogAvailable: false,
        });
    },
}));

const emptyMessages: Message[] = [];
const emptySessions: Session[] = [];

export function useSessions(): Session[] {
    return storage(useShallow((state) => Object.values(state.sessions)));
}

export function useHerdrTree(): { workspaces: HerdrTreeWorkspace[]; loaded: boolean } {
    return storage(useShallow((state) => ({ workspaces: state.herdrWorkspaces, loaded: state.herdrTreeLoaded })));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
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
                    name: session !== undefined ? getSessionName(session) : entry.sessionId.slice(0, 8),
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
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(_sessionId);
        return pathKey ? state.pathGitStatus[pathKey] ?? null : null;
    }));
}

export function useSessionGitStatusFiles(_sessionId: string): GitStatusFiles | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(_sessionId);
        return pathKey ? state.pathGitStatusFiles[pathKey] ?? null : null;
    }));
}

export function useSessionProjectFiles(_sessionId: string): ProjectFilesList | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(_sessionId);
        return pathKey ? state.pathProjectFiles[pathKey] ?? null : null;
    }));
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
