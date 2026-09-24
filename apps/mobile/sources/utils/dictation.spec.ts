import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { useDictation } from '@/utils/dictation';
import { applyWordReplacements, pcm16ChunksToArrayBuffer } from '@/utils/transcription';
import { wakeAndReport } from '@/watch/wakeAndReport';
import { usePluginEvents } from '@/plugins/events';
import { cancelRealtimeReportWait, configureVadStandby, micOwners, realtimeGeneration, realtimeWatchTarget, registerRealtimeNotificationStart, releaseDictation, resolveRealtimeTarget, retryVadStandby, startRealtimeSession, stopRealtimeSession, useRealtimeMuted } from '@/conversation/session';

const mocks = vi.hoisted(() => ({
    sessions: {} as Record<string, { id: string; activeAt: number; updatedAt: number }>,
    vadStandbyEnabled: false,
    applyLocalSettings: vi.fn(),
    modalAlert: vi.fn(),
    permission: vi.fn(),
    showDenied: vi.fn(),
    liveAudio: { init: vi.fn(), start: vi.fn(), stop: vi.fn(), on: vi.fn() },
    // A stand-in for whisper.cpp: it hears one word per half second of
    // speech, plus a guess at a word cut off mid-way that differs on every
    // reading.
    transcribe: vi.fn((data: ArrayBuffer, _options: object) => {
        const samples = new Int16Array(data);
        const spoken = samples.filter((sample) => sample !== 0).length;
        const guess = samples.at(-1) ? [['hm', 'uh', 'er'][mocks.transcribe.mock.calls.length % 3]] : [];
        const result = [...WORDS.slice(0, Math.floor(spoken / 8000)), ...guess].join(' ');
        return {
            stop: vi.fn(async () => undefined),
            promise: Promise.resolve({ result: ` ${result}`, segments: [{ t0: 0, t1: samples.length / 160, text: ` ${result}` }], isAborted: false }),
        };
    }),
    releases: vi.fn(),
    startRealtimeSession: vi.fn(),
    startVoiceService: vi.fn(),
    setVoiceNetworkActive: vi.fn(),
    stopVoiceService: vi.fn(),
    setVoiceGeneration: vi.fn(),
    notificationAction: null as ((action: 'start' | 'stop' | 'mute', desiredMuted?: boolean, generation?: string) => void) | null,
    addVoiceNotificationActionListener: vi.fn((listener: (action: 'start' | 'stop' | 'mute', desiredMuted?: boolean, generation?: string) => void) => {
        mocks.notificationAction = listener;
        return { remove: () => undefined };
    }),
    syncRequest: vi.fn(),
    voiceReports: () => mocks.syncRequest.mock.calls.filter((call) => call[0] === 'voice.report'),
    voicePending: [] as Array<Record<string, unknown> & { identity: string; attempts: number; readyAt: number }>,
    voiceDelivered: [] as string[],
    lifecycleEvents: [] as Array<Record<string, unknown> & { eventId: string }>,
    prebaselineLifecycleEvents: [] as Array<Record<string, unknown> & { eventId: string }>,
    lifecycleCatalogInitialized: true,
    lifecycleCatalogAvailable: true,
    storageListeners: new Set<(state: Record<string, unknown>, previous: Record<string, unknown>) => void>(),
    pluginSnapshot: [] as Array<Record<string, unknown>>,
    capability: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { addEventListener: vi.fn() } }));
