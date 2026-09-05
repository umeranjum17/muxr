import * as React from 'react';
import { storage } from '@/catalog/store';
import { sync } from '@/catalog/sync';
import { getCachedConnectionSettings } from '@/connection';
import {
    addVoiceNotificationActionListener,
    setVoiceNetworkActive,
    startVoiceService,
    stopVoiceService,
} from '@/../modules/voice-overlay';
import { startRealtimeSession as openRealtimeTransport, type RealtimeHandle, type RealtimeStatus } from './realtimeSession';
import { voiceDiagnostic } from '../infrastructure/voiceDiagnostics';
import {
    cancelVadStandbyStart,
    rearmVadStandby,
    startVadStandby,
    stopVadStandby,
    vadStandbyOwnsMicrophone,
} from './vadStandby';

import {
    exclusiveMicOwners,
    machineSwitchAllowed,
    type RealtimeMachineSwitchGuard as MicSwitchGuard,
} from '../domain/micOwnership';
import { startRealtimeConversation } from './startRealtimeConversation';
import { startDictation } from './startDictation';
import { stopRealtimeConversation } from './stopRealtimeConversation';
import { focusAgent } from './focusAgent';
import { interruptPlayback } from '@/playback/interrupt';

export type RealtimeSessionState = RealtimeStatus;
export interface RealtimeTarget { machineId: string; sessionId: string }
export type RealtimeMachineSwitchGuard = MicSwitchGuard;
export interface RealtimeTurn {
    id: number;
    role: 'user' | 'agent';
    text: string;
}
const MAX_TURNS = 60;

function visibleVoiceDetail(value: unknown): string | undefined {
    const clean = String(value ?? '')
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '$1 [redacted]')
        .replace(/\b(?:[A-Za-z][A-Za-z0-9]*_)+(?:api_key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]')
        .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[credential redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi, '[credential redacted]')
        .replace(/\b(?:pph?_[a-z0-9]+|(?:w\d+[A-Za-z]?):(?:p|t)\d+|(?:machine|device|session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b/gi, '[internal reference]')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[internal reference]')
        .replace(/file:\/\/\S+/g, '[path hidden]')
        .replace(/(^|\s)\/(?!\/)(?:[^\s/]+\/)+[^\s]*/g, '$1[path hidden]')
        .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s,;]*/g, '[path hidden]')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .trim()
        .slice(0, 500);
    return clean === '' ? undefined : clean;
}

/** Long enough to think mid-sentence; short enough not to bill a forgotten call. */
export const IDLE_HANGUP_MS = 120_000;
const REPORT_RESPONSE_TIMEOUT_MS = 45_000;

let session: RealtimeHandle | null = null;
let starting = false;
let state: RealtimeSessionState = 'disconnected';
let detail: string | undefined;
let turns: RealtimeTurn[] = [];
let muted = false;
let turnId = 0;
let bound: RealtimeTarget | null = null;
let pendingSpeech: string | null = null;
let reportSpeech: {
    sent: boolean;
    responseStarted: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
} | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
type VadArmResult = 'armed' | 'retry' | 'failed';
let vadArming: Promise<VadArmResult> | null = null;
let vadEpoch = 0;
/** Local completion watch; unlike `session`, this owns no provider connection. */
let watching = false;
/** Last used pane for a notification Talk action. */
let realtimeTarget: RealtimeTarget | null = null;
/** The one root-owned conversation sheet, shared by Terminal and Home. */
let realtimeConversationVisibleState = false;
/** Dictation and Realtime never own the microphone together. */
let dictating = false;
/** Supersedes in-flight handoffs, callbacks, turns and inactivity timers. */
let realtimeEpoch = 0;
const listeners = new Set<() => void>();
const watchActivationListeners = new Set<() => void>();
let notificationStart: () => void | Promise<void> = () => {};
const notify = () => {
    for (const listener of listeners) listener();
};

