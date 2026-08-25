import * as React from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import {
    addVoiceNotificationActionListener,
    startVoiceService,
    stopVoiceService,
} from '@/../modules/voice-overlay';
import { startRealtimeSession as openRealtimeTransport, type RealtimeHandle, type RealtimeStatus } from '@/voice/realtimeSession';
import { voiceDiagnostic } from '@/voice/voiceDiagnostics';
import {
    cancelVadStandbyStart,
    rearmVadStandby,
    startVadStandby,
    stopVadStandby,
    vadStandbyOwnsMicrophone,
} from '@/voice/vadStandby';

export type RealtimeSessionState = RealtimeStatus;
export interface RealtimeTarget { machineId: string; sessionId: string }
export type RealtimeMachineSwitchGuard =
    | { allowed: true }
    | { allowed: false; reason: 'voice-active'; action: 'end-voice-and-switch' };
export interface RealtimeTurn {
    id: number;
    role: 'user' | 'agent';
    text: string;
}
const MAX_TURNS = 60;
/** Long enough to think mid-sentence; short enough not to bill a forgotten call. */
export const IDLE_HANGUP_MS = 120_000;

let session: RealtimeHandle | null = null;
let starting = false;
let state: RealtimeSessionState = 'disconnected';
let detail: string | undefined;
let turns: RealtimeTurn[] = [];
let muted = false;
let turnId = 0;
let bound: RealtimeTarget | null = null;
let pendingSpeech: string | null = null;
let sleepAfterSpeech = false;
let reportSpeechStarted = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let vadArming: Promise<boolean> | null = null;
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
let notificationStart: () => void | Promise<void> = () => {};
const notify = () => {
    for (const listener of listeners) listener();
};

export function boundRealtimeSession(): string | null {
    return bound?.sessionId ?? null;
}

/** Settings and machine pickers call this before changing global connection state. */
export function realtimeMachineSwitchGuard(machineId: string): RealtimeMachineSwitchGuard {
    return bound !== null && bound.machineId !== machineId
        ? { allowed: false, reason: 'voice-active', action: 'end-voice-and-switch' }
        : { allowed: true };
}

/** Desk focus only if that agent is busy; otherwise the phone's last session. */
export async function resolveRealtimeTarget(): Promise<RealtimeTarget | null> {
    const machineId = getCachedConnectionSettings().machineId;
    const tree = await sync.request('herdr.tree', {}).catch(() => undefined);
    const focused = tree?.workspaces
        .filter((workspace) => workspace.focused)
        .flatMap((workspace) => workspace.tabs.filter((tab) => tab.focused))
        .flatMap((tab) => tab.panes)
        .find((pane) => pane.focused && pane.sessionId !== undefined);
    if (
        focused?.sessionId !== undefined
        && (focused.agentStatus === 'working' || focused.agentStatus === 'blocked')
    ) {
        return { machineId, sessionId: focused.sessionId };
    }

    if (getCachedConnectionSettings().machineId !== machineId) return null;
    const sessions = Object.values(storage.getState().sessions);
    const remembered = realtimeTarget;
    if (remembered?.machineId === machineId
        && sessions.some((candidate) => candidate.id === remembered.sessionId)) return { ...remembered };
    const sessionId = [...sessions]
        .sort((left, right) => (right.activeAt || right.updatedAt) - (left.activeAt || left.updatedAt))[0]
        ?.id ?? focused?.sessionId;
    return sessionId === undefined ? null : { machineId, sessionId };
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
    if (dictating) return 'already';
    if (session !== null || starting) return 'busy';
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
    const owners: Array<'realtime' | 'dictation' | 'vad'> = [];
    if (dictating) owners.push('dictation');
    if (session !== null || starting) owners.push('realtime');
    if (vadStandbyOwnsMicrophone()) owners.push('vad');
    return owners;
}

export function rememberedRealtimeSession(): string | null {
    return realtimeTarget?.sessionId ?? null;
}

export function realtimeWatchTarget(): string | null {
    return watching ? realtimeTarget?.sessionId ?? null : null;
}

export function acknowledgeRealtimeError(): void {
    detail = undefined;
    notify();
}

/** Make the agent say something unprompted, e.g. that a task finished. */
export function speak(text: string): void {
    session?.speak(text);
}

/**
 * Say this once a session exists, then disconnect again after its reply so a
 * completion report cannot leave a paid provider idling. Waking takes a few
 * seconds, so a report arriving while asleep must also survive until ready.
 */
export function speakWhenReady(text: string): void {
    sleepAfterSpeech = true;
    reportSpeechStarted = false;
    if (session !== null) return session.speak(text);
    pendingSpeech = text;
}