// The level is a reanimated shared value so chunks never re-render the screen;
// here it only needs to be a readable holder.
vi.mock('react-native-reanimated', () => ({ useSharedValue: (initial: number) => ({ value: initial }) }));
vi.mock('react-native-live-audio-stream', () => ({ default: mocks.liveAudio }));
const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
vi.mock('whisper.rn', () => ({ initWhisper: vi.fn(async () => ({ transcribeData: mocks.transcribe, release: mocks.releases })) }));
vi.mock('@/utils/dictationModels', () => ({ BUNDLED_DICTATION_MODEL_ID: 'base', getInstalledDictationModelUri: () => null }));
vi.mock('@/utils/dictationModelFiles', () => ({ bundledDictationModel: 1 }));
vi.mock('@/catalog/application/persistence', () => ({ loadLocalSettings: () => ({ dictationWordReplacements: [{ from: 'four', to: '4' }] }) }));
vi.mock('@/catalog/sync', () => ({ sync: { request: mocks.syncRequest } }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: '' }) }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.modalAlert } }));
vi.mock('../plugins/application/pluginStore', () => ({ pluginSnapshot: () => mocks.pluginSnapshot }));
vi.mock('../plugins/application/capabilityRegistry', () => ({ capabilityFor: () => mocks.capability }));
vi.mock('@/watch/store', () => ({
    sanitizePersistedVoiceReport: (report: Record<string, unknown>) => report,
}));
vi.mock('@/catalog/store', () => ({
    storage: {
    subscribe: vi.fn((listener: (state: Record<string, unknown>, previous: Record<string, unknown>) => void) => {
        mocks.storageListeners.add(listener);
        return () => mocks.storageListeners.delete(listener);
    }),
    getState: () => ({
        sessions: mocks.sessions,
        localSettings: { vadStandbyEnabled: mocks.vadStandbyEnabled },
        applyLocalSettings: (patch: { vadStandbyEnabled?: boolean }) => {
            if (patch.vadStandbyEnabled !== undefined) mocks.vadStandbyEnabled = patch.vadStandbyEnabled;
            mocks.applyLocalSettings(patch);
        },
        voicePendingReports: mocks.voicePending,
        voiceDeliveredReportIds: mocks.voiceDelivered,
        voiceReportScope: 'scope-a',
        voiceReportScopeGeneration: 1,
        lifecycleEvents: mocks.lifecycleEvents,
        prebaselineLifecycleEvents: mocks.prebaselineLifecycleEvents,
        lifecycleCatalogInitialized: mocks.lifecycleCatalogInitialized,
        lifecycleCatalogAvailable: mocks.lifecycleCatalogAvailable,
        admitVoiceReport: (report: Record<string, unknown> & { identity: string; attempts: number; readyAt: number }) => {
            if (mocks.voiceDelivered.includes(report.identity)) return 'delivered';
            if (mocks.voicePending.some((entry) => entry.identity === report.identity)) return 'pending';
            mocks.voicePending = [...mocks.voicePending, report];
            return 'admitted';
        },
        updateVoiceReportRetry: (identity: string, attempts: number, readyAt: number) => {
            mocks.voicePending = mocks.voicePending.map((entry) => entry.identity === identity ? { ...entry, attempts, readyAt } : entry);
        },
        deliverVoiceReport: (identity: string) => {
            mocks.voicePending = mocks.voicePending.filter((entry) => entry.identity !== identity);
            mocks.voiceDelivered = [...mocks.voiceDelivered, identity];
        },
        discardVoiceReport: (identity: string) => {
            mocks.voicePending = mocks.voicePending.filter((entry) => entry.identity !== identity);
        },
    }),
} }));
vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: mocks.permission,
    showMicrophonePermissionDeniedAlert: mocks.showDenied,
}));
vi.mock('../conversation/application/realtimeSession', () => ({ startRealtimeSession: mocks.startRealtimeSession }));
vi.mock('@/../modules/voice-overlay', () => ({
    startVoiceService: mocks.startVoiceService,
    setVoiceNetworkActive: mocks.setVoiceNetworkActive,
    routeVoiceAudio: vi.fn(() => true),
    releaseVoiceAudio: vi.fn(),
    stopVoiceService: mocks.stopVoiceService,
    setVoiceGeneration: mocks.setVoiceGeneration,
    addVoiceNotificationActionListener: mocks.addVoiceNotificationActionListener,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `token-${++uuidSeed}` }));

let uuidSeed = 0;
const act = TestRenderer.act;
let api: ReturnType<typeof useDictation> | null = null;
let renderer: ReturnType<typeof TestRenderer.create> | null = null;
let appended: string[] = [];
let base = 'hello';
let onData: ((chunk: string) => void) | undefined;

function Harness() {
    api = useDictation(() => base, (text) => appended.push(text));
    return null;
}

function PluginHarness() {
    usePluginEvents();
    return null;
}

/** What the mic button and the Live Activity both read. */
let mutedNow = false;
function MutedHarness() {
    mutedNow = useRealtimeMuted();
    return null;
}

async function renderDictation() {
    await act(async () => {
        renderer = TestRenderer.create(React.createElement(Harness));
    });
    return api!;
}

