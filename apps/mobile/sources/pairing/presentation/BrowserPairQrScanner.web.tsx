import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Asset } from 'expo-asset';
import { ActionButton } from '@/components/ActionButton';
import { useWebBackCloses } from '@/components/useWebBackCloses';
import { Typography } from '@/constants/Typography';
import { parseBrowserPairingQr, type BrowserPairingQr } from '../domain/pairingString';

export type BrowserPairQrScannerProps = {
    /** Launcher label, e.g. "Scan QR to pair". */
    title: string;
    onScanned: (qr: BrowserPairingQr) => void;
};

/** Secure context with a camera API; the launcher is hidden otherwise. */
export function canScanBrowserPairQr(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue?: unknown }[]> };

let detectorPromise: Promise<Detector> | undefined;

/**
 * Native BarcodeDetector only when it reports QR support and constructs;
 * otherwise the installed ponyfill with its WASM served from this origin
 * (the hashed export asset), never the CDN default. Configured before the
 * first detector is built, one shared instance, reset on failure so Retry
 * can work.
 */
function loadDetector(): Promise<Detector> {
    if (detectorPromise === undefined) {
        detectorPromise = createDetector().catch((cause: unknown) => {
            detectorPromise = undefined;
            throw cause;
        });
    }
    return detectorPromise;
}

async function createDetector(): Promise<Detector> {
    const native = (globalThis as unknown as { BarcodeDetector?: { getSupportedFormats?: () => Promise<readonly string[]>; new (options: { formats: string[] }): Detector } }).BarcodeDetector;
    if (native !== undefined && typeof native.getSupportedFormats === 'function') {
        try {
            if ((await native.getSupportedFormats()).includes('qr_code')) return new native({ formats: ['qr_code'] });
        } catch {
            // fall through to the ponyfill
        }
    }
    const wasm = new URL(Asset.fromModule(require('zxing-wasm/reader/zxing_reader.wasm')).uri, window.location.href);
    if (wasm.origin !== window.location.origin) throw new Error('decoder asset is not same-origin');
    const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector');
    await prepareZXingModule({
        overrides: { locateFile: (file: string, prefix: string) => (file.endsWith('.wasm') ? wasm.href : prefix + file) },
        fireImmediately: true,
    });
    return new BarcodeDetector({ formats: ['qr_code'] });
}

const CAMERA_ERRORS: Record<string, string> = {
    NotAllowedError: 'Camera access is blocked for this site. Allow the camera in your browser’s site settings, then open the camera again — or enter the pairing link manually.',
    SecurityError: 'Camera access is blocked for this site. Allow the camera in your browser’s site settings, then open the camera again — or enter the pairing link manually.',
    NotFoundError: 'No camera was found on this device. Enter the pairing link manually, or scan the QR with your phone’s camera app.',
    OverconstrainedError: 'No camera was found on this device. Enter the pairing link manually, or scan the QR with your phone’s camera app.',
    NotReadableError: 'The camera is busy or was interrupted. Close other apps using it, then open the camera again.',
    AbortError: 'The camera is busy or was interrupted. Close other apps using it, then open the camera again.',
};
const CAMERA_FAILED = 'The camera could not start. Open it again, or enter the pairing link manually.';
const DECODER_FAILED = 'The QR scanner could not load. Try again, or scan the QR with your phone’s camera app instead.';
const BACKGROUND_STOP = 'The camera stopped when this page went to the background. Open it again to keep scanning.';

type Phase =
    | { kind: 'idle' }
    | { kind: 'starting' }
    | { kind: 'scanning'; hint?: string }
    | { kind: 'error'; message: string };

/**
 * Browser QR scanner for the one-use pairing link. One stream, one
 * generation, one in-flight decode, one accepted result: every await
 * re-checks the generation, so cancel, success, hide, background, unmount
 * and a late permission answer all stop the tracks and can never deliver a
 * stale result. Frames, decoded links and errors are never logged or stored.
 */