function recordTurn(epoch: number, role: 'user' | 'agent', text: string): void {
    if (epoch !== realtimeEpoch) return;
    const trimmed = text.trim();
    if (trimmed === '') return;
    turns = [...turns, { id: turnId++, role, text: trimmed }].slice(-MAX_TURNS);
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
    if (!vadStandbyOwnsMicrophone()) stopVoiceService();
    session = null;
    starting = false;
    bound = null;
    turns = [];
    muted = false;
    pendingSpeech = null;
    sleepAfterSpeech = false;
    reportSpeechStarted = false;
}

function failRealtimeStart(epoch: number, reason: string): void {
    if (epoch !== realtimeEpoch) return;
    clearLiveState();
    rearmVadStandby();
    state = 'disconnected';
    detail = reason;
    notify();
}

export function startRealtimeSession(input: RealtimeTarget | string): boolean {
    const target = typeof input === 'string'
        ? { machineId: getCachedConnectionSettings().machineId, sessionId: input }
        : { ...input };
    voiceDiagnostic('startVoice.enter');
    if (dictating) {
        voiceDiagnostic('startVoice.guard:dictating');
        return false;
    }
    if (starting || session !== null) {
        voiceDiagnostic(bound?.machineId === target.machineId && bound.sessionId === target.sessionId
            ? 'startVoice.guard:duplicate'
            : 'startVoice.guard:pinned');
        return false;
    }
    vadEpoch += 1;
    const pendingVad = vadArming;
    cancelVadStandbyStart();
    const epoch = ++realtimeEpoch;
    realtimeTarget = target;
    watching = true;
    clearIdleTimer();
    session = null;
    turns = [];
    muted = false;
    sleepAfterSpeech = false;
    reportSpeechStarted = false;
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
    const liveEpoch = epoch;
    let handle!: RealtimeHandle;
    try {
        handle = openRealtimeTransport({
            target,
            onStatus: (next, why) => {
                if (liveEpoch !== realtimeEpoch || session !== handle) return;
                if (next === 'disconnected') {
                    clearLiveState();
                    state = 'disconnected';
                    detail = why === 'ended' ? undefined : why;
                    notify();
                    rearmVadStandby();
                    if (watching && !vadStandbyOwnsMicrophone()) void armVadStandby();
                    return;
                }
                if (next === 'connected' || next === 'thinking' || next === 'speaking') keepAwake(liveEpoch);
                if (next === 'speaking' && sleepAfterSpeech) reportSpeechStarted = true;
                if (next === 'connected' && sleepAfterSpeech && reportSpeechStarted) {
                    sleepRealtimeSession();
                    return;
                }
                if (next === 'connected' && pendingSpeech !== null) {
                    handle.speak(pendingSpeech);
                    pendingSpeech = null;
                }
                state = next;
                detail = why;
                notify();
            },
            onTurn: (role, text) => recordTurn(liveEpoch, role, text),
            onActivity: () => {
                if (liveEpoch === realtimeEpoch && session === handle) keepAwake(liveEpoch);
            },
        });
    } catch (error) {
        if (epoch === realtimeEpoch) {
            clearLiveState();
            state = 'disconnected';
            detail = error instanceof Error ? error.message : String(error);
            notify();
            rearmVadStandby();
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

async function armVadStandby(): Promise<boolean> {
    if (storage.getState().localSettings?.vadStandbyEnabled !== true || dictating || session !== null || starting) return false;
    if (vadArming !== null) return vadArming;
    const epoch = vadEpoch;
    const task = (async () => {
        const target = realtimeTarget?.machineId === getCachedConnectionSettings().machineId
            ? realtimeTarget
            : await resolveRealtimeTarget();
        if (target === null || epoch !== vadEpoch || storage.getState().localSettings?.vadStandbyEnabled !== true
            || dictating || session !== null || starting) return false;
        realtimeTarget = target;
        watching = true;
        const armed = await startVadStandby(
            () => {
                const wakeTarget = realtimeTarget;
                if (wakeTarget !== null && session === null && !starting && !dictating) startRealtimeSession(wakeTarget);
            },
            () => {
                storage.getState().applyLocalSettings({ vadStandbyEnabled: false });
                notify();
            },
        );
        if (epoch !== vadEpoch) {
            stopVadStandby();
            return false;
        }
        return armed;
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
    const armed = await armVadStandby();
    if (!armed) storage.getState().applyLocalSettings({ vadStandbyEnabled: false });
    notify();
    return armed;
}

function sleepRealtimeSession(): void {
    realtimeEpoch++;
    const active = session;
    clearLiveState();
    active?.stop();
    state = 'disconnected';
    detail = undefined;
    notify();
    if (watching) void armVadStandby();
}

export function stopRealtimeSession(): void {
    watching = false;
    vadEpoch += 1;
    storage.getState().applyLocalSettings({ vadStandbyEnabled: false });
    stopVadStandby();
    sleepRealtimeSession();
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
