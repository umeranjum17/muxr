import { MMKV } from 'react-native-mmkv';
import type { LifecycleCatalog, LifecycleEvent } from '@muxr/contract';
import { lifecycleNeedsHumanAlert } from '../domain/lifecycle';
import {
    MAX_VOICE_IDENTITY_LENGTH,
    isTrustedVoiceScopeKey,
    sanitizePersistedVoiceReport,
    agentNameIsTrusted,
    voiceReportIsRoutine,
    type VoiceAdmission,
    type VoiceReport,
} from '../domain/voiceReport';

export type PersistedVoiceReport = VoiceReport;
export type { VoiceAdmission };
export const isTrustedVoiceAgentName = agentNameIsTrusted;
export { sanitizePersistedVoiceReport };

const mmkv = new MMKV();
const NOTIFICATIONS_KEY = 'lifecycle-notifications-v1';
const VOICE_REPORTS_KEY = 'lifecycle-voice-reports-v1';
const MAX_EVENTS = 50;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SCOPE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SCOPES = 8;
const MAX_PENDING_VOICE = 128;
const MAX_ROUTINE_VOICE = 96;
const MAX_DELIVERED_VOICE = 512;

export interface WatchSnapshot {
    lifecycleRevision: number;
    lifecycleEvents: LifecycleEvent[];
    pendingLifecycleEvents: LifecycleEvent[];
    prebaselineLifecycleEvents: LifecycleEvent[];
    lifecycleCatalogInitialized: boolean;
    lifecycleCatalogAvailable: boolean;
    voicePendingReports: PersistedVoiceReport[];
    voiceDeliveredReportIds: string[];
    voiceReportScope: string;
    voiceReportScopeGeneration: number;
}

export interface AgentWatch {
    snapshot(): WatchSnapshot;
    setAuthority(authority: string): void;
    setScope(scope: string): WatchSnapshot;
    applyCatalog(catalog: LifecycleCatalog): LifecycleEvent[];
    applyEvent(event: LifecycleEvent): LifecycleEvent[];
    markPresented(eventId: string, at?: string): WatchSnapshot;
    acknowledgePush(eventId: string, machineId: string): WatchSnapshot;
    resetCatalog(): WatchSnapshot;
    admitVoice(report: PersistedVoiceReport): VoiceAdmission;
    updateVoiceRetry(identity: string, attempts: number, readyAt: number): WatchSnapshot;
    deliverVoice(identity: string): WatchSnapshot;
    discardVoice(identity: string): WatchSnapshot;
}

interface PresentedRecord {
    eventId: string;
    at: string;
}

interface NotificationScope {
    initialized: boolean;
    presented: PresentedRecord[];
    updatedAt: number;
}

interface VoiceScope {
    pending: PersistedVoiceReport[];
    delivered: string[];
    updatedAt: number;
}

function emptySnapshot(): WatchSnapshot {
    return {
        lifecycleRevision: 0,
        lifecycleEvents: [],
        pendingLifecycleEvents: [],
        prebaselineLifecycleEvents: [],
        lifecycleCatalogInitialized: false,
        lifecycleCatalogAvailable: false,
        voicePendingReports: [],
        voiceDeliveredReportIds: [],
        voiceReportScope: '',
        voiceReportScopeGeneration: 0,
    };
}

function emptyNotificationScope(): NotificationScope {
    return { initialized: false, presented: [], updatedAt: 0 };
}

function lifecycleTime(event: LifecycleEvent): number {
    return Date.parse(event.at) || 0;
}

function boundLifecycleEvents(events: readonly LifecycleEvent[]): LifecycleEvent[] {
    const cutoff = Date.now() - RETENTION_MS;
    const byId = new Map<string, LifecycleEvent>();
    for (const event of events) {
        if (lifecycleTime(event) < cutoff) continue;
        if (byId.has(event.eventId)) continue;
        byId.set(event.eventId, event);
    }
    return [...byId.values()]
        .sort((left, right) => lifecycleTime(right) - lifecycleTime(left))
        .slice(0, MAX_EVENTS);
}