export function BrowserPairQrScanner({ title, onScanned }: BrowserPairQrScannerProps) {
    const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' });
    // Each opening owns its own history entry under a document-unique id: an
    // obsolete entry restored by browser Forward must never be mistaken for
    // the current scan, even after this component remounts (demo Hide →
    // Connect) — a component-local counter would restart and collide.
    const [opening, setOpening] = React.useState('');
    const generation = React.useRef(0);
    const stream = React.useRef<MediaStream | null>(null);
    const video = React.useRef<HTMLVideoElement | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const launcher = React.useRef<View>(null);
    const returnFocus = React.useRef(false);
    const handler = React.useRef(onScanned);
    handler.current = onScanned;

    const stop = React.useCallback(() => {
        generation.current += 1;
        clearTimeout(timer.current);
        timer.current = undefined;
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = null;
        if (video.current !== null) {
            video.current.pause();
            video.current.srcObject = null;
        }
    }, []);

    const close = React.useCallback((next: Phase) => {
        stop();
        returnFocus.current = true;
        setPhase(next);
    }, [stop]);

    const start = React.useCallback(async () => {
        stop();
        const mine = generation.current;
        const live = () => mine === generation.current;
        setOpening(crypto.randomUUID());
        setPhase({ kind: 'starting' });
        let acquired: MediaStream;
        try {
            acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
        } catch (cause) {
            if (live()) setPhase({ kind: 'error', message: CAMERA_ERRORS[(cause as { name?: string })?.name ?? ''] ?? CAMERA_FAILED });
            return;
        }
        if (!live()) {
            // Cancelled while the permission prompt was open.
            acquired.getTracks().forEach((track) => track.stop());
            return;
        }
        stream.current = acquired;
        let detector: Detector;
        try {
            detector = await loadDetector();
        } catch {
            if (live()) close({ kind: 'error', message: DECODER_FAILED });
            return;
        }
        if (!live()) return;
        const element = video.current;
        if (element === null) {
            close({ kind: 'error', message: CAMERA_FAILED });
            return;
        }
        acquired.getVideoTracks()[0]?.addEventListener('ended', () => {
            if (live()) close({ kind: 'error', message: CAMERA_ERRORS.NotReadableError });
        });
        element.muted = true;
        element.srcObject = acquired;
        try { await element.play(); } catch { /* autoplay refusal: frames still arrive for detection */ }
        if (!live()) return;
        setPhase({ kind: 'scanning' });
        let accepted = false;
        const tick = async () => {
            if (!live()) return;
            if (element.readyState >= 2 && element.videoWidth > 0) {
                let found: { rawValue?: unknown }[] = [];
                try { found = await detector.detect(element); } catch { /* transient frame failure; next tick */ }
                if (!live() || accepted) return;
                const raw = found.find((entry) => typeof entry.rawValue === 'string')?.rawValue;
                if (raw !== undefined) {
                    const parsed = parseBrowserPairingQr(raw);
                    if (parsed.ok) {
                        accepted = true;
                        close({ kind: 'idle' });
                        handler.current(parsed.qr);
                        return;
                    }
                    setPhase((current) => (current.kind === 'scanning' && current.hint === parsed.error ? current : { kind: 'scanning', hint: parsed.error }));
                }
            }
            timer.current = setTimeout(() => { void tick(); }, 300);
        };
        void tick();
    }, [close, stop]);

    const active = phase.kind === 'starting' || phase.kind === 'scanning';
    // An active scanner owns one history entry: browser Back and Escape
    // close it (stopping the camera) instead of leaving the route, even
    // where the host frame persists across routes (the demo bar).
    const cancel = React.useCallback(() => close({ kind: 'idle' }), [close]);
    useWebBackCloses(active, cancel, `muxrQrScanner:${opening}`);
    React.useEffect(() => {
        if (!active) return undefined;
        const onHide = () => { if (document.visibilityState === 'hidden') close({ kind: 'error', message: BACKGROUND_STOP }); };
        document.addEventListener('visibilitychange', onHide);
        window.addEventListener('pagehide', stop);
        return () => {
            document.removeEventListener('visibilitychange', onHide);
            window.removeEventListener('pagehide', stop);
        };
    }, [active, close, stop]);
    React.useEffect(() => stop, [stop]);
    // The launcher remounts once the camera view is gone: return focus then.
    React.useEffect(() => {
        if (active || !returnFocus.current) return;
        returnFocus.current = false;
        (launcher.current as unknown as { focus?: () => void } | null)?.focus?.();
    }, [active]);

    let status = 'Waiting for camera permission…';
    if (phase.kind === 'scanning') status = phase.hint ?? 'Point the camera at the QR on your computer’s screen.';
    return (
        <View style={styles.frame}>
            {!active && (
                <ActionButton ref={launcher} title={title} icon="qr-code-outline" onPress={() => void start()} />
            )}
            {phase.kind === 'error' && (
                <Text accessibilityRole="alert" style={styles.error}>{phase.message}</Text>
            )}
            {active && (
                <>
                    <View style={styles.preview} accessibilityRole="image" accessibilityLabel="Live camera preview looking for the pairing QR">
                        <video ref={video} autoPlay muted playsInline style={videoStyle} />
                    </View>
                    <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text>
                    <ActionButton title="Cancel" variant="secondary" onPress={cancel} />
                </>
            )}
        </View>
    );
}

const videoStyle: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };

const styles = StyleSheet.create((theme) => ({
    frame: {
        gap: 12,
    },
    preview: {
        width: '100%',
        aspectRatio: 4 / 3,
        maxHeight: 360,
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceHighest,
    },
    status: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    error: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textDestructive,
    },
}));
