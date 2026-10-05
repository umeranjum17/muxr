import { Platform } from 'react-native';
import type { StoredHostedGrant } from '../application/linkPairing';
import { cachedGrant, loadGrants } from './grantStore';
import { isBrowserLinkOffer } from './linkPairClient';
import { looksLikeLinkOffer, PairingNeedsNewCode, STALE_PAIRING_CODE } from '../domain/pairingString';

export function pairingDeviceName(): string {
    if (Platform.OS === 'ios') return 'iPhone';
    if (Platform.OS === 'android') return 'Android phone';
    return 'Browser';
}

export function assertSupportedOffer(scanned: string): void {
    if (Platform.OS === 'web' && !isBrowserLinkOffer(scanned)) {
        throw new Error('Native pairing codes are for phones. Use a fresh browser link from `muxr pair --browser` on the computer.');
    }
    if (!looksLikeLinkOffer(scanned)) throw new PairingNeedsNewCode(STALE_PAIRING_CODE);
}

export function deviceAuthority(machineId: string, grant: StoredHostedGrant | undefined): 'control' | 'observe' {
    if (Platform.OS !== 'web') return 'control';
    return grant?.machineId === machineId ? grant.authority ?? 'observe' : 'observe';
}

export function initialDeviceAuthority(machineId: string): { authority: 'control' | 'observe'; loading: boolean } {
    return { authority: deviceAuthority(machineId, cachedGrant(machineId)), loading: Platform.OS === 'web' };
}

export async function loadDeviceAuthorityGrants(): Promise<StoredHostedGrant[]> {
    return Platform.OS === 'web' ? Object.values(await loadGrants()) : [];
}

export function pairingDeviceKind(): 'phone' | 'browser' {
    return Platform.OS === 'web' ? 'browser' : 'phone';
}