function boundPresented(records: PresentedRecord[]): PresentedRecord[] {
    const cutoff = Date.now() - RETENTION_MS;
    const byId = new Map<string, PresentedRecord>();
    for (const record of records) {
        if ((Date.parse(record.at) || 0) < cutoff) continue;
        byId.set(record.eventId, record);
    }
    return [...byId.values()]
        .sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0))
        .slice(0, MAX_EVENTS);
}

function newestScopes<T extends { updatedAt: number }>(
    scopes: Record<string, T>,
    allowKey: (key: string) => boolean,
): Record<string, T> {
    const cutoff = Date.now() - SCOPE_RETENTION_MS;
    const kept: Array<[string, T]> = [];
    for (const [key, scope] of Object.entries(scopes)) {
        if (!allowKey(key)) continue;
        if (scope.updatedAt < cutoff) continue;
        kept.push([key, scope]);
    }
    kept.sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
    return Object.fromEntries(kept.slice(0, MAX_SCOPES));
}

function readPresentedRecords(value: unknown): PresentedRecord[] {
    if (!Array.isArray(value)) return [];
    const records: PresentedRecord[] = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as { eventId?: unknown; at?: unknown };
        if (typeof record.eventId !== 'string' || typeof record.at !== 'string') continue;
        records.push({ eventId: record.eventId, at: record.at });
    }
    return records;
}

function readDeliveredIdentities(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const identities: string[] = [];
    const seen = new Set<string>();
    for (const id of value) {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_VOICE_IDENTITY_LENGTH) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        identities.push(id);
    }
    return identities;
}

function readPendingVoiceReports(value: unknown): PersistedVoiceReport[] {
    if (!Array.isArray(value)) return [];
    const reports: PersistedVoiceReport[] = [];
    for (const entry of value) {
        const report = sanitizePersistedVoiceReport(entry);
        if (report !== null) reports.push(report);
    }
    return reports;
}

function sanitizeVoiceScope(pending: unknown, delivered: unknown, updatedAt: number): VoiceScope {
    const allDelivered = readDeliveredIdentities(delivered);
    const deliveredIds = new Set(allDelivered);
    const pendingById = new Map<string, PersistedVoiceReport>();
    for (const report of readPendingVoiceReports(pending)) {
        if (deliveredIds.has(report.identity)) continue;
        if (pendingById.has(report.identity)) continue;
        pendingById.set(report.identity, report);
    }
    return {
        pending: [...pendingById.values()].slice(0, MAX_PENDING_VOICE),
        delivered: allDelivered.slice(-MAX_DELIVERED_VOICE),
        updatedAt,
    };
}

function loadNotificationPersistence(): Record<string, NotificationScope> {
    const raw = mmkv.getString(NOTIFICATIONS_KEY);
    if (!raw) return {};
    try {
        const value = JSON.parse(raw) as { scopes?: Record<string, NotificationScope> };
        if (typeof value.scopes !== 'object' || value.scopes === null) return {};
        const scopes: Record<string, NotificationScope> = {};
        for (const [key, scope] of Object.entries(value.scopes)) {
            if (typeof scope !== 'object' || scope === null) continue;
            scopes[key] = {
                initialized: scope.initialized === true,
                presented: readPresentedRecords(scope.presented),
                updatedAt: typeof scope.updatedAt === 'number' ? scope.updatedAt : 0,
            };
        }
        return scopes;
    } catch {
        return {};
    }
}

function saveNotificationPersistence(scopes: Record<string, NotificationScope>): Record<string, NotificationScope> {
    const next = newestScopes(scopes, () => true);
    mmkv.set(NOTIFICATIONS_KEY, JSON.stringify({ scopes: next }));
    return next;
}