export function boundRealtimeSession(): string | null {
    return bound?.sessionId ?? null;
}

/** Settings and machine pickers call this before changing global connection state. */
export function realtimeMachineSwitchGuard(machineId: string): RealtimeMachineSwitchGuard {
    return machineSwitchAllowed(bound?.machineId ?? null, machineId);
}

/** Desk focus only if that agent is busy; otherwise the phone's last session. */
export async function resolveRealtimeTarget(): Promise<RealtimeTarget | null> {
    const machineId = getCachedConnectionSettings().machineId;
    // The local catalog can contain routes from a previous Herdr snapshot. Resolve
    // only against the two fresh host views: session.list is the authoritative
    // session inventory and herdr.tree supplies the pane-to-route membership.
    const fresh = await Promise.all([
        sync.request('herdr.tree', {}),
        sync.request('session.list', {}),
    ]).catch(() => undefined);
    if (fresh === undefined) return null;
    const [tree, listedSessions] = fresh;
    if (!Array.isArray(listedSessions) || !Array.isArray(tree?.workspaces)
        || !tree.workspaces.every((workspace) => workspace !== null && typeof workspace === 'object'
            && Array.isArray(workspace.tabs)
            && workspace.tabs.every((tab) => tab !== null && typeof tab === 'object' && Array.isArray(tab.panes)))) return null;
    const listedIds = new Set(listedSessions
        .filter((session) => typeof session?.id === 'string' && session.id !== '')
        .map((session) => session.id));
    const liveRoutes = new Set(tree.workspaces
        .flatMap((workspace) => workspace.tabs)
        .flatMap((tab) => tab.panes)
        .flatMap((pane) => typeof pane.sessionId === 'string' && listedIds.has(pane.sessionId) ? [pane.sessionId] : []));
    if (liveRoutes.size === 0) return null;
    const focused = tree.workspaces
        .filter((workspace) => workspace.focused)
        .flatMap((workspace) => workspace.tabs.filter((tab) => tab.focused))
        .flatMap((tab) => tab.panes)
        .find((pane) => pane.focused && typeof pane.sessionId === 'string' && liveRoutes.has(pane.sessionId));
    const sessions = Object.values(storage.getState().sessions).filter((session) => liveRoutes.has(session.id));
    const focusedRoute = focusAgent({
        machineId,
        deskFocus: focused?.sessionId === undefined
            ? undefined
            : { agentRoute: focused.sessionId, agentStatus: focused.agentStatus },
        remembered: realtimeTarget === null || !liveRoutes.has(realtimeTarget.sessionId)
            ? null
            : { machineId: realtimeTarget.machineId, agentRoute: realtimeTarget.sessionId },
        listed: sessions.map((session) => ({
            agentRoute: session.id,
            activeAt: session.activeAt || 0,
            updatedAt: session.updatedAt,
        })),
    });
    if (!focusedRoute.ok) return null;
    if (getCachedConnectionSettings().machineId !== machineId) return null;
    return { machineId: focusedRoute.machineId, sessionId: focusedRoute.agentRoute };
}

export function registerRealtimeNotificationStart(handler: () => void | Promise<void>): () => void {
    notificationStart = handler;
    return () => { if (notificationStart === handler) notificationStart = () => {}; };
}

addVoiceNotificationActionListener((action) => {
    if (action === 'stop') stopRealtimeSession();
    else if (action === 'mute') toggleRealtimeMuted();
    else void notificationStart();
});

export async function claimDictation(): Promise<'granted' | 'busy' | 'already'> {
    const result = startDictation({ dictating, realtimeLive: session !== null || starting });
    if (!result.ok) return result.reason;
    vadEpoch += 1;
    const pendingVad = vadArming;
    stopVadStandby();
    dictating = true;
    if (pendingVad !== null) await pendingVad.catch(() => false);
    return 'granted';
}

