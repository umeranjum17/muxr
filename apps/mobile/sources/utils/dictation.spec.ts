import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { useDictation } from './dictation';
import { pcm16ChunksToArrayBuffer } from './transcription';
import { wakeAndReport } from '../voice/wakeAndReport';
import { micOwners, realtimeWatchTarget, registerRealtimeNotificationStart, releaseDictation, resolveRealtimeTarget, startRealtimeSession, stopRealtimeSession } from '../realtime/realtimeSessionState';

const mocks = vi.hoisted(() => ({
    sessions: {} as Record<string, { id: string; activeAt: number; updatedAt: number }>,
    modalAlert: vi.fn(),
    permission: vi.fn(),
    showDenied: vi.fn(),
    liveAudio: { init: vi.fn(), start: vi.fn(), stop: vi.fn(), on: vi.fn() },
    transcribe: vi.fn(),
    startRealtimeSession: vi.fn(),
    startVoiceService: vi.fn(),
    stopVoiceService: vi.fn(),
    notificationAction: null as ((action: 'start' | 'stop' | 'mute') => void) | null,
    addVoiceNotificationActionListener: vi.fn((listener: (action: 'start' | 'stop' | 'mute') => void) => {
        mocks.notificationAction = listener;
        return { remove: () => undefined };
    }),
    syncRequest: vi.fn(),
    callPlugin: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('react-native-live-audio-stream', () => ({ default: mocks.liveAudio }));
vi.mock('@/utils/localTranscription', () => ({ transcribePcm16: mocks.transcribe }));
vi.mock('@/sync/sync', () => ({ sync: { request: mocks.syncRequest } }));
vi.mock('@/plugins/callPlugin', () => ({ callPlugin: mocks.callPlugin }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.modalAlert } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: mocks.sessions }) } }));
vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: mocks.permission,
    showMicrophonePermissionDeniedAlert: mocks.showDenied,
}));
vi.mock('../voice/realtimeSession', () => ({ startRealtimeSession: mocks.startRealtimeSession }));
vi.mock('@/../modules/voice-overlay', () => ({
    startVoiceService: mocks.startVoiceService,
    stopVoiceService: mocks.stopVoiceService,
    addVoiceNotificationActionListener: mocks.addVoiceNotificationActionListener,
}));

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
    mocks.sessions = {
        'session-a': { id: 'session-a', activeAt: 1, updatedAt: 1 },
        'session-b': { id: 'session-b', activeAt: 2, updatedAt: 2 },
    };
    mocks.permission.mockResolvedValue({ granted: true, canAskAgain: true });
    mocks.liveAudio.init.mockResolvedValue(true);
    mocks.liveAudio.start.mockResolvedValue(true);
    mocks.liveAudio.stop.mockResolvedValue(true);
    mocks.liveAudio.on.mockImplementation((_event: string, listener: (chunk: string) => void) => { onData = listener; });
    mocks.transcribe.mockResolvedValue('world');
    mocks.startVoiceService.mockReturnValue(true);
    registerRealtimeNotificationStart(async () => {
        const target = await resolveRealtimeTarget();
        if (target !== null) startRealtimeSession(target);
    });
    mocks.syncRequest.mockResolvedValue({ text: 'unused' });
    mocks.callPlugin.mockResolvedValue({ say: 'The agent finished.' });
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
    it('captures PCM, transcribes locally, and releases the microphone', async () => {
        const boundary = new DataView(pcm16ChunksToArrayBuffer([
            Buffer.from([0x00, 0x80, 0xff, 0x7f]).toString('base64'),
        ]));
        expect([boundary.getInt16(0, true), boundary.getInt16(2, true)]).toEqual([-32768, 32767]);

        const dictation = await renderDictation();
        await act(async () => { dictation.toggle(); });
        await vi.advanceTimersByTimeAsync(0);
        expect(micOwners()).toEqual(['dictation']);
        expect(mocks.liveAudio.init).toHaveBeenCalledWith(expect.objectContaining({
            sampleRate: 16_000,
            channels: 1,
            bitsPerSample: 16,
        }));

        const pcm = Buffer.alloc(2560).toString('base64');
        onData?.(pcm);
        await vi.advanceTimersByTimeAsync(500);
        await act(async () => { api!.toggle(); });
        await vi.advanceTimersByTimeAsync(0);

        expect(mocks.transcribe).toHaveBeenCalledWith([pcm], undefined);
        expect(appended).toEqual(['hello world']);
        expect(micOwners()).toEqual([]);
    });

    it('starts notification Talk on the pane last used on the phone, not a stale desk focus', async () => {
        mocks.syncRequest.mockResolvedValue({
            workspaces: [
                { focused: true, tabs: [{ focused: true, panes: [{ sessionId: 'session-a', focused: true, agentStatus: 'idle' }] }] },
                { focused: false, tabs: [{ focused: true, panes: [{ sessionId: 'session-b', focused: true, agentStatus: 'working' }] }] },
            ],
        });
        const setMuted = vi.fn();
        mocks.startRealtimeSession.mockReturnValue({ stop: vi.fn(), setMuted, speak: vi.fn() });
        await expect(resolveRealtimeTarget()).resolves.toBe('session-b');

        mocks.notificationAction?.('start');
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.startVoiceService).toHaveBeenCalledOnce();
        expect(mocks.startRealtimeSession).toHaveBeenCalledOnce();

        mocks.notificationAction?.('mute');
        expect(setMuted).toHaveBeenCalledWith(true);
    });

    it('disconnects the sleeping provider, keeps watching locally, and wakes once to report completion', async () => {
        const first = { stop: vi.fn(), setMuted: vi.fn(), speak: vi.fn() };
        const woken = { stop: vi.fn(), setMuted: vi.fn(), speak: vi.fn() };
        mocks.startRealtimeSession.mockReturnValueOnce(first).mockReturnValueOnce(woken);

        startRealtimeSession('session-a');
        expect(realtimeWatchTarget()).toBe('session-a');
        const provider = mocks.startRealtimeSession.mock.calls[0]![0] as {
            onStatus: (status: 'disconnected', detail?: string) => void;
        };
        provider.onStatus('disconnected', 'ended');

        expect(micOwners()).toEqual([]);
        expect(mocks.stopVoiceService).toHaveBeenCalledOnce();
        expect(realtimeWatchTarget()).toBe('session-a');

        await wakeAndReport({ sessionId: 'session-a', status: 'done', pane: 'finished cleanly' });
        expect(mocks.startRealtimeSession).toHaveBeenCalledTimes(2);
        expect(mocks.callPlugin).toHaveBeenCalledWith('voice.report', { status: 'done', pane: 'finished cleanly' });
        expect(woken.speak).toHaveBeenCalledWith('The agent finished.');

        stopRealtimeSession();
        expect(woken.stop).toHaveBeenCalledOnce();
        expect(realtimeWatchTarget()).toBeNull();
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
        expect(mocks.transcribe).toHaveBeenCalledOnce();
    });
});