function loadVoicePersistence(): Record<string, VoiceScope> {
    const raw = mmkv.getString(VOICE_REPORTS_KEY);
    if (!raw) return {};
    try {
        const value = JSON.parse(raw) as { scopes?: Record<string, VoiceScope> };
        if (typeof value.scopes !== 'object' || value.scopes === null) return {};
        const cutoff = Date.now() - SCOPE_RETENTION_MS;
        const candidates: Array<[string, VoiceScope]> = [];
        for (const [key, scope] of Object.entries(value.scopes)) {
            if (!isTrustedVoiceScopeKey(key)) continue;
            if (typeof scope !== 'object' || scope === null) continue;
            if (typeof scope.updatedAt !== 'number' || !Number.isFinite(scope.updatedAt)) continue;
            if (scope.updatedAt < cutoff) continue;
            candidates.push([key, scope]);
        }
        candidates.sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
        const scopes: Record<string, VoiceScope> = {};
        for (const [key, scope] of candidates.slice(0, MAX_SCOPES)) {
            scopes[key] = sanitizeVoiceScope(scope.pending, scope.delivered, scope.updatedAt);
        }
        return scopes;
    } catch {
        return {};
    }
}

function saveVoicePersistence(scopes: Record<string, VoiceScope>): Record<string, VoiceScope> {
    const sanitized: Record<string, VoiceScope> = {};
    for (const [key, scope] of Object.entries(scopes)) {
        if (!isTrustedVoiceScopeKey(key)) continue;
        sanitized[key] = {
            pending: readPendingVoiceReports(scope.pending).slice(0, MAX_PENDING_VOICE),
            delivered: readDeliveredIdentities(scope.delivered).slice(-MAX_DELIVERED_VOICE),
            updatedAt: scope.updatedAt,
        };
    }
    const next = newestScopes(sanitized, isTrustedVoiceScopeKey);
    mmkv.set(VOICE_REPORTS_KEY, JSON.stringify({ scopes: next }));
    return next;
}

