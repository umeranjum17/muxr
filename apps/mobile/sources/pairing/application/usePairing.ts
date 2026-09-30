import * as React from 'react';
import { consentWords, pairingView } from '@byokit/ui-core/link';
import { pairingDeviceKind } from '../infrastructure/pairingPlatform';
import { useRouter } from 'expo-router';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/account/ui';
import { Modal } from '@/modal';
import { TokenStorage } from '@/account';
import { sync, syncCreate } from '@/catalog/sync';
import { getCachedConnectionSettings, saveConnectionSettings, parseSshFields, pinSshHostKey, saveSshCredential, readSshCredential, forgetSshCredential, type SshFieldInput } from '@/connection';
import { realtimeMachineSwitchGuard } from '@/conversation/session';
import { storeGrant, deleteGrant } from '../infrastructure/grantStore';
import { loadHostedGrant, linkPairMachineName, pairOverLink } from './linkPairing';
import { hostedPairingDuration, linkOfferRole, looksLikeLinkOffer, looksLikePairingLink } from '../domain/pairingString';
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
        if (looksLikeLinkOffer(url)) {
            router.push({ pathname: '/pair', params: { offer: url.trim() } });
            return;
        }
        Modal.alert('Pairing code expired', 'This pairing code is from an older muxr. Update muxr on both devices, run `muxr pair` on the computer, then scan its new link code.');
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
        return `${device === 'browser' ? 'This browser' : 'This phone'} will receive the access shown on the pairing screen. Only continue if you just ran ${device === 'browser' ? '`muxr pair --browser`' : '`muxr pair`'} on that computer.`;
    }
    let detail = pairLinkDetail(device, role);
    if (device === 'browser') detail = `Machine keys stay end-to-end encrypted in this browser for ${hostedPairingDuration(scanned)}. ${detail}`;
    return consentWords({ hostName: machineName, role, device, detail });
}

export type PairingProgress = ReturnType<typeof pairingView>;

export async function pairLinkOffer(scanned: string, auth: ReturnType<typeof useAuth>, options: {
    tunnelPort?: number;
    sshInput?: SshFieldInput;
    sshHostKey?: string;
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
    const previousSettings = getCachedConnectionSettings();
    const previousGrant = await loadHostedGrant(grant.machineId);
    const previousCredentials = auth.credentials ?? null;
    const previousSsh = await readSshCredential(previousSettings.machineId);
    const previousTargetSsh = await readSshCredential(grant.machineId);
    const parsedSsh = options.sshInput === undefined ? undefined : parseSshFields(options.sshInput);
    if (parsedSsh !== undefined && 'error' in parsedSsh) throw new Error(parsedSsh.error);
    const switchNeeded = !realtimeMachineSwitchGuard(grant.machineId).allowed;
    if (switchNeeded) {
        const approvedSwitch = await Modal.confirm(
            'End voice and switch?',
            'Realtime voice stays pinned to the computer where it started. Pairing will be discarded if you cancel.',
            { confirmText: 'End voice and switch', destructive: true },
        );
        if (!approvedSwitch) throw new Error('Pairing cancelled. Scan a new code when you are ready to switch.');
    }
    try {
        if (!await TokenStorage.setCredentials({ token: grant.credential, secret: grant.deviceKey.secretKey })) throw new Error('Failed to save credentials');
        let ssh = previousSettings.machineId === grant.machineId ? previousSettings.ssh : undefined;
        if (parsedSsh !== undefined) {
            await saveSshCredential(grant.machineId, parsedSsh.credential);
            ssh = pinSshHostKey(ssh, parsedSsh.target);
            if (ssh.hostKey === undefined && options.sshHostKey !== undefined) ssh = { ...ssh, hostKey: options.sshHostKey };
        }
        const paired = await pairMachine({ grant, endVoiceIfPinned: switchNeeded, ssh });
        if (!paired.ok) {
            const message = paired.reason === 'failed' ? paired.message : undefined;
            throw new Error(message ?? 'Pairing could not be activated. Scan a new code.');
        }
        await storeGrant(grant);
        await auth.login(paired.credential, paired.secretKey);
    } catch (cause) {
        await saveConnectionSettings(previousSettings);
        if (previousGrant === undefined) await deleteGrant(grant.machineId);
        else await storeGrant(previousGrant);
        if (previousTargetSsh === undefined) await forgetSshCredential(grant.machineId);
        else await saveSshCredential(grant.machineId, previousTargetSsh);
        if (previousSsh !== undefined) await saveSshCredential(previousSettings.machineId, previousSsh);
        if (previousCredentials === null) {
            if (!await TokenStorage.removeCredentials()) throw new Error('Failed to discard pairing credentials');
            sync.invalidateCatalog();
        } else {
            if (!await TokenStorage.setCredentials(previousCredentials)) throw new Error('Failed to restore credentials');
            await syncCreate(previousCredentials);
        }
        throw cause;
    }
    options.onProgress?.(pairingView({ phase: 'paired', hostName: machineName, device }));
    return true;
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
