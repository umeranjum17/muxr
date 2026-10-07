import * as React from 'react';
import { consentWords, pairingView } from '@byokit/ui-core/link';
import { pairingDeviceKind, pairingDeviceNoun } from '../infrastructure/pairingPlatform';
import { useRouter } from 'expo-router';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/account/ui';
import { Modal } from '@/modal';
import { linkPairMachineName, pairOverLink } from './linkPairing';
import { decidePairingInput, hostedPairingDuration, linkOfferRole, looksLikePairingLink } from '../domain/pairingString';
import { useCheckScannerPermissions } from './useCheckCameraPermissions';
import { pairMachine } from './PairMachine';
import { deliverScannedPairingLink } from './deliverScannedPairing';
/**
 * All pairing entries share the screen's single consent and inline progress.
 * The one-time offer is not claimed until the person presses Pair there.
 */
export function useHostedPairing() {
    const router = useRouter();
    return React.useCallback(async (url: string) => {
        const decided = decidePairingInput(url);
        if (!decided.ok) {
            Modal.alert(decided.expired ? 'Pairing code expired' : 'Pairing code not usable', decided.message);
            return;
        }
        router.push({ pathname: '/pair', params: { offer: decided.offer } });
    }, [router]);
}

/**
 * Describe the offer's authority before its one-time code is claimed.
 * Encryption alone does not explain terminal control or the browser grant's
 * duration; those access bounds belong in the consent too.
 */
export function pairLinkConsent(scanned: string, machineName: string): string {
    const device = pairingDeviceKind();
    const role = linkOfferRole(scanned);
    if (role === undefined) {
        return `This ${pairingDeviceNoun()} will receive the access shown on the pairing screen. Only continue if you just ran ${device === 'browser' ? '`muxr pair --browser`' : '`muxr pair`'} on that computer.`;
    }
    let detail = pairLinkDetail(device, role);
    if (device === 'browser') detail = `Machine keys stay end-to-end encrypted in this browser for ${hostedPairingDuration(scanned)}. ${detail}`;
    return nameDevice(consentWords({ hostName: machineName, role, device, detail }));
}

export { pairingDeviceNoun };

export type PairingProgress = ReturnType<typeof pairingView>;

export async function pairLinkOffer(scanned: string, auth: ReturnType<typeof useAuth>, options: {
    tunnelPort?: number;
    confirm?: (title: string, words: string) => Promise<boolean>;
    onProgress?: (view: PairingProgress) => void;
} = {}): Promise<boolean> {
    const device = pairingDeviceKind();
    const machineName = (await linkPairMachineName(scanned)) ?? 'your computer';
    const confirmation = pairLinkConsent(scanned, machineName);
    const approved = await (options.confirm ?? ((title, words) => Modal.confirm(title, words, { confirmText: 'Pair' })))(
        `Pair with ${machineName}?`,
        confirmation,
    );
    if (!approved) return false;
    const grant = await pairOverLink(scanned, {
        tunnelPort: options.tunnelPort,
        onWords: (words) => {
            const view = pairingView({ phase: 'compare', hostName: machineName, words, device });
            options.onProgress?.(view);
        },
    });
    // Activation runs through the shared path so a pinned voice session and a
    // previous machine's SSH credential are handled exactly like relay pairing.
    const paired = await pairMachine({ grant });
    if (!paired.ok && paired.reason === 'voice-pinned') {
        const switchApproved = await Modal.confirm(
            'End voice and switch?',
            'Realtime voice stays pinned to the computer where it started. The new pairing is saved even if you switch later.',
            { confirmText: 'End voice and switch', destructive: true },
        );
        if (!switchApproved) return false;
        const retried = await pairMachine({ grant, endVoiceIfPinned: true });
        if (!retried.ok) {
            Modal.alert('Pairing failed', 'Pairing failed');
            return false;
        }
        options.onProgress?.(pairedView(machineName, device));
        await auth.login(retried.credential, retried.secretKey);
        return true;
    }
    if (!paired.ok) {
        Modal.alert('Pairing failed', paired.message ?? 'Pairing failed');
        return false;
    }
    options.onProgress?.(pairedView(machineName, device));
    await auth.login(paired.credential, paired.secretKey);
    return true;
}

/** The kit only knows "This phone"; name the device the person is actually holding. */
function nameDevice(text: string): string {
    return text.replace(/(^|\? )This phone\b/, `$1This ${pairingDeviceNoun()}`);
}

function pairedView(machineName: string, device: 'phone' | 'browser'): PairingProgress {
    const view = pairingView({ phase: 'paired', hostName: machineName, device });
    return { ...view, title: nameDevice(view.title) };
}

function pairLinkDetail(device: 'phone' | 'browser', role: 'control' | 'view'): string {
    if (role === 'view') {
        return device === 'browser'
            ? 'Only continue if you just ran `muxr pair --browser-view` on that computer.'
            : 'Only continue if you just ran `muxr pair` on that computer.';
    }
    return device === 'browser'
        ? 'It receives the access shown on the pairing screen. Only continue if you just ran `muxr pair --browser` on that computer.'
        : 'It can also read and type into every agent terminal on that computer, answer approvals, and start or stop agents as the user who launched muxr. Only continue if you just ran `muxr pair` on that computer.';
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
        if (handler === null || !looksLikePairingLink(event.data)) return;
        pendingScan = null;
        void deliverScannedPairingLink(event.data, handler, {
            dismissScanner: () => CameraView.dismissScanner(),
        });
    });
}

/**
 * QR entry to pairing. Returns a function that checks camera
 * permission and launches the scanner; `onScanned` gets the link offer.
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
        if (!(await checkScannerPermissions())) {
            Modal.alert('Camera required', 'Allow camera access to scan the secure machine QR.');
            return;
        }
        pendingScan = stableHandler;
        try {
            await CameraView.launchScanner({ barcodeTypes: ['qr'] });
        } catch {
            if (pendingScan === stableHandler) pendingScan = null;
            Modal.alert('Camera scanner unavailable', 'The system QR scanner could not open. Enter the pairing string instead, or try again on a device with a working camera scanner.');
        }
    }, [checkScannerPermissions, stableHandler]);
}
