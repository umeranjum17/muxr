import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { Modal } from '@/modal';
import { claimHostedPairing, hostedPairingDisplayName } from '@/state/hostedE2ee';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/state/connectionSettings';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';

const PAIR_LINK = /^https:\/\/[^#]+\/pair#|^muxr:\/\/pair[?#]|^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/pair#/;

/**
 * Confirm + claim + save + login for a muxr pair link, wherever it came from
 * (first-run scan, Settings → Pair another machine, or the empty-herd card).
 * Pairing while already paired is a safe context switch — the old grant stays
 * stored — so the confirm body says that out loud instead of staying silent.
 */
export function useHostedPairing() {
    const auth = useAuth();
    const pairing = React.useRef(false);
    return React.useCallback(async (url: string) => {
        if (pairing.current) return;
        pairing.current = true;
        try {
            const switching = getCachedConnectionSettings().machineId !== '';
            const approved = await Modal.confirm(
                `Pair with ${hostedPairingDisplayName(url)}?`,
                (Platform.OS === 'web'
                    ? 'This browser receives read-only access for eight hours. Machine keys stay end-to-end encrypted with WebCrypto in this browser.\n\nOnly continue if you just ran `muxr pair --browser` there.'
                    : 'This phone will be able to read and type into every agent terminal on that computer, answer approvals, and start or stop agents as the user who launched muxr.\n\nOnly continue if you just ran `muxr setup` or `muxr pair` there.')
                + (switching
                    ? '\n\nThis device is already paired to another machine — pairing switches the active connection to this one. The previous pairing stays saved and you can switch back from Settings.'
                    : ''),
                { confirmText: 'Pair' },
            );
            if (!approved) return;
            const grant = await claimHostedPairing(url);
            await saveConnectionSettings({
                ...getCachedConnectionSettings(),
                mode: 'hosted',
                relayUrl: grant.relayUrl,
                machineId: grant.machineId,
                token: '',
                encryptionKey: '',
                selfhost: grant.source === 'selfhost' ? true : undefined,
            });
            await auth.login(grant.credential, grant.deviceKey.secretKey);
        } catch (error) {
            Modal.alert('Pairing failed', error instanceof Error ? error.message : String(error));
        } finally {
            pairing.current = false;
        }
    }, [auth]);
}

/*
 * Every mounted screen hears the native scan event, so the result must go only
 * to the component that launched the scanner — otherwise the home screen and
 * the pair screen both claim the same one-time code. One module-level slot:
 * launching overwrites it, consuming clears it, unmounting the owner clears it.
 */
let pendingScan: ((url: string) => void) | null = null;
let scanSubscription: { remove: () => void } | null = null;

function ensureScanSubscription(): void {
    if (scanSubscription !== null || !CameraView.isModernBarcodeScannerAvailable) return;
    scanSubscription = CameraView.onModernBarcodeScanned((event) => {
        const handler = pendingScan;
        if (handler === null || !PAIR_LINK.test(event.data)) return;
        pendingScan = null;
        void CameraView.dismissScanner().catch(() => undefined);
        handler(event.data);
    });
}

/**
 * QR entry to hosted pairing. Returns a function that primes the user, checks
 * camera permission and launches the scanner; `onScanned` gets the pair link.
 */
export function usePairQrScanner(onScanned: (url: string) => void, enabled: boolean = true) {
    const checkScannerPermissions = useCheckScannerPermissions();
    const handlerRef = React.useRef(onScanned);
    handlerRef.current = onScanned;
    const stableHandler = React.useCallback((url: string) => handlerRef.current(url), []);

    React.useEffect(() => {
        if (!enabled) return undefined;
        ensureScanSubscription();
        return () => {
            if (pendingScan === stableHandler) pendingScan = null;
        };
    }, [enabled, stableHandler]);

    return React.useCallback(async () => {
        // Prime before the system prompt: a bare permission dialog with no
        // context reads as suspicious on a security product.
        const primed = await Modal.confirm(
            'Scan your machine QR',
            'Point the camera at the QR code shown by `muxr setup` or `muxr pair` on your computer. The scan completes an end-to-end encrypted pairing — the image never leaves this phone.',
            { confirmText: 'Open camera' },
        );
        if (!primed) return;
        if (!(await checkScannerPermissions())) {
            Modal.alert('Camera required', 'Allow camera access to scan the secure machine QR.');
            return;
        }
        pendingScan = stableHandler;
        CameraView.launchScanner({ barcodeTypes: ['qr'] });
    }, [checkScannerPermissions, stableHandler]);
}
