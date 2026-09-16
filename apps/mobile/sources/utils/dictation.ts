import * as React from 'react';
import { Platform } from 'react-native';
import LiveAudioStream from 'react-native-live-audio-stream';
import { Modal } from '@/modal';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { claimDictation, releaseDictation } from '@/conversation/session';
import { voiceDiagnostic } from '@/conversation/diagnostics';
import { Buffer } from 'buffer';
import { appendTranscript } from '@/utils/transcription';
import { transcribePcm16 } from '@/utils/localTranscription';

const stopRecorder = async () => { await LiveAudioStream.stop(); };

// Below this a recording is a mis-tap, not speech.
const MIN_RECORDING_MS = 400;

/** Real input level from the PCM chunks already flowing to Whisper; no extra capture. */
function rmsLevel(chunk: string): number {
    const buf = Buffer.from(chunk, 'base64');
    const samples = Math.floor(buf.length / 2);
    if (samples === 0) return 0;
    const step = Math.max(1, Math.floor(samples / 64));
    let sum = 0;
    let count = 0;
    for (let i = 0; i < samples; i += step) {
        const s = buf.readInt16LE(i * 2) / 32768;
        sum += s * s;
        count += 1;
    }
    return Math.min(1, Math.sqrt(sum / count) * 4);
}

export function useDictation(getText: () => string, setText: (text: string) => void, hint?: string) {
    const [recording, setRecording] = React.useState(false);
    const [transcribing, setTranscribing] = React.useState(false);
    const [level, setLevel] = React.useState(0);
    const [pending, setPending] = React.useState<string | null>(null);
    const [finished, setFinished] = React.useState<string | null>(null);
    const startedAtRef = React.useRef(0);
    const stoppingRef = React.useRef(false);
    const recordingRef = React.useRef(false);
    const chunksRef = React.useRef<string[]>([]);
    const sinkRef = React.useRef({ getText, setText, hint });
    sinkRef.current = { getText, setText, hint };

    React.useEffect(() => () => {
        if (!recordingRef.current) return;
        recordingRef.current = false;
        void stopRecorder().catch(() => undefined).finally(releaseDictation);
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

        try {
            chunksRef.current = [];
            setPending(null);
            setFinished(null);
            await LiveAudioStream.init({
                sampleRate: 16_000,
                channels: 1,
                bitsPerSample: 16,
                audioSource: 6,
                bufferSize: 2560,
                wavFile: '',
            });
            LiveAudioStream.on('data', (chunk) => {
                if (!recordingRef.current) return;
                chunksRef.current.push(chunk);
                setLevel(rmsLevel(chunk));
            });
            recordingRef.current = true;
            await LiveAudioStream.start();
            startedAtRef.current = Date.now();
            setRecording(true);
        } catch (error) {
            recordingRef.current = false;
            await stopRecorder().catch(() => undefined);
            releaseDictation();
            console.error('Failed to start recording:', error);
            Modal.alert('Dictation failed', 'Could not start recording.');
        }
    }, []);

    const stop = React.useCallback(async () => {
        if (!recording || stoppingRef.current) return;
        stoppingRef.current = true;
        recordingRef.current = false;
        setRecording(false);
        setLevel(0);
        const elapsed = Date.now() - startedAtRef.current;

        try {
            await stopRecorder();
        } catch (error) {
            console.error('Failed to stop recording:', error);
            releaseDictation();
            stoppingRef.current = false;
            return;
        }
        releaseDictation();

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (elapsed < MIN_RECORDING_MS || chunks.length === 0) {
            stoppingRef.current = false;
            return;
        }

        setTranscribing(true);
        try {
            const { getText, setText, hint } = sinkRef.current;
            const text = await transcribePcm16(chunks, hint);
            const trimmed = (text ?? '').trim();
            if (trimmed) {
                setText(appendTranscript(getText(), trimmed));
                setPending(trimmed);
                setFinished(null);
            }
        } catch (error) {
            console.error('Transcription failed:', error);
            Modal.alert('Dictation failed', error instanceof Error ? error.message : 'Could not transcribe audio.');
        } finally {
            setTranscribing(false);
            stoppingRef.current = false;
        }
    }, [recording]);

    const toggle = React.useCallback(() => {
        voiceDiagnostic('dictate.tap');
        if (transcribing) return;
        void (recording ? stop() : start());
    }, [recording, start, stop, transcribing]);

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

    return { recording, transcribing, level, pending, finished, accept, discard, clearFinished, toggle };
}