/** Hand the mic ownership back; dictation must have stopped its recorder first. */
export function releaseDictation(): void {
    dictating = false;
    if (storage.getState().localSettings?.vadStandbyEnabled === true) void armVadStandby();
}

/** Testable single-owner invariant for every microphone consumer. */
export function micOwners(): Array<'realtime' | 'dictation' | 'vad'> {
    return exclusiveMicOwners({
        dictating,
        realtimeLive: session !== null || starting,
        vadOwns: vadStandbyOwnsMicrophone(),
    });
}

export function rememberedRealtimeSession(): string | null {
    return realtimeTarget?.sessionId ?? null;
}

export function realtimeWatchTarget(): string | null {
    if (!watching) return null;
    return realtimeTarget?.sessionId ?? null;
}

export function realtimeWatching(): boolean {
    return watching;
}

export function realtimeGeneration(): number {
    return realtimeEpoch;
}

export function registerRealtimeWatchActivation(listener: () => void): () => void {
    watchActivationListeners.add(listener);
    return () => watchActivationListeners.delete(listener);
}

function activateWatching(): void {
    if (watching) return;
    watching = true;
    for (const listener of watchActivationListeners) listener();
}

export function acknowledgeRealtimeError(): void {
    detail = undefined;
    notify();
}

/** Resolve only after the provider's response (and native playback) is drained. */
export function speakReport(text: string): Promise<void> {
    if (reportSpeech !== null) return Promise.reject(new Error('A voice report is already playing.'));
    if (session === null && !starting) return Promise.reject(new Error('Voice session is not connected.'));
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => rejectReportSpeech(new Error('Voice report timed out.')), REPORT_RESPONSE_TIMEOUT_MS);
        const active = session;
        reportSpeech = { sent: active !== null && state === 'connected', responseStarted: false, resolve, reject, timer };
        if (active !== null && state === 'connected') active.speak(text);
        else pendingSpeech = text;
    });
}

/** Called by the report coordinator only when it woke an otherwise sleeping provider. */
export function sleepAfterReports(): void {
    if (session !== null || starting) sleepRealtimeSession();
}

export function cancelRealtimeReportWait(generation: number): void {
    if (generation === realtimeEpoch) rejectReportSpeech(new Error('Voice report scope changed.'));
}

export function stopRealtimeReportProvider(generation: number): void {
    if (generation === realtimeEpoch && (session !== null || starting)) sleepRealtimeSession();
}

function resolveReportSpeech(): void {
    const report = reportSpeech;
    if (report === null) return;
    clearTimeout(report.timer);
    reportSpeech = null;
    report.resolve();
}

function rejectReportSpeech(error: Error): void {
    const report = reportSpeech;
    if (report === null) return;
    clearTimeout(report.timer);
    reportSpeech = null;
    pendingSpeech = null;
    report.reject(error);
}

function recordTurn(epoch: number, role: 'user' | 'agent', text: string): void {
    if (epoch !== realtimeEpoch) return;
    const trimmed = text.trim();
    if (trimmed === '') return;
    turns = [...turns, { id: turnId++, role, text: trimmed }].slice(-MAX_TURNS);
    if (role === 'agent' && reportSpeech?.sent === true) reportSpeech.responseStarted = true;
    keepAwake(epoch);
    notify();
}

function clearIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
}

/** Reset the full deadline only for activity belonging to this session. */
function keepAwake(epoch: number): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
        if (epoch === realtimeEpoch && session !== null) sleepRealtimeSession();
    }, IDLE_HANGUP_MS);
}

function clearLiveState(): void {
    clearIdleTimer();
    rejectReportSpeech(new Error('Voice session disconnected.'));
    if (!vadStandbyOwnsMicrophone()) stopVoiceService();
    session = null;
    starting = false;
    bound = null;
    turns = [];
    muted = false;
    pendingSpeech = null;
}