beforeEach(() => {
    vi.useFakeTimers();
    appended = [];
    base = 'hello';
    onData = undefined;
    mocks.vadStandbyEnabled = false;
    mocks.sessions = {
        'session-a': { id: 'session-a', activeAt: 1, updatedAt: 1 },
        'session-b': { id: 'session-b', activeAt: 2, updatedAt: 2 },
    };
    mocks.permission.mockResolvedValue({ granted: true, canAskAgain: true });
    mocks.liveAudio.init.mockResolvedValue(true);
    mocks.liveAudio.start.mockResolvedValue(true);
    mocks.liveAudio.stop.mockResolvedValue(true);
    mocks.liveAudio.on.mockImplementation((_event: string, listener: (chunk: string) => void) => { onData = listener; });
    mocks.startVoiceService.mockReturnValue(true);
    registerRealtimeNotificationStart(async () => {
        const target = await resolveRealtimeTarget();
        if (target !== null) startRealtimeSession(target);
    });
    // Realtime voice reporting is a product request now, not a plugin call.
    mocks.syncRequest.mockImplementation(async (method: string) => method === 'voice.report'
        ? { say: 'The agent finished.' }
        : { text: 'unused' });
    mocks.voicePending = [];
    mocks.voiceDelivered = [];
    mocks.lifecycleEvents = [];
    mocks.prebaselineLifecycleEvents = [];
    mocks.lifecycleCatalogInitialized = true;
    mocks.lifecycleCatalogAvailable = true;
    mocks.pluginSnapshot = [];
    mutedNow = false;
    mocks.capability.mockReset();
    vi.clearAllMocks();
});

afterEach(() => {
    stopRealtimeSession();
    releaseDictation();
    act(() => renderer?.unmount());
    renderer = null;
    vi.useRealTimers();
});