export function createAgentWatch(): AgentWatch {
    let notifications = loadNotificationPersistence();
    let voices = loadVoicePersistence();
    let scope = '';
    let authority = '';
    let notification = emptyNotificationScope();
    const presentedIds = new Set<string>();
    const preAuthorityPushes: Array<{ eventId: string; machineId: string }> = [];
    let voice: VoiceScope = { pending: [], delivered: [], updatedAt: 0 };
    let voiceGeneration = 0;
    let current = emptySnapshot();

    function replaceSnapshot(patch: Partial<WatchSnapshot>): WatchSnapshot {
        current = { ...current, ...patch };
        return current;
    }

    function saveNotifications(): void {
        if (scope === '') return;
        notification.updatedAt = Date.now();
        notifications[scope] = notification;
        notifications = saveNotificationPersistence(notifications);
    }

    function saveVoice(): void {
        if (scope === '') return;
        voice.updatedAt = Date.now();
        voices[scope] = voice;
        voices = saveVoicePersistence(voices);
    }

    function activateVoiceScope(stored: VoiceScope | undefined): VoiceScope {
        if (stored === undefined) {
            return { pending: [], delivered: [], updatedAt: Date.now() };
        }
        return sanitizeVoiceScope(stored.pending, stored.delivered, stored.updatedAt);
    }

    function acknowledgeInScope(scopeKey: string, eventId: string): void {
        const existing = notifications[scopeKey] ?? emptyNotificationScope();
        const updated: NotificationScope = {
            ...existing,
            presented: boundPresented([...existing.presented, { eventId, at: new Date().toISOString() }]),
            updatedAt: Date.now(),
        };
        notifications[scopeKey] = updated;
        notifications = saveNotificationPersistence(notifications);
        if (scopeKey !== scope) return;
        notification = updated;
        presentedIds.add(eventId);
    }

    return {
        snapshot: () => current,
        setAuthority(nextAuthority) {
            authority = nextAuthority;
            for (const push of preAuthorityPushes.splice(0)) {
                acknowledgeInScope(`${nextAuthority}:${push.machineId}`, push.eventId);
            }
        },
        setScope(nextScope) {
            if (nextScope === scope) return current;
            scope = nextScope;
            voiceGeneration += 1;
            const loaded = notifications[nextScope];
            if (loaded === undefined) {
                notification = { ...emptyNotificationScope(), updatedAt: Date.now() };
            } else {
                notification = { ...loaded, presented: boundPresented(loaded.presented) };
            }
            presentedIds.clear();
            for (const record of notification.presented) presentedIds.add(record.eventId);
            voice = activateVoiceScope(voices[nextScope]);
            return replaceSnapshot({
                lifecycleRevision: 0,
                lifecycleEvents: [],
                pendingLifecycleEvents: [],
                prebaselineLifecycleEvents: [],
                lifecycleCatalogInitialized: notification.initialized,
                lifecycleCatalogAvailable: false,
                voicePendingReports: voice.pending,
                voiceDeliveredReportIds: voice.delivered,
                voiceReportScope: nextScope,
                voiceReportScopeGeneration: voiceGeneration,
            });
        },
        applyCatalog(catalog) {
            if (catalog.revision < current.lifecycleRevision) return [];
            const eventsBeforeCatalog = current.prebaselineLifecycleEvents;
            const lifecycleEvents = boundLifecycleEvents([...eventsBeforeCatalog, ...catalog.events]);
            if (!current.lifecycleCatalogInitialized) {
                const liveEventIds = new Set(eventsBeforeCatalog.map((event) => event.eventId));
                const catalogHistory: PresentedRecord[] = [];
                for (const event of lifecycleEvents) {
                    if (liveEventIds.has(event.eventId)) continue;
                    catalogHistory.push({ eventId: event.eventId, at: event.at });
                }
                const presented = boundPresented([...notification.presented, ...catalogHistory]);
                for (const record of presented) presentedIds.add(record.eventId);
                const newAlerts = eventsBeforeCatalog.filter((event) => lifecycleNeedsHumanAlert(event.state));
                notification.initialized = true;
                notification.presented = presented;
                saveNotifications();
                replaceSnapshot({
                    lifecycleRevision: catalog.revision,
                    lifecycleEvents,
                    pendingLifecycleEvents: boundLifecycleEvents(newAlerts),
                    prebaselineLifecycleEvents: [],
                    lifecycleCatalogInitialized: true,
                    lifecycleCatalogAvailable: true,
                });
                return newAlerts;
            }
            const pendingIds = new Set(current.pendingLifecycleEvents.map((event) => event.eventId));
            const newAlerts = lifecycleEvents.filter((event) => {
                if (!lifecycleNeedsHumanAlert(event.state)) return false;
                if (presentedIds.has(event.eventId)) return false;
                if (pendingIds.has(event.eventId)) return false;
                return true;
            });
            replaceSnapshot({
                lifecycleRevision: catalog.revision,
                lifecycleEvents,
                pendingLifecycleEvents: boundLifecycleEvents([...newAlerts, ...current.pendingLifecycleEvents]),
                lifecycleCatalogAvailable: true,
            });
            return newAlerts;
        },
        applyEvent(event) {
            const lifecycleEvents = boundLifecycleEvents([event, ...current.lifecycleEvents]);
            if (!current.lifecycleCatalogInitialized) {
                replaceSnapshot({
                    lifecycleEvents,
                    prebaselineLifecycleEvents: boundLifecycleEvents([event, ...current.prebaselineLifecycleEvents]),
                });
                return [];
            }
            const alreadyPending = current.pendingLifecycleEvents.some((entry) => entry.eventId === event.eventId);
            if (!lifecycleNeedsHumanAlert(event.state) || presentedIds.has(event.eventId) || alreadyPending) {
                replaceSnapshot({ lifecycleEvents });
                return [];
            }
            const newAlerts = [event];
            replaceSnapshot({
                lifecycleEvents,
                pendingLifecycleEvents: boundLifecycleEvents([...newAlerts, ...current.pendingLifecycleEvents]),
            });
            return newAlerts;
        },
        markPresented(eventId, at) {
            const knownEvent = current.pendingLifecycleEvents.find((entry) => entry.eventId === eventId)
                ?? current.lifecycleEvents.find((entry) => entry.eventId === eventId);
            let presentedAt = new Date().toISOString();
            if (knownEvent !== undefined) presentedAt = knownEvent.at;
            else if (at !== undefined) presentedAt = at;
            presentedIds.add(eventId);
            notification.initialized = true;
            notification.presented = boundPresented([
                ...notification.presented,
                { eventId, at: presentedAt },
            ]);
            saveNotifications();
            return replaceSnapshot({
                pendingLifecycleEvents: current.pendingLifecycleEvents.filter((entry) => entry.eventId !== eventId),
            });
        },
        acknowledgePush(eventId, machineId) {
            if (authority === '') {
                const alreadyQueued = preAuthorityPushes.some((entry) =>
                    entry.eventId === eventId && entry.machineId === machineId);
                if (!alreadyQueued) preAuthorityPushes.push({ eventId, machineId });
                return current;
            }
            const scopeKey = `${authority}:${machineId}`;
            acknowledgeInScope(scopeKey, eventId);
            if (scopeKey !== scope) return current;
            return replaceSnapshot({
                pendingLifecycleEvents: current.pendingLifecycleEvents.filter((entry) => entry.eventId !== eventId),
            });
        },
        resetCatalog() {
            presentedIds.clear();
            notification.initialized = false;
            notification.presented = [];
            saveNotifications();
            return replaceSnapshot({
                lifecycleRevision: 0,
                lifecycleEvents: [],
                pendingLifecycleEvents: [],
                prebaselineLifecycleEvents: [],
                lifecycleCatalogInitialized: false,
                lifecycleCatalogAvailable: false,
            });
        },
        admitVoice(report) {
            const clean = sanitizePersistedVoiceReport(report);
            if (clean === null) return 'invalid';
            if (voice.delivered.includes(clean.identity)) return 'delivered';
            if (voice.pending.some((entry) => entry.identity === clean.identity)) return 'pending';
            const routineCount = voice.pending.filter((entry) => voiceReportIsRoutine(entry)).length;
            if (voiceReportIsRoutine(clean) && routineCount >= MAX_ROUTINE_VOICE) return 'full';
            if (voice.pending.length >= MAX_PENDING_VOICE) return 'full';
            voice = { ...voice, pending: [...voice.pending, clean] };
            saveVoice();
            replaceSnapshot({ voicePendingReports: voice.pending });
            return 'admitted';
        },
        updateVoiceRetry(identity, attempts, readyAt) {
            let found = false;
            const pending = voice.pending.map((entry) => {
                if (entry.identity !== identity) return entry;
                found = true;
                return { ...entry, attempts, readyAt };
            });
            if (!found) return current;
            voice = { ...voice, pending };
            saveVoice();
            return replaceSnapshot({ voicePendingReports: pending });
        },
        deliverVoice(identity) {
            const pending = voice.pending.filter((entry) => entry.identity !== identity);
            if (pending.length === voice.pending.length) return current;
            const delivered = [...voice.delivered.filter((id) => id !== identity), identity].slice(-MAX_DELIVERED_VOICE);
            voice = { ...voice, pending, delivered };
            saveVoice();
            return replaceSnapshot({ voicePendingReports: pending, voiceDeliveredReportIds: delivered });
        },
        discardVoice(identity) {
            const pending = voice.pending.filter((entry) => entry.identity !== identity);
            if (pending.length === voice.pending.length) return current;
            voice = { ...voice, pending };
            saveVoice();
            return replaceSnapshot({ voicePendingReports: pending });
        },
    };
}