function failRealtimeStart(epoch: number, reason: string): void {
    if (epoch !== realtimeEpoch) return;
    clearLiveState();
    rearmVadStandby();
    state = 'disconnected';
    detail = visibleVoiceDetail(reason);
    notify();
}

function applyTransportStatus(handle: RealtimeHandle, liveEpoch: number, next: RealtimeSessionState, why?: string): void {
    if (next === 'disconnected') {
        clearLiveState();
        state = 'disconnected';
        detail = why === 'ended' ? undefined : visibleVoiceDetail(why);
        notify();
        rearmVadStandby();
        if (watching && !vadStandbyOwnsMicrophone()) void armVadStandby();
        return;
    }
    if (next === 'connected' || next === 'thinking' || next === 'speaking') keepAwake(liveEpoch);
    if ((next === 'thinking' || next === 'speaking') && reportSpeech?.sent === true) reportSpeech.responseStarted = true;
    if (next === 'connected' && reportSpeech?.responseStarted === true) resolveReportSpeech();
    if (next === 'connected' && pendingSpeech !== null) {
        handle.speak(pendingSpeech);
        pendingSpeech = null;
        if (reportSpeech !== null) reportSpeech.sent = true;
    }
    state = next;
    detail = visibleVoiceDetail(why);
    notify();
}

export function startRealtimeSession(input: RealtimeTarget | string): boolean {
    const target = typeof input === 'string'
        ? { machineId: getCachedConnectionSettings().machineId, sessionId: input }
        : { ...input };
    voiceDiagnostic('startVoice.enter');
    const decision = startRealtimeConversation({
        machineId: target.machineId,
        agentRoute: target.sessionId,
        dictating,
        realtimeLive: starting || session !== null,
        bound: bound === null ? null : { machineId: bound.machineId, agentRoute: bound.sessionId },
    });
    if (!decision.ok) {
        voiceDiagnostic(`startVoice.guard:${decision.reason}`);
        return false;
    }
    vadEpoch += 1;
    const pendingVad = vadArming;
    cancelVadStandbyStart();
    const epoch = ++realtimeEpoch;
    realtimeTarget = target;
    activateWatching();
    clearIdleTimer();
    session = null;
    turns = [];
    muted = false;
    bound = target;
    starting = true;
    state = 'connecting';
    detail = undefined;
    notify();
    if (pendingVad === null) startRealtimeAfterService(target, epoch);
    else void pendingVad.then(
        () => startRealtimeAfterService(target, epoch),
        () => startRealtimeAfterService(target, epoch),
    );
    return true;
}

/** The service must be foreground before native PCM capture opens the microphone. */
function startRealtimeAfterService(target: RealtimeTarget, epoch: number): void {
    if (epoch !== realtimeEpoch) return;
    if (!startVoiceService()) {
        failRealtimeStart(epoch, 'Microphone capture could not start.');
        return;
    }
    if (epoch !== realtimeEpoch) {
        stopVoiceService();
        return;
    }
    setVoiceNetworkActive(true);
    const liveEpoch = epoch;
    let handle!: RealtimeHandle;
    try {
        handle = openRealtimeTransport({
            target,
            onStatus: (next, why) => {
                if (liveEpoch !== realtimeEpoch || session !== handle) return;
                applyTransportStatus(handle, liveEpoch, next, why);
            },
            onTurn: (role, text) => recordTurn(liveEpoch, role, text),
            onActivity: () => {
                if (liveEpoch === realtimeEpoch && session === handle) keepAwake(liveEpoch);
            },
        });
    } catch (error) {
        if (epoch === realtimeEpoch) {
            failRealtimeStart(epoch, error instanceof Error ? error.message : String(error));
            if (watching && !vadStandbyOwnsMicrophone()) void armVadStandby();
        }
        return;
    }
    if (epoch !== realtimeEpoch) {
        handle.stop();
        return;
    }
    session = handle;
    starting = false;
}