describe('on-device dictation flow', () => {
    it('shows words while the speaker talks and has the transcript ready on stop', async () => {
        const boundary = new DataView(pcm16ChunksToArrayBuffer([
            Buffer.from([0x00, 0x80, 0xff, 0x7f]).toString('base64'),
        ]));
        expect([boundary.getInt16(0, true), boundary.getInt16(2, true)]).toEqual([-32768, 32767]);

        const speech = Buffer.alloc(2560, 0x11).toString('base64');
        const silence = Buffer.alloc(2560).toString('base64');
        const say = async (seconds: number, chunk = speech) => {
            for (let i = 0; i < seconds * 12.5; i++) {
                onData?.(chunk);
                await vi.advanceTimersByTimeAsync(80);
            }
        };

        const dictation = await renderDictation();
        await act(async () => { dictation.toggle(); });
        await vi.advanceTimersByTimeAsync(0);
        expect(micOwners()).toEqual(['dictation']);
        expect(mocks.liveAudio.init).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 }));

        // Words reach the draft while the speaker is still going. They only
        // ever grow, and a half-heard word the next reading disagrees with
        // never shows.
        await act(async () => { await say(4); });
        const heard = appended.slice();
        expect(heard.length).toBeGreaterThan(1);
        heard.reduce((previous, next) => {
            expect(next.startsWith(previous)).toBe(true);
            return next;
        }, 'hello');
        expect(heard.join(' ')).not.toMatch(/\b(hm|uh|er)\b/);

        // After a pause the last reading already holds everything said, so
        // stopping reads nothing more; replacements still apply.
        await act(async () => { await say(1.5, silence); });
        const readings = mocks.transcribe.mock.calls.length;
        await act(async () => { api!.toggle(); });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.transcribe).toHaveBeenCalledTimes(readings);
        expect(appended.at(-1)).toBe('hello one two three 4 five six seven eight');
        expect(api!.live).toBe('');
        expect(api!.transcribing).toBe(false);
        expect(micOwners()).toEqual([]);

        // Cancelling takes the live words back out of the draft.
        appended = [];
        await act(async () => { api!.toggle(); });
        await vi.advanceTimersByTimeAsync(0);
        await act(async () => { await say(3); });
        expect(appended.at(-1)).not.toBe('hello');
        await act(async () => { api!.cancel(); });
        await vi.advanceTimersByTimeAsync(0);
        expect(appended.at(-1)).toBe('hello');
        expect(api!.recording).toBe(false);
        expect(micOwners()).toEqual([]);
    });

    it('starts notification Talk on the pane last used on the phone, not a stale desk focus', async () => {
        const tree = {
            workspaces: [
                { focused: true, tabs: [{ focused: true, panes: [{ sessionId: 'session-a', focused: true, agentStatus: 'idle' }] }] },
                { focused: false, tabs: [{ focused: true, panes: [{ sessionId: 'session-b', focused: true, agentStatus: 'working' }] }] },
            ],
        };
        mocks.syncRequest.mockImplementation(async (method: string) => method === 'herdr.tree'
            ? tree
            : method === 'session.list' ? [{ id: 'session-a' }, { id: 'session-b' }] : { text: 'unused' });
        const setMuted = vi.fn();
        mocks.startRealtimeSession.mockReturnValue({ stop: vi.fn(), setMuted, speak: vi.fn() });
        await expect(resolveRealtimeTarget()).resolves.toEqual({ machineId: '', sessionId: 'session-b' });

        mocks.notificationAction?.('start');
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.startVoiceService).toHaveBeenCalledOnce();
        expect(mocks.startRealtimeSession).toHaveBeenCalledOnce();

        act(() => { renderer = TestRenderer.create(React.createElement(MutedHarness)); });

        // Android's legacy action carries no state, so it stays a toggle.
        act(() => { mocks.notificationAction?.('mute'); });
        expect(setMuted).toHaveBeenLastCalledWith(true);
        expect(mutedNow).toBe(true);
        act(() => { mocks.notificationAction?.('mute'); });
        expect(setMuted).toHaveBeenLastCalledWith(false);
        expect(mutedNow).toBe(false);

        // The Live Activity sends the state its control was showing. Pressing a
        // stale mute twice must settle on muted, never flip back to an open mic.
        act(() => { mocks.notificationAction?.('mute', true); });
        act(() => { mocks.notificationAction?.('mute', true); });
        expect(setMuted.mock.calls).toEqual([[true], [false], [true]]);
        expect(mutedNow).toBe(true);

        act(() => { mocks.notificationAction?.('mute', false); });
        act(() => { mocks.notificationAction?.('mute', false); });
        expect(setMuted.mock.calls).toEqual([[true], [false], [true], [false]]);
        expect(mutedNow).toBe(false);

        // A supplied generation names the call the control was shown for. The
        // running call's token acts; an empty or foreign one is rejected before
        // any action, and a legacy event without the field still acts.
        const token = mocks.setVoiceGeneration.mock.calls.at(-1)?.[0] as string;
        expect(token).not.toBe('');
        act(() => { mocks.notificationAction?.('mute', true, token); });
        expect(setMuted.mock.calls).toEqual([[true], [false], [true], [false], [true]]);
        act(() => { mocks.notificationAction?.('mute', false, 'a-foreign-token'); });
        act(() => { mocks.notificationAction?.('mute', false, ''); });
        expect(setMuted.mock.calls).toEqual([[true], [false], [true], [false], [true]]);
        act(() => { mocks.notificationAction?.('mute', false, token); });
        expect(setMuted.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]]);

        // After teardown the control is stale: neither form may reopen the
        // microphone or leave a mute flag armed for the next call.
        act(() => { mocks.notificationAction?.('stop'); });
        act(() => { mocks.notificationAction?.('stop'); });
        expect(micOwners()).toEqual([]);
        act(() => { mocks.notificationAction?.('mute', true); });
        expect(mutedNow).toBe(false);
        act(() => { mocks.notificationAction?.('mute'); });
        expect(mutedNow).toBe(false);
        expect(setMuted).toHaveBeenCalledTimes(6);

        // No call is running, so the current token is empty. A control still
        // showing the ended call must not be able to start a new one.
        act(() => { mocks.notificationAction?.('start', undefined, ''); });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.startRealtimeSession).toHaveBeenCalledOnce();

        // Only an explicit start talks; an action this build does not know must
        // not fall through and open a session.
        const raw = mocks.notificationAction as ((action: string) => void) | null;
        act(() => { raw?.('snooze'); });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.startVoiceService).toHaveBeenCalledOnce();
        expect(mocks.startRealtimeSession).toHaveBeenCalledOnce();
        expect(micOwners()).toEqual([]);

        // A stop and a start that React coalesces into one render still rotate
        // the token, so an event queued against the ended call cannot act on the
        // one now running.
        mocks.setVoiceGeneration.mockClear();
        expect(startRealtimeSession('session-a')).toBe(true);
        const older = mocks.setVoiceGeneration.mock.calls.at(-1)?.[0] as string;
        act(() => {
            stopRealtimeSession();
            expect(startRealtimeSession('session-b')).toBe(true);
        });
        const newer = mocks.setVoiceGeneration.mock.calls.at(-1)?.[0] as string;
        expect(mocks.setVoiceGeneration.mock.calls.map((call) => call[0])).toEqual([older, '', newer]);
        expect(newer).not.toBe(older);

        const settled = setMuted.mock.calls.length;
        act(() => { mocks.notificationAction?.('mute', true, older); });
        act(() => { mocks.notificationAction?.('stop', undefined, older); });
        expect(setMuted).toHaveBeenCalledTimes(settled);
        expect(micOwners()).toEqual(['realtime']);
        act(() => { mocks.notificationAction?.('mute', true, newer); });
        expect(setMuted).toHaveBeenCalledTimes(settled + 1);
    });

    it('keeps a newer historical route out of notification voice targeting', async () => {
        mocks.sessions = {
            'live-session': { id: 'live-session', activeAt: 1, updatedAt: 1 },
            'historical-session': { id: 'historical-session', activeAt: 99, updatedAt: 99 },
        };
        mocks.syncRequest.mockImplementation(async (method: string) => method === 'herdr.tree'
            ? { workspaces: [{ focused: true, tabs: [{ focused: true, panes: [{ sessionId: 'live-session', focused: true, agentStatus: 'idle' }] }] }] }
            : method === 'session.list' ? [{ id: 'live-session' }] : { text: 'unused' });

        await expect(resolveRealtimeTarget()).resolves.toEqual({ machineId: '', sessionId: 'live-session' });
        mocks.syncRequest.mockRejectedValue(new Error('fresh route unavailable'));
        await expect(resolveRealtimeTarget()).resolves.toBeNull();
        mocks.syncRequest.mockImplementation(async (method: string) => method === 'herdr.tree'
            ? { workspaces: [{ tabs: [{ panes: [null] }] }] }
            : [{ id: 'live-session' }]);
        await expect(resolveRealtimeTarget()).resolves.toBeNull();
    });

    it('keeps live-session standby enabled and arms it once realtime ends', async () => {
        const live = { stop: vi.fn(), setMuted: vi.fn(), speak: vi.fn() };
        mocks.startRealtimeSession.mockReturnValue(live);
        startRealtimeSession('session-a');
        const provider = mocks.startRealtimeSession.mock.calls[0]![0] as {
            onStatus: (status: 'disconnected', detail?: string) => void;
        };

        await expect(configureVadStandby(true)).resolves.toBe(true);
        await expect(retryVadStandby()).resolves.toBe(false);
        await expect(retryVadStandby()).resolves.toBe(false);
        expect(mocks.vadStandbyEnabled).toBe(true);
        expect(mocks.applyLocalSettings).not.toHaveBeenCalledWith({ vadStandbyEnabled: false });

        provider.onStatus('disconnected', 'ended');
        await vi.waitFor(() => expect(mocks.liveAudio.start).toHaveBeenCalledOnce());
        expect(mocks.vadStandbyEnabled).toBe(true);
        expect(mocks.setVoiceNetworkActive).toHaveBeenLastCalledWith(false);

        // A mute requested while VAD arming still gates the start must reach the
        // transport that opens afterwards, not stop at the JS flag.
        const arming = retryVadStandby();
        expect(startRealtimeSession('session-a')).toBe(true);
        mocks.notificationAction?.('mute', true);
        expect(live.setMuted).not.toHaveBeenCalled();
        await arming;
        await vi.advanceTimersByTimeAsync(0);
        expect(live.setMuted).toHaveBeenCalledWith(true);
        stopRealtimeSession();

        await expect(configureVadStandby(false)).resolves.toBe(true);
        expect(mocks.vadStandbyEnabled).toBe(false);
        mocks.startVoiceService.mockReturnValue(false);
        await expect(configureVadStandby(true)).resolves.toBe(false);
        expect(mocks.vadStandbyEnabled).toBe(false);
    });

    it('retains and serializes prioritized reports until delivery, then sleeps after drain', async () => {
        const first = { stop: vi.fn(), setMuted: vi.fn(), speak: vi.fn() };
        const failed = { stop: vi.fn(), setMuted: vi.fn(), speak: vi.fn() };
        const rearmed = { stop: vi.fn(), setMuted: vi.fn(), speak: vi.fn() };
        const reporting = { stop: vi.fn(), setMuted: vi.fn(), speak: vi.fn() };
        mocks.startRealtimeSession
            .mockReturnValueOnce(first)
            .mockReturnValueOnce(failed)
            .mockReturnValueOnce(rearmed)
            .mockReturnValueOnce(reporting);
        let failFirst!: (error: Error) => void;
        let failVoiceReport = true;
        mocks.syncRequest.mockImplementation(async (method: string, input: { displayName: string; status: string }) => {
            if (method !== 'voice.report') return { text: 'unused' };
            if (failVoiceReport) {
                failVoiceReport = false;
                return new Promise((_resolve, reject) => { failFirst = reject; });
            }
            return { say: `${input.displayName}: ${input.status}` };
        });

        startRealtimeSession('session-a');
        expect(realtimeWatchTarget()).toBe('session-a');
        const provider = mocks.startRealtimeSession.mock.calls[0]![0] as {
            onStatus: (status: 'disconnected', detail?: string) => void;
        };
        provider.onStatus('disconnected', 'ended');

        expect(micOwners()).toEqual([]);
        expect(mocks.stopVoiceService).toHaveBeenCalledOnce();
        expect(realtimeWatchTarget()).toBe('session-a');

        await expect(Promise.all(['timeout', 'error', 'unknown'].map((status) => wakeAndReport({sessionId: status, from: 'working', status, agentName: 'Noah', taskTitle: 'Invalid settlement', eventId: `event:${status}`,})))).rejects.toThrow('Invalid voice report');
        expect(mocks.voicePending).toEqual([]);

        const rejectTail = vi.fn(async () => {
            expect(mocks.voicePending.some((entry) => entry.identity === 'event:three')).toBe(true);
            throw new Error('tail unavailable');
        });
        const reportsDone = Promise.all([
            wakeAndReport({sessionId: 'one', from: 'working', status: 'done', agentName: 'Alex', taskTitle: 'Ship one', eventId: 'event:one'}),
            wakeAndReport({sessionId: 'two', from: 'working', status: 'done', agentName: 'Bea', taskTitle: 'Ship two', eventId: 'event:two'}),
            wakeAndReport({sessionId: 'three', from: 'working', status: 'blocked', agentName: 'Cara', taskTitle: 'Unblock three', eventId: 'event:three', loadTail: rejectTail}),
            wakeAndReport({sessionId: 'one', from: 'working', status: 'done', agentName: 'Alex', taskTitle: 'Ship one', eventId: 'event:one'}),
        ]);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.startRealtimeSession).toHaveBeenCalledTimes(2);
        expect(mocks.startRealtimeSession.mock.calls[1]![0]).toMatchObject({ target: { sessionId: 'three' } });
        expect(mocks.voiceReports()).toHaveLength(1);
        expect(mocks.voiceReports()[0]![1]).toEqual({
            displayName: 'Cara', taskTitle: 'Unblock three', status: 'blocked', outcome: 'blocked',
        });
        expect(rejectTail).toHaveBeenCalledOnce();
        expect(failed.speak).not.toHaveBeenCalled();

        stopRealtimeSession();
        failFirst(new Error('provider unavailable'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(mocks.startRealtimeSession).toHaveBeenCalledTimes(2);
        expect(mocks.voiceReports()).toHaveLength(1);

        // A later legitimate watch activation resumes retained work without resubmission.
        startRealtimeSession('session-a');
        const rearmProvider = mocks.startRealtimeSession.mock.calls[2]![0] as {
            onStatus: (status: 'connected' | 'thinking' | 'speaking' | 'disconnected', detail?: string) => void;
        };
        rearmProvider.onStatus('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.startRealtimeSession).toHaveBeenCalledTimes(3);
        expect(mocks.voiceReports()).toHaveLength(2);

        expect(rearmed.speak).toHaveBeenLastCalledWith('Cara: blocked');
        // Thinking then connected is a complete no-audio response.
        rearmProvider.onStatus('thinking');
        rearmProvider.onStatus('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(rearmed.speak).toHaveBeenLastCalledWith('Alex: done');

        rearmProvider.onStatus('speaking');
        rearmProvider.onStatus('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(rearmed.speak).toHaveBeenLastCalledWith('Bea: done');

        rearmProvider.onStatus('speaking');
        rearmProvider.onStatus('connected');
        await vi.advanceTimersByTimeAsync(0);
        await reportsDone;
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.voiceReports().map((call) => (call[1] as { displayName: string }).displayName)).toEqual(['Cara', 'Cara', 'Alex', 'Bea']);
        expect(rearmed.speak.mock.calls.map((call) => call[0])).toEqual(['Cara: blocked', 'Alex: done', 'Bea: done']);
        expect(rearmed.stop).not.toHaveBeenCalled();
        cancelRealtimeReportWait(realtimeGeneration());
        expect(rearmed.stop).not.toHaveBeenCalled();

        // Once that user-owned conversation ends, a new cold report owns one final sleep.
        rearmProvider.onStatus('disconnected', 'ended');
        const finalReport = wakeAndReport({sessionId: 'four', from: 'working', status: 'failed', agentName: 'Dana', taskTitle: 'Repair four', eventId: 'event:four'});
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.startRealtimeSession).toHaveBeenCalledTimes(4);
        expect(mocks.startRealtimeSession.mock.calls[3]![0]).toMatchObject({ target: { sessionId: 'four' } });
        const reportProvider = mocks.startRealtimeSession.mock.calls[3]![0] as {
            onStatus: (status: 'connected' | 'thinking') => void;
        };
        reportProvider.onStatus('connected');
        reportProvider.onStatus('thinking');
        reportProvider.onStatus('connected');
        await vi.advanceTimersByTimeAsync(0);
        await finalReport;
        await vi.advanceTimersByTimeAsync(0);
        expect(reporting.stop).toHaveBeenCalledOnce();
        expect(micOwners()).toEqual([]);
        expect(realtimeWatchTarget()).toBe('four');

        stopRealtimeSession();
        expect(realtimeWatchTarget()).toBeNull();

        const working = {
            eventId: 'observer-working', sessionId: 'session-a', state: 'working',
            agentName: 'Elle', taskTitle: 'Retry queued report',
        };
        const otherWorking = { ...working, eventId: 'observer-other-working', sessionId: 'session-b' };
        mocks.lifecycleEvents = [otherWorking, working];
        mocks.pluginSnapshot = [{
            summary: { pluginId: 'voice', manifestHash: 'hash' },
            manifest: { contributions: [{
                slot: 'events', id: 'report', from: 'working', to: ['done'],
                action: { type: 'capability', name: 'speech.wake' },
            }] },
        }];
        let fullAttempts = 0;
        let deferredAttempts = 0;
        let finishOld!: () => void;
        let finishNew!: () => void;
        mocks.capability.mockImplementation((input: { eventId: string }) => {
            if (input.eventId === 'observer-done') {
                fullAttempts += 1;
                return fullAttempts === 1
                    ? Promise.reject(Object.assign(new Error('queue full'), { retryable: true }))
                    : Promise.resolve();
            }
            if (input.eventId === 'observer-invalid') {
                return Promise.reject(Object.assign(new Error('invalid credential'), { retryable: false }));
            }
            if (input.eventId === 'observer-deferred') {
                deferredAttempts += 1;
                return new Promise<void>((resolve) => {
                    if (deferredAttempts === 1) finishOld = resolve;
                    else finishNew = resolve;
                });
            }
            return Promise.resolve();
        });
        const notifyObserver = () => {
            const observerState = {
                lifecycleEvents: mocks.lifecycleEvents,
                prebaselineLifecycleEvents: mocks.prebaselineLifecycleEvents,
                sessions: mocks.sessions,
                lifecycleCatalogInitialized: mocks.lifecycleCatalogInitialized,
                lifecycleCatalogAvailable: mocks.lifecycleCatalogAvailable,
                voicePendingReports: mocks.voicePending,
                voiceReportScopeGeneration: 1,
            };
            for (const listener of mocks.storageListeners) listener(observerState, observerState);
        };
        act(() => { renderer = TestRenderer.create(React.createElement(PluginHarness)); });
        mocks.lifecycleEvents = [{ ...working, eventId: 'observer-done', state: 'done' }, otherWorking, working];
        notifyObserver();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(fullAttempts).toBe(1);

        // The rejected transition remains retryable after falling out of the
        // bounded lifecycle catalog; a permanent invalid event is tried once.
        const newer = Array.from({ length: 50 }, (_, index) => ({
            ...working, eventId: `observer-newer-${index}`, sessionId: `newer-${index}`,
        }));
        mocks.lifecycleEvents = [{ ...otherWorking, eventId: 'observer-invalid', state: 'done', taskTitle: 'password=secret' }, ...newer];
        notifyObserver();
        await vi.advanceTimersByTimeAsync(1_500);
        await vi.advanceTimersByTimeAsync(1_500);
        expect(mocks.capability.mock.calls.filter(([input]) => input.eventId === 'observer-done')).toHaveLength(2);
        expect(mocks.capability.mock.calls.filter(([input]) => input.eventId === 'observer-invalid')).toHaveLength(1);
        expect(mocks.capability).toHaveBeenCalledWith(expect.objectContaining({
            eventId: 'observer-done', from: 'working', status: 'done',
        }));

        // A callback from the old scope cannot acknowledge or clear the same
        // canonical action after the observer establishes a new epoch.
        mocks.lifecycleEvents = [];
        mocks.lifecycleCatalogAvailable = false;
        notifyObserver();
        mocks.lifecycleEvents = [working];
        mocks.lifecycleCatalogAvailable = true;
        notifyObserver();
        mocks.lifecycleEvents = [{ ...working, eventId: 'observer-deferred', state: 'done' }, working];
        await vi.advanceTimersByTimeAsync(1_500);
        expect(deferredAttempts).toBe(1);
        mocks.lifecycleEvents = [];
        mocks.lifecycleCatalogAvailable = false;
        notifyObserver();
        mocks.lifecycleEvents = [{ ...working, eventId: 'observer-deferred', state: 'done' }, working];
        mocks.prebaselineLifecycleEvents = [mocks.lifecycleEvents[0]!];
        notifyObserver();
        mocks.lifecycleCatalogAvailable = true;
        notifyObserver();
        expect(deferredAttempts).toBe(2);
        finishOld();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(deferredAttempts).toBe(2);
        finishNew();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(deferredAttempts).toBe(2);
    });

    it('speaks an agent-stop report only while realtime watching is active', async () => {
        const notifyObserver = () => {
            const observerState = {
                lifecycleEvents: mocks.lifecycleEvents,
                prebaselineLifecycleEvents: mocks.prebaselineLifecycleEvents,
                sessions: mocks.sessions,
                lifecycleCatalogInitialized: mocks.lifecycleCatalogInitialized,
                lifecycleCatalogAvailable: mocks.lifecycleCatalogAvailable,
                voicePendingReports: mocks.voicePending,
                voiceReportScopeGeneration: 1,
            };
            for (const listener of mocks.storageListeners) listener(observerState, observerState);
        };
        act(() => { renderer = TestRenderer.create(React.createElement(PluginHarness)); });
        const working = { eventId: 'settle-working', sessionId: 'session-a', state: 'working', agentName: 'Nia', taskTitle: 'Ship the report' };
        const settled = (eventId: string) => ({ ...working, eventId, state: 'done' });
        const reported = (eventId: string) => mocks.voicePending.some((entry) => entry.identity === eventId)
            || mocks.voiceDelivered.includes(eventId);

        mocks.lifecycleEvents = [working];
        notifyObserver();
        await vi.advanceTimersByTimeAsync(1_500);
        mocks.lifecycleEvents = [settled('settle-idle-done'), working];
        notifyObserver();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(reported('settle-idle-done')).toBe(false);

        startRealtimeSession('session-a');
        const activeWorking = { ...working, eventId: 'settle-active-working' };
        mocks.lifecycleEvents = [activeWorking];
        notifyObserver();
        await vi.advanceTimersByTimeAsync(1_500);
        mocks.lifecycleEvents = [settled('settle-active-done'), activeWorking];
        notifyObserver();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(reported('settle-active-done')).toBe(true);
    });

    it('releases ownership when the native recorder cannot start', async () => {
        mocks.liveAudio.start.mockRejectedValue(new Error('No audio input device'));
        const dictation = await renderDictation();
        await act(async () => { dictation.toggle(); });
        await vi.advanceTimersByTimeAsync(0);

        expect(mocks.modalAlert).toHaveBeenCalledWith('Dictation failed', 'Could not start recording.');
        expect(micOwners()).toEqual([]);
    });

    it('does not claim the mic when permission is denied and blocks Realtime while dictating', async () => {
        mocks.permission.mockResolvedValue({ granted: false, canAskAgain: false });
        const dictation = await renderDictation();
        await act(async () => { dictation.toggle(); });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.showDenied).toHaveBeenCalledWith(false);
        expect(micOwners()).toEqual([]);

        mocks.permission.mockResolvedValue({ granted: true, canAskAgain: true });
        await act(async () => { dictation.toggle(); });
        await vi.advanceTimersByTimeAsync(0);
        startRealtimeSession('session-a');
        expect(mocks.startRealtimeSession).not.toHaveBeenCalled();
        expect(micOwners()).toEqual(['dictation']);
    });

    it('coalesces duplicate taps into one local transcription', async () => {
        const dictation = await renderDictation();
        await act(async () => {
            dictation.toggle();
            dictation.toggle();
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.liveAudio.start).toHaveBeenCalledOnce();

        onData?.(Buffer.alloc(2560).toString('base64'));
        await vi.advanceTimersByTimeAsync(500);
        await act(async () => {
            api!.toggle();
            api!.toggle();
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.liveAudio.stop).toHaveBeenCalledOnce();
        expect(api!.transcribing).toBe(false);
    });
});
