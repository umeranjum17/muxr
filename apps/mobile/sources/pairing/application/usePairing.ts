import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/account/ui';
import { Modal } from '@/modal';
import { hostedPairingAuthority, hostedPairingDisplayName, prepareHostedPairingInput } from './hostedE2ee';
import { linkPairMachineName, pairOverLink } from './hostedE2ee';
import { looksLikeLinkOffer, looksLikePairingLink } from '../domain/pairingString';
import { getCachedConnectionSettings } from '@/connection';
import { useCheckScannerPermissions } from './useCheckCameraPermissions';
import { pairMachine } from './PairMachine';
import { deliverScannedPairingLink } from './deliverScannedPairing';
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
            if (looksLikeLinkOffer(url)) {
                await pairLinkOffer(url.trim(), auth);
                return;
            }
            const prepared = prepareHostedPairingInput(url);
            const switching = getCachedConnectionSettings().machineId !== '';
            const browserAuthority = hostedPairingAuthority(prepared);
            const approved = await Modal.confirm(
                `Pair with ${hostedPairingDisplayName(prepared)}?`,
                (Platform.OS === 'web'
                    ? `This browser receives ${browserAuthority === 'control' ? 'full terminal and agent control' : 'view-only access'} for eight hours (30 days for a personal browser). Machine keys stay end-to-end encrypted with WebCrypto in this browser.\n\nOnly continue if you just ran ${browserAuthority === 'control' ? '`muxr pair --browser` or `muxr pair --browser-personal`' : '`muxr pair --browser-view`'} there.`
                    : 'This phone will be able to read and type into every agent terminal on that computer, answer approvals, and start or stop agents as the user who launched muxr.\n\nOnly continue if you just ran `muxr setup` or `muxr pair` there.')
                + (switching
                    ? '\n\nThis device is already paired to another machine — pairing switches the active connection to this one. The previous pairing stays saved and you can switch back from Settings.'
                    : ''),
                { confirmText: 'Pair' },
            );
            if (!approved) return;
            const paired = await pairMachine({ url: prepared });
            if (!paired.ok && paired.reason === 'voice-pinned') {
                const switchApproved = await Modal.confirm(
                    'End voice and switch?',
                    'Realtime voice stays pinned to the computer where it started. The new pairing is saved even if you switch later.',
                    { confirmText: 'End voice and switch', destructive: true },
                );
                if (!switchApproved) return;
                const retried = await pairMachine({ grant: paired.grant, endVoiceIfPinned: true });
                if (!retried.ok) {
                    Modal.alert('Pairing failed', retried.reason === 'failed' ? retried.message ?? 'Pairing failed' : 'Pairing failed');
                    return;
                }
                await auth.login(retried.credential, retried.secretKey);
                return;
            }
            if (!paired.ok) {
                Modal.alert('Pairing failed', paired.message ?? 'Pairing failed');
                return;
            }
            await auth.login(paired.credential, paired.secretKey);
        } catch (error) {
            Modal.alert('Pairing failed', error instanceof Error ? error.message : String(error));
        } finally {
            pairing.current = false;
        }
    }, [auth]);
}

/**
 * Pairing over the byokit link (migration step 4): the computer shows two
 * confirmation words while the person there approves; the words appear here
 * too, and pairing completes only when that approval and the phone's proof
 * over the machine's own link both land.
 */
export async function pairLinkOffer(scanned: string, auth: ReturnType<typeof useAuth>, options: { tunnelPort?: number } = {}): Promise<boolean> {
    const browser = Platform.OS === 'web';
    const machineName = (await linkPairMachineName(scanned)) ?? 'your computer';
    const approved = await Modal.confirm(
        `Pair with ${machineName}?`,
        browser
            ? 'This browser will receive the access shown on the pairing screen. Only continue if you just ran `muxr pair --browser` on that computer.'
            : 'This phone will be able to read and type into every agent terminal on that computer, answer approvals, and start or stop agents as the user who launched muxr.\n\nOnly continue if you just ran `muxr pair` there.',
        { confirmText: 'Pair' },
    );
    if (!approved) return false;
    const grant = await pairOverLink(scanned, {
        ...options,
        onWords: (words) => {
            void Modal.alert(
                'Compare the two words',
                `The computer is deciding whether to pair this ${browser ? 'browser' : 'phone'}.\n\nIt shows: ${words}\n\nIt should only be approved if these words match what it displays.`,
            );
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
        await auth.login(retried.credential, retried.secretKey);
        return true;
    }
    if (!paired.ok) {
        Modal.alert('Pairing failed', paired.message ?? 'Pairing failed');
        return false;
    }
    await auth.login(paired.credential, paired.secretKey);
    return true;
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
 * QR entry to pairing. Returns a function that primes the user, checks camera
 * permission and launches the scanner; `onScanned` gets the short relay code.
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
        try {
            await CameraView.launchScanner({ barcodeTypes: ['qr'] });
        } catch {
            if (pendingScan === stableHandler) pendingScan = null;
            Modal.alert('Camera scanner unavailable', 'The system QR scanner could not open. Enter the short pairing string instead, or try again on a device with a working camera scanner.');
        }
    }, [checkScannerPermissions, stableHandler]);
}