async function armVadStandby(): Promise<VadArmResult> {
    if (storage.getState().localSettings?.vadStandbyEnabled !== true || dictating || session !== null || starting) return 'retry';
    if (vadArming !== null) return vadArming;
    const epoch = vadEpoch;
    const task = (async (): Promise<VadArmResult> => {
        const target = realtimeTarget?.machineId === getCachedConnectionSettings().machineId
            ? realtimeTarget
            : await resolveRealtimeTarget();
        if (target === null || epoch !== vadEpoch || storage.getState().localSettings?.vadStandbyEnabled !== true
            || dictating || session !== null || starting) return 'retry';
        realtimeTarget = target;
        activateWatching();
        const armed = await startVadStandby(() => {
            const wakeTarget = realtimeTarget;
            if (wakeTarget !== null && session === null && !starting && !dictating) startRealtimeSession(wakeTarget);
        });
        if (epoch !== vadEpoch) {
            stopVadStandby();
            return 'retry';
        }
        return armed ? 'armed' : 'failed';
    })();
    vadArming = task;
    try {
        return await task;
    } finally {
        if (vadArming === task) vadArming = null;
    }
}

export async function configureVadStandby(enabled: boolean): Promise<boolean> {
    storage.getState().applyLocalSettings({ vadStandbyEnabled: enabled });
    if (!enabled) {
        vadEpoch += 1;
        stopVadStandby();
        notify();
        return true;
    }
    const result = await armVadStandby();
    if (result === 'failed') storage.getState().applyLocalSettings({ vadStandbyEnabled: false });
    notify();
    return result !== 'failed';
}

/** Retry a persisted preference without treating normal live/busy state as rejection. */
export async function retryVadStandby(): Promise<boolean> {
    if (storage.getState().localSettings?.vadStandbyEnabled !== true) return false;
    return await armVadStandby() === 'armed';
}

function sleepRealtimeSession(): void {
    realtimeEpoch++;
    const active = session;
    clearLiveState();
    interruptPlayback({ stop: () => active?.stop() });
    state = 'disconnected';
    detail = undefined;
    notify();
    if (watching) void armVadStandby();
}

export function stopRealtimeSession(): void {
    if (storage.getState().localSettings?.vadStandbyEnabled === true) {
        sleepRealtimeSession();
        return;
    }
    stopRealtimeConversation({
        endWatch: () => {
            watching = false;
            vadEpoch += 1;
            stopVadStandby();
        },
        interruptPlayback: () => sleepRealtimeSession(),
    });
}

export function toggleRealtimeMuted(): void {
    muted = !muted;
    session?.setMuted(muted);
    notify();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useRealtimeSessionState(): { state: RealtimeSessionState; detail?: string } {
    const current = React.useSyncExternalStore(subscribe, () => state);
    return { state: current, detail };
}

export function realtimeSessionSnapshot(): { state: RealtimeSessionState; detail?: string; starting: boolean } {
    return { state, detail, starting };
}

export function useRealtimeTurns(): RealtimeTurn[] {
    return React.useSyncExternalStore(subscribe, () => turns);
}

export function useRealtimeMuted(): boolean {
    return React.useSyncExternalStore(subscribe, () => muted);
}

export function useRealtimeWatching(): boolean {
    return React.useSyncExternalStore(subscribe, () => watching);
}

export function openRealtimeConversation(): void {
    if (realtimeConversationVisibleState) return;
    realtimeConversationVisibleState = true;
    notify();
}

export function closeRealtimeConversation(): void {
    if (!realtimeConversationVisibleState) return;
    realtimeConversationVisibleState = false;
    notify();
}

/** Non-hook read for code that runs outside React, e.g. a capability handler. */
export function realtimeConversationVisible(): boolean {
    return realtimeConversationVisibleState;
}

export function useRealtimeConversationVisible(): boolean {
    return React.useSyncExternalStore(subscribe, () => realtimeConversationVisibleState);
}
