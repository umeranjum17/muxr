import * as React from 'react';
import { Platform } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { Modal } from '@/modal';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { claimDictation, releaseDictation } from '@/conversation/session';
import { voiceDiagnostic } from '@/conversation/diagnostics';
import { appendTranscript } from '@/utils/transcription';
import { startLiveTranscription, type LiveTranscription } from '@/utils/localTranscription';

// Put `spoken` where the last live words were, keeping anything typed before them.
function replaceSpoken(draft: string, shown: string, spoken: string): string {
    const trimmed = draft.trimEnd();
    const stem = shown && trimmed.endsWith(shown) ? trimmed.slice(0, trimmed.length - shown.length) : draft;
    return spoken ? appendTranscript(stem, spoken) : stem.trimEnd();
}

// Below this a recording is a mis-tap, not speech.
const MIN_RECORDING_MS = 400;

// How long a cancelled transcription can still be taken back. The reading
// keeps going underneath, so Undo returns the whole transcript, not a part.
export const DICTATION_UNDO_MS = 5000;

export function useDictation(getText: () => string, setText: (text: string) => void, hint?: string) {
    const [recording, setRecording] = React.useState(false);
    const [transcribing, setTranscribing] = React.useState(false);
    // A reanimated shared value, not state: the level changes ~12 times a
    // second while recording, and only the bars that read it may re-render.
    const level = useSharedValue(0);
    // Words heard so far, while the microphone is live and until the final
    // reading lands. They are also written into the draft as they settle.
    const [live, setLive] = React.useState('');
    const [pending, setPending] = React.useState<string | null>(null);
    const [finished, setFinished] = React.useState<string | null>(null);
    // A cancelled transcription waiting out its undo window.
    const [discarded, setDiscarded] = React.useState(false);
    const discardRef = React.useRef<{ timer: ReturnType<typeof setTimeout>; heard: string; text: string | null } | null>(null);
    const startedAtRef = React.useRef(0);
    const stoppingRef = React.useRef(false);
    const sessionRef = React.useRef<LiveTranscription | null>(null);
    const shownRef = React.useRef('');
    const transcriptionRef = React.useRef<AbortController | null>(null);
    const sinkRef = React.useRef({ getText, setText, hint });
    sinkRef.current = { getText, setText, hint };

    const showSpoken = React.useCallback((spoken: string) => {
        setLive(spoken);
        if (spoken === shownRef.current) return;
        const { getText, setText } = sinkRef.current;
        setText(replaceSpoken(getText(), shownRef.current, spoken));
        shownRef.current = spoken;
    }, []);

    React.useEffect(() => () => {
        if (discardRef.current !== null) clearTimeout(discardRef.current.timer);
        transcriptionRef.current?.abort();
        const session = sessionRef.current;
        sessionRef.current = null;
        if (session === null) return;
        session.cancel();
        releaseDictation();
    }, []);

    const start = React.useCallback(async () => {
        if (Platform.OS === 'web') {
            Modal.alert('Dictation unavailable', 'On-device dictation is available in the Android and iOS apps.');
            return;
        }

        voiceDiagnostic('permission.begin');
        let permission;
        try {
            permission = await requestMicrophonePermission();
        } finally {
            voiceDiagnostic('permission.end');
        }
        if (!permission.granted) {
            showMicrophonePermissionDeniedAlert(permission.canAskAgain);
            return;
        }

        voiceDiagnostic('dictation.claim.begin');
        const claim = await claimDictation().finally(() => voiceDiagnostic('dictation.claim.end'));
        if (claim === 'already') return;
        if (claim === 'busy') {
            Modal.alert('Voice session active', 'End the voice session first.');
            return;
        }

        const controller = new AbortController();
        transcriptionRef.current = controller;
        shownRef.current = '';
        setLive('');
        setPending(null);
        setFinished(null);
        try {
            sessionRef.current = await startLiveTranscription({
                hint: sinkRef.current.hint,
                onLevel: (value) => { level.value = value; },
                onText: (spoken) => { if (!controller.signal.aborted) showSpoken(spoken); },
            });
            startedAtRef.current = Date.now();
            setRecording(true);
        } catch (error) {
            releaseDictation();
            console.error('Failed to start recording:', error);
            Modal.alert('Dictation failed', 'Could not start recording.');
        }
    }, [showSpoken]);

    const stop = React.useCallback(async () => {
        const session = sessionRef.current;
        if (!recording || stoppingRef.current || session === null) return;
        stoppingRef.current = true;
        sessionRef.current = null;
        setRecording(false);
        level.value = 0;
        const elapsed = Date.now() - startedAtRef.current;
        const signal = transcriptionRef.current?.signal;
        if (signal?.aborted || elapsed < MIN_RECORDING_MS) {
            session.cancel();
            releaseDictation();
            showSpoken('');
            stoppingRef.current = false;
            return;
        }

        setTranscribing(true);
        const cancel = () => session.cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            const text = await session.finish().finally(releaseDictation);
            if (signal?.aborted) return;
            if (discardRef.current !== null) {
                discardRef.current.text = text;
                return;
            }
            showSpoken(text);
            if (text) setPending(text);
            setFinished(null);
        } catch (error) {
            if (!signal?.aborted) {
                console.error('Transcription failed:', error);
                Modal.alert('Dictation failed', error instanceof Error ? error.message : 'Could not transcribe audio.');
            }
        } finally {
            signal?.removeEventListener('abort', cancel);
            if (signal?.aborted) showSpoken('');
            shownRef.current = '';
            setLive('');
            setTranscribing(false);
            stoppingRef.current = false;
        }
    }, [recording, showSpoken]);

    const toggle = React.useCallback(() => {
        voiceDiagnostic('dictate.tap');
        if (transcribing || stoppingRef.current) return;
        void (recording ? stop() : start());
    }, [recording, start, stop, transcribing]);

    const cancel = React.useCallback(() => {
        if (recording) {
            transcriptionRef.current?.abort();
            void stop();
            return;
        }
        if (!stoppingRef.current || discardRef.current !== null) return;
        // Take the words out of the draft now, but let the reading finish so
        // an Undo inside the window can put all of it back.
        const heard = shownRef.current;
        const controller = transcriptionRef.current;
        const timer = setTimeout(() => {
            discardRef.current = null;
            setDiscarded(false);
            controller?.abort();
        }, DICTATION_UNDO_MS);
        discardRef.current = { timer, heard, text: null };
        showSpoken('');
        setDiscarded(true);
    }, [recording, stop, showSpoken]);

    const undoCancel = React.useCallback(() => {
        const held = discardRef.current;
        if (held === null) return;
        clearTimeout(held.timer);
        discardRef.current = null;
        setDiscarded(false);
        if (held.text === null) {
            // Still reading: show what was heard; the final reading replaces it.
            showSpoken(held.heard);
            return;
        }
        showSpoken(held.text);
        shownRef.current = '';
        if (held.text) setPending(held.text);
    }, [showSpoken]);

    const accept = React.useCallback(() => {
        if (pending === null) return;
        setFinished(pending);
        setPending(null);
    }, [pending]);

    const discard = React.useCallback(() => {
        if (pending === null) return;
        const wanted = pending;
        setPending(null);
        setFinished(null);
        try {
            const current = sinkRef.current.getText();
            const trimmedEnd = current.trimEnd();
            if (trimmedEnd.endsWith(wanted)) {
                sinkRef.current.setText(trimmedEnd.slice(0, trimmedEnd.length - wanted.length).trimEnd());
            }
        } catch {
        }
    }, [pending]);

    const clearFinished = React.useCallback(() => {
        setFinished(null);
    }, []);

    return { recording, transcribing, discarded, level, live, pending, finished, accept, discard, clearFinished, toggle, cancel, undoCancel };
}
