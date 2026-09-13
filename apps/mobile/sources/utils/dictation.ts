import * as React from 'react';
import { Platform } from 'react-native';
import LiveAudioStream from 'react-native-live-audio-stream';
import { Buffer } from 'buffer';
import { create } from 'zustand';
import { Modal } from '@/modal';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { claimDictation, releaseDictation } from '@/conversation/session';
import { voiceDiagnostic } from '@/conversation/diagnostics';
import { appendTranscript } from '@/utils/transcription';
import { transcribePcm16 } from '@/utils/localTranscription';
import { WEB_SPEECH_UNSUPPORTED, startWebSpeechDictation, webSpeechDictationSupported } from '@/utils/webSpeechDictation';

const stopRecorder = async () => { await LiveAudioStream.stop(); };

// Below this a recording is a mis-tap, not speech.
const MIN_RECORDING_MS = 400;
// The status strip re-renders on every level push; chunk rate (~12 Hz) is its animation frame.
const LEVEL_PUSH_MS = 100;

interface DictationStatus {
    recording: boolean;
    transcribing: boolean;
    /** Smoothed input level 0..1. Native only; the browser path leaves it at the floor. */
    level: number;
}

/**
 * Presentation state for the composer's voice path, shared by the dictate
 * button and the listening strip above the composer. The hook below stays
 * the only writer; the transport (recorder, whisper, browser recognition)
 * is untouched by who reads this.
 */
export const useDictationStatus = create<DictationStatus>(() => ({ recording: false, transcribing: false, level: 0 }));

/** RMS of one base64 PCM16 chunk, gained so speech reads mid-scale. */
function chunkLevel(chunk: string): number {
    try {
        const bytes = Buffer.from(chunk, 'base64');
        const count = Math.floor(bytes.length / 2);
        if (count === 0) return 0;
        let sum = 0;
        for (let index = 0; index < count; index += 1) {
            const sample = bytes.readInt16LE(index * 2) / 32768;
            sum += sample * sample;
        }
        return Math.min(1, Math.sqrt(sum / count) * 3);
    } catch {
        return 0;
    }
}

export function useDictation(getText: () => string, setText: (text: string) => void, hint?: string) {
    const [recording, setRecording] = React.useState(false);
    const [transcribing, setTranscribing] = React.useState(false);
    const startedAtRef = React.useRef(0);
    const stoppingRef = React.useRef(false);
    const recordingRef = React.useRef(false);
    const chunksRef = React.useRef<string[]>([]);
    const sinkRef = React.useRef({ getText, setText, hint });
    sinkRef.current = { getText, setText, hint };
    const webSpeechRef = React.useRef<{ stop: () => void } | undefined>(undefined);
    const levelRef = React.useRef(0);
    const levelPushedAtRef = React.useRef(0);

    // The strip reads the store; the hook's own return shape is unchanged.
    const pushLevel = React.useCallback((level: number) => {
        const now = Date.now();
        if (now - levelPushedAtRef.current < LEVEL_PUSH_MS) return;
        levelPushedAtRef.current = now;
        useDictationStatus.setState({ level });
    }, []);

    React.useEffect(() => () => {
        if (!recordingRef.current) return;
        recordingRef.current = false;
        useDictationStatus.setState({ recording: false, transcribing: false, level: 0 });
        if (Platform.OS === 'web') {
            webSpeechRef.current?.stop();
            webSpeechRef.current = undefined;
            releaseDictation();
            return;
        }
        void stopRecorder().catch(() => undefined).finally(releaseDictation);
    }, []);

    const start = React.useCallback(async () => {
        if (Platform.OS === 'web') {
            // Progressive enhancement: the browser's own recognition edits the
            // draft. No host, no provider, no realtime session involved.
            if (!webSpeechDictationSupported()) {
                Modal.alert('Dictation unavailable', WEB_SPEECH_UNSUPPORTED);
                return;
            }
            const claim = await claimDictation();
            if (claim === 'already') return;
            if (claim === 'busy') {
                Modal.alert('Voice session active', 'End the voice session first.');
                return;
            }
            try {
                webSpeechRef.current = startWebSpeechDictation({
                    onFinal: (text) => { const { getText, setText } = sinkRef.current; setText(appendTranscript(getText(), text)); },
                    onEnd: () => {
                        if (!recordingRef.current) return;
                        recordingRef.current = false;
                        webSpeechRef.current = undefined;
                        setRecording(false);
                        useDictationStatus.setState({ recording: false, level: 0 });
                        releaseDictation();
                    },
                    onError: (message) => { Modal.alert('Dictation stopped', message); },
                });
                recordingRef.current = true;
                startedAtRef.current = Date.now();
                setRecording(true);
                levelRef.current = 0;
                useDictationStatus.setState({ recording: true, transcribing: false, level: 0 });
            } catch (error) {
                releaseDictation();
                Modal.alert('Dictation failed', error instanceof Error ? error.message : WEB_SPEECH_UNSUPPORTED);
            }
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
                // Smooth the input level for the listening bars; the strip reads it live.
                levelRef.current += (chunkLevel(chunk) - levelRef.current) * 0.35;
                pushLevel(levelRef.current);
            });
            recordingRef.current = true;
            await LiveAudioStream.start();
            startedAtRef.current = Date.now();
            setRecording(true);
            levelRef.current = 0;
            useDictationStatus.setState({ recording: true, transcribing: false, level: 0 });
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
        if (Platform.OS === 'web') {
            // Stopping lets the final result land through onresult, then onend releases.
            webSpeechRef.current?.stop();
            return;
        }
        stoppingRef.current = true;
        recordingRef.current = false;
        setRecording(false);
        // The level stays where it was: the transcribing strip freezes the
        // bars on this snapshot instead of collapsing them.
        useDictationStatus.setState({ recording: false });
        const elapsed = Date.now() - startedAtRef.current;

        try {
            await stopRecorder();
        } catch (error) {
            console.error('Failed to stop recording:', error);
            releaseDictation();
            stoppingRef.current = false;
            useDictationStatus.setState({ level: 0 });
            return;
        }
        releaseDictation();

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (elapsed < MIN_RECORDING_MS || chunks.length === 0) {
            stoppingRef.current = false;
            useDictationStatus.setState({ level: 0 });
            return;
        }

        setTranscribing(true);
        useDictationStatus.setState({ transcribing: true });
        try {
            const { getText, setText, hint } = sinkRef.current;
            const text = await transcribePcm16(chunks, hint);
            if (text) setText(appendTranscript(getText(), text));
        } catch (error) {
            console.error('Transcription failed:', error);
            Modal.alert('Dictation failed', error instanceof Error ? error.message : 'Could not transcribe audio.');
        } finally {
            setTranscribing(false);
            stoppingRef.current = false;
            useDictationStatus.setState({ transcribing: false, level: 0 });
        }
    }, [recording]);

    const toggle = React.useCallback(() => {
        voiceDiagnostic('dictate.tap');
        if (transcribing) return;
        void (recording ? stop() : start());
    }, [recording, start, stop, transcribing]);

    return { recording, transcribing, toggle };
}
